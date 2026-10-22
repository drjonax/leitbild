// Words around the numbers a vignette writes. The numbers themselves come from
// the one formatter beside quantityUnits, so a live readout shows exactly the
// digits its card cites.
import { distanceParts, durationParts, numberText, unitSymbol } from '../../../core/observation/model.ts'

/** Value and unit symbol, as the card reads it: "91.3 %", "287.4 °C", "3". */
export const quantityText = (value: number, unit: string): string => {
  const symbol = unitSymbol(unit)
  return symbol === '' ? numberText(value, unit) : `${numberText(value, unit)} ${symbol}`
}

/**
 * A label without the object the vignette is titled by: "<object> · <observable>" reads "<observable>" under a title
 * "<object>", or "<object> · <element>"; the whole label stays in the tooltip.
 */
export const underTitle = (label: string, title: string): string => {
  const object = title.split(' · ')[0]!
  const shown = [title, object].find(prefix => label.startsWith(`${prefix} · `))
  return shown === undefined ? label : label.slice(shown.length + 3)
}

/** A Run time as the footer and "since" read it: hh:mm:ss. */
export const clockText = (at: string | number): string => new Date(at).toISOString().slice(11, 19)

/** A duration as the card writes it: "45 s", "4 min", "2 h". */
export const durationText = (seconds: number): string => { const parts = durationParts(seconds); return `${parts.value} ${parts.unit}` }

/** A distance as the card writes it: metres under a kilometre, else kilometres. */
export const distanceText = (metres: number): string => { const parts = distanceParts(metres); return `${parts.value} ${parts.unit}` }

/**
 * What every vignette's footer says it is, beside its clock: a view World generated from the model, or one the
 * Assistant composed; never an operating display. Until its view is read, only the latter.
 */
export const provenanceMark = (view: { readonly by?: 'assistant' } | undefined): string =>
  view === undefined ? 'not an operating display'
    : view.by === 'assistant' ? 'AI-composed view · not an operating display' : 'Generated from the model · not an operating display'
