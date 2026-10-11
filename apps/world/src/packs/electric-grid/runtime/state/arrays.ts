import type { GridExternalConnectionState, GridExternalSystemState, GridHvdcLinkState, GridStorageState } from '../instance.ts'
import type { GridBranchTrip } from '../protection/state.ts'

// The Grid's per-tick state, one typed array per quantity in model order. The runtime reads and
// writes these by index; string ids and the published state objects live at the boundary
// (state/views.ts). A nullable quantity holds NaN for null.

/** Codes of the string-valued quantities: the position in each list is the stored code. */
export const branchStatusCodes = ['closed', 'open', 'tripped'] as const
export const flowModelCodes = [null, 'ac', 'dc'] as const
export const voltageModelCodes = ['ac-fdlf', 'not-converged', 'de-energised'] as const

export const generatorLifecycleCodes = ['online', 'offline', 'starting', 'stopping', 'tripped'] as const
export const loadServiceStateCodes = ['normal', 'constrained', 'shed', 'outage'] as const

export const branchClosed = 0
export const branchOpen = 1
export const branchTripped = 2
export const flowModelNone = 0
export const flowModelAc = 1
export const flowModelDc = 2
export const voltageModelAc = 0
export const voltageModelNotConverged = 1
export const voltageModelDeEnergised = 2
export const generatorOnline = 0
export const generatorOffline = 1
export const generatorStarting = 2
export const generatorStopping = 3
export const generatorTripped = 4
export const loadNormal = 0
export const loadConstrained = 1
export const loadShed = 2
export const loadOutage = 3

/** The code of `value` in `codes`; anything else is an explicit error. */
export const codeOf = <T>(codes: ReadonlyArray<T>, value: T, subject: string): number => {
  const code = codes.indexOf(value)
  if (code === -1) throw new Error(`${subject} cannot be ${String(value)}; it is one of ${codes.map(String).join(', ')}`)
  return code
}

/** A nullable quantity as stored: NaN for null. A NaN given as a value is an error, never a silent null. */
export const storedNullable = (value: number | null, subject: string): number => {
  if (value === null) return Number.NaN
  if (Number.isNaN(value)) throw new Error(`${subject} is NaN; a missing value is null`)
  return value
}

/** A stored nullable quantity as published: null for NaN. */
export const publishedNullable = (value: number): number | null => value === value ? value : null

/** Bus quantities of the last network solution. */
export interface GridBusArrays {
  /** Plan island of each bus at the last solution; its stable id is `solvedIslandIds[solvedIsland[bus]]`. */
  readonly solvedIsland: Int32Array
  /** Stable island id of each plan island at the last solution (reused, resized per solution). */
  readonly solvedIslandIds: string[]
  readonly energized: Uint8Array
  readonly voltagePu: Float64Array
  readonly voltageModel: Uint8Array
  readonly reactiveInjectionMvar: Float64Array
  readonly frequencyHz: Float64Array
  readonly angleRad: Float64Array
  readonly netInjectionMw: Float64Array
}

export interface GridBranchArrays {
  readonly status: Uint8Array
  readonly availability: Float64Array
  readonly flowModel: Uint8Array
  readonly flowMw: Float64Array
  readonly apparentPowerMva: Float64Array
  readonly loadingPercent: Float64Array
  readonly voltageFromPu: Float64Array
  readonly voltageToPu: Float64Array
  readonly reactiveFromMvar: Float64Array
  readonly reactiveToMvar: Float64Array
  readonly frequencyHz: Float64Array
  readonly lossesMw: Float64Array
  /** Relay state: conductor thermal level, start of the present excursion above the emergency rating (NaN: none), the trip. */
  readonly thermalLevel: Float64Array
  readonly overEmergencySinceElapsedMs: Float64Array
  readonly trip: Array<GridBranchTrip | null>
}

export interface GridGeneratorArrays {
  readonly lifecycle: Uint8Array
  readonly availableMw: Float64Array
  readonly dispatchMw: Float64Array
  readonly targetMw: Float64Array
  readonly scheduledMw: Float64Array
  readonly fcrMw: Float64Array
  readonly afrrMw: Float64Array
  readonly mfrrMw: Float64Array
  /** Reserve volumes allocated to each unit (FrequencyReserveAllocation, field by field). */
  readonly fcrNReserveMw: Float64Array
  readonly fcrDUpReserveMw: Float64Array
  readonly fcrDDownReserveMw: Float64Array
  readonly afrrUpReserveMw: Float64Array
  readonly afrrDownReserveMw: Float64Array
  readonly mfrrUpReserveMw: Float64Array
  readonly mfrrDownReserveMw: Float64Array
  readonly reserveMw: Float64Array
  readonly frequencyHz: Float64Array
  readonly synchronisesAtElapsedMs: Float64Array
}

export interface GridLoadArrays {
  readonly nominalDemandMw: Float64Array
  readonly modelledDemandMw: Float64Array
  readonly manualDemandLimitMw: Float64Array
  readonly manualShedEmergency: Uint8Array
  readonly demandMw: Float64Array
  readonly curtailedMw: Float64Array
  readonly lfddShedMw: Float64Array
  readonly outageMw: Float64Array
  readonly unservedMw: Float64Array
  readonly shedMw: Float64Array
  /** Position of the load's shed-cause list in load-service.ts shedCauseLists. */
  readonly shedCauses: Uint8Array
  readonly servedMw: Float64Array
  readonly frequencyHz: Float64Array
  readonly voltagePu: Float64Array
  readonly serviceState: Uint8Array
}

