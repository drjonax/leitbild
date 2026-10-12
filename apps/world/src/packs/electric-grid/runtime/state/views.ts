import type { FrequencyReserveAllocation } from '../frequency/types.ts'
import type { GridBranchState, GridBusState, GridGeneratorState, GridLoadState } from '../instance.ts'
import { shedCauseLists } from '../load-service.ts'
import type { GridBranchProtectionState, GridBranchTrip } from '../protection/state.ts'
import {
  branchStatusCodes,
  codeOf,
  flowModelCodes,
  generatorLifecycleCodes,
  loadServiceStateCodes,
  publishedNullable,
  storedNullable,
  voltageModelCodes,
  type GridBranchArrays,
  type GridBusArrays,
  type GridGeneratorArrays,
  type GridLoadArrays,
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
    // −1: a separated boundary bus, in no island.
    islandId: readOnly(index => arrays.solvedIsland[index]! < 0 ? null : arrays.solvedIslandIds[arrays.solvedIsland[index]!]),
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

/** The reserve allocation of a unit as stored: one array per product field. */
export const writeReserves = (arrays: GridGeneratorArrays, index: number, reserves: FrequencyReserveAllocation): void => {
  arrays.fcrNReserveMw[index] = reserves.fcrNMw
  arrays.fcrDUpReserveMw[index] = reserves.fcrDUpMw
  arrays.fcrDDownReserveMw[index] = reserves.fcrDDownMw
  arrays.afrrUpReserveMw[index] = reserves.afrrUpMw
  arrays.afrrDownReserveMw[index] = reserves.afrrDownMw
  arrays.mfrrUpReserveMw[index] = reserves.mfrrUpMw
  arrays.mfrrDownReserveMw[index] = reserves.mfrrDownMw
}

/** A unit's reserve allocation as a published object (a copy; the arrays hold the state). */
export const readReserves = (arrays: GridGeneratorArrays, index: number): FrequencyReserveAllocation => ({
  fcrNMw: arrays.fcrNReserveMw[index]!,
  fcrDUpMw: arrays.fcrDUpReserveMw[index]!,
  fcrDDownMw: arrays.fcrDDownReserveMw[index]!,
  afrrUpMw: arrays.afrrUpReserveMw[index]!,
  afrrDownMw: arrays.afrrDownReserveMw[index]!,
  mfrrUpMw: arrays.mfrrUpReserveMw[index]!,
  mfrrDownMw: arrays.mfrrDownReserveMw[index]!,
})

/** Generator states by id over the generator arrays, in model order. */
export const generatorStateViews = (generatorIds: ReadonlyArray<string>, arrays: GridGeneratorArrays): Map<string, GridGeneratorState> => {
  const accessors: Record<string, Accessor> = {
    state: codeField(generatorLifecycleCodes, arrays.lifecycle, 'generator state'),
    availableMw: numberField(arrays.availableMw),
    dispatchMw: numberField(arrays.dispatchMw),
    targetMw: numberField(arrays.targetMw),
    scheduledMw: numberField(arrays.scheduledMw),
    fcrMw: numberField(arrays.fcrMw),
    afrrMw: numberField(arrays.afrrMw),
    mfrrMw: numberField(arrays.mfrrMw),
    reserves: {
      get() { return readReserves(arrays, this[viewIndex]) },
      set(value: FrequencyReserveAllocation) { writeReserves(arrays, this[viewIndex], value) },
    },
    reserveMw: numberField(arrays.reserveMw),
    frequencyHz: nullableField(arrays.frequencyHz, 'generator frequencyHz'),
    synchronisesAtElapsedMs: nullableField(arrays.synchronisesAtElapsedMs, 'generator synchronisesAtElapsedMs'),
  }
  return new Map(generatorIds.map((id, index) => [id, view<GridGeneratorState>(index, accessors)]))
}

/** Load states by id over the load arrays, in model order. */
export const loadStateViews = (loadIds: ReadonlyArray<string>, arrays: GridLoadArrays): Map<string, GridLoadState> => {
  const accessors: Record<string, Accessor> = {
    nominalDemandMw: numberField(arrays.nominalDemandMw),
    modelledDemandMw: readOnly(index => arrays.modelledDemandMw[index]),
    manualDemandLimitMw: nullableField(arrays.manualDemandLimitMw, 'load manualDemandLimitMw'),
    manualShedEmergency: {
      get() { return arrays.manualShedEmergency[this[viewIndex]] === 1 },
      set(value: boolean) { arrays.manualShedEmergency[this[viewIndex]] = value ? 1 : 0 },
    },
    profileFactor: readOnly(index => arrays.profileFactor[index]),
    demandMw: numberField(arrays.demandMw),
    curtailedMw: numberField(arrays.curtailedMw),
    lfddShedMw: numberField(arrays.lfddShedMw),
    outageMw: numberField(arrays.outageMw),
    unservedMw: numberField(arrays.unservedMw),
    shedMw: numberField(arrays.shedMw),
    shedCauses: readOnly(index => shedCauseLists[arrays.shedCauses[index]!]),
    servedMw: numberField(arrays.servedMw),
    networkLossMw: readOnly(index => arrays.networkLossMw[index]),
    frequencyHz: nullableField(arrays.frequencyHz, 'load frequencyHz'),
    voltagePu: nullableField(arrays.voltagePu, 'load voltagePu'),
    serviceState: codeField(loadServiceStateCodes, arrays.serviceState, 'load serviceState'),
  }
  return new Map(loadIds.map((id, index) => [id, view<GridLoadState>(index, accessors)]))
}
