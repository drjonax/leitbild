import type { IsoTimestamp } from '../../../core/model/index.ts'
import { profiledGridDemand } from './dynamics.ts'
import type { GridRuntimeInstance } from './instance.ts'

/** Sets each load's demand for this tick (profiled when enabled) and resets served/shed before control acts. */
export const applyGridDemand = (grid: GridRuntimeInstance, at: IsoTimestamp): void => {
  for (const load of grid.definition.model.loads) {
    const state = grid.loads.get(load.id)!
    state.demandMw = grid.definition.automation.loadProfiles ? profiledGridDemand(load, state.nominalDemandMw, at) : state.nominalDemandMw
    state.servedMw = state.demandMw
    state.shedMw = 0
  }
}
