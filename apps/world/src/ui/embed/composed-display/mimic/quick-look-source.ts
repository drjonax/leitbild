import type { SimulationRunId } from '../../../../core/model/index.ts'
import type { ComposedReadoutsPanel } from '../../../../packs/process-plant/displays/compose.ts'
import { detailDisplayStateSchema } from '../../../../packs/process-plant/displays/composition.ts'
import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
import { appendPoint, gatePaths, HOLD_GAP_MS, type TrendPoint } from '../../../../packs/process-plant/displays/trend-reading.ts'
import type { ComposedDisplayClient, ComposedDisplaySample, ViewSize } from '../composed-display-client.ts'
import type { ComposedDisplaySnapshot } from '../composed-display-session.ts'

// What an item's quick look shows, read while it is open: the lead values of
// the item's detail, exactly as the detail would show them (World compiles
// the same detail for the same window, so the two can never disagree), with
// each recorded one's sparkline history, sampled each second until it closes.
// Nothing of it enters the published view.

/** At most this many lead values in a quick look; the detail shows the rest. */
export const QUICK_LOOK_LEADS = 6
/** A quick look samples as a display does. */
const QUICK_LOOK_SAMPLE_MS = 1_000

export type QuickLookState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  /** `panel`: the detail's lead values, null where it has none. */
  | {
    readonly kind: 'shown'
    readonly panel: ComposedReadoutsPanel | null
    readonly latest: ComposedDisplaySample | undefined
    readonly history: Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>
    /** Message of the last failed sample; the values shown are then the last received. */
    readonly sampleError: string | null
  }

export interface MimicQuickLookSource {
  /** Starts reading an item's quick look; `onChange` gets each state until the returned function stops it. */
  readonly open: (item: MimicDrawnItem, onChange: (state: QuickLookState) => void) => () => void
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const createMimicQuickLook = (config: {
  readonly client: Pick<ComposedDisplayClient, 'view' | 'history' | 'sample'>
  readonly runId: SimulationRunId
  readonly plantId: string
  /** The window's size, which the detail is drawn for: a quick look and the detail it leads to are one compile. */
  readonly size: () => ViewSize | null
  readonly setInterval?: (run: () => void, ms: number) => unknown
  readonly clearInterval?: (timer: unknown) => void
}): MimicQuickLookSource => ({
  open: (item, onChange) => {
    let stopped = false
    let timer: unknown
    const every = config.setInterval ?? ((run, ms) => setInterval(run, ms))
    const stopTimer = config.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
    const emit = (state: QuickLookState): void => { if (!stopped) onChange(state) }
    emit({ kind: 'loading' })
    void (async () => {
      try {
        const state = JSON.stringify(detailDisplayStateSchema.parse({ detail: { plantId: config.plantId, components: item.components } }))
        const view = await config.client.view(config.runId, config.plantId, state, config.size())
        const leads = view.display.panels.find((panel): panel is ComposedReadoutsPanel => panel.kind === 'readouts')
        const panel = leads === undefined ? null : { ...leads, pens: leads.pens.slice(0, QUICK_LOOK_LEADS) }
        const now = Date.parse(view.simulationTime)
        // Each recorded numeric lead's sparkline, read from one hold gap before its window (as the display's own are).
        const plotted = panel === null || panel.sparklineMs === undefined ? [] : panel.pens.filter(pen => pen.recorded && pen.valueKind === 'number')
        const horizonMs = panel?.sparklineMs ?? 0
        const series = new Map<string, ReadonlyArray<TrendPoint>>()
        const historyMissing = new Set<string>()
        const historyErrors = new Map<string, string>()
        await Promise.all(plotted.map(async pen => {
          try {
            const points = await config.client.history(config.runId, pen.seriesId, { from: now - horizonMs - HOLD_GAP_MS, to: now })
            if (points.length === 0) historyMissing.add(String(pen.path))
            series.set(String(pen.path), points)
          } catch (error) {
            historyErrors.set(String(pen.path), messageOf(error))
          }
        }))
        let shown: Extract<QuickLookState, { kind: 'shown' }> = { kind: 'shown', panel, latest: undefined, history: { series, historyMissing, historyErrors }, sampleError: null }
        emit(shown)
        // With the values its limits' gates read, so a limit whose gates do not hold reads idle, as on the detail.
        const paths = panel === null ? [] : [...new Set(panel.pens.flatMap(pen => [String(pen.path), ...pen.thresholds.flatMap(threshold => (threshold.gates ?? []).flatMap(gatePaths))]))]
        if (paths.length === 0 || stopped) return
        const sample = async (): Promise<void> => {
          try {
            const latest = await config.client.sample(config.runId, config.plantId, paths, false)
            const at = Date.parse(latest.simulationTime)
            const extended = new Map(shown.history.series)
            for (const pen of plotted) {
              const value = latest.values.find(entry => entry.path === String(pen.path))?.value
              if (typeof value === 'number') extended.set(String(pen.path), appendPoint(extended.get(String(pen.path)) ?? [], { t: at, v: value }, at - horizonMs))
            }
            shown = { ...shown, latest, history: { ...shown.history, series: extended }, sampleError: null }
          } catch (error) {
            shown = { ...shown, sampleError: messageOf(error) }
          }
          emit(shown)
        }
        await sample()
        if (!stopped) timer = every(() => { void sample() }, QUICK_LOOK_SAMPLE_MS)
      } catch (error) {
        emit({ kind: 'failed', message: messageOf(error) })
      }
    })()
    return () => {
      stopped = true
      if (timer !== undefined) stopTimer(timer)
    }
  },
})
