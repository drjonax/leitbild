/** Live trip acceptance (plan v5 §5.1): a unit overview opened at power stays open through the fault, and must
 * follow it within one sample. Reusable every release, on any loopback stack.
 *
 *   bun scripts/display-eval/live-trip.ts --origin=http://127.0.0.1:<port> --workspace=<id> --from=<paused Run at power>
 *       --out=<dir> [--label=<stack>] [--sizes=1920,1046] [--port=<CDP port>] [--unit="Halden Unit 1"] [--subject=plant:halden-1]
 *       [--after=90]
 *
 * For each size it copies the at-power Run (the copy keeps the Scenario's fault ahead of it), opens the Workspace at
 * 1920 × 1080 (for 1046 with the Assistant's chat open, which leaves the display window 1046 px), opens the unit
 * overview from the rail, then plays the copy at realtime and reads the display every 300 ms until `after` seconds
 * of Run time past the trip. The upset's time comes from the plant's own alerts (their raised time), the mode change
 * from World's sample of the unit's default; neither from the display under test.
 *
 * Checks, tagged by the release that must pass them (later releases keep the earlier checks):
 *   R1  alerts-rows   the alerts list has rows within one sample of the upset, and keeps them (95 % of reads after)
 *       frames        an alarmed drawn item is framed within one sample, and stays framed; at the end every drawn
 *                     element with an active plant alert of caution or worse is framed
 *       worst-chip    the frame's worst chip shows within one sample, and stays
 *       leads         within one sample of the mode change the lead rows are the ones World composes for the unit
 *                     now (POST displays/default), no longer the at-power set
 *       no-clipped    throughout: no value clipped by a box that hides overflow, or hidden sideways in a box that
 *                     scrolls (a column scrolled out of a narrow window)
 *       no-overrun    throughout: no drawn value running past the room its drawing reserved for it (W0.6)
 *       no-frozen     throughout, while playing, the frame never says FROZEN
 *   R2  trip-line     the frame (not its alerts list) says TRIP
 *       rods-on-bottom  the drawing writes "Rods on bottom"
 *       rods-in       the core's rods are drawn fully inserted
 *       expected      the alerts list folds the expected alerts into an aggregate ("expected")
 * "Within one sample": by the display's own Run clock, at most 2 s after the event (a sample a second, written to
 * the second). Writes <out>/<label>-live-trip.json and shots. Loopback only; no model is called. */
import { join } from 'node:path'
import { ensureChrome, loopbackOrigin, openPage, options, sleep, type Page } from './browser.ts'
import { openUnitDisplay, readDisplay, type DisplayState } from './display-dom.ts'
import { createStackApi, type StackApi } from './stack-api.ts'

const ONE_SAMPLE_S = 2
const POLL_MS = 300
const PRIORITY_RANK: Readonly<Record<string, number>> = { caution: 1, warning: 2, alarm: 3, emergency: 4, critical: 4 }

/** "<object> · <observable>" under a title "<object>" reads "<observable>" (World's underTitle). */
const underTitle = (label: string, title: string): string => {
  const object = title.split(' · ')[0]!
  const shown = [title, object].find(prefix => label.startsWith(`${prefix} · `))
  return shown === undefined ? label : label.slice(shown.length + 3)
}
/** The lead rows of a compiled vignette: its first values section's labels as the frame writes them. */
const leadLabels = (view: any): ReadonlyArray<string> => {
  const section = (view?.sections ?? []).find((entry: any) => Array.isArray(entry.values))
  return (section?.values ?? []).map((value: any) => underTitle(String(value.label), String(view.title)))
}
const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((entry, index) => entry === b[index])

interface Poll { readonly wall: number; readonly simMs: number | null; readonly state: DisplayState }

