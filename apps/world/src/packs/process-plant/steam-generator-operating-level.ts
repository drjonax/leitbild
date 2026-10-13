import { liquidEnthalpyKjPerKg, saturatedWaterSteam } from './runtime/water-properties.ts'

/** The mixture levels, as fractions of the full-scale inventory, that a level instrument reads 0 % and 100 % at. */
export interface SteamGeneratorLevelSpan {
  readonly lower: number
  readonly upper: number
}

const levelSpan = (parameters: Readonly<Record<string, unknown>>, lowerKey: string, upperKey: string, name: string): SteamGeneratorLevelSpan => {
  const lower = Number(parameters[lowerKey] ?? 0)
  const upper = Number(parameters[upperKey] ?? 1)
  if (!(upper > lower)) throw new Error(`Steam-generator ${name} range must span upward: its upper fraction must exceed its lower one`)
  return { lower, upper }
}

/**
 * The narrow range spans only part of a steam generator's height, above the
 * tube bundle: the two-phase mixture level, as a fraction of the full-scale
 * inventory, that reads 0 % and 100 % on it. Without the parameters it spans
 * the whole generator.
 */
export const steamGeneratorNarrowRange = (parameters: Readonly<Record<string, unknown>>): SteamGeneratorLevelSpan =>
  levelSpan(parameters, 'narrowRangeLowerFraction', 'narrowRangeUpperFraction', 'narrow')

/**
 * The wide range spans from about the tube sheet to the narrow range's upper
 * tap, above the separators, so it still reads a level the narrow range has
 * lost below its span. Without the parameters it spans the whole generator.
 */
export const steamGeneratorWideRange = (parameters: Readonly<Record<string, unknown>>): SteamGeneratorLevelSpan =>
  levelSpan(parameters, 'wideRangeLowerFraction', 'wideRangeUpperFraction', 'wide')

/** What a level instrument reads of a mixture level given in percent of the full-scale inventory: off its span it stays at the end it left by. */
export const steamGeneratorLevelOnSpanPercent = (
  range: SteamGeneratorLevelSpan,
  mixtureLevelPercent: number,
): number => Math.min(100, Math.max(0, (mixtureLevelPercent / 100 - range.lower) / (range.upper - range.lower) * 100))

/**
 * The energy, in MJ, each kilogram of feedwater takes up in a steam generator
 * to leave as its steam: saturated steam at the generator's nominal pressure
 * less feedwater at its design temperature, both from the IF97 tables. The
 * feedwater heaters the model leaves out set that temperature, so it is
 * declared, never read from the feed train. Initialization, the operating
 * point's sizing and the boiling all use this one relation.
 */
export const steamGeneratorFeedToSteamEnthalpyMjPerKg = (parameters: Readonly<Record<string, unknown>>): number => {
  const pressure = Number(parameters.nominalPressureMPa)
  const feedwaterTemperature = Number(parameters.designFeedwaterTemperatureC)
  if (!Number.isFinite(pressure) || !Number.isFinite(feedwaterTemperature)) {
    throw new Error('Steam generator needs its nominal pressure and design feedwater temperature to make steam')
  }
  const steam = saturatedWaterSteam(pressure)
  if (!(feedwaterTemperature < steam.temperatureC)) throw new Error('Steam-generator design feedwater temperature must lie below its saturation temperature')
  return (steam.vapourEnthalpyKjPerKg - liquidEnthalpyKjPerKg(feedwaterTemperature, pressure)) / 1_000
}

/** Nominal level is the indicated narrow-range level, including the steady boiling swell.
 * Share this relation between initialization and the inventory pressure datum. */
export const steamGeneratorOperatingLevel = (parameters: Readonly<Record<string, unknown>>) => {
  const recirculation = Math.max(1, Math.min(1.35, 1 + (Number(parameters.recirculationRatio ?? 1) - 1) * 0.06))
  const voidFraction = Math.min(0.45, Number(parameters.voidFractionAtNominalBoiling ?? 0.16) * recirculation * Number(parameters.initialSteamFlowFraction ?? 0))
  const swell = Math.min(35, voidFraction * Number(parameters.swellLevelGainPercent ?? 26))
  const range = steamGeneratorNarrowRange(parameters)
  const mixture = (range.lower + Number(parameters.nominalLevelPercent) * (range.upper - range.lower)) * 100
  const collapsed = mixture - swell
  if (collapsed <= 0) throw new Error('Nominal steam-generator indicated level must exceed boiling swell')
  return { voidFraction, swell, collapsed }
}
