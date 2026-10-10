import { recordingSeriesIdFor } from '../../core/model/index.ts'
import type {
  IsoTimestamp,
  PackRuntimeRecordingBatch,
  RecordingProfileDescriptor,
  RecordingSeriesDescriptor,
  ScenarioRecordingSelection,
} from '../../core/model/index.ts'
import type { GridModelAssetCounts } from './definition-refs.ts'
import type { GridRuntimeInstance } from './runtime/instance.ts'

export const electricGridRecordingProfiles: ReadonlyArray<RecordingProfileDescriptor> = [{
  id: 'operations',
  title: 'Operations',
  description: 'Grid balance, frequency, voltage, loading, supply and alarm summaries.',
  defaultIntervalMs: 2_000,
  minimumIntervalMs: 500,
}, {
  id: 'engineering',
  title: 'Engineering detail',
  description: 'Per-asset electrical state for detailed investigation; intentionally slower and opt-in.',
  defaultIntervalMs: 10_000,
  minimumIntervalMs: 2_000,
}]

interface GridRecordingSeries {
  readonly grid: GridRuntimeInstance
  readonly descriptor: RecordingSeriesDescriptor
  readonly value: () => number
}

export interface GridRecordingPlan {
  readonly intervalMs: number
  readonly descriptors: ReadonlyArray<RecordingSeriesDescriptor>
  readonly sample: (config: { readonly observedAt: IsoTimestamp; readonly simulationTime: IsoTimestamp }) => PackRuntimeRecordingBatch
}

const profileFor = (profileId: string): RecordingProfileDescriptor => {
  const profile = electricGridRecordingProfiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`unknown electric-grid recording profile: ${profileId}`)
  return profile
}

const series = (config: {
  readonly grid: GridRuntimeInstance
  readonly signalId: string
  readonly title: string
  readonly quantity: string
  readonly unit: string
  readonly value: () => number
}): GridRecordingSeries => ({
  grid: config.grid,
  descriptor: {
    id: recordingSeriesIdFor(config.grid.definition.gridId, config.signalId),
    subjectId: config.grid.definition.gridId,
    signalId: config.signalId,
    title: `${config.grid.definition.model.title} · ${config.title}`,
    valueType: 'number',
    quantity: config.quantity,
    unit: config.unit,
  },
  value: config.value,
})

const operations = [{
  signalId: 'grid.frequency', title: 'Frequency', quantity: 'frequency', unit: 'Hz', key: 'frequencyHz',
}, {
  signalId: 'grid.generation', title: 'Generation', quantity: 'active-power', unit: 'MW', key: 'totalGenerationMw',
}, {
  signalId: 'grid.load', title: 'Demand', quantity: 'active-power', unit: 'MW', key: 'totalLoadMw',
}, {
  signalId: 'grid.served-load', title: 'Served load', quantity: 'active-power', unit: 'MW', key: 'servedLoadMw',
}, {
  signalId: 'grid.unserved-load', title: 'Unserved load', quantity: 'active-power', unit: 'MW', key: 'unservedLoadMw',
}, {
  signalId: 'grid.reserve', title: 'Reserve margin', quantity: 'active-power', unit: 'MW', key: 'reserveMarginMw',
}, {
  signalId: 'grid.maximum-branch-loading', title: 'Maximum branch loading', quantity: 'ratio', unit: '%', key: 'highestBranchLoadingPercent',
}, {
  signalId: 'grid.minimum-voltage', title: 'Minimum voltage', quantity: 'voltage-ratio', unit: 'pu', key: 'lowestVoltagePu',
}, {
  signalId: 'grid.active-alarms', title: 'Active alarms', quantity: 'count', unit: '1', key: 'activeAlarmCount',
}] as const
const operationsSeries = (grid: GridRuntimeInstance): ReadonlyArray<GridRecordingSeries> => operations.map(({ key, ...item }) => series({ grid, ...item, value: () => grid.projection[key] }))

export const gridRecordingSeriesCount = (counts: GridModelAssetCounts, profileId: string): number =>
  operations.length + (profileId === 'engineering'
    ? counts.bus * 2 + counts.branch * 2 + counts.generator + counts.load + counts.storage : 0)

const engineeringSeries = (grid: GridRuntimeInstance): ReadonlyArray<GridRecordingSeries> => [
  ...grid.definition.model.buses.flatMap(bus => {
    const state = () => grid.busStates.get(bus.id)
    return [
      series({ grid, signalId: `${bus.id}.voltage`, title: `${bus.label} voltage`, quantity: 'voltage-ratio', unit: 'pu', value: () => state()?.voltagePu ?? 1 }),
      series({ grid, signalId: `${bus.id}.frequency`, title: `${bus.label} frequency`, quantity: 'frequency', unit: 'Hz', value: () => state()?.frequencyHz ?? grid.definition.model.nominalFrequencyHz }),
    ]
  }),
  ...grid.definition.model.branches.flatMap(branch => {
    const state = () => grid.branches.get(branch.id)!
    return [
      series({ grid, signalId: `${branch.id}.flow`, title: `${branch.label} flow`, quantity: 'active-power', unit: 'MW', value: () => state().flowMw }),
      series({ grid, signalId: `${branch.id}.loading`, title: `${branch.label} loading`, quantity: 'ratio', unit: '%', value: () => state().loadingPercent }),
    ]
  }),
  ...grid.definition.model.generators.map(generator => series({
    grid, signalId: `${generator.id}.dispatch`, title: `${generator.label} dispatch`, quantity: 'active-power', unit: 'MW', value: () => grid.generators.get(generator.id)!.dispatchMw,
  })),
  ...grid.definition.model.loads.map(load => series({
    grid, signalId: `${load.id}.served`, title: `${load.label} served load`, quantity: 'active-power', unit: 'MW', value: () => grid.loads.get(load.id)!.servedMw,
  })),
  ...grid.definition.model.storage.map(item => series({
    grid, signalId: `${item.id}.state-of-charge`, title: `${item.label} state of charge`, quantity: 'ratio', unit: '1', value: () => grid.storage.get(item.id)!.stateOfChargeFraction,
  })),
]

export const createGridRecordingPlan = (config: {
  readonly selection: ScenarioRecordingSelection
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
}): GridRecordingPlan => {
  const profile = profileFor(config.selection.profileId)
  const intervalMs = config.selection.intervalMs ?? profile.defaultIntervalMs
  if (intervalMs < profile.minimumIntervalMs) throw new Error(`electric-grid recording profile ${profile.id} requires an interval of at least ${profile.minimumIntervalMs} ms`)
  const plans = [...config.grids.values()].flatMap(grid => profile.id === 'engineering'
    ? [...operationsSeries(grid), ...engineeringSeries(grid)]
    : operationsSeries(grid))
  return {
    intervalMs,
    descriptors: plans.map(item => item.descriptor),
    sample: ({ observedAt, simulationTime }) => ({
      descriptors: [],
      samples: plans.map(item => ({
        seriesId: item.descriptor.id,
        observedAt,
        simulationTime,
        elapsedMs: Math.round(item.grid.elapsedMs),
        value: item.value(),
        quality: 'good' as const,
      })),
    }),
  }
}
