import type { GridLoadDefinition } from '../grid-model.ts'
import type { GridLoadShedCause, GridLoadState } from './instance.ts'

// A load serves at least its critical demand: neither manual nor automatic shedding disconnects it.
// Load service is constrained 0.2 Hz from nominal: outside the Nordic normal band (49.9–50.1 Hz) and the FCR-N range.
const constrainedDeviationHz = 0.2

/** Applies the manual shedding limit to this demand sample: the load draws at most the limit, never less than its critical demand. */
export const curtailGridLoad = (state: GridLoadState, load: GridLoadDefinition): void => {
  const limitMw = state.manualDemandLimitMw
  state.curtailedMw = limitMw === null ? 0 : Math.max(0, state.demandMw - Math.max(load.criticalMw, limitMw))
}

/** Demand still connected after manual curtailment: what frequency control and LFDD act on. */
export const connectedGridLoadMw = (state: GridLoadState): number => state.demandMw - state.curtailedMw

// The four possible cause lists, shared: every live load is completed on every network solution.
const shedCauseLists: ReadonlyArray<ReadonlyArray<GridLoadShedCause>> = [
  Object.freeze([]), Object.freeze(['manual' as const]), Object.freeze(['lfdd' as const]), Object.freeze(['manual' as const, 'lfdd' as const]),
]

const shedCausesFor = (state: GridLoadState): ReadonlyArray<GridLoadShedCause> =>
  shedCauseLists[(state.curtailedMw > 0 ? 1 : 0) + (state.lfddShedMw > 0 ? 2 : 0)]!

/** Closes a live load's service for this tick from its served and LFDD-shed demand. */
export const completeLiveGridLoad = (state: GridLoadState, frequencyHz: number, nominalFrequencyHz: number): void => {
  state.outageMw = 0
  state.shedMw = state.curtailedMw + state.lfddShedMw
  state.unservedMw = state.shedMw
  state.shedCauses = shedCausesFor(state)
  state.frequencyHz = frequencyHz
  state.voltagePu = 1
  state.serviceState = state.shedMw > 0 ? 'shed' : Math.abs(frequencyHz - nominalFrequencyHz) >= constrainedDeviationHz ? 'constrained' : 'normal'
}

/** A load in a de-energised island is out of supply: nothing is served and no LFDD stage holds it. */
export const completeDeadGridLoad = (state: GridLoadState): void => {
  state.servedMw = 0
  state.lfddShedMw = 0
  state.outageMw = state.demandMw - state.curtailedMw
  state.shedMw = state.curtailedMw
  state.unservedMw = state.demandMw
  state.shedCauses = shedCausesFor(state)
  state.frequencyHz = null
  state.voltagePu = 0
  state.serviceState = 'outage'
}
