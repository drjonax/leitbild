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
import type { GridIslandAcOutcome } from './ac-load-flow.ts'
import type { GeneratorTripCause } from './frequency/generator-protection.ts'
import { dispatchGridFromLiveIslands } from './dispatch.ts'
import { noReserves } from './frequency/governors.ts'
import { upwardReserveMw } from './reserve-allocation.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridAlarmState, type GridAlarmState, type PersistedGridAlarmState } from './alarms.ts'
import type { GridRuntimeSignal } from './grid-signals.ts'
import { createGridProtectionState, type GridBranchProtectionState, type GridGeneratorTripRecord, type GridProtectionState } from './protection/state.ts'
import { branchStatusCodes, codeOf, createGridStateArrays, storedNullable, type GridStateArrays } from './state/arrays.ts'
import { branchStateViews } from './state/views.ts'
import type { GridIslandSystem } from './network/dc-power-flow.ts'

/**
 * Where a bus voltage comes from. `ac-fdlf`: the island's AC load flow converged and the voltage
 * is its result; `not-converged`: the island is energised but its AC load flow failed, so no
 * voltage is known (never a DC or nominal stand-in); `de-energised`: no source holds the bus (0 pu).
 */
export type GridVoltageModel = 'ac-fdlf' | 'not-converged' | 'de-energised'

/** A bus at the last network solution: a read-only view of the bus arrays (state/views.ts). */
export interface GridBusState {
  readonly busId: string
  /** Stable id of the island holding the bus. */
  readonly islandId: string
  readonly energized: boolean
  /** AC voltage magnitude (pu); null while the island's AC load flow has not converged; 0 when de-energised. */
  readonly voltagePu: number | null
  readonly voltageModel: GridVoltageModel
  /** Net reactive injection of the bus's sources in the AC solution (Mvar: generation − demand, shunts are network); null unless converged; 0 when de-energised. */
  readonly reactiveInjectionMvar: number | null
  /** Island frequency; null when the bus is de-energised. */
  readonly frequencyHz: number | null
  /** DC voltage angle (rad), relative to the bus's AC component reference. */
  readonly angleRad: number
  /** Net active injection of the DC balance (MW), including the bus's share of branch losses. */
  readonly netInjectionMw: number
}

