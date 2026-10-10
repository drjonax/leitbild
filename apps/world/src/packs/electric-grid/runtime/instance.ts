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
import type { IslandFrequencyState } from './frequency/island-state.ts'
import type { FrequencyReserveAllocation } from './frequency/types.ts'
import { dispatchGridFromLiveIslands } from './dispatch.ts'
import { noReserves } from './frequency/governors.ts'
import { upwardReserveMw } from './reserve-allocation.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import type { GridIslandSystem } from './network/dc-power-flow.ts'

/**
 * The DC model computes no voltage. A live bus reports nominal voltage (1.0 pu) marked
 * `dc-nominal`; that value is not a computed result.
 */
export type GridVoltageModel = 'dc-nominal'

export interface GridBusState {
  readonly busId: string
  /** Stable id of the island holding the bus. */
  islandId: string
  energized: boolean
  /** 1.0 (nominal, not computed) on a live bus, 0 on a de-energised bus. */
  voltagePu: number
  readonly voltageModel: GridVoltageModel
  /** Island frequency; null when the bus is de-energised. */
  frequencyHz: number | null
  angleRad: number
  /** Net injection solved by the DC flow (MW), including the bus's share of branch losses. */
  netInjectionMw: number
}

export interface GridBranchState {
  state: 'closed' | 'open'
  availability: number
  flowMw: number
  loadingPercent: number
  voltageFromPu: number
  voltageToPu: number
  frequencyHz: number | null
  /** Quadratic DC loss r·P²/S_base (MW). */
  lossesMw: number
}

/** tripped →(reset)→ offline →(start)→ starting →(start-up time)→ online →(stop)→ stopping →(0 MW)→ offline. */
export type GridGeneratorLifecycleState = 'online' | 'offline' | 'starting' | 'stopping' | 'tripped'

export interface GridGeneratorState {
  state: GridGeneratorLifecycleState
  availableMw: number
  /** Electrical output into the network (MW): mechanical power plus the unit's inertial share. */
  dispatchMw: number
  /** Operator or dispatch set-point; frequency control acts on top of it. */
  targetMw: number
  /** Set-point followed at the unit's ramp rate. */
  scheduledMw: number
  /** Activated FCR-N and FCR-D (MW). */
  fcrMw: number
  afrrMw: number
  mfrrMw: number
  /** Reserve volumes allocated to this unit at dispatch. */
  reserves: FrequencyReserveAllocation
  /** Upward reserve allocated (FCR-N, FCR-D up, aFRR up, mFRR up), MW. */
  reserveMw: number
  frequencyHz: number | null
  /** Grid elapsed time at which a starting unit synchronises; null in every other state. */
  synchronisesAtElapsedMs: number | null
}

export type GridLoadShedCause = 'manual' | 'lfdd'

/**
 * One load's service: demand follows the profile; a manual limit curtails it; latched LFDD stages
 * shed part of what remains; a de-energised island serves nothing (outage). Served load is what
 * is left, at the island's load self-regulation.
 */
export interface GridLoadState {
  /** Scheduled demand before the load profile (Model × Operating Point, or an EV charging schedule). */
  nominalDemandMw: number
  /** Manual shedding limit from shed-load: the load draws at most this; null when not shed manually. */
  manualDemandLimitMw: number | null
  /** Demand this tick, profiled, before any shedding. */
  demandMw: number
  /** Demand disconnected by the manual shedding limit. */
  curtailedMw: number
  /** Demand disconnected by latched LFDD stages; restored only by command. */
  lfddShedMw: number
  /** Demand not served because its island is de-energised. */
  outageMw: number
  /** Total demand not served: curtailed + LFDD shed + outage. */
  unservedMw: number
  /** Total shed demand: curtailedMw + lfddShedMw. */
  shedMw: number
  shedCauses: Array<GridLoadShedCause>
  servedMw: number
  frequencyHz: number | null
  voltagePu: number
  serviceState: 'normal' | 'constrained' | 'shed' | 'outage'
}

export interface GridStorageState {
  stateOfChargeFraction: number
  dispatchMw: number
  frequencyHz: number | null
  voltagePu: number
  state: 'idle' | 'charging' | 'discharging' | 'unavailable'
}

