import type { SimulationRunId } from '../../../core/model/index.ts'
import type { CompiledComposedDisplay } from '../../../packs/process-plant/displays/compose.ts'
import { querySimulationRunCapability } from '../../simulation-run-client.ts'
import { workspaceApiPath } from '../../workspace-context.ts'
import type { TrendPoint } from './trend-geometry.ts'

export interface RunPresence {
  /** The Run's name, so a display says which Run its advice is about. */
  readonly title: string
  readonly loaded: boolean
  readonly playback: 'playing' | 'paused'
  readonly currentSimulationTime: string
}

export type ComposedDisplayViewResult =
  | {
    readonly kind: 'advice'
    readonly plantId: string
    readonly plantLabel: string | null
    readonly issuedAt: string
    readonly simulationTime: string
    readonly modelChanged: boolean
    /** A mimic draws differently now than when the advice was composed (a newer layout or model semantics). */
    readonly drawingChanged: boolean
    readonly display: CompiledComposedDisplay
  }
  /** A unit overview World generates for the Plant, or equipment opened from it: no advice, so nothing about it goes stale. */
  | {
    readonly kind: 'overview' | 'detail'
    readonly plantId: string
    readonly plantLabel: string | null
    readonly simulationTime: string
    readonly display: CompiledComposedDisplay
  }

export interface ViewSize {
  readonly width: number
  readonly height: number
}

export interface ComposedDisplayAlarm {
  readonly id: string
  readonly ruleId: string
  readonly kind: 'alarm' | 'trip'
  readonly title: string
  readonly severity: 'info' | 'notice' | 'warning' | 'critical'
  /** False once its condition cleared; it stays listed until acknowledged. */
  readonly active: boolean
  readonly acknowledged: boolean
  readonly firstOut: boolean
  readonly firstActiveElapsedMs?: number
}

export interface ComposedDisplaySample {
  readonly simulationTime: string
  readonly plantElapsedMs: number
  /** Present where the Plant declares operating modes: the one it is in, or null where none holds. */
  readonly mode?: { readonly id: string; readonly label: string } | null
  /** Present when the sample asked for alarms. */
  readonly alarms?: ReadonlyArray<ComposedDisplayAlarm>
  readonly values: ReadonlyArray<{
    readonly path: string
    readonly value: number | boolean
    readonly quality: 'good' | 'outside-hard-range'
  }>
}

export interface ComposedDisplayClient {
  /** null when the Run no longer exists. Never loads the Run. */
  readonly presence: (runId: SimulationRunId) => Promise<RunPresence | null>
  /** Explicitly loads a Run at the reader's request. */
  readonly loadRun: (runId: SimulationRunId) => Promise<void>
  /** `size`: the view's inner size, which a generated display is drawn for; null for advice, sized when composed. */
  readonly view: (runId: SimulationRunId, plantId: string, state: string, size: ViewSize | null) => Promise<ComposedDisplayViewResult>
  readonly history: (runId: SimulationRunId, seriesId: string, window: { readonly from: number; readonly to: number }) => Promise<ReadonlyArray<TrendPoint>>
  readonly sample: (runId: SimulationRunId, plantId: string, paths: ReadonlyArray<string>, alarms: boolean) => Promise<ComposedDisplaySample>
}

const runPath = (runId: SimulationRunId, suffix = ''): string =>
  workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}${suffix}` as `/${string}`)

const failureMessage = async (response: Response, action: string): Promise<string> => {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') return `${action} failed: ${body.error.message}`
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return `${action} failed with HTTP ${response.status}`
}

// One window of a 30 minute horizon at the operations interval is 1 800
// samples; the page size leaves room for faster recording profiles.
const HISTORY_PAGE_LIMIT = 4_000

interface RecordedSamplePage {
  readonly samples?: ReadonlyArray<{ readonly simulationTime?: string; readonly value: unknown }>
}

export const composedDisplayClient: ComposedDisplayClient = {
  presence: async runId => {
    const response = await fetch(runPath(runId, '/presence'))
    if (response.status === 404) return null
    if (!response.ok) throw new Error(await failureMessage(response, 'Run status'))
    const body = await response.json() as { title: string; loaded: boolean; execution: { playback: 'playing' | 'paused'; currentSimulationTime: string } }
    return { title: body.title, loaded: body.loaded, playback: body.execution.playback, currentSimulationTime: body.execution.currentSimulationTime }
  },
  loadRun: async runId => {
    const response = await fetch(runPath(runId))
    if (!response.ok) throw new Error(await failureMessage(response, 'Loading the Run'))
  },
  view: (runId, plantId, state, size) => querySimulationRunCapability<ComposedDisplayViewResult>(runId, 'world.process-plant.display.view', { plantId, state, ...(size === null ? {} : { size }) }),
  history: async (runId, seriesId, window) => {
    const query = new URLSearchParams({
      mode: 'raw',
      seriesId,
      timeAxis: 'simulation',
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      limit: String(HISTORY_PAGE_LIMIT),
    })
    const response = await fetch(`${runPath(runId, '/history/samples')}?${query}`)
    if (!response.ok) throw new Error(await failureMessage(response, 'Reading history'))
    const page = await response.json() as RecordedSamplePage
    return (page.samples ?? [])
      .flatMap(sample => typeof sample.value === 'number' && sample.simulationTime !== undefined
        ? [{ t: Date.parse(sample.simulationTime), v: sample.value }]
        : [])
      .sort((left, right) => left.t - right.t)
  },
  sample: (runId, plantId, paths, alarms) => querySimulationRunCapability<ComposedDisplaySample>(runId, 'world.process-plant.display.sample', { plantId, paths, alarms }),
}
