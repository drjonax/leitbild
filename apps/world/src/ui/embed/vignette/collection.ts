// Objects as a vignette shows them (architecture B2): a table of the core
// slots present, and a map section's caption. Urgency sorts and reads as a
// code, never as a colour; only an alert's own priority colours its cell.
import { numberText } from '../../../core/observation/model.ts'
import { clockText, durationText } from './format.ts'
import type { EntityColumn, EntityRow, VignetteSample } from './model.ts'
import { toneOf, type AlertTone } from './readout.ts'

export const columnHead = (column: EntityColumn, near: { readonly label: string } | undefined): string =>
  column === 'status' ? 'Status' : column === 'urgency' ? 'Urgency' : column === 'alert' ? 'Worst alert' : column === 'eta' ? 'ETA'
    : column === 'distance' ? (near === undefined ? 'Distance' : `To ${near.label}`) : 'Position age'

export interface EntityCell {
  readonly text: string
  /** A status word or an urgency code drawn in a box. */
  readonly boxed: boolean
  readonly tone: AlertTone | null
  readonly title?: string
}

/** A distance as a table reads it: metres under a kilometre, else kilometres. */
export const distanceText = (metres: number): string => (metres < 1_000 ? `${numberText(metres, 'm')} m` : `${numberText(metres / 1_000, 'km')} km`)

const empty: EntityCell = { text: '—', boxed: false, tone: null }

export const entityCell = (row: EntityRow, column: EntityColumn): EntityCell => {
  if (column === 'status') return row.status === undefined ? empty : { text: row.status.word, boxed: true, tone: null, ...(row.status.since === undefined ? {} : { title: `since ${clockText(row.status.since.at)}` }) }
  if (column === 'urgency') return row.urgency === undefined ? empty : { text: row.urgency, boxed: true, tone: null }
  if (column === 'alert') return row.alert === undefined ? empty : { text: row.alert.message, boxed: false, tone: toneOf(row.alert.priority ?? undefined), title: row.alert.priority === null ? `${row.alert.severity} · priority not declared` : row.alert.priority }
  if (column === 'eta') return row.etaS === undefined ? empty : { text: durationText(row.etaS), boxed: false, tone: null }
  if (column === 'distance') return row.distanceM === undefined ? empty : { text: distanceText(row.distanceM), boxed: false, tone: null }
  return row.ageS === undefined ? empty : { text: `${durationText(row.ageS)} ago`, boxed: false, tone: null }
}

type MapFrame = NonNullable<VignetteSample['maps']>[number]

/** What a map section frames, in words: "3 with a position within 5 km of the depot · 1 without". */
export const mapCaption = (frame: MapFrame | undefined): string => {
  if (frame === undefined) return 'Reading positions…'
  const where = frame.within === undefined ? '' : ` within ${frame.within}${frame.around === undefined ? '' : ` of ${frame.around}`}`
  return `${frame.positioned} with a position${where}${frame.missing === 0 ? '' : ` · ${frame.missing} without`}`
}
