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

// A startup-rate meter, in decades a minute, from how its range's indication
// changed over the step: a reading pinned at the end of its span reads no
// change, and the meter pins at its own span, as it does on the prompt drop of
// a trip.
const startupRateDpm = (previous: number, current: number, dtSeconds: number, span: { readonly min: number; readonly max: number }): number =>
  clamp(60 * Math.log10(current / previous) / dtSeconds, span.min, span.max)

/** The intermediate range's startup rate, from how its indicated current changed over the step. */
export const intermediateRangeStartupRateDpm = (previousCurrentAmps: number, currentAmps: number, dtSeconds: number): number =>
  startupRateDpm(previousCurrentAmps, currentAmps, dtSeconds, nuclearInstrumentSpans.intermediateRangeStartupRateDpm)

/**
 * The source range's startup rate, from how its count rate changed over the
 * step, while the source range counted through the whole step. With its high
 * voltage off it reads zero, measuring nothing; on the step the high voltage
 * comes back the count rate jumps from nothing, which is no rate of the flux,
 * so it reads zero then too rather than pin at +5 DPM. It holds no earlier
 * reading.
 */
export const sourceRangeStartupRateDpm = (previous: { readonly energized: boolean; readonly countRateCps: number }, current: { readonly energized: boolean; readonly countRateCps: number }, dtSeconds: number): number =>
  previous.energized && current.energized
    ? startupRateDpm(previous.countRateCps, current.countRateCps, dtSeconds, nuclearInstrumentSpans.sourceRangeStartupRateDpm)
    : 0
