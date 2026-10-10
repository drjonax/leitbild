import type {
  CompiledGridDefinition,
  GridAssetDefinition,
  GridAssetKind,
  GridBranchDefinition,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridStorageDefinition,
} from '../grid-model.ts'
import type { GridProjection } from '../model.ts'
import type { ElectricalConnectionDefinition } from '../../../core/model/index.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import type { GridIslandSystem } from './network/dc-power-flow.ts'

export interface GridBusState {
  readonly busId: string
  readonly voltagePu: number
  readonly frequencyHz: number
  readonly angleRad: number
  readonly islandId: string
  readonly netInjectionMw: number
}

export interface GridBranchState {
  state: 'closed' | 'open'
  availability: number
  flowMw: number
  loadingPercent: number
  voltageFromPu: number
  voltageToPu: number
  frequencyHz: number
  lossesMw: number
}

/** tripped →(reset)→ offline →(start)→ starting →(start-up time)→ online →(stop)→ stopping →(0 MW)→ offline. */
export type GridGeneratorLifecycleState = 'online' | 'offline' | 'starting' | 'stopping' | 'tripped'

export interface GridGeneratorState {
  state: GridGeneratorLifecycleState
  availableMw: number
  dispatchMw: number
  targetMw: number
  reserveMw: number
  frequencyHz: number
  /** Grid elapsed time at which a starting unit synchronises; null in every other state. */
  synchronisesAtElapsedMs: number | null
}

export type GridLoadShedCause = 'manual' | 'lfdd'

export interface GridLoadState {
  /** Scheduled demand before the load profile (Model × Operating Point, or an EV charging schedule). */
  nominalDemandMw: number
  /** Manual shedding limit from shed-load: the load draws at most this; null when not shed manually. */
  manualDemandLimitMw: number | null
  demandMw: number
  servedMw: number
  /** Demand disconnected by the manual shedding limit. */
  curtailedMw: number
  /** Demand disconnected by automatic under-frequency load shedding. */
  lfddShedMw: number
  /** Total shed demand: curtailedMw + lfddShedMw. */
  shedMw: number
  shedCauses: Array<GridLoadShedCause>
  frequencyHz: number
  voltagePu: number
  serviceState: 'normal' | 'constrained' | 'shed' | 'outage'
}

export interface GridStorageState {
  stateOfChargeFraction: number
  dispatchMw: number
  frequencyHz: number
  voltagePu: number
  state: 'idle' | 'charging' | 'discharging' | 'unavailable'
}

export interface GridTopologyIsland {
  readonly id: string
  /** The island's first bus in model order: the angle reference, which absorbs the island's injection mismatch. */
  readonly referenceBusId: string
  /** Buses in model order. */
  readonly buses: ReadonlyArray<string>
  readonly busSet: ReadonlySet<string>
  readonly branches: ReadonlyArray<GridBranchDefinition>
  readonly generators: ReadonlyArray<GridGeneratorDefinition>
  readonly loads: ReadonlyArray<GridLoadDefinition>
  readonly storage: ReadonlyArray<GridStorageDefinition>
}

export interface GridTopologyPlan {
  readonly network: CompiledGridNetwork
  /** Closed flag (1) per model branch this plan was built from; compared with live branch states every tick. */
  readonly closedBranches: Uint8Array
  readonly islands: ReadonlyArray<GridTopologyIsland>
  /** DC systems aligned with `islands`. */
  readonly systems: ReadonlyArray<GridIslandSystem>
  readonly islandIdByBus: ReadonlyMap<string, string>
  /** Latest solve per bus in model order: scheduled injection (MW) and angle (rad). */
  readonly injectionsMw: Float64Array
  readonly anglesRad: Float64Array
  /** Latest solve per island, aligned with `islands`: MW absorbed by the reference bus (the island's injection sum). */
  readonly referenceMismatchMw: Float64Array
}

export interface GridRuntimeDiagnostics {
  lastSuccessfulTickAt: string | null
  lastTickDurationMs: number
  maximumTickDurationMs: number
  topologyRebuildCount: number
  lastTopologyRebuildDurationMs: number
  queryCount: number
  lastQueryDurationMs: number
  persistenceFailureCount: number
  lastPersistenceFailure: string | null
}

export interface GridRuntimeInstance {
  readonly definition: CompiledGridDefinition
  elapsedMs: number
  tick: number
  readonly branches: Map<string, GridBranchState>
  readonly generators: Map<string, GridGeneratorState>
  readonly loads: Map<string, GridLoadState>
  readonly storage: Map<string, GridStorageState>
  readonly externalConnections: Map<string, GridExternalConnectionState>
  busStates: Map<string, GridBusState>
  frequencyByIsland: Map<string, number>
  topologyPlan: GridTopologyPlan | null
  readonly diagnostics: GridRuntimeDiagnostics
  projection: GridProjection
}

export interface GridExternalConnectionState {
  readonly definition: ElectricalConnectionDefinition
  readonly busId: string
  systemActivePowerMw: number
  connected: boolean
}

