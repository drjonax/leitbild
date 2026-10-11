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
import { flowModelAc, flowModelNone, publishedNullable } from './runtime/state/arrays.ts'

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
  /** null: the quantity does not exist now (for example the frequency of a de-energised island); no sample is taken. */
  readonly value: () => number | boolean | null
}

export interface GridRecordingPlan {
  readonly intervalMs: number
  /** Every series described so far; islands that form later add their series when first sampled. */
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
  readonly valueType?: 'number' | 'boolean'
  readonly quantity: string
  readonly unit: string
  readonly value: () => number | boolean | null
}): GridRecordingSeries => ({
  grid: config.grid,
  descriptor: {
    id: recordingSeriesIdFor(config.grid.definition.gridId, config.signalId),
    subjectId: config.grid.definition.gridId,
    signalId: config.signalId,
    title: `${config.grid.definition.model.title} · ${config.title}`,
    valueType: config.valueType ?? 'number',
    quantity: config.quantity,
    unit: config.unit,
  },
  value: config.value,
})

const operations = [{
  signalId: 'grid.frequency', title: 'Frequency (largest-load energised island)', quantity: 'frequency', unit: 'Hz', key: 'frequencyHz',
}, {
  signalId: 'grid.frequency.min', title: 'Lowest island frequency', quantity: 'frequency', unit: 'Hz', key: 'frequencyMinHz',
}, {
  signalId: 'grid.frequency.max', title: 'Highest island frequency', quantity: 'frequency', unit: 'Hz', key: 'frequencyMaxHz',
}, {
  signalId: 'grid.generation', title: 'Generation', quantity: 'active-power', unit: 'MW', key: 'totalGenerationMw',
}, {
  signalId: 'grid.load', title: 'Demand', quantity: 'active-power', unit: 'MW', key: 'totalLoadMw',
}, {
  signalId: 'grid.served-load', title: 'Served load', quantity: 'active-power', unit: 'MW', key: 'servedLoadMw',
}, {
  signalId: 'grid.unserved-load', title: 'Unserved load', quantity: 'active-power', unit: 'MW', key: 'unservedLoadMw',
}, {
  signalId: 'grid.losses', title: 'Network losses', quantity: 'active-power', unit: 'MW', key: 'lossesMw',
}, {
  signalId: 'grid.reserve', title: 'Reserve margin', quantity: 'active-power', unit: 'MW', key: 'reserveMarginMw',
}, {
  signalId: 'grid.maximum-branch-loading', title: 'Maximum branch loading', quantity: 'ratio', unit: '%', key: 'highestBranchLoadingPercent',
}, {
  signalId: 'grid.voltage.min', title: 'Lowest bus voltage (converged islands)', quantity: 'voltage', unit: 'pu', key: 'voltageMinPu',
}, {
  signalId: 'grid.voltage.max', title: 'Highest bus voltage (converged islands)', quantity: 'voltage', unit: 'pu', key: 'voltageMaxPu',
}, {
  signalId: 'grid.dc-flow-islands', title: 'Energised islands on DC flows (AC load flow not converged)', quantity: 'count', unit: '1', key: 'notConvergedIslandCount',
}, {
  signalId: 'grid.island-count', title: 'Energised islands', quantity: 'count', unit: '1', key: 'activeIslandCount',
}, {
  signalId: 'grid.active-alarms', title: 'Active alarms', quantity: 'count', unit: '1', key: 'activeAlarmCount',
}] as const
const operationsSeries = (grid: GridRuntimeInstance): ReadonlyArray<GridRecordingSeries> => operations.map(({ key, ...item }) => series({ grid, ...item, value: () => grid.projection[key] }))

/** Frequency and energisation series of one island, keyed by its stable id. */
const islandSeries = (grid: GridRuntimeInstance, islandId: string): ReadonlyArray<GridRecordingSeries> => {
  const island = () => grid.projection.islands.find(candidate => candidate.id === islandId)
  return [
    series({ grid, signalId: `island.${islandId}.frequency`, title: `Island ${islandId} frequency`, quantity: 'frequency', unit: 'Hz', value: () => island()?.frequencyHz ?? null }),
    series({ grid, signalId: `island.${islandId}.energized`, title: `Island ${islandId} energised`, valueType: 'boolean', quantity: 'boolean', unit: 'boolean', value: () => {
      const current = island()
      return current === undefined ? null : current.energized
    } }),
    // true: flows from its converged AC load flow; false: DC flows (not converged); no sample while de-energised.
    series({ grid, signalId: `island.${islandId}.ac-flow`, title: `Island ${islandId} flows from the AC load flow`, valueType: 'boolean', quantity: 'boolean', unit: 'boolean', value: () => {
      const flowModel = island()?.flowModel ?? null
      return flowModel === null ? null : flowModel === 'ac'
    } }),
  ]
}

// Each island adds its three series when it forms; the estimate counts the main island's.
const estimatedIslandSeriesCount = 3

