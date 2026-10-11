import type { CompiledComponent } from '../graph/index.ts'
import { nuclearInstrumentSpans } from '../graph/reactor-component-definitions.ts'
import { clamp, optionalParameterNumber, parameterNumber } from './component-helpers.ts'

// The ex-core nuclear instrumentation reads neutron flux, in proportion to a
// core's fission power, on three overlapping ranges, each pinned at the ends
// of its span:
// - the power range, calibrated in percent of rated thermal power;
// - the intermediate range, a compensated ion chamber whose current runs from
//   1e-11 A to 1e-3 A, with a startup-rate meter on how fast it changes;
// - the source range, which counts pulses while its high voltage is on.
// P-6 holds while the intermediate range reads above its setpoint (1e-10 A),
// P-10 while the power range reads above its own (10 %), the reference
// four-loop plant's nominal setpoints (NUREG-1431 Table 3.3.1-1, function
// 16). The source range's high voltage is cut above P-6, where operators
// block it on every startup, and by P-10 in any case, as the detectors would
// saturate; below P-6 it comes back by itself. It then reads the intermediate
// range's flux, overlapping it by its top decades, over the 10 cps the startup
// source keeps with the reactor shut down.

const sourceCountsCps = 10

export interface NuclearInstrumentationReading {
  readonly powerRangePercent: number
  readonly aboveP10: boolean
  readonly intermediateRangeCurrentAmps: number
  readonly aboveP6: boolean
  readonly sourceRangeEnergized: boolean
  readonly sourceRangeCountRateCps: number
}

export const nuclearInstrumentationReading = (core: CompiledComponent, fissionPowerMw: number): NuclearInstrumentationReading => {
  const fluxFraction = Math.max(0, fissionPowerMw / parameterNumber(core, 'ratedPowerMw'))
  const powerRange = clamp(fluxFraction * 100, nuclearInstrumentSpans.powerRangePercent.min, nuclearInstrumentSpans.powerRangePercent.max)
  // The current the chamber would carry for this flux, before its span pins the indication.
  const current = fluxFraction * optionalParameterNumber(core, 'nominalIntermediateRangeCurrentAmps', 5e-4)
  const p6 = parameterNumber(core, 'p6IntermediateRangeCurrentAmps')
  const aboveP6 = current >= p6
  const aboveP10 = powerRange >= parameterNumber(core, 'p10PowerRangePercent')
  const sourceRangeEnergized = !aboveP6 && !aboveP10
  return {
    powerRangePercent: powerRange,
    aboveP10,
    intermediateRangeCurrentAmps: clamp(current, nuclearInstrumentSpans.intermediateRangeCurrentAmps.min, nuclearInstrumentSpans.intermediateRangeCurrentAmps.max),
    aboveP6,
    sourceRangeEnergized,
    sourceRangeCountRateCps: sourceRangeEnergized
      ? clamp(sourceCountsCps + optionalParameterNumber(core, 'nominalSourceRangeCountRateCps', 100_000) * current / p6, nuclearInstrumentSpans.sourceRangeCountRateCps.min, nuclearInstrumentSpans.sourceRangeCountRateCps.max)
      : 0,
  }
}

/**
 * The intermediate range's startup rate, in decades a minute, from how its
 * indicated current changed over the step: a flux pinned at the end of the
 * span reads no change, and the meter pins at its own span, as it does on the
 * prompt drop of a trip.
 */
export const intermediateRangeStartupRateDpm = (previousCurrentAmps: number, currentAmps: number, dtSeconds: number): number =>
  clamp(
    60 * Math.log10(currentAmps / previousCurrentAmps) / dtSeconds,
    nuclearInstrumentSpans.intermediateRangeStartupRateDpm.min,
    nuclearInstrumentSpans.intermediateRangeStartupRateDpm.max,
  )