export interface GridBranchState {
  /** open: by operator; tripped: by its protection, open until reset-branch-protection. */
  state: 'closed' | 'open' | 'tripped'
  availability: number
  /**
   * Where flowMw and apparentPowerMva come from: 'ac' when the branch's island AC load flow
   * converged, 'dc' (the DC solution) when it did not, null when the branch carries no flow (open,
   * tripped or de-energised).
   */
  flowModel: 'ac' | 'dc' | null
  /** Active power entering the branch at its from end (MW), positive towards the to-bus. */
  flowMw: number
  /**
   * The flow its ratings bound, which loading, relays and alarms act on: the larger end apparent
   * power (MVA) with flowModel 'ac', |flowMw| with 'dc', 0 without flow.
   */
  apparentPowerMva: number
  /** apparentPowerMva over the derated continuous rating (%). */
  loadingPercent: number
  /** AC voltage at each end (pu); null while the island's AC load flow has not converged; 0 when de-energised. */
  voltageFromPu: number | null
  voltageToPu: number | null
  /** AC reactive power entering the branch at each end (Mvar); null unless the island's AC load flow converged. */
  reactiveFromMvar: number | null
  reactiveToMvar: number | null
  frequencyHz: number | null
  /** I²R loss of the AC solution when the island converged, else the quadratic DC estimate r·P²/S_base (MW). */
  lossesMw: number
  readonly protection: GridBranchProtectionState
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

/** manual: curtailment within the load's interruptible demand; emergency: manual shedding beyond it; lfdd: automatic. */
export type GridLoadShedCause = 'manual' | 'emergency' | 'lfdd'

/**
 * One load's service: demand follows the profile; a manual limit curtails it; latched LFDD stages
 * shed part of what remains; a de-energised island serves nothing (outage). Served load is what
 * is left, at the island's load self-regulation.
 */
export interface GridLoadState {
  /** Scheduled demand before the load profile (Model × Operating Point, or an EV charging schedule). */
  nominalDemandMw: number
  /** Demand before the load profile as the Model and Operating Point set it; an EV schedule below it uses interruptible demand. */
  readonly modelledDemandMw: number
  /** Manual shedding limit from shed-load: the load draws at most this; null when not shed manually. */
  manualDemandLimitMw: number | null
  /** The limit was set as emergency shedding, beyond the load's interruptible demand. */
  manualShedEmergency: boolean
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
  shedCauses: ReadonlyArray<GridLoadShedCause>
  servedMw: number
  frequencyHz: number | null
  /** Voltage of the load's bus (pu): the AC result, null while its island has not converged, 0 when de-energised. */
  voltagePu: number | null
  serviceState: 'normal' | 'constrained' | 'shed' | 'outage'
}

export interface GridStorageState {
  stateOfChargeFraction: number
  dispatchMw: number
  frequencyHz: number | null
  /** Voltage of the storage's bus (pu), as for loads. */
  voltagePu: number | null
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

/**
 * deblocked: the converters run and the transfer follows the set-point; blocked: stopped by
 * block-hvdc (or after a trip reset) at 0 MW until deblock-hvdc; tripped: stopped by the converter
 * protection or trip-hvdc at 0 MW until reset-hvdc-trip.
 */
export type GridHvdcLinkOperatingState = 'deblocked' | 'blocked' | 'tripped'

/** command: trip-hvdc; ac-voltage-loss: a converter terminal's AC bus was de-energised. */
export type GridHvdcTripCause = 'command' | 'ac-voltage-loss'

export interface GridHvdcTrip {
  readonly cause: GridHvdcTripCause
  readonly atElapsedMs: number
  /** Transfer at the trip (MW, signed like the set-point). */
  readonly transferMw: number
}

export interface GridHvdcLinkState {
  state: GridHvdcLinkOperatingState
  /** Set-point (MW): positive sends from the link's from-bus (its Norwegian converter) to its to-bus, so positive exports. */
  setpointMw: number
  /** Power sent at the sending converter (MW, signed like the set-point), ramping towards the set-point. */
  transferMw: number
  lossesMw: number
  /** The trip of a tripped link; null in every other state. */
  trip: GridHvdcTrip | null
}

/**
 * One AC component: buses joined by closed branches. Its first bus in model order is its DC angle
 * reference; it absorbs nothing, because the component's injections sum to zero by construction.
 */
export interface GridTopologyComponent {
  readonly referenceBusId: string
  /** Network indices of its buses, ascending (model order). */
  readonly busIndices: Int32Array
  /** Ids of `busIndices`, computed on first read. */
  readonly buses: ReadonlyArray<string>
  /** Index of the synchronous island holding the component. */
  readonly islandIndex: number
}

/**
 * A synchronous island: AC components that share one frequency. Components are joined by closed
 * branches, or by the synchronous external system whose boundary buses they hold: several
 * Norwegian components tied to the Nordic remainder run at its frequency as one island.
 */
export interface GridTopologyIsland {
  readonly id: string
  /** The reference bus of the island's first component. */
  readonly referenceBusId: string
  /** Network indices of its buses, ascending (model order). */
  readonly busIndices: Int32Array
  /** Model indices of its closed branches, ascending. */
  readonly branchIndices: Int32Array
  /** Model indices of its generators, loads and storage units: bus by bus, in model order within a bus. */
  readonly generatorIndices: Int32Array
  readonly loadIndices: Int32Array
  readonly storageIndices: Int32Array
  /** Model indices of the connection points at its buses, in model order. */
  readonly connectionPointIndices: Int32Array
  /** Synchronous external systems coupled to it through a boundary bus with a closed tie, in bus order. */
  readonly externalIndices: Int32Array
  /** Indices into the plan's components, ascending. */
  readonly componentIndices: ReadonlyArray<number>
  /** Ids and definitions of the integer lists above, computed on first read (queries, commands, tests); the runtime reads the lists. */
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
  /** Synchronous islands; their ids name the structure, not the stable island identity. */
  readonly islands: ReadonlyArray<GridTopologyIsland>
  /** AC components, ordered by their first bus. */
  readonly components: ReadonlyArray<GridTopologyComponent>
  /** DC systems aligned with `components`. */
  readonly systems: ReadonlyArray<GridIslandSystem>
  /** Structural island id of each bus id, computed on first read; the runtime reads `islandIndexOfBus`. */
  readonly islandIdByBus: ReadonlyMap<string, string>
  /** Plan island index per bus in model order. */
  readonly islandIndexOfBus: Int32Array
  /** Plan component index per bus in model order. */
  readonly componentIndexOfBus: Int32Array
  /** Latest solve per bus in model order: injection (MW) and angle (rad, relative to the bus's component reference). */
  readonly injectionsMw: Float64Array
  readonly anglesRad: Float64Array
  /** Latest solve per component, aligned with `components`: the component's injection sum, which must be 0. */
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
  /** The unit and protection element of a generator trip. */
  readonly trip?: { readonly unitId: string; readonly elementId: string; readonly cause: GeneratorTripCause }
}

export interface GridRuntimeInstance {
  readonly definition: CompiledGridDefinition
  elapsedMs: number
  tick: number
  /** The per-tick state the runtime works on, by model index (state/arrays.ts); the Maps below are views of it by id. */
  readonly arrays: GridStateArrays
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
  readonly protection: GridProtectionState
  readonly alarms: GridAlarmState
  /** The latest AC load-flow outcome of each energised island, by stable island id. */
  readonly acOutcomeByIsland: Map<string, GridIslandAcOutcome>
  /** Alarm transitions and protection trips waiting for the adapter to emit them, oldest first. */
  readonly signalQueue: GridRuntimeSignal[]
  readonly diagnostics: GridRuntimeDiagnostics
  projection: GridProjection
}

export interface GridExternalConnectionState {
  readonly definition: ElectricalConnectionDefinition
  readonly busId: string
  /** The connected system's object exists and its runtime is available: the bay links the Grid to a system. */
  systemPresent: boolean
  systemActivePowerMw: number
  /** The system exchanges power: its own port is connected and energised. */
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
  readonly branches: ReadonlyArray<{ readonly id: string; readonly state: GridBranchState['state']; readonly availability: number; readonly protection: GridBranchProtectionState }>
  readonly generators: ReadonlyArray<{
    readonly id: string
    readonly state: GridGeneratorState['state']
    readonly availableMw: number
    readonly targetMw: number
    readonly reserves: FrequencyReserveAllocation
    readonly synchronisesAtElapsedMs: number | null
  }>
  readonly loads: ReadonlyArray<{ readonly id: string; readonly nominalDemandMw: number; readonly manualDemandLimitMw: number | null; readonly manualShedEmergency: boolean }>
  readonly storage: ReadonlyArray<{ readonly id: string; readonly stateOfChargeFraction: number }>
  readonly externalSystems: ReadonlyArray<{ readonly id: string; readonly scheduledImportMw: number }>
  readonly hvdcLinks: ReadonlyArray<{ readonly id: string; readonly state: GridHvdcLinkOperatingState; readonly setpointMw: number; readonly transferMw: number; readonly trip: GridHvdcTrip | null }>
  readonly islands: ReadonlyArray<{ readonly id: string; readonly anchorBusId: string; readonly frequency: IslandFrequencyState | null }>
  readonly lossLoadByBusMw: ReadonlyArray<number>
  readonly protection: {
    readonly lastSampleElapsedMs: number | null
    readonly thermalInitialised: boolean
    readonly recordedGeneratorTrips: ReadonlyArray<GridGeneratorTripRecord & { readonly generatorId: string }>
  }
  readonly alarms: PersistedGridAlarmState
}

const requireRestored = <T extends { readonly id: string }>(items: ReadonlyArray<T>, ids: ReadonlyArray<string>, kind: string): ReadonlyMap<string, T> => {
  const byId = new Map(items.map(item => [item.id, item]))
  if (byId.size !== items.length || byId.size !== ids.length || ids.some(id => !byId.has(id))) {
    throw new Error(`stored Grid runtime state does not hold exactly the Model's ${kind}`)
  }
  return byId
}

const requiredValue = <Value,>(values: ReadonlyMap<string, Value>, id: string, subject: string): Value => {
  const value = values.get(id)
  if (value === undefined) throw new Error(`the Operating Point gives ${id} no ${subject}`)
  return value
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
  const initialBranchStates = new Map(operatingPoint.branchStates.map(entry => [entry.branchId, entry]))
  const arrays = createGridStateArrays(model.buses.length, model.branches.length)
  // Before the first solution a branch carries no flow: no flow model, 0 MW, 0 pu at both ends,
  // no reactive power or frequency. Its relays start idle unless restored.
  model.branches.forEach((branch, index) => {
    const stored = restoredBranches?.get(branch.id)
    const initial = requiredValue(initialBranchStates, branch.id, 'initial branch state')
    const branchArrays = arrays.branches
    branchArrays.status[index] = codeOf(branchStatusCodes, stored?.state ?? initial.state, `branch ${branch.id} state`)
    branchArrays.availability[index] = stored?.availability ?? initial.availability
    if (stored !== undefined) {
      branchArrays.thermalLevel[index] = stored.protection.thermalLevel
      branchArrays.overEmergencySinceElapsedMs[index] = storedNullable(stored.protection.overEmergencySinceElapsedMs, `branch ${branch.id} overEmergencySinceElapsedMs`)
      branchArrays.trip[index] = stored.protection.trip
    }
  })
  const branches = branchStateViews(model.branches.map(branch => branch.id), arrays.branches)
  const generators = new Map(model.generators.map(generator => {
    const stored = restoredGenerators?.get(generator.id)
    const availableMw = stored?.availableMw ?? Math.min(generator.capacityMw, generator.availableMw * operatingPoint.generationAvailabilityScale)
    if (availableMw > generator.capacityMw) throw new Error(`stored generator ${generator.id} availability exceeds its capacity`)
    if (!stored && generator.initialState === 'online' && availableMw < generator.minimumStableMw) {
      throw new Error(`generator ${generator.id} starts online with ${availableMw} MW available, below its minimum stable generation of ${generator.minimumStableMw} MW`)
    }
    const reserves = stored?.reserves ?? noReserves
    return [generator.id, {
      state: stored?.state ?? generator.initialState,
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
    const modelledDemandMw = load.demandMw * operatingPoint.loadScale
    const nominalDemandMw = stored?.nominalDemandMw ?? modelledDemandMw
    return [load.id, {
      nominalDemandMw,
      modelledDemandMw,
      manualDemandLimitMw: stored?.manualDemandLimitMw ?? null,
      manualShedEmergency: stored?.manualShedEmergency ?? false,
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
    if (fraction === null) throw new Error(`storage ${item.id} has no initial state of charge: Operating Point ${operatingPoint.id} gives none`)
    if (!(fraction >= 0 && fraction <= 1)) throw new Error(`storage ${item.id} state of charge must lie within 0..1`)
    return [item.id, {
      stateOfChargeFraction: fraction,
      dispatchMw: 0,
      frequencyHz: null,
      voltagePu: 0,
      state: 'unavailable',
    } satisfies GridStorageState]
  }))
  const scheduledExports = new Map(operatingPoint.externalExchanges.map(exchange => [exchange.systemId, exchange.scheduledExportMw]))
  const externalSystems = new Map(index.externalSystems.map(system => [system.id, {
    // An asynchronous system exchanges only through HVDC links; a synchronous one starts at its scheduled exchange.
    scheduledImportMw: restoredExternals?.get(system.id)?.scheduledImportMw ?? (system.synchronous ? -requiredValue(scheduledExports, system.id, 'scheduled exchange') : 0),
    importMw: 0,
    fcrMw: 0,
    afrrMw: 0,
    mechanicalMw: 0,
    islandId: null,
    energized: false,
  } satisfies GridExternalSystemState]))
  const hvdcSetpoints = new Map(operatingPoint.hvdcSetpoints.map(entry => [entry.linkId, entry.setpointMw]))
  const hvdcLinks = new Map(index.hvdcLinks.map(link => {
    const stored = restoredHvdc?.get(link.id)
    if (stored && stored.state !== 'deblocked' && (stored.setpointMw !== 0 || stored.transferMw !== 0)) throw new Error(`stored HVDC link ${link.id} is ${stored.state} but carries a set-point or transfer`)
    if (stored && (stored.state === 'tripped') !== (stored.trip !== null)) throw new Error(`stored HVDC link ${link.id} must carry a trip exactly when it is tripped`)
    // A fresh Grid starts with each link deblocked, transferring its Operating Point set-point.
    const setpointMw = stored?.setpointMw ?? requiredValue(hvdcSetpoints, link.id, 'HVDC set-point')
    return [link.id, {
      state: stored?.state ?? 'deblocked',
      setpointMw,
      transferMw: stored?.transferMw ?? setpointMw,
      lossesMw: 0,
      trip: stored?.trip ?? null,
    } satisfies GridHvdcLinkState]
  }))
  const pointsById = new Map(model.connectionPoints.map(point => [point.id, point]))
  const externalConnections = new Map<string, GridExternalConnectionState>()
  for (const connection of config.connections ?? []) {
    if (connection.network.objectId !== definition.gridId) continue
    const point = pointsById.get(connection.network.portId)
    if (!point) throw new Error(`Grid connection references unknown network port: ${connection.network.objectId}:${connection.network.portId}`)
    // One system per connection point: a second connection would replace the first's exchange.
    const existing = externalConnections.get(point.id)
    if (existing) throw new Error(`Grid connection point ${connection.network.objectId}:${point.id} is connected by both ${existing.definition.id} and ${connection.id}`)
    externalConnections.set(point.id, { definition: connection, busId: point.busId, systemPresent: true, systemActivePowerMw: 0, connected: false })
  }
  const grid: GridRuntimeInstance = {
    definition,
    elapsedMs: restored?.elapsedMs ?? 0,
    tick: restored?.tick ?? 0,
    arrays,
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
    protection: createGridProtectionState(restored?.protection),
    alarms: createGridAlarmState(restored?.alarms),
    acOutcomeByIsland: new Map(),
    signalQueue: [],
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
  voltageModel: 'ac-fdlf',
  voltageMinPu: null,
  voltageMaxPu: null,
  notConvergedIslandCount: 0,
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