/** Per plan island scratch of one network solution, grown when a plan holds more islands. */
export interface GridIslandScratch {
  energised: Uint8Array
  acConverged: Uint8Array
  solve: Uint8Array
  frequencyHz: Float64Array
  /** Power supplied into and served in the energised islands over one solution (MW). */
  readonly balance: { suppliedMw: number; servedMw: number }
}

/**
 * The Grid's state by model index. Storage units, external systems, HVDC links and connection
 * points are few; their state objects (the ones the id Maps hold) are kept in model order here.
 */
export interface GridStateArrays {
  readonly buses: GridBusArrays
  readonly branches: GridBranchArrays
  readonly generators: GridGeneratorArrays
  readonly loads: GridLoadArrays
  readonly storage: ReadonlyArray<GridStorageState>
  readonly externalSystems: ReadonlyArray<GridExternalSystemState>
  readonly hvdcLinks: ReadonlyArray<GridHvdcLinkState>
  /** The system connected at each connection point, or null. */
  readonly connections: ReadonlyArray<GridExternalConnectionState | null>
  readonly islands: GridIslandScratch
}

const floats = (count: number, fill = 0): Float64Array => new Float64Array(count).fill(fill)

export const createGridGeneratorArrays = (count: number): GridGeneratorArrays => ({
  lifecycle: new Uint8Array(count),
  availableMw: floats(count),
  dispatchMw: floats(count),
  targetMw: floats(count),
  scheduledMw: floats(count),
  fcrMw: floats(count),
  afrrMw: floats(count),
  mfrrMw: floats(count),
  fcrNReserveMw: floats(count),
  fcrDUpReserveMw: floats(count),
  fcrDDownReserveMw: floats(count),
  afrrUpReserveMw: floats(count),
  afrrDownReserveMw: floats(count),
  mfrrUpReserveMw: floats(count),
  mfrrDownReserveMw: floats(count),
  reserveMw: floats(count),
  frequencyHz: floats(count, Number.NaN),
  synchronisesAtElapsedMs: floats(count, Number.NaN),
})

export const createGridLoadArrays = (count: number): GridLoadArrays => ({
  nominalDemandMw: floats(count),
  modelledDemandMw: floats(count),
  manualDemandLimitMw: floats(count, Number.NaN),
  manualShedEmergency: new Uint8Array(count),
  demandMw: floats(count),
  curtailedMw: floats(count),
  lfddShedMw: floats(count),
  outageMw: floats(count),
  unservedMw: floats(count),
  shedMw: floats(count),
  shedCauses: new Uint8Array(count),
  servedMw: floats(count),
  frequencyHz: floats(count, Number.NaN),
  voltagePu: floats(count),
  serviceState: new Uint8Array(count).fill(loadOutage),
})

export const createGridBranchArrays = (count: number): GridBranchArrays => ({
  status: new Uint8Array(count),
  availability: floats(count),
  flowModel: new Uint8Array(count),
  flowMw: floats(count),
  apparentPowerMva: floats(count),
  loadingPercent: floats(count),
  voltageFromPu: floats(count),
  voltageToPu: floats(count),
  reactiveFromMvar: floats(count, Number.NaN),
  reactiveToMvar: floats(count, Number.NaN),
  frequencyHz: floats(count, Number.NaN),
  lossesMw: floats(count),
  thermalLevel: floats(count),
  overEmergencySinceElapsedMs: floats(count, Number.NaN),
  trip: new Array<GridBranchTrip | null>(count).fill(null),
})

const createGridBusArrays = (count: number): GridBusArrays => ({
  solvedIsland: new Int32Array(count),
  solvedIslandIds: [],
  energized: new Uint8Array(count),
  voltagePu: floats(count),
  voltageModel: new Uint8Array(count).fill(voltageModelDeEnergised),
  reactiveInjectionMvar: floats(count),
  frequencyHz: floats(count, Number.NaN),
  angleRad: floats(count),
  netInjectionMw: floats(count),
})

export const createGridStateArrays = (config: {
  readonly buses: number
  readonly branches: GridBranchArrays
  readonly generators: GridGeneratorArrays
  readonly loads: GridLoadArrays
  readonly storage: ReadonlyArray<GridStorageState>
  readonly externalSystems: ReadonlyArray<GridExternalSystemState>
  readonly hvdcLinks: ReadonlyArray<GridHvdcLinkState>
  readonly connections: ReadonlyArray<GridExternalConnectionState | null>
}): GridStateArrays => ({
  buses: createGridBusArrays(config.buses),
  branches: config.branches,
  generators: config.generators,
  loads: config.loads,
  storage: config.storage,
  externalSystems: config.externalSystems,
  hvdcLinks: config.hvdcLinks,
  connections: config.connections,
  islands: { energised: new Uint8Array(0), acConverged: new Uint8Array(0), solve: new Uint8Array(0), frequencyHz: new Float64Array(0), balance: { suppliedMw: 0, servedMw: 0 } },
})

/** The island scratch sized for `islandCount` plan islands, zeroed. */
export const islandScratch = (arrays: GridStateArrays, islandCount: number): GridIslandScratch => {
  const scratch = arrays.islands
  if (scratch.energised.length < islandCount) {
    const capacity = Math.max(islandCount, scratch.energised.length * 2)
    scratch.energised = new Uint8Array(capacity)
    scratch.acConverged = new Uint8Array(capacity)
    scratch.solve = new Uint8Array(capacity)
    scratch.frequencyHz = new Float64Array(capacity)
  }
  scratch.energised.fill(0, 0, islandCount)
  scratch.acConverged.fill(0, 0, islandCount)
  scratch.solve.fill(0, 0, islandCount)
  scratch.frequencyHz.fill(Number.NaN, 0, islandCount)
  return scratch
}
