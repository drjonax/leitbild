import type { GridLoadDefinition } from '../grid-model.ts'
import type { GridLoadShedCause, GridLoadState } from './instance.ts'

// A load serves at least its critical demand: neither manual nor automatic shedding disconnects it.

const shedCausesFor = (state: GridLoadState): Array<GridLoadShedCause> => [
  ...(state.curtailedMw > 0 ? ['manual' as const] : []),
  ...(state.lfddShedMw > 0 ? ['lfdd' as const] : []),
]

/** Applies the manual shedding limit to this tick's demand; automatic shedding starts from zero. */
export const serveGridLoadDemand = (state: GridLoadState, load: GridLoadDefinition): void => {
  const limitMw = state.manualDemandLimitMw
  state.curtailedMw = limitMw === null ? 0 : Math.max(0, state.demandMw - Math.max(load.criticalMw, limitMw))
  state.lfddShedMw = 0
  state.shedMw = state.curtailedMw
  state.servedMw = state.demandMw - state.curtailedMw
  state.shedCauses = shedCausesFor(state)
}

/** Sheds a fraction of the demand still served above critical demand by under-frequency load shedding. */
export const shedGridLoadByLfdd = (state: GridLoadState, load: GridLoadDefinition, shedFraction: number): void => {
  const servedBeforeLfddMw = state.demandMw - state.curtailedMw
  state.lfddShedMw = Math.max(0, servedBeforeLfddMw - load.criticalMw) * shedFraction
  state.shedMw = state.curtailedMw + state.lfddShedMw
  state.servedMw = servedBeforeLfddMw - state.lfddShedMw
  state.shedCauses = shedCausesFor(state)
}

export const gridLoadServiceState = (
  state: GridLoadState,
  frequencyHz: number,
  nominalFrequencyHz: number,
): GridLoadState['serviceState'] => state.servedMw <= 0
  ? 'outage'
  : state.shedMw > 0
    ? 'shed'
    // 0.2 Hz: outside the Nordic normal band (49.9–50.1 Hz) and the FCR-N range; the Pack's "constrained" supply band.
    : Math.abs(frequencyHz - nominalFrequencyHz) >= 0.2 ? 'constrained' : 'normal'