/** The series a Grid records from its start (one island), as createGridRecordingPlan describes them; an HVDC terminal has no bus series. */
export const gridRecordingSeriesCount = (counts: GridModelAssetCounts, profileId: string): number =>
  operations.length + estimatedIslandSeriesCount + (profileId === 'engineering'
    ? (counts.bus - counts.hvdcTerminal) * 2 + counts.branch * 3 + counts.generator + counts.load + counts.storage : 0)

// Per-asset values read the Grid's arrays by model index; bus values exist once the network has been
// solved. An HVDC terminal lies in no island and takes no part in energisation, so it has no bus series.
const engineeringSeries = (grid: GridRuntimeInstance): ReadonlyArray<GridRecordingSeries> => {
  const { buses, branches, generators, loads, storage } = grid.arrays
  const solved = (): boolean => grid.busStates.size > 0
  return [
    ...grid.definition.model.buses.flatMap((bus, index) => grid.hvdcTerminals.has(bus.id) ? [] : [
      series({ grid, signalId: `${bus.id}.energized`, title: `${bus.label} energised`, valueType: 'boolean', quantity: 'boolean', unit: 'boolean', value: () => solved() ? buses.energized[index] === 1 : null }),
      series({ grid, signalId: `${bus.id}.frequency`, title: `${bus.label} frequency`, quantity: 'frequency', unit: 'Hz', value: () => solved() ? publishedNullable(buses.frequencyHz[index]!) : null }),
    ]),
    ...grid.definition.model.branches.flatMap((branch, index) => [
      series({ grid, signalId: `${branch.id}.flow`, title: `${branch.label} flow`, quantity: 'active-power', unit: 'MW', value: () => branches.flowMw[index]! }),
      series({ grid, signalId: `${branch.id}.loading`, title: `${branch.label} loading`, quantity: 'ratio', unit: '%', value: () => branches.loadingPercent[index]! }),
      // true: flow and loading from the AC load flow; false: the DC flow; no sample without flow.
      series({ grid, signalId: `${branch.id}.ac-flow`, title: `${branch.label} flow from the AC load flow`, valueType: 'boolean', quantity: 'boolean', unit: 'boolean', value: () => {
        const flowModel = branches.flowModel[index]!
        return flowModel === flowModelNone ? null : flowModel === flowModelAc
      } }),
    ]),
    ...grid.definition.model.generators.map((generator, index) => series({
      grid, signalId: `${generator.id}.dispatch`, title: `${generator.label} dispatch`, quantity: 'active-power', unit: 'MW', value: () => generators.dispatchMw[index]!,
    })),
    ...grid.definition.model.loads.map((load, index) => series({
      grid, signalId: `${load.id}.served`, title: `${load.label} served load`, quantity: 'active-power', unit: 'MW', value: () => loads.servedMw[index]!,
    })),
    ...grid.definition.model.storage.map((item, index) => series({
      grid, signalId: `${item.id}.state-of-charge`, title: `${item.label} state of charge`, quantity: 'ratio', unit: '1', value: () => storage[index]!.stateOfChargeFraction,
    })),
  ]
}

export const createGridRecordingPlan = (config: {
  readonly selection: ScenarioRecordingSelection
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
}): GridRecordingPlan => {
  const profile = profileFor(config.selection.profileId)
  const intervalMs = config.selection.intervalMs ?? profile.defaultIntervalMs
  if (intervalMs < profile.minimumIntervalMs) throw new Error(`electric-grid recording profile ${profile.id} requires an interval of at least ${profile.minimumIntervalMs} ms`)
  const plans: GridRecordingSeries[] = [...config.grids.values()].flatMap(grid => profile.id === 'engineering'
    ? [...operationsSeries(grid), ...engineeringSeries(grid)]
    : [...operationsSeries(grid)])
  const describedIslands = new Set<string>()
  const addIslandSeries = (): ReadonlyArray<RecordingSeriesDescriptor> => {
    const added: RecordingSeriesDescriptor[] = []
    for (const grid of config.grids.values()) {
      for (const island of grid.projection.islands) {
        const key = `${grid.definition.gridId}\u0000${island.id}`
        if (describedIslands.has(key)) continue
        describedIslands.add(key)
        const created = islandSeries(grid, island.id)
        plans.push(...created)
        added.push(...created.map(item => item.descriptor))
      }
    }
    return added
  }
  addIslandSeries()
  return {
    intervalMs,
    get descriptors() {
      return plans.map(item => item.descriptor)
    },
    sample: ({ observedAt, simulationTime }) => {
      const descriptors = addIslandSeries()
      const samples: PackRuntimeRecordingBatch['samples'][number][] = []
      for (const item of plans) {
        const value = item.value()
        if (value === null) continue
        samples.push({
          seriesId: item.descriptor.id,
          observedAt,
          simulationTime,
          elapsedMs: Math.round(item.grid.elapsedMs),
          value,
          quality: 'good' as const,
        })
      }
      return { descriptors: [...descriptors], samples }
    },
  }
}
