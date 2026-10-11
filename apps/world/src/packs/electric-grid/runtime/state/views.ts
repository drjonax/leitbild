import type { GridBranchTrip } from '../protection/state.ts'
import type { GridBranchProtectionState } from '../protection/state.ts'
import type { GridBranchState, GridBusState } from '../instance.ts'
import {
  branchStatusCodes,
  codeOf,
  flowModelCodes,
  publishedNullable,
  storedNullable,
  voltageModelCodes,
  type GridBranchArrays,
  type GridBusArrays,
} from './arrays.ts'

// Boundary views of the typed state: one object per asset, built once per Grid, whose own
// enumerable accessors (in the published key order) read and write the arrays. Queries,
// persistence, projection, commands and tests see the same shapes as plain state objects:
// JSON.stringify, structuredClone, spread and equality read the accessors. The runtime itself
// works on the arrays.

const viewIndex = Symbol('grid state index')

interface Indexed {
  readonly [viewIndex]: number
}

type Accessor = { readonly get: (this: Indexed) => unknown; readonly set?: (this: Indexed, value: never) => void }

/** A view of asset `index` with the given accessors (shared by all views of a kind) and plain data properties. */
const view = <T>(index: number, accessors: Readonly<Record<string, Accessor>>, data: Readonly<Record<string, unknown>> = {}): T => {
  const target = Object.defineProperty({}, viewIndex, { value: index })
  for (const [key, value] of Object.entries(data)) Object.defineProperty(target, key, { value, enumerable: true })
  for (const [key, accessor] of Object.entries(accessors)) {
    Object.defineProperty(target, key, { enumerable: true, get: accessor.get, ...(accessor.set === undefined ? {} : { set: accessor.set }) })
  }
  return target as T
}

const numberField = (values: Float64Array): Accessor => ({
  get() { return values[this[viewIndex]]! },
  set(value: number) { values[this[viewIndex]] = value },
})

const nullableField = (values: Float64Array, subject: string): Accessor => ({
  get() { return publishedNullable(values[this[viewIndex]]!) },
  set(value: number | null) { values[this[viewIndex]] = storedNullable(value, subject) },
})

const codeField = <T>(codes: ReadonlyArray<T>, values: Uint8Array, subject: string): Accessor => ({
  get() { return codes[values[this[viewIndex]]!] },
  set(value: T) { values[this[viewIndex]] = codeOf(codes, value, subject) },
})

const readOnly = (get: (index: number) => unknown): Accessor => ({ get() { return get(this[viewIndex]) } })

/** Relay state of each branch, readable and writable as GridBranchProtectionState. */
const branchProtectionViews = (arrays: GridBranchArrays): ReadonlyArray<GridBranchProtectionState> => {
  const accessors: Record<string, Accessor> = {
    thermalLevel: numberField(arrays.thermalLevel),
    overEmergencySinceElapsedMs: nullableField(arrays.overEmergencySinceElapsedMs, 'branch overEmergencySinceElapsedMs'),
    trip: {
      get() { return arrays.trip[this[viewIndex]]! },
      set(value: GridBranchTrip | null) { arrays.trip[this[viewIndex]] = value },
    },
  }
  return Array.from({ length: arrays.status.length }, (_, index) => view<GridBranchProtectionState>(index, accessors))
}

/** Branch states by id over the branch arrays, in model order. */
export const branchStateViews = (branchIds: ReadonlyArray<string>, arrays: GridBranchArrays): Map<string, GridBranchState> => {
  const protection = branchProtectionViews(arrays)
  const accessors: Record<string, Accessor> = {
    state: codeField(branchStatusCodes, arrays.status, 'branch state'),
    availability: numberField(arrays.availability),
    flowModel: codeField(flowModelCodes, arrays.flowModel, 'branch flowModel'),
    flowMw: numberField(arrays.flowMw),
    apparentPowerMva: numberField(arrays.apparentPowerMva),
    loadingPercent: numberField(arrays.loadingPercent),
    voltageFromPu: nullableField(arrays.voltageFromPu, 'branch voltageFromPu'),
    voltageToPu: nullableField(arrays.voltageToPu, 'branch voltageToPu'),
    reactiveFromMvar: nullableField(arrays.reactiveFromMvar, 'branch reactiveFromMvar'),
    reactiveToMvar: nullableField(arrays.reactiveToMvar, 'branch reactiveToMvar'),
    frequencyHz: nullableField(arrays.frequencyHz, 'branch frequencyHz'),
    lossesMw: numberField(arrays.lossesMw),
    protection: readOnly(index => protection[index]),
  }
  return new Map(branchIds.map((id, index) => [id, view<GridBranchState>(index, accessors)]))
}

/** Bus states by id over the bus arrays of the last network solution, in model order. */
export const busStateViews = (busIds: ReadonlyArray<string>, arrays: GridBusArrays): Map<string, GridBusState> => {
  const accessors: Record<string, Accessor> = {
    islandId: readOnly(index => arrays.solvedIslandIds[arrays.solvedIsland[index]!]),
    energized: readOnly(index => arrays.energized[index] === 1),
    voltagePu: readOnly(index => publishedNullable(arrays.voltagePu[index]!)),
    voltageModel: readOnly(index => voltageModelCodes[arrays.voltageModel[index]!]),
    reactiveInjectionMvar: readOnly(index => publishedNullable(arrays.reactiveInjectionMvar[index]!)),
    frequencyHz: readOnly(index => publishedNullable(arrays.frequencyHz[index]!)),
    angleRad: readOnly(index => arrays.angleRad[index]),
    netInjectionMw: readOnly(index => arrays.netInjectionMw[index]),
  }
  return new Map(busIds.map((busId, index) => [busId, view<GridBusState>(index, accessors, { busId })]))
}
