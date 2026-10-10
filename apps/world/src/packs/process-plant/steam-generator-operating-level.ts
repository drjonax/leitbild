/**
 * The narrow range spans only part of a steam generator's height, above the
 * tube bundle: the two-phase mixture level, as a fraction of the full-scale
 * inventory, that reads 0 % and 100 % on it. Without the parameters it spans
 * the whole generator.
 */
export const steamGeneratorNarrowRange = (parameters: Readonly<Record<string, unknown>>) => {
  const lower = Number(parameters.narrowRangeLowerFraction ?? 0)
  const upper = Number(parameters.narrowRangeUpperFraction ?? 1)
  if (!(upper > lower)) throw new Error('Steam-generator narrow range must span upward: its upper fraction must exceed its lower one')
  return { lower, upper }
}

/** Narrow-range level of a mixture level given in percent of the full-scale inventory. */
export const steamGeneratorNarrowRangeLevelPercent = (
  range: { readonly lower: number; readonly upper: number },
  mixtureLevelPercent: number,
): number => Math.min(100, Math.max(0, (mixtureLevelPercent / 100 - range.lower) / (range.upper - range.lower) * 100))

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