export interface GridAssetSnapshot {
  readonly id: string
  readonly label: string
  readonly kind: GridAssetKind
  readonly definition: GridAssetDefinition
  readonly state?: GridBusState | GridBranchState | GridGeneratorState | GridLoadState | GridStorageState
}

export interface RestoredGridRuntimeState {
  readonly elapsedMs: number
  readonly tick: number
  readonly frequencies: ReadonlyArray<{ readonly islandId: string; readonly frequencyHz: number }>
  readonly branches: ReadonlyArray<{ readonly id: string; readonly state: GridBranchState['state']; readonly availability: number }>
  readonly generators: ReadonlyArray<{ readonly id: string; readonly state: GridGeneratorState['state']; readonly availableMw: number; readonly dispatchMw: number; readonly targetMw: number; readonly synchronisesAtElapsedMs: number | null }>
  readonly loads: ReadonlyArray<{ readonly id: string; readonly nominalDemandMw: number; readonly manualDemandLimitMw: number | null }>
  readonly storage: ReadonlyArray<{ readonly id: string; readonly stateOfChargeFraction: number; readonly dispatchMw: number }>
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const initialGenerationTargets = (definition: CompiledGridDefinition): Map<string, number> => {
  const loadByComponent = new Map<string, number>()
  const availableByComponent = new Map<string, number>()
  for (const load of definition.model.loads) {
    const componentId = definition.index.staticComponentByBus.get(load.busId)!
    loadByComponent.set(componentId, (loadByComponent.get(componentId) ?? 0) + load.demandMw * definition.operatingPoint.loadScale)
  }
  for (const generator of definition.model.generators) {
    const componentId = definition.index.staticComponentByBus.get(generator.busId)!
    const availableMw = Math.min(generator.capacityMw, generator.availableMw * definition.operatingPoint.generationAvailabilityScale)
    availableByComponent.set(componentId, (availableByComponent.get(componentId) ?? 0) + availableMw)
  }
  return new Map(definition.model.generators.map(generator => {
    const componentId = definition.index.staticComponentByBus.get(generator.busId)!
    const demandMw = loadByComponent.get(componentId) ?? 0
    const availableMw = availableByComponent.get(componentId) ?? 0
    const generatorAvailableMw = Math.min(generator.capacityMw, generator.availableMw * definition.operatingPoint.generationAvailabilityScale)
    return [generator.id, availableMw <= 0 ? 0 : Math.min(generatorAvailableMw, demandMw * generatorAvailableMw / availableMw)]
  }))
}

export const createGridRuntimeInstance = (config: {
  readonly definition: CompiledGridDefinition
  readonly at: string
  readonly restored?: RestoredGridRuntimeState
  readonly connections?: ReadonlyArray<ElectricalConnectionDefinition>
}): GridRuntimeInstance => {
  const targets = initialGenerationTargets(config.definition)
  const restoredBranches = new Map(config.restored?.branches.map(item => [item.id, item]))
  const restoredGenerators = new Map(config.restored?.generators.map(item => [item.id, item]))
  const restoredLoads = new Map(config.restored?.loads.map(item => [item.id, item]))
  const restoredStorage = new Map(config.restored?.storage.map(item => [item.id, item]))
  const branches = new Map(config.definition.model.branches.map(branch => {
    const restored = restoredBranches.get(branch.id)
    return [branch.id, {
      state: restored?.state ?? 'closed',
      availability: restored?.availability ?? 1,
      flowMw: 0,
      loadingPercent: 0,
      voltageFromPu: 1,
      voltageToPu: 1,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      lossesMw: 0,
    } satisfies GridBranchState]
  }))
  const generators = new Map(config.definition.model.generators.map(generator => {
    const restored = restoredGenerators.get(generator.id)
    const targetMw = restored?.targetMw ?? targets.get(generator.id) ?? 0
    const initialAvailableMw = generator.availableMw * config.definition.operatingPoint.generationAvailabilityScale
    return [generator.id, {
      state: restored?.state ?? 'online',
      availableMw: clamp(restored?.availableMw ?? initialAvailableMw, 0, generator.capacityMw),
      dispatchMw: clamp(restored?.dispatchMw ?? targetMw, 0, generator.capacityMw),
      targetMw: clamp(targetMw, 0, generator.capacityMw),
      reserveMw: generator.reserveMw,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      synchronisesAtElapsedMs: restored?.synchronisesAtElapsedMs ?? null,
    } satisfies GridGeneratorState]
  }))
  const loads = new Map(config.definition.model.loads.map(load => {
    const restored = restoredLoads.get(load.id)
    const nominalDemandMw = restored?.nominalDemandMw ?? load.demandMw * config.definition.operatingPoint.loadScale
    return [load.id, {
      nominalDemandMw,
      manualDemandLimitMw: restored?.manualDemandLimitMw ?? null,
      demandMw: nominalDemandMw,
      servedMw: nominalDemandMw,
      curtailedMw: 0,
      lfddShedMw: 0,
      shedMw: 0,
      shedCauses: [],
      frequencyHz: config.definition.model.nominalFrequencyHz,
      voltagePu: 1,
      serviceState: 'normal',
    } satisfies GridLoadState]
  }))
  const storage = new Map(config.definition.model.storage.map(item => {
    const restored = restoredStorage.get(item.id)
    return [item.id, {
      stateOfChargeFraction: clamp(restored?.stateOfChargeFraction ?? config.definition.operatingPoint.storageStateOfCharge, 0, 1),
      dispatchMw: restored?.dispatchMw ?? 0,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      voltagePu: 1,
      state: 'idle',
    } satisfies GridStorageState]
  }))
  const pointsById = new Map(config.definition.model.connectionPoints.map(point => [point.id, point]))
  const externalConnections = new Map((config.connections ?? []).flatMap(connection => {
    if (connection.network.objectId !== config.definition.gridId) return []
    const point = pointsById.get(connection.network.portId)
    if (!point) throw new Error(`Grid connection references unknown network port: ${connection.network.objectId}:${connection.network.portId}`)
    return [[point.id, {
      definition: connection,
      busId: point.busId,
      systemActivePowerMw: 0,
      connected: false,
    } satisfies GridExternalConnectionState] as const]
  }))
  return {
    definition: config.definition,
    elapsedMs: config.restored?.elapsedMs ?? 0,
    tick: config.restored?.tick ?? 0,
    branches,
    generators,
    loads,
    storage,
    externalConnections,
    busStates: new Map(),
    frequencyByIsland: new Map(config.restored?.frequencies.map(item => [item.islandId, item.frequencyHz])),
    topologyPlan: null,
    diagnostics: {
      lastSuccessfulTickAt: null,
      lastTickDurationMs: 0,
      maximumTickDurationMs: 0,
      topologyRebuildCount: 0,
      lastTopologyRebuildDurationMs: 0,
      queryCount: 0,
      lastQueryDurationMs: 0,
      persistenceFailureCount: 0,
      lastPersistenceFailure: null,
    },
    projection: {
      statusTone: 'idle',
      statusLabel: 'Initializing',
      summary: 'Grid runtime is initializing',
      nominalFrequencyHz: config.definition.model.nominalFrequencyHz,
      frequencyHz: config.definition.model.nominalFrequencyHz,
      totalGenerationMw: 0,
      totalLoadMw: 0,
      servedLoadMw: 0,
      unservedLoadMw: 0,
      reserveMarginMw: 0,
      highestBranchLoadingPercent: 0,
      lowestVoltagePu: 1,
      activeIslandCount: 1,
      activeAlarmCount: 0,
      tick: config.restored?.tick ?? 0,
      updatedAt: config.at,
    },
  }
}

/** Balance the starting conventional dispatch after connected systems publish their initial exchange. */
export const balanceInitialGridDispatch = (grid: GridRuntimeInstance): void => {
  const demandByComponent = new Map<string, number>()
  const externalByComponent = new Map<string, number>()
  const dispatchByComponent = new Map<string, number>()
  for (const load of grid.definition.model.loads) {
    const component = grid.definition.index.staticComponentByBus.get(load.busId)!
    demandByComponent.set(component, (demandByComponent.get(component) ?? 0) + grid.loads.get(load.id)!.demandMw)
  }
  for (const connection of grid.externalConnections.values()) {
    if (!connection.connected) continue
    const component = grid.definition.index.staticComponentByBus.get(connection.busId)!
    externalByComponent.set(component, (externalByComponent.get(component) ?? 0) + connection.systemActivePowerMw)
  }
  for (const generator of grid.definition.model.generators) {
    const component = grid.definition.index.staticComponentByBus.get(generator.busId)!
    dispatchByComponent.set(component, (dispatchByComponent.get(component) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  }
  for (const generator of grid.definition.model.generators) {
    const component = grid.definition.index.staticComponentByBus.get(generator.busId)!
    const current = dispatchByComponent.get(component) ?? 0
    const required = Math.max(0, (demandByComponent.get(component) ?? 0) - (externalByComponent.get(component) ?? 0))
    const factor = current <= 0 ? 0 : required / current
    const state = grid.generators.get(generator.id)!
    state.targetMw = Math.min(state.availableMw, state.targetMw * factor)
    state.dispatchMw = Math.min(state.availableMw, state.dispatchMw * factor)
  }
}

export const gridAssetSnapshotFor = (grid: GridRuntimeInstance, assetId: string): GridAssetSnapshot | undefined => {
  const entry = grid.definition.index.assetById.get(assetId)
  if (!entry) return undefined
  const state = entry.kind === 'bus'
    ? grid.busStates.get(entry.id)
    : entry.kind === 'branch'
      ? grid.branches.get(entry.id)
      : entry.kind === 'generator'
        ? grid.generators.get(entry.id)
        : entry.kind === 'load'
          ? grid.loads.get(entry.id)
          : grid.storage.get(entry.id)
  return {
    ...entry,
    ...(state === undefined ? {} : { state }),
  }
}

export const gridAssetSnapshots = (grid: GridRuntimeInstance): ReadonlyArray<GridAssetSnapshot> =>
  grid.definition.index.assets.map(entry => gridAssetSnapshotFor(grid, entry.id)!)
