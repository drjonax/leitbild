/** Containment acceptance (plan v5 §5.5): every value inside its box, in the unit overview's column and drawing and
 * in every drawn item's pop-over, at 1920 px and at 1046 px with the chat open. Reusable every release.
 *
 *   bun scripts/display-eval/containment.ts --origin=http://127.0.0.1:<port> --workspace=<id> --run=<Run id> --out=<dir>
 *       [--label=<stack>] [--sizes=1920,1046] [--port=<CDP port>] [--unit="Halden Unit 1"] [--items=<n>]
 *
 * A value fails when a box that hides overflow clips any of its text, when a drawn reading runs past the room its
 * drawing reserved for it, or when it stands sideways out of a box that scrolls (display-dom.ts): a pop-over's body
 * scrolled sideways, a window column scrolled out of a narrow window. A value below the fold of a box that scrolls
 * down (a tall pop-over's body) is counted apart, not failed. Pop-overs are opened one by one on every drawn item
 * (scrolled into view first) and read once their content has drawn. Reads only: the Run is not changed.
 * Writes <out>/<label>-containment.json and shots. Loopback only; no model is called. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { openUnitDisplay, readDisplay, type DisplayState, type ValueBox } from './display-dom.ts'

/** Clipped, run past its drawn room, or hidden sideways in a scrolling box (a 304 px pop-over or a 1046 px window
 * that scrolls its column away): not readable where it stands. Below the fold of a box that scrolls down is not. */
const FAILING: ReadonlyArray<string> = ['clipped', 'overrun', 'scrolled-x']
const failing = (values: ReadonlyArray<ValueBox>) => values.filter(value => FAILING.includes(value.status))
const count = (values: ReadonlyArray<ValueBox>, status: string) => values.filter(value => value.status === status).length
const summary = (values: ReadonlyArray<ValueBox>) => ({
  values: values.length,
  failing: failing(values).length,
  clipped: count(values, 'clipped'), overrun: count(values, 'overrun'), sideways: count(values, 'scrolled-x'), belowFold: count(values, 'scrolled-y'),
  byWhere: Object.fromEntries([...new Set(values.map(value => value.where))].map(where => [where, { values: values.filter(value => value.where === where).length, failing: failing(values.filter(value => value.where === where)).length }])),
})

const SHOWN = `(() => { const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame)); const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }; return docs.sort((a, b) => area(b) - area(a))[0] ?? null })()`

/** The drawn items a press opens a pop-over (or a faceplate) on, by their accessible names. */
const itemsOf = (page: Page, generation: string): Promise<string[]> => page.eval<string[]>(`(() => {
  const shown = ${SHOWN}
  if (!shown) return []
  const selector = ${JSON.stringify(generation)} === 'vignette' ? '.flow [role=button]' : 'button[aria-label*="Quick look"]'
  return [...shown.doc.querySelectorAll(selector)].map(el => el.getAttribute('aria-label') || '').filter(Boolean)
})()`)

const openItem = async (page: Page, generation: string, name: string): Promise<boolean> => {
  const selector = generation === 'vignette' ? '.flow [role=button]' : 'button[aria-label*="Quick look"]'
  // The item's centre on the page, through the frames it stands in; scrolled into view first, as a person would.
  const pointOf = (scroll: boolean) => page.eval<{ x: number; y: number } | null>(`(() => {
    const shown = ${SHOWN}
    const el = shown && [...shown.doc.querySelectorAll(${JSON.stringify(selector)})].find(candidate => candidate.getAttribute('aria-label') === ${JSON.stringify(name)})
    if (!el) return null
    if (${scroll}) el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    let ox = 0, oy = 0
    for (let frame = shown.frame; frame; frame = frame.ownerDocument.defaultView.frameElement) { const fr = frame.getBoundingClientRect(); ox += fr.left + frame.clientLeft; oy += fr.top + frame.clientTop }
    return { x: ox + r.left + r.width / 2, y: oy + r.top + r.height / 2 }
  })()`)
  if (await pointOf(true) === null) return false
  await sleep(250)
  const settled = await pointOf(false)
  if (settled === null) return false
  await page.click({ x: settled.x, y: settled.y, w: 0, h: 0, count: 1, tag: '', label: name })
  try {
    await page.until(`(() => { const shown = ${SHOWN}; const pop = shown && shown.doc.querySelector('.popover[role=dialog], .popover[aria-label]'); return pop && !/Reading the element/.test(pop.innerText) && pop.querySelector('.section, .status, section, table') !== null })()`, 20_000, 50)
    await sleep(1_200)
    return true
  } catch { return false }
}

