import { osloHourOfDay, profiledGridDemand } from './dynamics.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { curtailGridLoad } from './load-service.ts'

/**
 * Demand follows the daily profile sampled on a fixed one-minute grid of absolute simulation time
 * and held between samples, so the demand trajectory, and with it the frequency response, does not
 * depend on the adapter tick. The daily profile moves demand by at most about 0.08 % per minute.
 */
export const demandSampleMs = 60_000

export const demandSampleTimeMs = (epochMs: number): number => Math.floor(epochMs / demandSampleMs) * demandSampleMs

/** Sets each load's demand to its profiled value at the demand sample containing `epochMs`, then applies its manual limit. */
export const applyGridDemand = (grid: GridRuntimeInstance, epochMs: number): void => {
  const sampleMs = demandSampleTimeMs(epochMs)
  const osloHour = osloHourOfDay(sampleMs)
  for (const load of grid.definition.model.loads) {
    const state = grid.loads.get(load.id)!
    state.demandMw = profiledGridDemand(load, state.nominalDemandMw, osloHour)
    curtailGridLoad(state, load)
  }
}

/** While HVDC transfers ramp, advances are split on this finer absolute grid so ramps are followed second by second. */
export const rampSampleMs = 1_000

/** End of the segment starting at `cursorMs` on an absolute grid of `sampleMs`, not beyond `endMs`. */
export const segmentEndMs = (cursorMs: number, endMs: number, sampleMs: number): number =>
  Math.min(endMs, Math.floor(cursorMs / sampleMs) * sampleMs + sampleMs)
