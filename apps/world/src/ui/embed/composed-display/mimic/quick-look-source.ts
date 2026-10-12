import type { SimulationRunId } from '../../../../core/model/index.ts'
import { measuresNow, type ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
import { appendPoint, gatePaths, HOLD_GAP_MS, type TrendPoint } from '../../../../packs/process-plant/displays/trend-reading.ts'
import type { ComposedDisplayClient, ComposedDisplaySample } from '../composed-display-client.ts'
import type { ComposedDisplaySnapshot } from '../composed-display-session.ts'

// What an item's quick look shows while it is open: the lead values World
// chose for it with the drawing (mimic/quick-look.ts), each recorded one
// with its sparkline's history, read when it opens, and their values
// sampled each second until it closes. Opening one compiles nothing; nothing
// of it enters the published view.

/** A quick look samples as a display does. */
const QUICK_LOOK_SAMPLE_MS = 1_000

export type QuickLookState =
  | { readonly kind: 'loading' }
  | {
    readonly kind: 'shown'
    readonly latest: ComposedDisplaySample | undefined
    readonly history: Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>
    /** Message of the last failed sample; the values shown are then the last received. */
    readonly sampleError: string | null
  }

export interface MimicQuickLookSource {
  /** Starts reading an item's quick look; `onChange` gets each state until the returned function stops it. */
  readonly open: (look: { readonly pens: ReadonlyArray<ComposedDisplayPen>; readonly sparklineMs: number }, onChange: (state: QuickLookState) => void) => () => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * A quick-look row's value in the latest sample: none (read as "—") while
 * the reading measures nothing, outside the validity its equipment declares
 * (a turbine's speed off line, the grid's frequency on a dead grid), never
 * its raw value; else its sampled value or state.
 */
export const quickLookValue = (pen: ComposedDisplayPen, latest: ComposedDisplaySample | undefined): { readonly value: number | boolean | undefined; readonly quality: 'good' | 'outside-hard-range' | undefined } => {
  const read = (path: string) => latest?.values.find(entry => entry.path === path)?.value
  const entry = latest?.values.find(candidate => candidate.path === String(pen.path))
  if (!measuresNow(pen, read)) return { value: undefined, quality: undefined }
  return { value: entry?.value, quality: entry?.quality }
}

export const createMimicQuickLook = (config: {
  readonly client: Pick<ComposedDisplayClient, 'history' | 'sample'>
  readonly runId: SimulationRunId
  readonly plantId: string
  readonly setInterval?: (run: () => void, ms: number) => unknown
  readonly clearInterval?: (timer: unknown) => void
}): MimicQuickLookSource => ({
  open: ({ pens, sparklineMs }, onChange) => {
    let stopped = false
    let timer: unknown
    const every = config.setInterval ?? ((run, ms) => setInterval(run, ms))
    const stopTimer = config.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
    const emit = (state: QuickLookState): void => { if (!stopped) onChange(state) }
    emit({ kind: 'loading' })
    // With the values its limits' gates read, so a limit whose gates do not hold reads idle, as on the detail, and the
    // flag each reading is valid under, so a reading that measures nothing reads "—" (quickLookValue).
    const paths = [...new Set(pens.flatMap(pen => [String(pen.path), ...(pen.validWhile === undefined ? [] : [String(pen.validWhile)]), ...pen.thresholds.flatMap(threshold => (threshold.gates ?? []).flatMap(gatePaths))]))]
    const plotted = pens.filter(pen => pen.recorded && pen.valueKind === 'number')
    void (async () => {
      let shown: Extract<QuickLookState, { kind: 'shown' }> | undefined
      const sample = async (): Promise<ComposedDisplaySample | Error> => {
        try {
          return await config.client.sample(config.runId, config.plantId, paths, false)
        } catch (error) {
          return error instanceof Error ? error : new Error(messageOf(error))
        }
      }
      // The first sample says where the Run is now; each sparkline reads from one hold gap before its window (as the display's own do).
      const first = await sample()
      if (stopped) return
      const now = first instanceof Error ? Number.NaN : Date.parse(first.simulationTime)
      const series = new Map<string, ReadonlyArray<TrendPoint>>()
      const historyMissing = new Set<string>()
      const historyErrors = new Map<string, string>()
      await Promise.all(plotted.map(async pen => {
        if (!Number.isFinite(now)) { historyErrors.set(String(pen.path), 'no sample to read history up to'); return }
        try {
          const points = await config.client.history(config.runId, pen.seriesId, { from: now - sparklineMs - HOLD_GAP_MS, to: now })
          if (points.length === 0) historyMissing.add(String(pen.path))
          series.set(String(pen.path), points)
        } catch (error) {
          historyErrors.set(String(pen.path), messageOf(error))
        }
      }))
      const apply = (next: ComposedDisplaySample | Error): void => {
        if (shown === undefined) return
        if (next instanceof Error) { shown = { ...shown, sampleError: next.message }; emit(shown); return }
        const at = Date.parse(next.simulationTime)
        const extended = new Map(shown.history.series)
        for (const pen of plotted) {
          const value = next.values.find(entry => entry.path === String(pen.path))?.value
          if (typeof value === 'number') extended.set(String(pen.path), appendPoint(extended.get(String(pen.path)) ?? [], { t: at, v: value }, at - sparklineMs))
        }
        shown = { ...shown, latest: next, history: { ...shown.history, series: extended }, sampleError: null }
        emit(shown)
      }
      shown = { kind: 'shown', latest: undefined, history: { series, historyMissing, historyErrors }, sampleError: null }
      apply(first)
      if (!stopped) timer = every(() => { void (async () => apply(await sample()))() }, QUICK_LOOK_SAMPLE_MS)
    })()
    return () => {
      stopped = true
      if (timer !== undefined) stopTimer(timer)
    }
  },
})
