// Words around the numbers a vignette writes. The numbers themselves come from
// the one formatter beside quantityUnits, so a live readout shows exactly the
// digits its card cites.
import { numberText, unitSymbol } from '../../../core/observation/model.ts'

/** Value and unit symbol, as the card reads it: "91.3 %", "287.4 °C", "3". */
export const quantityText = (value: number, unit: string): string => {
  const symbol = unitSymbol(unit)
  return symbol === '' ? numberText(value, unit) : `${numberText(value, unit)} ${symbol}`
}

/** A Run time as the footer and "since" read it: hh:mm:ss. */
export const clockText = (at: string | number): string => new Date(at).toISOString().slice(11, 19)

/** A duration as a countdown reads it: "45 s", "4 min", "2 h". */
export const durationText = (seconds: number): string =>
  seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5_400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3_600)} h`