/** A synchronous or asynchronous neighbouring system and its live exchange. */
export interface GridExternalSystemState {
  /** Scheduled import into Norway (MW; negative exports), set by dispatch. */
  scheduledImportMw: number
  /** Power flowing in from the system (MW), including its inertial share and reserves. */
  importMw: number
  /** Activated FCR and aFRR of the system (MW). */
  fcrMw: number
  afrrMw: number
  /** Schedule, reserves and demand self-regulation before inertial sharing (MW). */
  mechanicalMw: number
  islandId: string | null
  energized: boolean
}

export interface GridHvdcLinkState {
  /** Set-point (MW): positive sends from the link's from-bus to its to-bus. */
  setpointMw: number
  /** Power sent at the sending converter (MW, signed like the set-point), ramping towards the set-point. */
  transferMw: number
  lossesMw: number
}

export interface GridTopologyIsland {
  readonly id: string
  /** The island's first bus in model order: the DC angle reference. It absorbs nothing; the island balance closes by construction. */
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
  /** Structural islands; their ids name the structure, not the stable island identity. */
  readonly islands: ReadonlyArray<GridTopologyIsland>
  /** DC systems aligned with `islands`. */
  readonly systems: ReadonlyArray<GridIslandSystem>
  readonly islandIdByBus: ReadonlyMap<string, string>
  /** Plan island index per bus in model order. */
  readonly islandIndexOfBus: Int32Array
  /** Latest solve per bus in model order: injection (MW) and angle (rad). */
  readonly injectionsMw: Float64Array
  readonly anglesRad: Float64Array
  /** Latest solve per island, aligned with `islands`: the island's injection sum, which must be 0. */
  readonly referenceMismatchMw: Float64Array
}

/** A stable electrical island: identity survives splits and merges; frequency state is null while de-energised. */
export interface GridIsland {
  readonly id: string
  /** Index of the plan island this record follows. */
  readonly planIndex: number
  /** A bus of the island; locates the island again in a rebuilt plan. */
  readonly anchorBusId: string
  energized: boolean
  frequency: IslandFrequencyState | null
  rocofHzPerSecond: number | null
  /** Lowest and highest frequency reached in the last advance (Hz). */
  minimumHz: number | null
  maximumHz: number | null
}

export interface GridIslandPlan {
  readonly plan: GridTopologyPlan
  /** Aligned with `plan.islands`. */
  readonly islands: ReadonlyArray<GridIsland>
}

export interface GridEnergyAudit {
  /** Largest |Σ injection| of an energised island at the last solve (MW); balance closes by construction, so this stays below 1e-6. */
  lastMaximumIslandMismatchMw: number
  /** ∫ Σ |island injection sum| dt (MWh). */
  cumulativeMismatchMwh: number
  /** Energy integrals over the run (MWh): generation and imports into islands, served demand, network losses. */
  suppliedEnergyMwh: number
  servedEnergyMwh: number
  lossEnergyMwh: number
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
  energyAudit: GridEnergyAudit
}

/** A discrete frequency-control action taken inside the runtime (protection trip, LFDD stage, mFRR, collapse). */
export interface GridFrequencyEvent {
  readonly islandId: string
  readonly atElapsedSeconds: number
  readonly kind: 'generator-trip' | 'lfdd-stage-operated' | 'mfrr-activated' | 'storage-state-changed' | 'island-collapsed'
  readonly summary: string
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
  readonly externalSystems: Map<string, GridExternalSystemState>
  readonly hvdcLinks: Map<string, GridHvdcLinkState>
  busStates: Map<string, GridBusState>
  topologyPlan: GridTopologyPlan | null
  /** Stable islands reconciled against `islandPlan.plan`; null before the first tick. */
  islandPlan: GridIslandPlan | null
  /** Persisted islands, consumed by the first reconciliation of a restored Grid. */
  restoredIslands: RestoredGridRuntimeState['islands'] | null
  /** Loss load each bus carries in the island balance (MW, model bus order): half of the losses of its closed branches at the last solve. */
  readonly lossLoadByBusMw: Float64Array
  /** Bounded list of the latest discrete frequency-control actions, newest last. */
  readonly frequencyEvents: GridFrequencyEvent[]
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
  readonly branches: ReadonlyArray<{ readonly id: string; readonly state: GridBranchState['state']; readonly availability: number }>
  readonly generators: ReadonlyArray<{
    readonly id: string
    readonly state: GridGeneratorState['state']
    readonly availableMw: number
    readonly targetMw: number
    readonly reserves: FrequencyReserveAllocation
    readonly synchronisesAtElapsedMs: number | null
  }>
  readonly loads: ReadonlyArray<{ readonly id: string; readonly nominalDemandMw: number; readonly manualDemandLimitMw: number | null }>
  readonly storage: ReadonlyArray<{ readonly id: string; readonly stateOfChargeFraction: number }>
  readonly externalSystems: ReadonlyArray<{ readonly id: string; readonly scheduledImportMw: number }>
  readonly hvdcLinks: ReadonlyArray<{ readonly id: string; readonly setpointMw: number; readonly transferMw: number }>
  readonly islands: ReadonlyArray<{ readonly id: string; readonly anchorBusId: string; readonly frequency: IslandFrequencyState | null }>
  readonly lossLoadByBusMw: ReadonlyArray<number>
}

