import type { CompiledComponent } from '../graph/index.ts'
import { clamp, optionalParameterNumber, parameterNumber } from './component-helpers.ts'

// The ex-core nuclear instrumentation reads neutron flux, in proportion to a
// core's fission power. The intermediate range is a compensated ion chamber
// whose current spans 1e-11 A to 1e-3 A, pinned at either end of that span.
// The source range counts pulses while its detectors' high voltage is on:
// below P-6, an intermediate-range current of 1e-10 A by default. Above it the
// high voltage is cut, as the detectors would saturate, and it reads no
// counts. With the reactor shut down the startup source keeps 10 cps.

const intermediateRangeSpanAmps = { min: 1e-11, max: 1e-3 } as const
const sourceCountsCps = 10

export interface NuclearInstrumentationReading {
  readonly intermediateRangeCurrentAmps: number
  readonly sourceRangeEnergized: boolean
  readonly sourceRangeCountRateCps: number
}

export const nuclearInstrumentationReading = (core: CompiledComponent, fissionPowerMw: number): NuclearInstrumentationReading => {
  const fluxFraction = Math.max(0, fissionPowerMw / parameterNumber(core, 'ratedPowerMw'))
  // The current the chamber would carry for this flux, before its span pins the indication.
  const current = fluxFraction * optionalParameterNumber(core, 'nominalIntermediateRangeCurrentAmps', 5e-4)
  const p6 = optionalParameterNumber(core, 'sourceRangeCutoffCurrentAmps', 1e-10)
  const sourceRangeEnergized = current < p6
  return {
    intermediateRangeCurrentAmps: clamp(current, intermediateRangeSpanAmps.min, intermediateRangeSpanAmps.max),
    sourceRangeEnergized,
    sourceRangeCountRateCps: sourceRangeEnergized
      ? sourceCountsCps + optionalParameterNumber(core, 'nominalSourceRangeCountRateCps', 100_000) * current / p6
      : 0,
  }
}
