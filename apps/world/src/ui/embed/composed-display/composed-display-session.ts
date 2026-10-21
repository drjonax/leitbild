import type { SimulationRunId } from '../../../core/model/index.ts'
import type { CompiledComposedPanel, ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
import type { ComposedDisplayClient, ComposedDisplaySample, ComposedDisplayViewResult, ViewSize } from './composed-display-client.ts'
import { appendPoint, COMPARISON_HISTORY_MS, gatePaths, HOLD_GAP_MS, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'
import { LEAD_VALUE_SPARKLINE_MS } from '../../../packs/process-plant/displays/composition.ts'
import type { ValueDomain } from './trend-geometry.ts'

export type ComposedDisplayPhase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'live' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'failed'; readonly message: string }

export interface ComposedDisplaySnapshot {
  readonly phase: ComposedDisplayPhase
  readonly view?: ComposedDisplayViewResult
  readonly series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
  /** Signals without recorded history in the window; their trend starts when the view opened. */
  readonly historyMissing: ReadonlySet<string>
  /** Lead values whose history could not be read, and why; their sparkline starts when the view opened. */
  readonly historyErrors: ReadonlyMap<string, string>
  /**
   * Value range seen per panel scale (one per trend strip, one for a
   * comparison) since the view opened; it only grows, so scales never jump inward.
   */
  readonly ranges: ReadonlyArray<ReadonlyArray<ValueDomain | null>>
  readonly latest?: ComposedDisplaySample
  readonly playback?: 'playing' | 'paused'
  readonly runTitle?: string
  readonly lastSampleWallMs?: number
  /** Message of the last failed sample; null once a sample succeeds again. */
  readonly sampleError: string | null
  /** The Run's time moved backwards after the advice (reset); the advice may no longer apply. */
  readonly resetSinceAdvice: boolean
}

// Live samples match the operations recording interval. One request is in
// flight at a time: the next is asked for once the last is answered. A quick
// answer keeps the 1 Hz rhythm; while answers take longer than a second, or
// fail, the next request waits longer after each answer (2 s, then 3 s), so a
// congested World is not asked again before it has answered.
export const SAMPLE_INTERVAL_MS = 1_000
export const SAMPLE_BACKOFF_MS: ReadonlyArray<number> = [SAMPLE_INTERVAL_MS, 2_000, 3_000]
/**
 * A display whose last sample is older than this, or failed, is stale: its
 * drawing shows no values and its controls are disabled. The longest wait
 * between samples leaves an answer 2 s before it, so a World that answers
 * slowly reads as live and only one that stops answering reads as stale.
 */
export const STALE_AFTER_MS = 5_000
/** Samples further apart than this in wall time mean the display missed some; it reads the Run's history for them. */
export const MISSED_SAMPLES_MS = 5 * SAMPLE_INTERVAL_MS
// Presence is cheap and never loads a Run, but is only needed to notice pause and removal, so it runs less often.
const PRESENCE_EVERY_SAMPLES = 5
/**
 * A Run that is not loaded is asked about again after these waits, the last
 * one repeating: the display resumes by itself once someone loads the Run,
 * and never loads it itself (presence holds no lease).
 */
export const PRESENCE_RETRY_MS: ReadonlyArray<number> = [1_000, 2_000, 5_000, 10_000]
// After this long without interaction the view stops polling, so a forgotten
// open chat cannot keep a Run simulating indefinitely.
export const IDLE_SUSPEND_MS = 15 * 60_000
// Alarm state marks values in alarm on every panel, not only the alarms strip.
const WITH_ALARMS = true

/** Whether a live display's values are too old to show, at wall time `wallNowMs`. */
export const sampleStale = (snapshot: ComposedDisplaySnapshot, wallNowMs: number): boolean => snapshot.phase.kind === 'live'
  && (snapshot.sampleError !== null || (snapshot.lastSampleWallMs !== undefined && wallNowMs - snapshot.lastSampleWallMs > STALE_AFTER_MS))

/** Runs `run` after `delayMs` on the session's clock and returns its cancel; a test passes a fake clock. */
export type ScheduleTimer = (run: () => void, delayMs: number) => () => void

const realTimer: ScheduleTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

/** A signal whose history a display keeps: from its window's start until now. */
interface HistoryPen {
  readonly path: string
  readonly seriesId: string
  readonly horizonMs: number
}

type History = Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The Plant's declared operating mode in a sample: its id, null where none holds, undefined where the Plant declares none. */
const modeOf = (sample: ComposedDisplaySample | undefined): string | null | undefined =>
  sample?.mode === undefined ? undefined : sample.mode?.id ?? null

const pensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'alarms' || panel.kind === 'mimic') return []
  return panel.kind === 'trend' ? [...panel.strips.flatMap(strip => strip.pens), ...panel.live] : panel.pens
}

