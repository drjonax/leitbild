import type { GridLoadDefinition } from '../grid-model.ts'
import type { GridLoadShedCause } from './instance.ts'
import { manualCurtailmentMw } from './load-shedding.ts'
import { loadConstrained, loadNormal, loadOutage, loadShed, type GridLoadArrays } from './state/arrays.ts'

// A load serves at least its critical demand: neither manual nor automatic shedding disconnects it.
// Load service is constrained 0.2 Hz from nominal: outside the Nordic normal band (49.9–50.1 Hz) and the FCR-N range.
const constrainedDeviationHz = 0.2

/**
 * Applies the manual shedding limit to load `index` for this demand sample: the load draws at most
 * the limit, never less than its critical demand, and a curtailment never more than its interruptible demand.
 */
export const curtailGridLoad = (loads: GridLoadArrays, index: number, load: GridLoadDefinition): void => {
  loads.curtailedMw[index] = manualCurtailmentMw(load, loads, index)
}

/** Demand of load `index` still connected after manual curtailment: what frequency control and LFDD act on. */
export const connectedGridLoadMw = (loads: GridLoadArrays, index: number): number => loads.demandMw[index]! - loads.curtailedMw[index]!

/**
 * Losses below 132 kV that load `index` draws while its bus is energised: its profiled losses times
 * the share of its demand still connected after manual curtailment and LFDD, whose feeders take the
 * network below them out of service. Never itself curtailed, shed or counted as demand.
 */
export const connectedNetworkLossMw = (loads: GridLoadArrays, index: number): number => {
  const demandMw = loads.demandMw[index]!
  if (!(demandMw > 0)) return 0
  // Linear in the connected share, a middle estimate: I²R losses fall roughly with the square of the load, transformer no-load losses not at all.
  return loads.profiledNetworkLossMw[index]! * Math.max(0, demandMw - loads.curtailedMw[index]! - loads.lfddShedMw[index]!) / demandMw
}

// The possible cause lists, shared: every live load is completed on every network solution. A
// load's shedCauses code is its position here.
export const shedCauseLists: ReadonlyArray<ReadonlyArray<GridLoadShedCause>> = [
  Object.freeze([]), Object.freeze(['manual' as const]), Object.freeze(['emergency' as const]),
  Object.freeze(['lfdd' as const]), Object.freeze(['manual' as const, 'lfdd' as const]), Object.freeze(['emergency' as const, 'lfdd' as const]),
]

const shedCausesCode = (loads: GridLoadArrays, index: number): number =>
  (loads.curtailedMw[index]! > 0 ? (loads.manualShedEmergency[index] === 1 ? 2 : 1) : 0) + (loads.lfddShedMw[index]! > 0 ? 3 : 0)

/** Closes a live load's service for this tick from its served and LFDD-shed demand; its voltage follows from the AC solution. */
export const completeLiveGridLoad = (loads: GridLoadArrays, index: number, frequencyHz: number, nominalFrequencyHz: number): void => {
  loads.outageMw[index] = 0
  const shedMw = loads.curtailedMw[index]! + loads.lfddShedMw[index]!
  loads.shedMw[index] = shedMw
  loads.unservedMw[index] = shedMw
  loads.shedCauses[index] = shedCausesCode(loads, index)
  loads.frequencyHz[index] = frequencyHz
  loads.serviceState[index] = shedMw > 0 ? loadShed : Math.abs(frequencyHz - nominalFrequencyHz) >= constrainedDeviationHz ? loadConstrained : loadNormal
}

/** A load in a de-energised island is out of supply: nothing is served and no LFDD stage holds it. */
export const completeDeadGridLoad = (loads: GridLoadArrays, index: number): void => {
  loads.servedMw[index] = 0
  loads.networkLossMw[index] = 0
  loads.lfddShedMw[index] = 0
  loads.outageMw[index] = loads.demandMw[index]! - loads.curtailedMw[index]!
  loads.shedMw[index] = loads.curtailedMw[index]!
  loads.unservedMw[index] = loads.demandMw[index]!
  loads.shedCauses[index] = shedCausesCode(loads, index)
  loads.frequencyHz[index] = Number.NaN
  loads.voltagePu[index] = 0
  loads.serviceState[index] = loadOutage
}
