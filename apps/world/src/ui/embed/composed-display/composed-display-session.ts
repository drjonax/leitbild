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

// Live polling matches the operations recording interval. Presence is cheap
// but only needed to notice pause and removal, so it runs less often.
export const SAMPLE_INTERVAL_MS = 1_000
/** Samples further apart than this in wall time mean the display missed some; it reads the Run's history for them. */
export const MISSED_SAMPLES_MS = 5 * SAMPLE_INTERVAL_MS
const PRESENCE_EVERY_SAMPLES = 5
// After this long without interaction the view stops polling, so a forgotten
// open chat cannot keep a Run simulating indefinitely.
export const IDLE_SUSPEND_MS = 15 * 60_000
// Alarm state marks values in alarm on every panel, not only the alarms strip.
const WITH_ALARMS = true

/** A signal whose history a display keeps: from its window's start until now. */
interface HistoryPen {
  readonly path: string
  readonly seriesId: string
  readonly horizonMs: number
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const pensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'alarms' || panel.kind === 'mimic') return []
  return panel.kind === 'trend' ? [...panel.strips.flatMap(strip => strip.pens), ...panel.live] : panel.pens
}

/** Pens drawn over time: trend strips (not their live-only rows) and comparisons, which show rates. */
const plottedPensOf = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'trend') return panel.strips.flatMap(strip => strip.pens)
  return panel.kind === 'comparison' ? panel.pens : []
}

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
}) => {
  const wallNow = config.wallNow ?? (() => Date.now())
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let polls = 0
  let lastInteractionWallMs = wallNow()
  let lastSimulationMs: number | undefined
  let snapshot: ComposedDisplaySnapshot = { phase: { kind: 'checking' }, series: new Map(), historyMissing: new Set(), historyErrors: new Map(), ranges: [], sampleError: null, resetSinceAdvice: false }
  // What the view shows: the state it was embedded with, or equipment opened from a generated display.
  let state = config.state

  const update = (patch: Partial<ComposedDisplaySnapshot>): void => {
    if (closed) return
    snapshot = { ...snapshot, ...patch }
    config.onChange(snapshot)
  }

  const fail = (error: unknown): void => update({ phase: { kind: 'failed', message: messageOf(error) } })

  const stopPolling = (): void => { clearInterval(timer); timer = undefined }

  const panels = () => snapshot.view?.display.panels ?? []

  /**
   * Every displayed signal is sampled once, however many panels show it, with
   * the instrument that reads it over a wider span (its legend reads that one
   * off its span) and the values its drawn gated limits require, so a limit
   * whose gates do not hold is drawn idle as World reads it (gatesHold); and
   * everything a faceplate's live rows read (faceplate-live.ts).
   */
  const sampledPaths = (): ReadonlyArray<string> => [...new Set([...(config.operated?.() ?? []), ...panels().flatMap(panel => panel.kind === 'mimic'
    ? panel.mimic.paths.map(String)
    : [
      ...pensOf(panel).flatMap(pen => [String(pen.path), ...(pen.wider === undefined ? [] : [String(pen.wider.path)]), ...(pen.validWhile === undefined ? [] : [String(pen.validWhile)]), ...pen.thresholds.flatMap(threshold => (threshold.gates ?? []).flatMap(gatePaths))]),
      ...(panel.kind === 'faceplate' ? panel.faceplate.paths : []),
    ])])]
  // A display that draws equipment, or is operated, reads what people and AI agents did on its paths with every sample: a
  // drawing judges a command they issued "not followed" only after its travel time (evaluate.ts, QA-6).
  const sample = (): Promise<ComposedDisplaySample> => config.client.sample(config.runId, config.plantId, sampledPaths(), WITH_ALARMS,
    panels().some(panel => panel.kind === 'mimic') || (config.operated?.() ?? null) !== null)

  /** Trends keep their horizon; comparisons keep ten minutes for rates. Advice readouts use only the latest sample. */
  const trendPens = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<HistoryPen> =>
    shown.flatMap(panel => plottedPensOf(panel).map(pen => ({
      path: String(pen.path),
      seriesId: pen.seriesId,
      horizonMs: panel.kind === 'trend' ? panel.horizonMs : COMPARISON_HISTORY_MS,
    })))

  /** A generated display's lead values, and the values a faceplate's rows show, keep their sparklines' window: the recorded numeric ones. */
  const sparklinePens = (shown: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<HistoryPen> => shown.flatMap(panel => {
    if (panel.kind === 'faceplate') {
      const rows = new Set(panel.faceplate.columns.flatMap(column => column.rows.flatMap(row => row.kind === 'values' ? row.paths : [])))
      return panel.pens.filter(pen => rows.has(String(pen.path)) && pen.recorded && pen.valueKind === 'number').map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs: LEAD_VALUE_SPARKLINE_MS }))
    }
    if (panel.kind !== 'readouts' || panel.sparklineMs === undefined) return []
    const horizonMs = panel.sparklineMs
    return panel.pens.filter(pen => pen.recorded && pen.valueKind === 'number').map(pen => ({ path: String(pen.path), seriesId: pen.seriesId, horizonMs }))
  })

  /**
   * The history behind what a display draws over time, read once when it
   * opens; live samples extend it. A trend is its history, so a trend whose
   * history cannot be read fails the display. A sparkline only adds direction
   * to a lead value, so one that cannot be read is said on its row and starts
   * with the live samples. Sparklines read from one hold gap before their
   * window, so the value held at the window's start is known.
   */
  const backfill = async (shown: ReadonlyArray<CompiledComposedPanel>, now: number): Promise<Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>> => {
    const series = new Map<string, ReadonlyArray<TrendPoint>>()
    const historyMissing = new Set<string>()
    const historyErrors = new Map<string, string>()
    const read = async (pen: HistoryPen, from: number): Promise<void> => {
      const points = await config.client.history(config.runId, pen.seriesId, { from, to: now })
      if (points.length === 0) historyMissing.add(pen.path)
      series.set(pen.path, points)
    }
    await Promise.all([
      ...trendPens(shown).map(pen => read(pen, now - pen.horizonMs)),
      ...sparklinePens(shown).map(async pen => {
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
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>,
    latest: ComposedDisplaySample | undefined,
  ): ReadonlyArray<ReadonlyArray<ValueDomain | null>> => panels().map((panel, index) =>
    scaleValues(panel, series, latest).map((values, scale) => {
      const previous = snapshot.ranges[index]?.[scale] ?? null
      if (values.length === 0) return previous
      return {
        min: Math.min(...values, ...(previous === null ? [] : [previous.min])),
        max: Math.max(...values, ...(previous === null ? [] : [previous.max])),
      }
    }))

  const applySample = (sample: ComposedDisplaySample): void => {
    const at = Date.parse(sample.simulationTime)
    const reset = lastSimulationMs !== undefined && at < lastSimulationMs
    lastSimulationMs = at
    const series = new Map(reset ? [] : snapshot.series)
    for (const pen of [...trendPens(panels()), ...sparklinePens(panels())]) {
      const value = sample.values.find(entry => entry.path === pen.path)?.value
      if (typeof value !== 'number') continue
      series.set(pen.path, appendPoint(series.get(pen.path) ?? [], { t: at, v: value }, at - pen.horizonMs))
    }
    update({ series, ranges: grownRanges(series, sample), latest: sample, lastSampleWallMs: wallNow(), sampleError: null, resetSinceAdvice: snapshot.resetSinceAdvice || reset })
  }

  const checkPresence = async (): Promise<boolean> => {
    const presence = await config.client.presence(config.runId)
    if (presence === null) { stopPolling(); update({ phase: { kind: 'missing' } }); return false }
    if (!presence.loaded) { stopPolling(); update({ phase: { kind: 'inactive' } }); return false }
    update({ playback: presence.playback, runTitle: presence.title })
    return true
  }

  const poll = async (): Promise<void> => {
    if (closed || snapshot.phase.kind !== 'live') return
    if (config.suspendWhenIdle && wallNow() - lastInteractionWallMs > IDLE_SUSPEND_MS) { stopPolling(); update({ phase: { kind: 'suspended' } }); return }
    polls += 1
    try {
      if (polls % PRESENCE_EVERY_SAMPLES === 0 && !await checkPresence()) return
      const sampled = await sample()
      // A display that missed samples (hidden, suspended or slow to answer)
      // reads what the Run recorded meanwhile, so no line is drawn flat
      // across the gap as if the value had held.
      if (snapshot.lastSampleWallMs !== undefined && wallNow() - snapshot.lastSampleWallMs > MISSED_SAMPLES_MS) {
        update(await backfill(panels(), Date.parse(sampled.simulationTime)))
      }
      applySample(sampled)
    } catch (error) {
      // Keep the last values on screen; the stale marker and this message say they are old.
      update({ sampleError: messageOf(error) })
    }
  }

  // The frame may be hidden before the display has started (a window opening
  // behind another, a tab in the background); polling starts only while shown.
  let visible = true

  const startPolling = (): void => {
    stopPolling()
    if (!visible || closed) return
    timer = setInterval(() => { void poll() }, SAMPLE_INTERVAL_MS)
  }

  const begin = async (): Promise<void> => {
    update({ phase: { kind: 'starting' } })
    const view = await config.client.view(config.runId, config.plantId, state, config.size())
    update({ view })
    const now = Date.parse(view.simulationTime)
    const history = await backfill(view.display.panels, now)
    lastSimulationMs = now
    // The first sample fills readouts, comparisons and alarms before polling starts.
    const first = await sample()
    update({ ...history, latest: first, lastSampleWallMs: wallNow(), ranges: grownRanges(history.series, first), phase: { kind: 'live' } })
  }

  // A generated display is drawn for its view, so a view with no size yet (a
  // hidden or collapsed frame) waits until it has one rather than asking for a
  // drawing of nothing.
  const drawable = (): boolean => {
    const size = config.size()
    return size === null || (size.width >= 1 && size.height >= 1)
  }
  let awaitingSize: { readonly poll?: boolean } | null = null

  /** Checks presence first and never loads an inactive Run on its own. */
  const start = async (options: { readonly poll?: boolean } = {}): Promise<void> => {
    if (!drawable()) { awaitingSize = options; return }
    try {
      if (!await checkPresence()) return
      await begin()
      if (options.poll !== false) startPolling()
    } catch (error) { fail(error) }
  }

  return {
    start,
    loadRun: async (options: { readonly poll?: boolean } = {}): Promise<void> => {
      try {
        update({ phase: { kind: 'starting' } })
        await config.client.loadRun(config.runId)
        await begin()
        if (options.poll !== false) startPolling()
      } catch (error) { fail(error) }
    },
    resume: (): void => {
      lastInteractionWallMs = wallNow()
      if (snapshot.phase.kind !== 'suspended') return
      update({ phase: { kind: 'live' } })
      startPolling()
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
      if (snapshot.view?.kind !== 'overview' && snapshot.view?.kind !== 'detail') return
      const drawn = state
      try {
        const view = await config.client.view(config.runId, config.plantId, drawn, config.size())
        if (drawn === state) update({ view })
      } catch (error) {
        update({ sampleError: messageOf(error) })
      }
    },
    /**
     * Shows another generated display of the same Plant in place (equipment
     * opened from an overview, or back), with its lead values' history read
     * once as it opens; the latest sample carries over until the next one
     * arrives. A display that cannot be drawn leaves the current one and
     * rejects.
     */
    open: async (next: string): Promise<void> => {
      if (closed) return
      const view = await config.client.view(config.runId, config.plantId, next, config.size())
      if (closed) return
      const history = await backfill(view.display.panels, Date.parse(view.simulationTime))
      if (closed) return
      state = next
      update({ view, ...history, ranges: [] })
      if (snapshot.phase.kind === 'live') await poll()
    },
    poll,
    /** Polls only while the frame is shown; shown again, it samples at once and fills what it missed. */
    setVisible: (shown: boolean): void => {
      visible = shown
      if (!shown) { stopPolling(); return }
      if (snapshot.phase.kind === 'live' && timer === undefined) { void poll(); startPolling() }
    },
    close: (): void => { closed = true; stopPolling() },
  }
}
