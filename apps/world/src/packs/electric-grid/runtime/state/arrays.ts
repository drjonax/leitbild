import type { GridBranchTrip } from '../protection/state.ts'

// The Grid's per-tick state, one typed array per quantity in model order. The runtime reads and
// writes these by index; string ids and the published state objects live at the boundary
// (state/views.ts). A nullable quantity holds NaN for null.

/** Codes of the string-valued quantities: the position in each list is the stored code. */
export const branchStatusCodes = ['closed', 'open', 'tripped'] as const
export const flowModelCodes = [null, 'ac', 'dc'] as const
export const voltageModelCodes = ['ac-fdlf', 'not-converged', 'de-energised'] as const

export const branchClosed = 0
export const branchOpen = 1
export const branchTripped = 2
export const flowModelNone = 0
export const flowModelAc = 1
export const flowModelDc = 2
export const voltageModelAc = 0
export const voltageModelNotConverged = 1
export const voltageModelDeEnergised = 2

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

/** Per plan island scratch of one network solution, grown when a plan holds more islands. */
export interface GridIslandScratch {
  energised: Uint8Array
  acConverged: Uint8Array
  solve: Uint8Array
  frequencyHz: Float64Array
}

export interface GridStateArrays {
  readonly buses: GridBusArrays
  readonly branches: GridBranchArrays
  readonly islands: GridIslandScratch
}

export const createGridStateArrays = (busCount: number, branchCount: number): GridStateArrays => ({
  buses: {
    solvedIsland: new Int32Array(busCount),
    solvedIslandIds: [],
    energized: new Uint8Array(busCount),
    voltagePu: new Float64Array(busCount),
    voltageModel: new Uint8Array(busCount).fill(voltageModelDeEnergised),
    reactiveInjectionMvar: new Float64Array(busCount),
    frequencyHz: new Float64Array(busCount).fill(Number.NaN),
    angleRad: new Float64Array(busCount),
    netInjectionMw: new Float64Array(busCount),
  },
  branches: {
    status: new Uint8Array(branchCount),
    availability: new Float64Array(branchCount),
    flowModel: new Uint8Array(branchCount),
    flowMw: new Float64Array(branchCount),
    apparentPowerMva: new Float64Array(branchCount),
    loadingPercent: new Float64Array(branchCount),
    voltageFromPu: new Float64Array(branchCount),
    voltageToPu: new Float64Array(branchCount),
    reactiveFromMvar: new Float64Array(branchCount).fill(Number.NaN),
    reactiveToMvar: new Float64Array(branchCount).fill(Number.NaN),
    frequencyHz: new Float64Array(branchCount).fill(Number.NaN),
    lossesMw: new Float64Array(branchCount),
    thermalLevel: new Float64Array(branchCount),
    overEmergencySinceElapsedMs: new Float64Array(branchCount).fill(Number.NaN),
    trip: new Array<GridBranchTrip | null>(branchCount).fill(null),
  },
  islands: { energised: new Uint8Array(0), acConverged: new Uint8Array(0), solve: new Uint8Array(0), frequencyHz: new Float64Array(0) },
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
