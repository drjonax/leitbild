import type { CompiledGridDefinition, GridDemandDayType } from '../grid-model.ts'
import { evaluateDemandProfiles, localClockText, localDayType, osloLocalMs } from './demand-profiles.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { curtailGridLoad } from './load-service.ts'
import { gridTablesFor } from './state/tables.ts'

/**
 * Demand follows the daily profile sampled on a fixed one-minute grid of absolute simulation time
 * and held between samples, so the demand trajectory, and with it the frequency response, does not
 * depend on the adapter tick. The steepest measured profile hour (NO5 business, summer weekday
 * 06:00–07:00) moves a load by 0.29 % per minute.
 */
export const demandSampleMs = 60_000

export const demandSampleTimeMs = (epochMs: number): number => Math.floor(epochMs / demandSampleMs) * demandSampleMs

/** The demand sample the loads' demand was last set at: its local day type and each Model demand profile's factor. */
export interface GridDemandSample {
  sampleMs: number
  dayType: GridDemandDayType
  readonly factors: Float64Array
}

/** The demand sample containing `epochMs`. */
export const gridDemandSampleAt = (definition: CompiledGridDefinition, epochMs: number): GridDemandSample => {
  const sampleMs = demandSampleTimeMs(epochMs)
  const localMs = osloLocalMs(sampleMs)
  const factors = new Float64Array(definition.model.demandProfiles.length)
  evaluateDemandProfiles(gridTablesFor(definition).demandProfileHours, factors.length, localMs, factors)
  return { sampleMs, dayType: localDayType(localMs), factors }
}

/** When and on which local day type the loads' demand was last sampled. */
export const gridDemandSampleClock = (sample: GridDemandSample): { readonly sampleAt: string; readonly localTime: string; readonly dayType: GridDemandDayType } => ({
  sampleAt: new Date(sample.sampleMs).toISOString(),
  localTime: localClockText(osloLocalMs(sample.sampleMs)),
  dayType: sample.dayType,
})

/**
 * Sets each load's demand to its profiled value at the demand sample containing `epochMs`, then
 * applies its manual limit; the losses below 132 kV behind the fully connected load follow the
 * same profile at the Operating Point's load scale (connectedNetworkLossMw draws its connected share).
 */
export const applyGridDemand = (grid: GridRuntimeInstance, epochMs: number): void => {
  const tables = gridTablesFor(grid.definition)
  const sample = grid.demandSample
  sample.sampleMs = demandSampleTimeMs(epochMs)
  const localMs = osloLocalMs(sample.sampleMs)
  evaluateDemandProfiles(tables.demandProfileHours, sample.factors.length, localMs, sample.factors)
  sample.dayType = localDayType(localMs)
  const loadProfile = tables.loadDemandProfile
  const loads = grid.arrays.loads
  const definitions = grid.definition.model.loads
  const loadScale = grid.definition.operatingPoint.loadScale
  for (let load = 0; load < definitions.length; load += 1) {
    const definition = definitions[load]!
    const factor = sample.factors[loadProfile[load]!]!
    loads.profileFactor[load] = factor
    loads.demandMw[load] = Math.max(definition.criticalMw, loads.nominalDemandMw[load]! * factor)
    loads.profiledNetworkLossMw[load] = definition.networkLossMw * loadScale * factor
    curtailGridLoad(loads, load, definition)
  }
}

/** While HVDC transfers ramp, advances are split on this finer absolute grid so ramps are followed second by second. */
export const rampSampleMs = 1_000

/** End of the segment starting at `cursorMs` on an absolute grid of `sampleMs`, not beyond `endMs`. */
export const segmentEndMs = (cursorMs: number, endMs: number, sampleMs: number): number =>
  Math.min(endMs, Math.floor(cursorMs / sampleMs) * sampleMs + sampleMs)