const requireRestored = <T extends { readonly id: string }>(items: ReadonlyArray<T>, ids: ReadonlyArray<string>, kind: string): ReadonlyMap<string, T> => {
  const byId = new Map(items.map(item => [item.id, item]))
  if (byId.size !== items.length || byId.size !== ids.length || ids.some(id => !byId.has(id))) {
    throw new Error(`stored Grid runtime state does not hold exactly the Model's ${kind}`)
  }
  return byId
}

export const createGridRuntimeInstance = (config: {
  readonly definition: CompiledGridDefinition
  readonly at: string
  readonly restored?: RestoredGridRuntimeState
  readonly connections?: ReadonlyArray<ElectricalConnectionDefinition>
}): GridRuntimeInstance => {
  const { definition, restored } = config
  const { model, operatingPoint, index } = definition
  const restoredBranches = restored ? requireRestored(restored.branches, model.branches.map(item => item.id), 'branches') : null
  const restoredGenerators = restored ? requireRestored(restored.generators, model.generators.map(item => item.id), 'generators') : null
  const restoredLoads = restored ? requireRestored(restored.loads, model.loads.map(item => item.id), 'loads') : null
  const restoredStorage = restored ? requireRestored(restored.storage, model.storage.map(item => item.id), 'storage') : null
  const restoredExternals = restored ? requireRestored(restored.externalSystems, index.externalSystems.map(item => item.id), 'external systems') : null
  const restoredHvdc = restored ? requireRestored(restored.hvdcLinks, index.hvdcLinks.map(item => item.id), 'HVDC links') : null
  if (restored && restored.lossLoadByBusMw.length !== model.buses.length) throw new Error('stored Grid runtime state has a loss vector of the wrong length')
  const branches = new Map(model.branches.map(branch => {
    const stored = restoredBranches?.get(branch.id)
    return [branch.id, {
      state: stored?.state ?? 'closed',
      availability: stored?.availability ?? 1,
      flowMw: 0,
      loadingPercent: 0,
      voltageFromPu: 0,
      voltageToPu: 0,
      frequencyHz: null,
      lossesMw: 0,
    } satisfies GridBranchState]
  }))
  const generators = new Map(model.generators.map(generator => {
    const stored = restoredGenerators?.get(generator.id)
    const availableMw = stored?.availableMw ?? Math.min(generator.capacityMw, generator.availableMw * operatingPoint.generationAvailabilityScale)
    if (availableMw > generator.capacityMw) throw new Error(`stored generator ${generator.id} availability exceeds its capacity`)
    const reserves = stored?.reserves ?? noReserves
    return [generator.id, {
      state: stored?.state ?? 'online',
      availableMw,
      dispatchMw: 0,
      // A fresh Grid is dispatched from its live islands before the first advance.
      targetMw: stored?.targetMw ?? 0,
      scheduledMw: 0,
      fcrMw: 0,
      afrrMw: 0,
      mfrrMw: 0,
      reserves,
      reserveMw: upwardReserveMw(reserves),
      frequencyHz: null,
      synchronisesAtElapsedMs: stored?.synchronisesAtElapsedMs ?? null,
    } satisfies GridGeneratorState]
  }))
  const loads = new Map(model.loads.map(load => {
    const stored = restoredLoads?.get(load.id)
    const nominalDemandMw = stored?.nominalDemandMw ?? load.demandMw * operatingPoint.loadScale
    return [load.id, {
      nominalDemandMw,
      manualDemandLimitMw: stored?.manualDemandLimitMw ?? null,
      demandMw: nominalDemandMw,
      curtailedMw: 0,
      lfddShedMw: 0,
      outageMw: nominalDemandMw,
      unservedMw: nominalDemandMw,
      shedMw: 0,
      shedCauses: [],
      servedMw: 0,
      frequencyHz: null,
      voltagePu: 0,
      serviceState: 'outage',
    } satisfies GridLoadState]
  }))
  const storage = new Map(model.storage.map(item => {
    const fraction = restoredStorage?.get(item.id)?.stateOfChargeFraction ?? operatingPoint.storageStateOfCharge
    if (!(fraction >= 0 && fraction <= 1)) throw new Error(`storage ${item.id} state of charge must lie within 0..1`)
    return [item.id, {
      stateOfChargeFraction: fraction,
      dispatchMw: 0,
      frequencyHz: null,
      voltagePu: 0,
      state: 'unavailable',
    } satisfies GridStorageState]
  }))
  const externalSystems = new Map(index.externalSystems.map(system => [system.id, {
    scheduledImportMw: restoredExternals?.get(system.id)?.scheduledImportMw ?? 0,
    importMw: 0,
    fcrMw: 0,
    afrrMw: 0,
    mechanicalMw: 0,
    islandId: null,
    energized: false,
  } satisfies GridExternalSystemState]))
  const hvdcLinks = new Map(index.hvdcLinks.map(link => {
    const stored = restoredHvdc?.get(link.id)
    return [link.id, { setpointMw: stored?.setpointMw ?? 0, transferMw: stored?.transferMw ?? 0, lossesMw: 0 } satisfies GridHvdcLinkState]
  }))
  const pointsById = new Map(model.connectionPoints.map(point => [point.id, point]))
  const externalConnections = new Map((config.connections ?? []).flatMap(connection => {
    if (connection.network.objectId !== definition.gridId) return []
    const point = pointsById.get(connection.network.portId)
    if (!point) throw new Error(`Grid connection references unknown network port: ${connection.network.objectId}:${connection.network.portId}`)
    return [[point.id, {
      definition: connection,
      busId: point.busId,
      systemActivePowerMw: 0,
      connected: false,
    } satisfies GridExternalConnectionState] as const]
  }))
  const grid: GridRuntimeInstance = {
    definition,
    elapsedMs: restored?.elapsedMs ?? 0,
    tick: restored?.tick ?? 0,
    branches,
    generators,
    loads,
    storage,
    externalConnections,
    externalSystems,
    hvdcLinks,
    busStates: new Map(),
    topologyPlan: null,
    islandPlan: null,
    restoredIslands: restored?.islands ?? null,
    lossLoadByBusMw: restored ? Float64Array.from(restored.lossLoadByBusMw) : new Float64Array(model.buses.length),
    frequencyEvents: [],
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
      energyAudit: { lastMaximumIslandMismatchMw: 0, cumulativeMismatchMwh: 0, suppliedEnergyMwh: 0, servedEnergyMwh: 0, lossEnergyMwh: 0 },
    },
    projection: initialGridProjection(config.at, model.nominalFrequencyHz, restored?.tick ?? 0),
  }
  // A fresh Grid starts dispatched from its live islands; a restored one keeps its stored set-points.
  if (!restored) dispatchGridFromLiveIslands(grid, Date.parse(config.at))
  return grid
}

const initialGridProjection = (at: string, nominalFrequencyHz: number, tick: number): GridProjection => ({
  statusTone: 'idle',
  statusLabel: 'Initializing',
  summary: 'Grid runtime is initializing',
  nominalFrequencyHz,
  frequencyHz: null,
  frequencyBasis: 'largest-load-energized-island',
  frequencyIslandId: null,
  frequencyMinHz: null,
  frequencyMaxHz: null,
  voltageModel: 'dc-nominal',
  totalGenerationMw: 0,
  totalLoadMw: 0,
  servedLoadMw: 0,
  unservedLoadMw: 0,
  lossesMw: 0,
  reserveMarginMw: 0,
  highestBranchLoadingPercent: 0,
  activeIslandCount: 0,
  islandCount: 0,
  activeAlarmCount: 0,
  islands: [],
  energyAudit: { maximumIslandMismatchMw: 0, cumulativeMismatchMwh: 0 },
  tick,
  updatedAt: at,
})

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