/** Pens drawn over time: trend strips (not their live-only rows) and comparisons, which show rates. */
const plottedPensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'trend') return panel.strips.flatMap(strip => strip.pens)
  return panel.kind === 'comparison' ? panel.pens : []
}

/** Trends keep their horizon; comparisons keep ten minutes for rates. Advice readouts use only the latest sample. */
const trendPens = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<HistoryPen> =>
  shown.flatMap(panel => plottedPensOf(panel).map(pen => ({
    path: String(pen.path),
    seriesId: pen.seriesId,
    horizonMs: panel.kind === 'trend' ? panel.horizonMs : COMPARISON_HISTORY_MS,
  })))

/**
 * A generated display's lead values, the values a faceplate's rows show and
 * the readings its drawing's vessels trace keep their sparklines' window:
 * the recorded numeric ones.
 */
const sparklinePens = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<HistoryPen> => shown.flatMap(panel => {
  if (panel.kind === 'mimic') {
    const trends = panel.trends
    return trends === undefined ? [] : trends.pens.filter(pen => pen.recorded && pen.valueKind === 'number').map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs: trends.windowMs }))
  }
  if (panel.kind === 'faceplate') {
    const rows = new Set(panel.faceplate.columns.flatMap(column => column.rows.flatMap(row => row.kind === 'values' ? row.paths : [])))
    return panel.pens.filter(pen => rows.has(String(pen.path)) && pen.recorded && pen.valueKind === 'number').map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs: LEAD_VALUE_SPARKLINE_MS }))
  }
  if (panel.kind !== 'readouts' || panel.sparklineMs === undefined) return []
  const horizonMs = panel.sparklineMs
  return panel.pens.filter(pen => pen.recorded && pen.valueKind === 'number').map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs }))
})

/** Every signal whose history a display keeps. */
const historyPaths = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlySet<string> =>
  new Set([...trendPens(shown), ...sparklinePens(shown)].map(pen => pen.path))

