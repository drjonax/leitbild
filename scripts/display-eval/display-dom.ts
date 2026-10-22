/** Reads what the display window shows, in the page, for the acceptance scripts: the frame's clock word, the
 * worst chip, the lead rows, the alerts, the drawn items an alert frames, and every value with whether its box
 * holds it (plan v5 §5.1, §5.5). Two display generations are read: today's vignette (`display.vignette`, base and
 * later) and the pre-swap composed display (`process-plant.display`, OLD 724ae2ac8), each by its own markup.
 *
 * Containment: a value's text (every text node under it, through shadow roots and slots, not a hidden spacer) must
 * lie inside every ancestor that does not let overflow show, as CSS clips it (an absolutely placed box escapes the
 * ancestors below its containing block, a fixed one all but the viewport). Outside an ancestor that hides overflow
 * it is `clipped`; drawn in a flow drawing past the room the layout reserved for its text it is `overrun` (nothing
 * clips it, but it runs into whatever stands next to it). Outside a scrolling ancestor's view it is `scrolled-x`
 * or `scrolled-y`: there, but not readable without scrolling. The scripts fail clipped, overrun and scrolled-x (a
 * value hidden sideways: a pop-over's body scrolled sideways, a column scrolled out of a narrow window) and count
 * scrolled-y apart (a tall pop-over's body scrolls down by design). */

import type { Page } from './browser.ts'

/** Opens a unit's overview from the rail's monitor button and waits for its frame. A press the page takes before it
 * is ready opens nothing (seen on the pre-swap display), so it presses again, at most three times. */