/** The display's Run clock ("sim 04:02:21") on the Run's date. */
const simOf = (state: DisplayState, day: string): number | null => {
  const match = state.sim?.match(/(\d{2}):(\d{2}):(\d{2})/)
  return match ? Date.parse(`${day}T${match[1]}:${match[2]}:${match[3]}.000Z`) : null
}
const badValues = (state: DisplayState) => state.values.filter(value => value.status === 'clipped' || value.status === 'overrun')

/** The shown display's envelope state, from its frame's URL. */
const shownViewState = (page: Page): Promise<string | null> => page.eval<string | null>(`(() => {
  const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = docs.sort((a, b) => area(b) - area(a))[0]
  const hash = shown && (shown.frame.getAttribute('src') || '').split('#view=')[1]
  if (!hash) return null
  try { return JSON.parse(decodeURIComponent(hash)).state ?? null } catch { return null }
})()`)

const coreRods = (page: Page): Promise<{ bars: number; insertedShares: number[]; withdrawnBars: number; unknownBars: number } | null> => page.eval(`(() => {
  const docs = lb.documents().filter(d => d.frame && /\\/world\\/embed\\//.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))
  const area = d => { const r = d.frame.getBoundingClientRect(); return r.width * r.height }
  const shown = docs.sort((a, b) => area(b) - area(a))[0]
  const svg = shown && [...shown.doc.querySelectorAll('svg.vessel')].find(s => s.querySelector('rect.core'))
  if (!svg) return null
  const core = Number(svg.querySelector('rect.core').getAttribute('height')) + 1
  const bars = [...svg.querySelectorAll('rect.bar')].map(bar => Math.round((Number(bar.getAttribute('height')) / core) * 100) / 100)
  return { bars: bars.length, insertedShares: bars, withdrawnBars: svg.querySelectorAll('rect.bar-out').length, unknownBars: svg.querySelectorAll('rect.bar-unknown').length }
})()`)

interface Check { readonly id: string; readonly release: 'R1' | 'R2'; readonly pass: boolean | null; readonly detail: string; readonly shot: string | undefined }