export const createComposedDisplaySession = (config: {
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly state: string
  readonly client: ComposedDisplayClient
  readonly onChange: (snapshot: ComposedDisplaySnapshot) => void
  /** Advice stops updating after a quarter of an hour unattended; an operating overview keeps updating. */
  readonly suspendWhenIdle: boolean
  /** The view's current size, which a generated display is drawn for; null for advice. */
  readonly size: () => ViewSize | null
  /**
   * Where the display is operated (in the process display window): the paths
   * its controls write and read besides what it draws. Null where it is not.
   */
  readonly operated?: () => ReadonlyArray<string> | null
  readonly wallNow?: () => number
  readonly schedule?: ScheduleTimer
}) => {
  const wallNow = config.wallNow ?? (() => Date.now())
  const schedule = config.schedule ?? realTimer
  let closed = false
  let cancelTimer: (() => void) | null = null
  // The one sample request in flight, which a second poll joins rather than repeats.
  let inFlight: Promise<void> | null = null
  // Polling runs once the session started with it, only while the frame is shown.
  let polling = false
  let visible = true
  let polls = 0
  let backoff = 0
  let presenceRetry = 0
  // Presence is read before the next sample where the Run may have unloaded meanwhile (shown again, resumed).
  let presenceDue = false
  let lastInteractionWallMs = wallNow()
  let lastElapsedMs: number | undefined
  // The operating mode a generated display was drawn in: its lead values follow the mode, so a new mode draws it again.
  let drawnMode: string | null | undefined
  let redrawing: Promise<void> | null = null
  let snapshot: ComposedDisplaySnapshot = { phase: { kind: 'checking' }, series: new Map(), historyMissing: new Set(), historyErrors: new Map(), ranges: [], sampleError: null, resetSinceAdvice: false }
  // What the view shows: the state it was embedded with, or equipment opened from a generated display.
  let state = config.state

  const update = (patch: Partial<ComposedDisplaySnapshot>): void => {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    config.onChange(snapshot)
  }

  const fail = (error: unknown): void => update({ phase: { kind: 'failed', message: messageOf(error) } })

  const stopTimer = (): void => {
    cancelTimer?.()
    cancelTimer = null
  }

  const panels = () => snapshot.view?.display.panels ?? []
  const generated = (): boolean => snapshot.view?.kind === 'overview' || snapshot.view?.kind === 'detail'

  /**
   * Every displayed signal is sampled once, however many panels show it, with
   * the instrument that reads it over a wider span (its legend reads that one
   * off its span) and the values its drawn gated limits require, so a limit
   * whose gates do not hold is drawn idle as World reads it (gatesHold); and
   * everything a faceplate's live rows read (faceplate-live.ts).
   */
  const sampledPaths = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => [...new Set([...(config.operated?.() ?? []), ...shown.flatMap(panel => panel.kind === 'mimic'
    ? panel.mimic.paths.map(String)
    : [
      ...pensOf(panel).flatMap(pen => [String(pen.path), ...(pen.wider === undefined ? [] : [String(pen.wider.path)]), ...(pen.validWhile === undefined ? [] : [String(pen.validWhile)]), ...pen.thresholds.flatMap(threshold => (threshold.gates ?? []).flatMap(gatePaths))]),
      ...(panel.kind === 'faceplate' ? panel.faceplate.paths : []),
    ])])]
  // A display that draws equipment, or is operated, reads what people and AI agents did on its paths with every sample: a
  // drawing judges a command they issued "not followed" only after its travel time (evaluate.ts, QA-6).
  const sampleFor = (shown: ReadonlyArray<CompiledComposedPanel>): Promise<ComposedDisplaySample> => config.client.sample(config.runId, config.plantId, sampledPaths(shown), WITH_ALARMS,
    shown.some(panel => panel.kind === 'mimic') || (config.operated?.() ?? null) !== null)

  /**
   * The history behind what a display draws over time, read once when it
   * opens; live samples extend it. A trend is its history, so a trend whose
   * history cannot be read fails the display. A sparkline only adds direction
   * to a lead value, so one that cannot be read is said on its row and starts
   * with the live samples. Sparklines read from one hold gap before their
   * window, so the value held at the window's start is known. `wanted`
   * narrows the reading to signals the display does not keep yet.
   */
  const backfill = async (shown: ReadonlyArray<CompiledComposedPanel>, now: number, wanted: (path: string) => boolean = () => true): Promise<History> => {
    const series = new Map<string, ReadonlyArray<TrendPoint>>()
    const historyMissing = new Set<string>()
    const historyErrors = new Map<string, string>()
    const read = async (pen: HistoryPen, from: number): Promise<void> => {
      const points = await config.client.history(config.runId, pen.seriesId, { from, to: now })
      if (points.length === 0) historyMissing.add(pen.path)
      series.set(pen.path, points)
    }
    await Promise.all([
      ...trendPens(shown).filter(pen => wanted(pen.path)).map(pen => read(pen, now - pen.horizonMs)),
      ...sparklinePens(shown).filter(pen => wanted(pen.path)).map(async pen => {
        try {
          await read(pen, now - pen.horizonMs - HOLD_GAP_MS)
        } catch (error) {
          historyErrors.set(pen.path, messageOf(error))
        }
      }),
    ])
    return { series, historyMissing, historyErrors }
  }

  /** Values on each scale of a panel: trends their history per strip, comparisons the latest sample. */
  const scaleValues = (
    panel: CompiledComposedPanel,
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>,
    latest: ComposedDisplaySample | undefined,
  ): ReadonlyArray<ReadonlyArray<number>> => {
    if (panel.kind === 'trend') return panel.strips.map(strip => strip.pens.flatMap(pen => (series.get(String(pen.path)) ?? []).map(point => point.v)))
    if (panel.kind !== 'comparison') return []
    const paths = new Set(panel.pens.map(pen => String(pen.path)))
    return [(latest?.values ?? []).flatMap(entry => paths.has(entry.path) && typeof entry.value === 'number' ? [entry.value] : [])]
  }

  const grownRanges = (
    shown: ReadonlyArray<CompiledComposedPanel>,
    previousRanges: ComposedDisplaySnapshot['ranges'],
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>,
    latest: ComposedDisplaySample | undefined,
  ): ReadonlyArray<ReadonlyArray<ValueDomain | null>> => shown.map((panel, index) =>
    scaleValues(panel, series, latest).map((values, scale) => {
      const previous = previousRanges[index]?.[scale] ?? null
      if (values.length === 0) return previous
      return {
        min: Math.min(...values, ...(previous === null ? [] : [previous.min])),
        max: Math.max(...values, ...(previous === null ? [] : [previous.max])),
      }
    }))

  /**
   * A reset is the Run's own clock going backwards: the Plant's elapsed time
   * falls. Samples arrive one at a time, so their order is the Run's order.
   */
  const resetBy = (sample: ComposedDisplaySample): boolean => {
    const reset = lastElapsedMs !== undefined && sample.plantElapsedMs < lastElapsedMs
    lastElapsedMs = sample.plantElapsedMs
    return reset
  }

  /**
   * Draws a generated display again for the view's size and the Plant's mode
   * now; the history it already keeps carries on, and signals it newly shows
   * (a lead value the new mode puts first) read theirs before it is shown.
   */
  const redraw = (): Promise<void> => {
    if (redrawing !== null) return redrawing
    const drawn = state
    const work = (async (): Promise<void> => {
      try {
        const view = await config.client.view(config.runId, config.plantId, drawn, config.size())
        if (closed || drawn !== state) return
        const mode = modeOf(snapshot.latest)
        const kept = snapshot.series
        const fresh = await backfill(view.display.panels, Date.parse(view.simulationTime), path => !kept.has(path))
        if (closed || drawn !== state) return
        const shown = historyPaths(view.display.panels)
        const series = new Map([...snapshot.series].filter(([path]) => shown.has(path)))
        for (const [path, points] of fresh.series) series.set(path, points)
        const historyMissing = new Set([...snapshot.historyMissing].filter(path => shown.has(path) && !fresh.series.has(path)))
        for (const path of fresh.historyMissing) historyMissing.add(path)
        const historyErrors = new Map([...snapshot.historyErrors].filter(([path]) => shown.has(path) && !fresh.series.has(path)))
        for (const [path, error] of fresh.historyErrors) historyErrors.set(path, error)
        drawnMode = mode
        update({ view, series, historyMissing, historyErrors, ranges: grownRanges(view.display.panels, [], series, snapshot.latest) })
      } catch (error) {
        update({ sampleError: messageOf(error) })
      }
    })()
    redrawing = work.finally(() => { redrawing = null })
    return redrawing
  }

  const applySample = (sample: ComposedDisplaySample): void => {
    const at = Date.parse(sample.simulationTime)
    const reset = resetBy(sample)
    const series = new Map(reset ? [] : snapshot.series)
    for (const pen of [...trendPens(panels()), ...sparklinePens(panels())]) {
      const value = sample.values.find(entry => entry.path === pen.path)?.value
      if (typeof value !== 'number') continue
      series.set(pen.path, appendPoint(series.get(pen.path) ?? [], { t: at, v: value }, at - pen.horizonMs))
    }
    update({ series, ranges: grownRanges(panels(), snapshot.ranges, series, sample), latest: sample, lastSampleWallMs: wallNow(), sampleError: null, resetSinceAdvice: snapshot.resetSinceAdvice || reset })
    // A generated display's lead values follow the Plant's mode (a trip puts the post-trip values first).
    const mode = modeOf(sample)
    if (!generated()) return
    if (drawnMode === undefined) drawnMode = mode
    else if (mode !== drawnMode) void redraw()
  }

  const scheduleNext = (delayMs: number): void => {
    stopTimer()
    if (closed || !polling || !visible) return
    cancelTimer = schedule(() => {
      cancelTimer = null
      if (snapshot.phase.kind === 'inactive') void watchPresence()
      else void poll()
    }, delayMs)
  }

  const watchAgain = (): void => {
    presenceRetry = Math.min(presenceRetry + 1, PRESENCE_RETRY_MS.length - 1)
    scheduleNext(PRESENCE_RETRY_MS[presenceRetry]!)
  }

  /** Reads presence: whether the Run exists and is loaded. A Run that is not loaded is watched until it is. */
  const checkPresence = async (): Promise<boolean> => {
    const presence = await config.client.presence(config.runId)
    if (closed) return false
    if (presence === null) { stopTimer(); update({ phase: { kind: 'missing' } }); return false }
    if (!presence.loaded) {
      update({ phase: { kind: 'inactive' } })
      presenceRetry = 0
      scheduleNext(PRESENCE_RETRY_MS[0]!)
      return false
    }
    update({ playback: presence.playback, runTitle: presence.title })
    return true
  }

  const begin = async (): Promise<void> => {
    update({ phase: { kind: 'starting' } })
    const view = await config.client.view(config.runId, config.plantId, state, config.size())
    update({ view })
    const history = await backfill(view.display.panels, Date.parse(view.simulationTime))
    // The first sample fills readouts, comparisons and alarms before polling starts.
    const first = await sampleFor(view.display.panels)
    const reset = resetBy(first)
    drawnMode = modeOf(first)
    update({
      ...history,
      latest: first,
      lastSampleWallMs: wallNow(),
      ranges: grownRanges(view.display.panels, [], history.series, first),
      resetSinceAdvice: snapshot.resetSinceAdvice || reset,
      phase: { kind: 'live' },
    })
  }

  /** While the Run is not loaded: asks again with backoff, and draws the display afresh once someone loads it. */
  const watchPresence = async (): Promise<void> => {
    if (closed || snapshot.phase.kind !== 'inactive') return
    try {
      const presence = await config.client.presence(config.runId)
      if (closed || snapshot.phase.kind !== 'inactive') return
      if (presence === null) { stopTimer(); update({ phase: { kind: 'missing' } }); return }
      if (!presence.loaded) { watchAgain(); return }
      update({ playback: presence.playback, runTitle: presence.title })
    } catch {
      // Presence could not be read this time; the Run stays shown as not active and is asked about again.
      watchAgain()
      return
    }
    try {
      await begin()
      backoff = 0
      scheduleNext(SAMPLE_INTERVAL_MS)
    } catch (error) { fail(error) }
  }

  // A sample this late after the last one means the display missed some: wider at a slower rhythm, so a congested
  // World is not also asked for history on every answer.
  const missedAfterMs = (): number => Math.max(MISSED_SAMPLES_MS, 3 * SAMPLE_BACKOFF_MS[backoff]!)

  const pollOnce = async (): Promise<void> => {
    if (closed || snapshot.phase.kind !== 'live') return
    if (config.suspendWhenIdle && wallNow() - lastInteractionWallMs > IDLE_SUSPEND_MS) { stopTimer(); update({ phase: { kind: 'suspended' } }); return }
    polls += 1
    const startedAt = wallNow()
    let failed = false
    try {
      if (polls % PRESENCE_EVERY_SAMPLES === 0 || presenceDue) {
        presenceDue = false
        if (!await checkPresence()) return
      }
      const sampled = await sampleFor(panels())
      if (closed) return
      // A display that missed samples (hidden, suspended or slow to answer)
      // reads what the Run recorded meanwhile, so no line is drawn flat
      // across the gap as if the value had held.
      if (snapshot.lastSampleWallMs !== undefined && wallNow() - snapshot.lastSampleWallMs > missedAfterMs()) {
        update(await backfill(panels(), Date.parse(sampled.simulationTime)))
      }
      applySample(sampled)
    } catch (error) {
      failed = true
      // Keep the last values on screen; the stale marker and this message say they are old.
      update({ sampleError: messageOf(error) })
    }
    if (snapshot.phase.kind !== 'live') return
    const latency = wallNow() - startedAt
    backoff = failed || latency > SAMPLE_INTERVAL_MS ? Math.min(backoff + 1, SAMPLE_BACKOFF_MS.length - 1) : 0
    scheduleNext(backoff === 0 ? Math.max(0, SAMPLE_INTERVAL_MS - latency) : SAMPLE_BACKOFF_MS[backoff]!)
  }

  /** One sample, unless one is in flight: then it joins that one. */
  const poll = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    const work = pollOnce().finally(() => { inFlight = null })
    inFlight = work
    return work
  }

  // A generated display is drawn for its view, so a view with no size yet (a
  // hidden or collapsed frame) waits until it has one rather than asking for a
  // drawing of nothing.
  const drawable = (): boolean => {
    const size = config.size()
    return size === null || (size.width >= 1 && size.height >= 1)
  }
  let awaitingSize: { readonly poll?: boolean } | null = null

  /** Checks presence first and never loads an inactive Run on its own; with polling, an inactive Run is watched until it loads. */
  const start = async (options: { readonly poll?: boolean } = {}): Promise<void> => {
    if (!drawable()) { awaitingSize = options; return }
    polling = options.poll !== false
    try {
      if (!await checkPresence()) return
      await begin()
      scheduleNext(SAMPLE_INTERVAL_MS)
    } catch (error) { fail(error) }
  }

  return {
    start,
    loadRun: async (options: { readonly poll?: boolean } = {}): Promise<void> => {
      polling = options.poll !== false
      stopTimer()
      try {
        update({ phase: { kind: 'starting' } })
        await config.client.loadRun(config.runId)
        await begin()
        scheduleNext(SAMPLE_INTERVAL_MS)
      } catch (error) { fail(error) }
    },
    resume: (): void => {
      lastInteractionWallMs = wallNow()
      if (snapshot.phase.kind !== 'suspended') return
      update({ phase: { kind: 'live' } })
      // The Run may have unloaded while nobody watched it: presence first, so the display never loads it.
      presenceDue = true
      if (polling && visible) void poll()
    },
    interacted: (): void => { lastInteractionWallMs = wallNow() },
    /**
     * Draws a display that waited for its view to have a size, once it has
     * one. A page that is not rendered gets no resize events, so the view
     * also asks on its clock.
     */
    sized: async (): Promise<void> => {
      if (closed || awaitingSize === null || !drawable()) return
      const options = awaitingSize
      awaitingSize = null
      await start(options)
    },
    /** A generated display is drawn again for the view's new size, or first drawn once the view has one; its samples carry on. */
    relayout: async (): Promise<void> => {
      if (closed || !drawable()) return
      if (awaitingSize !== null) {
        const options = awaitingSize
        awaitingSize = null
        await start(options)
        return
      }
      if (!generated()) return
      await redraw()
    },
    /**
     * Shows another generated display of the same Plant in place (equipment
     * opened from an overview, or back). Its lead values' history and its
     * first sample are read before it is shown, so it never shows the previous
     * display's values, or none, as if they were stale. A display that cannot
     * be drawn leaves the current one and rejects.
     */
    open: async (next: string): Promise<void> => {
      if (closed) return
      const view = await config.client.view(config.runId, config.plantId, next, config.size())
      if (closed) return
      const history = await backfill(view.display.panels, Date.parse(view.simulationTime))
      if (closed) return
      const live = snapshot.phase.kind === 'live'
      let first: ComposedDisplaySample | undefined
      if (live) {
        stopTimer()
        if (inFlight !== null) await inFlight
        const work = sampleFor(view.display.panels)
        inFlight = work.then(() => {}, () => {}).finally(() => { inFlight = null })
        try {
          first = await work
        } catch (error) {
          // The current display stays shown, and live.
          scheduleNext(SAMPLE_INTERVAL_MS)
          throw error
        }
        if (closed) return
      }
      state = next
      if (first === undefined) {
        update({ view, ...history, ranges: [] })
        return
      }
      const reset = resetBy(first)
      drawnMode = modeOf(first)
      update({ view, ...history, latest: first, lastSampleWallMs: wallNow(), sampleError: null, ranges: grownRanges(view.display.panels, [], history.series, first), resetSinceAdvice: snapshot.resetSinceAdvice || reset })
      backoff = 0
      scheduleNext(SAMPLE_INTERVAL_MS)
    },
    poll,
    /**
     * Polls only while the frame is on screen. Hidden, it asks the Run
     * nothing, so it holds no lease on it; shown again, it reads presence
     * first, samples at once and fills what it missed from the Run's history.
     */
    setVisible: (shown: boolean): void => {
      if (shown === visible) return
      visible = shown
      if (!shown) { stopTimer(); return }
      if (!polling || closed) return
      if (snapshot.phase.kind === 'live') { presenceDue = true; void poll() }
      else if (snapshot.phase.kind === 'inactive') void watchPresence()
    },
    close: (): void => { closed = true; stopTimer() },
  }
}