const runSize = async (config: { origin: string; workspaceId: string; runId: string; port: number; size: number; out: string; label: string; unit: string; maxItems: number }) => {
  const { size, out, label } = config
  const tag = `${label}-${size}`
  const page = await openPage(config.port, 1920, 1080)
  try {
    await page.goto(`${config.origin}/workspaces/${config.workspaceId}?world=${encodeURIComponent(config.runId)}`)
    await page.waitFor({ sel: 'button', text: `Open process display for ${config.unit}` }, 120_000)
    if (size < 1920) {
      await page.click({ sel: 'button', text: 'Open Leitbild Assistant' })
      await page.until(`lb.documents().some(d => d.frame && /\\/agents/.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`, 60_000)
      await sleep(2_000)
    }
    await openUnitDisplay(page, config.unit)
    await page.until(`(() => { const s = ${readDisplay()}; return s.generation !== 'none' && s.word !== null && s.values.length > 0 })()`, 120_000)
    await sleep(3_000)
    const window = await page.eval<DisplayState>(readDisplay())
    await page.shot(join(out, `${tag}-window.png`))
    const popovers: Array<Record<string, unknown>> = []
    const names = (await itemsOf(page, window.generation)).slice(0, config.maxItems)
    for (const [index, name] of names.entries()) {
      const opened = await openItem(page, window.generation, name)
      if (!opened) { popovers.push({ item: name, opened: false }); await page.key('Escape'); await sleep(500); continue }
      const state = await page.eval<DisplayState>(readDisplay('popover'))
      const bad = failing(state.values)
      const shot = bad.length > 0 ? join(out, `${tag}-popover-${String(index).padStart(2, '0')}.png`) : undefined
      if (shot !== undefined) await page.shot(shot)
      popovers.push({ item: name, opened: true, title: state.popover?.title ?? null, ...summary(state.values), failingValues: bad, ...(shot === undefined ? {} : { shot }) })
      await page.key('Escape')
      await sleep(600)
    }
    const total = (field: string) => popovers.reduce((sum, entry) => sum + Number(entry[field] ?? 0), 0)
    const popoverValues = total('values'), popoverFailing = total('failing')
    return {
      size, displayWidth: window.frame?.width ?? null, generation: window.generation,
      window: { ...summary(window.values), failingValues: failing(window.values) },
      popovers: { opened: popovers.filter(entry => entry.opened).length, of: names.length, values: popoverValues, failing: popoverFailing, clipped: total('clipped'), overrun: total('overrun'), sideways: total('sideways'), belowFold: total('belowFold'), withFailing: popovers.filter(entry => Number(entry.failing ?? 0) > 0).length, items: popovers },
      pass: failing(window.values).length === 0 && popoverFailing === 0 && popovers.every(entry => entry.opened),
      console: page.console.slice(-20),
    }
  } catch (error) {
    await page.shot(join(out, `${tag}-failed.png`))
    throw error
  } finally {
    await page.close()
  }
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), runId = argv.get('run'), out = argv.get('out')
  if (workspaceId === undefined || runId === undefined || out === undefined) throw new Error('usage: containment.ts --origin=… --workspace=<id> --run=<Run id> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44333)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const results: Array<Record<string, unknown>> = []
  try {
    for (const size of (argv.get('sizes') ?? '1920,1046').split(',').map(Number)) {
      const result = await runSize({ origin, workspaceId, runId, port, size, out, label, unit: argv.get('unit') ?? 'Halden Unit 1', maxItems: Number(argv.get('items') ?? 200) })
      results.push(result)
      await Bun.write(join(out, `${label}-containment.json`), JSON.stringify({ label, origin, runId, results }, null, 2))
      const w = result.window, p = result.popovers
      console.log(`${label} ${size} ${result.pass ? 'PASS' : 'FAIL'}  window ${w.failing}/${w.values} failing (clipped ${w.clipped}, overrun ${w.overrun}, sideways ${w.sideways}; ${w.belowFold} below the fold)  pop-overs ${p.failing}/${p.values} failing in ${p.withFailing} of ${p.opened} opened (${p.of} items; clipped ${p.clipped}, overrun ${p.overrun}, sideways ${p.sideways}, ${p.belowFold} below the fold)`)
      for (const value of w.failingValues.slice(0, 12)) console.log(`   window ${value.where} "${value.label}" ${value.text} ${value.status} by ${value.by} ${value.px} px`)
    }
  } finally {
    if (chrome.started) await chrome.stop()
  }
}