const runSize = async (config: {
  readonly api: StackApi; readonly origin: string; readonly workspaceId: string; readonly from: string; readonly port: number
  readonly size: number; readonly out: string; readonly label: string; readonly unit: string; readonly subject: string; readonly afterS: number
}): Promise<Record<string, unknown>> => {
  const { api, size, out, label, unit, subject } = config
  const tag = `${label}-${size}`
  const shot = (name: string) => join(out, `${tag}-${name}.png`)
  const copy = await api.copy(config.from, `live trip ${size} px · ${new Date().toISOString().slice(0, 19)}`)
  await api.load(copy)
  const start = await api.presence(copy)
  const day = String(start.execution.currentSimulationTime).slice(0, 10)
  const page = await openPage(config.port, 1920, 1080)
  const polls: Poll[] = []
  const shots: Record<string, string> = {}
  try {
    await page.goto(`${config.origin}/workspaces/${config.workspaceId}?world=${encodeURIComponent(copy)}`)
    await page.waitFor({ sel: 'button', text: `Open process display for ${unit}` }, 120_000)
    if (size < 1920) {
      await page.click({ sel: 'button', text: 'Open Leitbild Assistant' })
      await page.until(`lb.documents().some(d => d.frame && /\\/agents/.test(d.frame.getAttribute('src') || '') && lb.shown(d.frame))`, 60_000)
      await sleep(2_000)
    }
    await openUnitDisplay(page, unit)
    await page.until(`(() => { const s = ${readDisplay()}; return s.generation !== 'none' && s.word !== null && s.sim !== null })()`, 120_000)
    await sleep(2_500)
    const atPower = await page.eval<DisplayState>(readDisplay())
    await page.shot(shots.atPower = shot('0-at-power'))
    // World's default of the unit at power: the oracle for today's vignette, which World composes (the pre-swap
    // display composed its own leads).
    const vignette = atPower.generation === 'vignette'
    const fresh = vignette ? await api.defaultView(copy, subject) : null
    const atPowerExpected = fresh === null ? null : leadLabels(fresh.view)
    // The unit's mode as World samples it; a sample that fails is counted, and the next read tries again.
    let modeReadsFailed = 0
    const modeOf = async (): Promise<string | null> => {
      if (fresh === null) return null
      const sample = await api.sample(copy, fresh.state).catch(() => { modeReadsFailed += 1; return null })
      const mode = sample?.observations?.find((entry: any) => String(entry.ref).endsWith('#mode'))
      return mode === undefined ? null : JSON.stringify(mode.value ?? mode.text ?? null)
    }
    const modeAtPower = await modeOf()
    const playSim = Date.parse((await api.presence(copy)).execution.currentSimulationTime)
    const known = new Set(((await api.objects(copy)).find(object => object.id === subject)?.alerts ?? []).map((alert: any) => alert.id))

    // Play, and watch the display and the plant side by side.
    await api.playRealtime(copy)
    let upsetMs: number | null = null, tripMs: number | null = null, modeMs: number | null = null
    let stopAt = Date.now() + 240_000
    let lastApi = 0
    const firstAfter: Record<string, boolean> = {}
    while (Date.now() < stopAt) {
      const state = await page.eval<DisplayState>(readDisplay())
      const simMs = simOf(state, day)
      polls.push({ wall: Date.now(), simMs, state })
      if (Date.now() - lastApi > 1_000) {
        lastApi = Date.now()
        const plant = (await api.objects(copy)).find(object => object.id === subject)
        const raised = (plant?.alerts ?? []).filter((alert: any) => !known.has(alert.id) && Date.parse(alert.raisedAt) >= playSim - 1_000)
        if (upsetMs === null && raised.length > 0) upsetMs = Math.min(...raised.map((alert: any) => Date.parse(alert.raisedAt)))
        const trips = raised.filter((alert: any) => alert.kind === 'trip')
        if (tripMs === null && trips.length > 0) tripMs = Math.min(...trips.map((alert: any) => Date.parse(alert.raisedAt)))
        if (modeMs === null && upsetMs !== null) {
          const mode = await modeOf()
          if (mode !== null && mode !== modeAtPower) modeMs = Date.parse((await api.presence(copy)).execution.currentSimulationTime)
        }
        if (upsetMs !== null && stopAt - Date.now() > config.afterS * 1_000 + 5_000) stopAt = Date.now() + config.afterS * 1_000
      }
      // Shots at the first sample after the upset, then 10 s and 60 s after it.
      if (upsetMs !== null && simMs !== null) {
        for (const [name, offset] of [['1-first-sample-after-upset', 0], ['2-upset+10s', 10_000], ['3-upset+60s', 60_000]] as const) {
          if (!firstAfter[name] && simMs >= upsetMs + offset) { firstAfter[name] = true; await page.shot(shots[name] = shot(name)) }
        }
      }
      await sleep(POLL_MS)
    }
    await page.shot(shots.end = shot('4-end'))
    const rods = await coreRods(page)
    // What the display should frame at the end: drawn elements with an active alert of caution or worse.
    const viewState = await shownViewState(page)
    const view = viewState === null || !vignette ? null : await api.view(copy, viewState)
    const plantAlerts: ReadonlyArray<any> = (await api.objects(copy)).find(object => object.id === subject)?.alerts ?? []
    await api.pause(copy)
    const after = fresh === null ? null : await api.defaultView(copy, subject)
    const postTripExpected = after === null ? null : leadLabels(after.view)
    const nodes = (view?.sections ?? []).filter((section: any) => section.kind === 'topology').flatMap((section: any) => section.nodes ?? [])
    const elementOfItem = new Map<string, string>(nodes.map((node: any) => [String(node.id), String(node.element ?? node.id)]))
    const drawnElements = new Set(nodes.map((node: any) => String(node.element ?? node.id)))
    // The plant's own active alerts of caution or worse on elements the drawing draws (from the Run, not the display).
    const alerted = new Set<string>(plantAlerts.filter(alert => alert.returned !== true && (PRIORITY_RANK[alert.priority ?? ''] ?? 0) >= 1)
      .map(alert => alert.subject?.element).filter((element: unknown): element is string => typeof element === 'string' && drawnElements.has(element)))
    const last = polls.at(-1)!.state
    const framedElements = new Set(last.framed.map(item => elementOfItem.get(item.item) ?? item.item))
    const unframed = [...alerted].filter(element => !framedElements.has(element))

    // ---- checks ----
    const afterUpset = polls.filter(poll => upsetMs !== null && poll.simMs !== null && poll.simMs >= upsetMs)
    const lagOf = (condition: (state: DisplayState) => boolean, from: number | null) => {
      if (from === null) return { lagS: null, kept: null }
      const later = polls.filter(poll => poll.simMs !== null && poll.simMs >= from)
      const first = later.find(poll => condition(poll.state))
      if (first === undefined) return { lagS: null, kept: null }
      const rest = later.filter(poll => poll.wall >= first.wall)
      return { lagS: (first.simMs! - from) / 1000, kept: rest.filter(poll => condition(poll.state)).length / rest.length }
    }
    const within = (lag: { lagS: number | null }) => lag.lagS !== null && lag.lagS <= ONE_SAMPLE_S
    /** Shown within one sample and kept: in at least 95 % of the reads after (an alert of a trip stands for minutes). */
    const held = (lag: { lagS: number | null; kept: number | null }) => within(lag) && lag.kept !== null && lag.kept >= 0.95
    const kept = (lag: { kept: number | null }) => lag.kept === null ? '-' : `${Math.round(lag.kept * 100)} %`
    const rowsLag = lagOf(state => (state.alerts?.rows.length ?? 0) > 0, upsetMs)
    const framesLag = lagOf(state => state.framed.length > 0 || state.framedSymbols > 0, upsetMs)
    const chipLag = lagOf(state => state.worst !== null, upsetMs)
    const leadsTarget = postTripExpected
    const leadsLag = leadsTarget === null ? null : lagOf(state => sameList(state.leads.map(lead => lead.label), leadsTarget), modeMs ?? upsetMs)
    // Without World's oracle (the pre-swap display): only whether, and when, the lead rows left the at-power set.
    const atPowerLabels = atPower.leads.map(lead => lead.label)
    const switchLag = lagOf(state => state.leads.length > 0 && !sameList(state.leads.map(lead => lead.label), atPowerLabels), upsetMs)
    const frozen = polls.filter(poll => poll.state.word === 'FROZEN')
    const statusPolls = (status: string) => polls.filter(poll => poll.state.values.some(value => value.status === status))
    const worstRead = (status: string) => statusPolls(status).sort((a, b) => b.state.values.filter(value => value.status === status).length - a.state.values.filter(value => value.status === status).length)[0]
    const listed = (status: string) => {
      const read = worstRead(status)
      return read === undefined ? '' : read.state.values.filter(value => value.status === status).slice(0, 8).map(value => `${value.where} "${value.label}" ${value.text} by ${value.by} ${value.px} px`).join('; ')
    }
    const frameText = (state: DisplayState) => (state.alerts?.rows ?? []).reduce((text, row) => text.replace(row, ' '), state.text)
    const checks: Check[] = [
      { id: 'alerts-rows', release: 'R1', pass: upsetMs === null ? null : held(rowsLag), detail: upsetMs === null ? 'no upset seen' : `first rows ${rowsLag.lagS === null ? 'never' : `${rowsLag.lagS} s`} after the upset, kept in ${kept(rowsLag)} of reads after; at the end ${last.alerts === null ? 'no alerts section' : `"${last.alerts.heading}", ${last.alerts.rows.length} rows${last.alerts.more ? `, ${last.alerts.more}` : ''}`}`, shot: shots['1-first-sample-after-upset'] },
      { id: 'frames', release: 'R1', pass: upsetMs === null ? null : held(framesLag) && unframed.length === 0, detail: `first frame ${framesLag.lagS === null ? 'never' : `${framesLag.lagS} s`} after the upset, kept in ${kept(framesLag)} of reads after; at the end ${last.framed.length} drawn items marked (${last.framedSymbols} symbols framed); ${alerted.size} drawn elements carry an active plant alert of caution or worse${nodes.length === 0 ? ' (no World topology to name the drawn elements: the pre-swap mimic)' : ''}${unframed.length === 0 ? '' : `, unframed: ${unframed.join(', ')}`}`, shot: shots['2-upset+10s'] },
      { id: 'worst-chip', release: 'R1', pass: upsetMs === null ? null : held(chipLag), detail: `worst chip ${chipLag.lagS === null ? 'never' : `${chipLag.lagS} s`} after the upset, kept in ${kept(chipLag)} of reads after; at the end "${last.worst ?? '-'}"`, shot: shots['1-first-sample-after-upset'] },
      {
        id: 'leads', release: 'R1',
        pass: leadsTarget === null || leadsLag === null ? (atPower.generation === 'old' && atPowerLabels.length > 0 ? switchLag.lagS !== null : null) : within(leadsLag) && !sameList(leadsTarget, atPowerExpected ?? []),
        detail: leadsTarget === null ? `${atPower.generation === 'old' ? 'the pre-swap display composes its own leads (no World oracle)' : 'World composes no default here'}; the lead rows left the at-power set ${switchLag.lagS === null ? 'never' : `${switchLag.lagS} s after the upset`}; at power: ${atPowerLabels.join(' | ') || '(none in the DOM at this size)'}; at the end: ${last.leads.map(lead => lead.label).join(' | ') || '(none in the DOM at this size)'}`
          : `mode changed ${modeMs === null || upsetMs === null ? '(not seen)' : `${(modeMs - upsetMs) / 1000} s after the upset`}; display leads match World's post-trip default ${leadsLag?.lagS === null ? 'never' : `${leadsLag!.lagS} s after`}; at power: ${atPower.leads.map(lead => lead.label).join(' | ')}; World now: ${leadsTarget.join(' | ')}; display at the end: ${last.leads.map(lead => lead.label).join(' | ')}`,
        shot: shots['2-upset+10s'],
      },
      {
        id: 'no-clipped', release: 'R1', pass: statusPolls('clipped').length === 0 && statusPolls('scrolled-x').length === 0,
        detail: `${statusPolls('clipped').length} of ${polls.length} reads had values clipped${statusPolls('clipped').length === 0 ? '' : ` (the worst: ${listed('clipped')})`}; ${statusPolls('scrolled-x').length} had values hidden sideways in a scrolling box${statusPolls('scrolled-x').length === 0 ? '' : ` (the worst: ${listed('scrolled-x')})`}`,
        shot: shots.end,
      },
      { id: 'no-overrun', release: 'R1', pass: statusPolls('overrun').length === 0, detail: statusPolls('overrun').length === 0 ? `no drawn value past its room in ${polls.length} reads` : `${statusPolls('overrun').length} of ${polls.length} reads had drawn values past the room their drawing reserved; the worst: ${listed('overrun')}`, shot: shots.end },
      { id: 'no-frozen', release: 'R1', pass: frozen.length === 0, detail: frozen.length === 0 ? `never FROZEN in ${polls.length} reads` : `FROZEN in ${frozen.length} of ${polls.length} reads`, shot: shots.end },
      { id: 'trip-line', release: 'R2', pass: afterUpset.length === 0 ? null : /\bTRIP\b/.test(frameText(last)), detail: `frame text outside the alerts list ${/\bTRIP\b/.test(frameText(last)) ? 'says TRIP' : 'does not say TRIP'}`, shot: shots.end },
      { id: 'rods-on-bottom', release: 'R2', pass: afterUpset.length === 0 ? null : /Rods on bottom/i.test(last.text), detail: /Rods on bottom/i.test(last.text) ? 'written' : 'not written', shot: shots.end },
      { id: 'rods-in', release: 'R2', pass: rods === null ? null : rods.bars > 0 && rods.withdrawnBars === 0 && rods.unknownBars === 0 && rods.insertedShares.every(share => share >= 0.95), detail: rods === null ? 'no core vessel drawn' : `${rods.bars} rods, inserted shares ${rods.insertedShares.join(', ')}, ${rods.withdrawnBars} drawn withdrawn, ${rods.unknownBars} unknown`, shot: shots.end },
      { id: 'expected', release: 'R2', pass: afterUpset.length === 0 ? null : /expected/i.test((last.alerts?.rows ?? []).join(' ') + (last.alerts?.heading ?? '')), detail: `alerts list ${/expected/i.test((last.alerts?.rows ?? []).join(' ')) ? 'has' : 'has no'} expected aggregate`, shot: shots.end },
    ]
    return {
      size, copy, displayWidth: atPower.frame?.width ?? null, generation: atPower.generation,
      events: { playSim: new Date(playSim).toISOString(), upset: upsetMs === null ? null : new Date(upsetMs).toISOString(), trip: tripMs === null ? null : new Date(tripMs).toISOString(), modeChange: modeMs === null ? null : new Date(modeMs).toISOString(), modeAtPower, modeReadsFailed },
      atPower: { worst: atPower.worst, leads: atPower.leads, alerts: atPower.alerts, word: atPower.word, badValues: badValues(atPower) },
      end: { worst: last.worst, leads: last.leads, alerts: last.alerts, framed: last.framed, framedSymbols: last.framedSymbols, word: last.word, sim: last.sim, badValues: badValues(last), scrolled: last.values.filter(value => value.status.startsWith('scrolled')).length },
      checks,
      timeline: polls.map(poll => ({ wall: poll.wall, sim: poll.state.sim, word: poll.state.word, worst: poll.state.worst, rows: poll.state.alerts?.rows.length ?? null, framed: poll.state.framed.length, leads: poll.state.leads.map(lead => lead.label).join(' | '), bad: badValues(poll.state).length })),
      shots,
      console: page.console.slice(-20),
    }
  } catch (error) {
    await page.shot(shot('failed'))
    throw error
  } finally {
    await api.pause(copy).catch(() => undefined)
    await page.close()
  }
}