export const openUnitDisplay = async (page: Page, unit: string): Promise<void> => {
  const shown = `lb.documents().some(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.click({ sel: 'button', text: `Open process display for ${unit}` })
    const opened = await page.until(shown, 15_000).then(() => true, () => false)
    if (opened) return
  }
  throw new Error(`three presses on "Open process display for ${unit}" opened no display`)
}

/** An expression for `Page.eval` (browser.ts): the shown display window's state, or the pop-over's when `scope` is 'popover'. */
export const readDisplay = (scope: 'window' | 'popover' = 'window'): string => `(${READER})(${JSON.stringify(scope)})`

export type ValueStatus = 'ok' | 'clipped' | 'overrun' | 'scrolled-x' | 'scrolled-y'
export interface ValueBox {
  readonly where: string
  readonly label: string
  readonly text: string
  readonly status: ValueStatus
  /** The ancestor that hides it, or the box it runs past. */
  readonly by?: string
  /** How far past, in px. */
  readonly px?: number
}
export interface DisplayState {
  readonly generation: 'vignette' | 'old' | 'none'
  readonly frame: { readonly width: number; readonly height: number } | null
  readonly title: string | null
  /** LIVE, PAUSED or FROZEN, as the frame says it. */
  readonly word: string | null
  readonly sim: string | null
  readonly worst: string | null
  readonly chips: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly leads: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly alerts: { readonly heading: string; readonly rows: ReadonlyArray<string>; readonly more: string | null } | null
  /** Drawn items framed or marked by an alert: their item ids, by tone. */
  readonly framed: ReadonlyArray<{ readonly item: string; readonly tone: string; readonly name: string }>
  /** Drawn symbols (devices, tanks, exchangers) drawing OpenBridge's alert frame. */
  readonly framedSymbols: number
  readonly values: ReadonlyArray<ValueBox>
  /** The drawing's and the frame's own text, for text checks (a trip line, "Rods on bottom"). */
  readonly text: string
  readonly popover: { readonly title: string; readonly ready: boolean } | null
}

const READER = `(scope) => {
  const lb = window.__lb
  const TOL = 0.5
  // A text box's height is its font's content area, which a tight line box may cut by a pixel or three without
  // touching a glyph: vertically only more than that counts.
  const TOL_Y = 3
  const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  // The display window's frame: the largest shown embed (a chat card or a dialog is smaller).
  const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = docs.sort((a, b) => area(b) - area(a))[0]
  const empty = { generation: 'none', frame: null, title: null, word: null, sim: null, worst: null, chips: [], leads: [], alerts: null, framed: [], values: [], text: '', popover: null }
  if (!shown) return empty
  const doc = shown.doc
  const win = doc.defaultView
  const frameRect = shown.frame.getBoundingClientRect()
  const text = el => (el ? (el.innerText ?? el.textContent ?? '') : '').replace(/\\s+/g, ' ').trim()
  const parentOf = n => n.assignedSlot ?? (n.parentNode instanceof win.ShadowRoot ? n.parentNode.host : n.parentNode)
  const describe = el => el.tagName.toLowerCase() + (el.classList && el.classList.length ? '.' + [...el.classList].filter(c => !c.startsWith('svelte-')).join('.') : '')
  // Every rendered text node under an element, through its shadow root and its light children; not a hidden width
  // spacer (OpenBridge's textbox reserves a value's width with invisible zeros) and not an SVG title.
  const hidden = el => { const s = win.getComputedStyle(el); return s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0 }
  const textNodes = root => {
    const out = []
    const walk = node => {
      if (node.nodeType === 3) { if (node.textContent.trim()) out.push(node); return }
      if (node.nodeType !== 1 && node.nodeType !== 11) return
      if (node.nodeType === 1 && (node.tagName.toLowerCase() === 'title' || hidden(node))) return
      if (node.nodeType === 1 && node.shadowRoot) walk(node.shadowRoot)
      for (const child of node.childNodes) walk(child)
    }
    walk(root)
    return out
  }
  const rectOf = node => { const range = doc.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null }
  const rank = { ok: 0, 'scrolled-y': 1, 'scrolled-x': 2, overrun: 3, clipped: 4 }
  const deepText = el => textNodes(el).map(node => node.textContent).join(' ').replace(/\\s+/g, ' ').trim()
  // Where a text box stands against each ancestor that does not let overflow show. An ancestor that hides overflow
  // clips it; a scrolling one only hides it until scrolled, so outer ancestors then judge it as scrolled into view.
  // An absolutely placed box escapes the ancestors below its containing block, a fixed one all but the viewport.
  const contain = (node, start) => {
    let r = { left: start.left, right: start.right, top: start.top, bottom: start.bottom }
    let worst = { status: 'ok' }
    let escaping = null
    for (let el = parentOf(node); el && el.nodeType === 1; el = parentOf(el)) {
      const s = win.getComputedStyle(el)
      const root = el === doc.documentElement
      if (escaping === 'absolute' && s.position === 'static' && !root) continue
      if (escaping === 'fixed' && !root && s.transform === 'none' && s.filter === 'none') continue
      escaping = s.position === 'absolute' ? 'absolute' : s.position === 'fixed' ? 'fixed' : null
      if (s.display === 'contents') continue
      const box = el.getBoundingClientRect()
      const left = root ? 0 : box.left + el.clientLeft, top = root ? 0 : box.top + el.clientTop
      const right = root ? win.innerWidth : left + el.clientWidth, bottom = root ? win.innerHeight : top + el.clientHeight
      for (const [axis, overflow, lo, hi, a, b] of [['x', root ? 'auto' : s.overflowX, left, right, 'left', 'right'], ['y', root ? 'auto' : s.overflowY, top, bottom, 'top', 'bottom']]) {
        if (overflow === 'visible') continue
        const past = Math.max(lo - r[a], r[b] - hi)
        if (past <= (axis === 'y' ? TOL_Y : TOL)) continue
        if (overflow === 'hidden' || overflow === 'clip') return { status: 'clipped', by: describe(el), px: past }
        const status = axis === 'x' ? 'scrolled-x' : 'scrolled-y'
        if (rank[status] > rank[worst.status]) worst = { status, by: describe(el), px: past }
        const size = Math.min(r[b] - r[a], hi - lo)
        r = { ...r, [a]: lo, [b]: lo + size }
      }
    }
    return worst
  }
  const valueBox = (el, where, label, reserved) => {
    let worst = { status: 'ok' }
    for (const node of textNodes(el)) {
      const r = rectOf(node)
      if (r === null) continue
      let found = contain(node, r)
      if (reserved) {
        const past = r.right - reserved.getBoundingClientRect().right
        if (past > TOL && rank.overrun > rank[found.status]) found = { status: 'overrun', by: describe(reserved), px: past }
      }
      if (rank[found.status] > rank[worst.status]) worst = found
    }
    return { where, label, text: deepText(el), status: worst.status, ...(worst.by ? { by: worst.by, px: Math.round(worst.px * 10) / 10 } : {}) }
  }
  const whereOf = el => el.closest('.popover') ? 'popover' : el.closest('.flow') ? 'drawing' : el.closest('.chips') ? 'chips' : el.closest('.legend') ? 'trend' : el.closest('table.grouped') ? 'grouped' : el.closest('.column') ? 'column' : 'section'

  if (doc.querySelector('article.vignette')) {
    const article = doc.querySelector('article.vignette')
    const footer = article.querySelector(':scope > footer')
    const pop = doc.querySelector('.popover[role=dialog]')
    const root = scope === 'popover' ? pop : article
    if (!root) return { ...empty, generation: 'vignette' }
    const labelOf = el => text(el.closest('.readout, .state')?.querySelector(':scope > .label'))
    const values = []
    for (const el of root.querySelectorAll('.readout > .reading, .state > obc-status-indicator, .state > .unknown')) {
      if (scope === 'window' && el.closest('.popover')) continue
      values.push(valueBox(el, whereOf(el), labelOf(el)))
    }
    for (const el of root.querySelectorAll('.legend .now')) values.push(valueBox(el, 'trend', text(el.parentElement?.querySelector('.name'))))
    for (const el of root.querySelectorAll('.flow .text > span.reading, .flow .text > span.word, .flow .text > span.command')) {
      const box = el.closest('.text')
      values.push(valueBox(el, 'drawing', text(box.firstElementChild), box))
    }
    const sections = [...article.querySelectorAll('.section')].filter(s => !s.closest('.popover'))
    const leadSection = sections.find(s => s.querySelector(':scope > .readout, :scope > .state'))
    const leads = leadSection ? [...leadSection.querySelectorAll(':scope > .readout, :scope > .state')].map(row => ({ label: text(row.querySelector(':scope > .label')), value: deepText(row.querySelector(':scope > .reading, :scope > obc-status-indicator, :scope > .unknown') ?? doc.createElement('i')) })) : []
    const alertsSection = [...article.querySelectorAll('section.alerts')].find(s => !s.closest('.popover'))
    const framed = [...article.querySelectorAll('.flow .text')].filter(t => ['caution', 'warning', 'alarm', 'critical'].some(c => t.classList.contains(c)))
      .map(t => ({ item: t.dataset.item, tone: ['critical', 'alarm', 'warning', 'caution'].find(c => t.classList.contains(c)), name: text(t.firstElementChild) }))
    const framedSymbols = [...article.querySelectorAll('.flow obc-automation-button, .flow obc-automation-tank, .flow obc-heat-exchanger')].filter(el => el.alert === true).length
    const clock = footer?.querySelector('.clock')
    const sim = [...(footer?.querySelectorAll(':scope > span') ?? [])].map(text).find(t => /^(sim|wall) /.test(t)) ?? null
    return {
      generation: 'vignette',
      frame: { width: Math.round(frameRect.width), height: Math.round(frameRect.height) },
      title: text(article.querySelector(':scope > header h1')),
      word: clock ? text(clock) : null,
      sim,
      worst: text(article.querySelector(':scope > header .chip')) || null,
      chips: [...article.querySelectorAll(':scope > .chips > .state')].map(chip => ({ label: text(chip.querySelector('.label')), value: deepText(chip.querySelector('obc-status-indicator, .unknown') ?? doc.createElement('i')) })),
      leads,
      alerts: alertsSection ? { heading: text(alertsSection.querySelector('h2')), rows: [...alertsSection.querySelectorAll('li')].map(text), more: text(alertsSection.querySelector('.more')) || null } : null,
      framed, framedSymbols,
      values,
      text: text(article),
      popover: pop ? { title: pop.getAttribute('aria-label') || '', ready: pop.querySelector('.section') !== null } : null,
    }
  }

  if (doc.querySelector('article.card')) {
    // The pre-swap composed display (OLD): its banner, state chip, lead column, alarm list, mimic and quick looks.
    const card = doc.querySelector('article.card')
    const look = doc.querySelector('.popover[aria-label]')
    const root = scope === 'popover' ? look : card
    if (!root) return { ...empty, generation: 'old' }
    const values = []
    // Lead readouts, the mimic's value and state rows, a quick look's values (ul.rows) and a faceplate's cells.
    for (const el of root.querySelectorAll('ul.readouts .reading, ul.readouts .state, .value-row, .state-row, ul.rows .value, li.line .reading, li.line obc-status-indicator')) {
      if (scope === 'window' && el.closest('.popover')) continue
      const where = el.closest('.popover') ? 'popover' : el.closest('.mimic-panel') ? 'drawing' : el.closest('ul.readouts') ? 'column' : 'card'
      const label = text(el.closest('li')?.querySelector('.head .name, :scope > .name, .tag') ?? el.closest('.stack')?.querySelector('.tag'))
      values.push(valueBox(el, where, label, where === 'drawing' ? el.closest('.stack') : undefined))
    }
    const leads = [...card.querySelectorAll('section[aria-label="Lead values"] ul.readouts > li')].map(li => ({ label: text(li.querySelector('.head .name')), value: deepText(li.querySelector('.reading, .state') ?? doc.createElement('i')) }))
    const alarms = card.querySelector('section.alarms')
    const banner = card.querySelector('.banner')
    const framed = [...card.querySelectorAll('.mimic-panel .item')].filter(item => item.querySelector('.frame-box')).map((item, index) => ({ item: String(index), tone: (item.querySelector('.flap-line')?.className ?? '').replace('flap-line', '').trim() || 'alert', name: text(item.querySelector('.stack .tag')) }))
    return {
      generation: 'old',
      frame: { width: Math.round(frameRect.width), height: Math.round(frameRect.height) },
      title: text(card.querySelector('.unit, h1')),
      word: text(card.querySelector('.chip')).toUpperCase() || null,
      sim: text(card.querySelector('.clock')) || null,
      worst: banner && banner.classList.contains('trip') ? text(banner) : null,
      chips: [...card.querySelectorAll('.csf')].map(chip => ({ label: chip.getAttribute('aria-label') || '', value: text(chip) })),
      leads,
      alerts: alarms ? { heading: text(alarms.querySelector('h2')) || text(alarms.querySelector('.empty')), rows: [...alarms.querySelectorAll('li')].map(text), more: text(alarms.querySelector('.more')) || null } : null,
      framed, framedSymbols: framed.length,
      values,
      text: text(card),
      popover: look ? { title: look.getAttribute('aria-label') || '', ready: look.querySelector('section') !== null } : null,
    }
  }
  return empty
}`