if (import.meta.main) {
  const argv = options(Bun.argv.slice(2))
  const origin = loopbackOrigin(argv.get('origin'))
  const workspaceId = argv.get('workspace'), from = argv.get('from'), out = argv.get('out')
  if (workspaceId === undefined || from === undefined || out === undefined) throw new Error('usage: live-trip.ts --origin=… --workspace=<id> --from=<paused Run at power> --out=<dir> (see the header)')
  const label = argv.get('label') ?? new URL(origin).port
  const port = Number(argv.get('port') ?? 44332)
  const chrome = await ensureChrome({ port, profile: join(out, `chrome-${port}`) })
  const api = createStackApi(origin, workspaceId)
  const results: Array<Record<string, unknown>> = []
  try {
    for (const size of (argv.get('sizes') ?? '1920,1046').split(',').map(Number)) {
      const result = await runSize({ api, origin, workspaceId, from, port, size, out, label, unit: argv.get('unit') ?? 'Halden Unit 1', subject: argv.get('subject') ?? 'plant:halden-1', afterS: Number(argv.get('after') ?? 90) })
      results.push(result)
      await Bun.write(join(out, `${label}-live-trip.json`), JSON.stringify({ label, origin, from, results }, null, 2))
      for (const check of result.checks as Check[]) console.log(`${label} ${size} ${check.release} ${check.id.padEnd(15)} ${check.pass === null ? 'n/a ' : check.pass ? 'PASS' : 'FAIL'}  ${check.detail.slice(0, 220)}`)
    }
  } finally {
    if (chrome.started) await chrome.stop()
  }
}
