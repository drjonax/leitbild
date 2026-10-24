/**
 * The card a vignette returns (architecture A5): one keyed item per line,
 * written as the renderer writes it (one number format, core/observation).
 * A value reads "<number> <unit>", its priority word at caution or above,
 * "since hh:mm:ss" for a state and "<effect> in 4 min" from its time to act;
 * its limits are its declared thresholds. An alert reads "<priority> ·
 * <message>" with its marks and no numbers; an object its core slots. The
 * named items come first; what 48 items or 2,400 characters leave out is
 * counted in `more`.
 */
import { DISPLAY_CARD_MAX_ITEMS, DISPLAY_CARD_MAX_TEXT, displayCardSchema, displayCardTextLength, type DisplayCard, type DisplayCardAdjustment, type DisplayCardItem } from '@leitbild/contracts'
import { priorityLevels, type Priority } from '../../../core/model/alerts.ts'
import { distanceParts, durationParts, numberShown, numberText, unitSymbol, type Observation, type Quantity } from '../../../core/observation/model.ts'
import type { AlertRow } from '../alerts/rows.ts'
import type { Declared } from './declared.ts'
import type { CompareRow, EntityRow, FleetColumn, FleetRow, FleetTally, SetBand, SetColumn, SlotDeclaration, VignetteSample } from './model.ts'

type Item = Omit<DisplayCardItem, 'key'>
type Shown = { readonly value: number; readonly decimals: number }
type Words = { readonly text: string; readonly number: Shown }

const clock = (at: string): string => at.slice(11, 19)
const shown = (value: number, unit: string, kind?: Quantity, decades = false): Shown => numberShown(value, unit, kind, decades)
const quantity = (value: number, unit: string, kind?: Quantity, decades = false): string =>
  unitSymbol(unit) === '' ? numberText(value, unit, kind, decades) : `${numberText(value, unit, kind, decades)} ${unitSymbol(unit)}`
const duration = (seconds: number): Words => { const { value, unit } = durationParts(seconds); return { text: `${value} ${unit}`, number: { value, decimals: 0 } } }
const distance = (metres: number): Words => { const { value, unit } = distanceParts(metres); return { text: `${numberText(value, unit)} ${unit}`, number: shown(value, unit) } }
/** A number as a slot of this unit code shows it: seconds as a duration, metres as a distance. */
const slotWords = (value: number, unit: string): Words => unit === 's' ? duration(value) : unit === 'm' ? distance(value) : { text: quantity(value, unit), number: shown(value, unit) }
const atLeastCaution = (priority: string | null | undefined): boolean => priority != null && priorityLevels.indexOf(priority as never) >= priorityLevels.indexOf('caution')

export const valueItem = ({ observable, object }: Declared, observation: Observation | undefined): Item => {
  const label = `${object.label} · ${observable.label}`.slice(0, 80)
  const value = observation?.value ?? null
  const numbers: Shown[] = []
  // A reading that measures nothing now (meaningfulWhile off) reads "—", as a readout shows it.
  const notApplicable = observation?.quality === 'not-applicable'
  const decades = observable.decades === true
  const word = notApplicable ? '—'
    : typeof value === 'number' ? (numbers.push(shown(value, observable.unit, observable.quantity, decades)), quantity(value, observable.unit, observable.quantity, decades))
    : value === null ? 'no reading'
      : observable.states?.find(state => state.value === String(value))?.label ?? (typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value))
  const threshold = observable.thresholds.find(entry => entry.id === observation?.timeToAct?.threshold)
  const toAct = observation?.timeToAct === undefined ? undefined : duration(observation.timeToAct.seconds)
  if (toAct !== undefined) numbers.push(toAct.number)
  const parts = [word,
    ...(observation !== undefined && observation.quality !== 'good' && !notApplicable ? [observation.quality] : []),
    ...(atLeastCaution(observation?.priority) ? [observation!.priority] : []),
    ...(observation?.since !== undefined ? [`since ${clock(observation.since.at)}`] : []),
    ...(toAct !== undefined ? [`${threshold?.effect ?? 'limit'} in ${toAct.text}`] : [])]
  const near = typeof value === 'number' ? (limit: number) => Math.abs(limit - value) : () => 0
  const limits = [...observable.thresholds].sort((left, right) => Number(right.id === observation?.past) - Number(left.id === observation?.past) || near(left.value) - near(right.value))
    .slice(0, 4).map(entry => shown(entry.value, observable.unit, observable.quantity, decades))
  return {
    label, reading: parts.join(' · ').slice(0, 120), ...(observable.unit === '' ? {} : { unit: observable.unit }), numbers,
    ...(limits.length === 0 ? {} : { limits }), ...(observation === undefined ? {} : { priority: observation.priority }), subject: { ref: observable.ref },
  }
}

export const alertItem = (row: AlertRow): Item => {
  const marks = [...(row.alert.firstOut !== undefined ? ['first out'] : []), ...(row.alert.advisory === true ? ['advisory'] : []),
    ...(row.alert.acknowledged ? ['acknowledged'] : []), ...(row.alert.returned === true ? ['returned'] : [])]
  return {
    label: row.objectLabel.slice(0, 80), reading: [row.priority ?? 'priority not declared', row.alert.message, ...marks].join(' · ').slice(0, 120), numbers: [],
    ...(row.priority === null ? {} : { priority: row.priority }), subject: { objectId: row.objectId, alertId: row.alert.id },
  }
}

/** An entity row in words, with the numbers it shows. */
export const entityItem = (row: EntityRow): Item => {
  const parts: Array<{ readonly text: string; readonly number?: Shown }> = [
    ...[row.status?.word, row.urgency].filter((word): word is string => word !== undefined).map(text => ({ text })),
    ...(row.alert === undefined ? [] : [{ text: `${row.alert.priority ?? `${row.alert.severity} (priority not declared)`} · ${row.alert.message}` }]),
    ...(row.etaS === undefined ? [] : [(words => ({ text: `ETA ${words.text}`, number: words.number }))(duration(row.etaS))]),
    ...(row.distanceM === undefined ? [] : [(words => ({ text: `${words.text} away`, number: words.number }))(distance(row.distanceM))]),
    ...(row.ageS === undefined ? [] : [(words => ({ text: `fix ${words.text} old`, number: words.number }))(duration(row.ageS))]),
    ...(row.closed === true ? [{ text: 'closed' }] : []),
  ]
  return {
    label: row.label.slice(0, 80), reading: (parts.map(part => part.text).join(' · ') || 'no slots').slice(0, 120),
    numbers: parts.flatMap(part => part.number === undefined ? [] : [part.number]).slice(0, 8), subject: { objectId: row.objectId },
  }
}

/** An entity-floor object's slots, one item each. */
export const slotItems = (objectId: string, label: string, slots: ReadonlyArray<SlotDeclaration>, values: VignetteSample['slots'][string]): ReadonlyArray<Item> => slots.flatMap(slot => {
  const value = values[slot.key]?.value
  if (value === undefined) return []
  const words = typeof value === 'number' ? slotWords(value, slot.unit) : null
  const since = values[slot.key]?.since
  return [{
    label: `${label} · ${slot.label}`.slice(0, 80), reading: `${words?.text ?? (value === null ? 'no reading' : String(value))}${since === undefined ? '' : ` · since ${clock(since.at)}`}`.slice(0, 120),
    ...(slot.unit === '' || words === null ? {} : { unit: slot.unit }), numbers: words === null ? [] : [words.number], subject: { objectId },
  }]
})

/** A number a set view shows, as its column writes it: a count unit ('1') by the column's word. */
const setNumber = (value: number, column: SetColumn | Pick<FleetColumn, 'label' | 'unit'>): Words => {
  const quantityKind = 'quantity' in column ? column.quantity : undefined
  const decades = 'decades' in column && column.decades === true
  if (column.unit === '1' && quantityKind === undefined) return { text: `${numberText(value, column.unit, 'count')} ${column.label.toLowerCase()}`, number: shown(value, column.unit, 'count') }
  return { text: quantity(value, column.unit, quantityKind, decades), number: shown(value, column.unit, quantityKind, decades) }
}
/** A fleet column's number with its column's words, so two numbers of one unit are told apart. */
const labelled = (value: number, column: Pick<FleetColumn, 'label' | 'unit'>): Words => {
  const words = setNumber(value, column)
  return column.unit === '1' ? words : { text: `${column.label} ${words.text}`, number: words.number }
}
const priorityWord = (priority: Priority | null): ReadonlyArray<string> => atLeastCaution(priority) ? [priority!] : []

/** A fleet row in words: each column's word or number (none where it has none now), then its worst alert at caution or above. */
export const fleetRowItem = (row: FleetRow, columns: ReadonlyArray<Pick<FleetColumn, 'key' | 'label' | 'unit'>>): Item => {
  const parts = columns.flatMap(column => {
    const value = row.values[column.key]
    return value === null || value === undefined ? [] : [typeof value === 'number' ? labelled(value, column) : { text: value }]
  })
  const alert = row.alert !== undefined && atLeastCaution(row.alert.priority) ? [`${row.alert.priority} · ${row.alert.message}`] : []
  return {
    label: row.label.slice(0, 80), reading: ([...parts.map(part => part.text), ...alert].join(' · ') || 'no reading').slice(0, 120),
    numbers: parts.flatMap(part => 'number' in part && part.number !== undefined ? [part.number] : []).slice(0, 8),
    ...(row.priority === null ? {} : { priority: row.priority }), subject: { objectId: row.objectId },
  }
}

/** A set's aggregate header: how many members, then each tally word's count and up to three of its members. */
export const setHeaderItem = (label: string, members: number, tallies: ReadonlyArray<FleetTally>): Item => ({
  label: label.slice(0, 80),
  reading: [`${members} ${members === 1 ? 'unit' : 'units'}`, ...tallies.map(tally => `${tally.count} ${tally.word}${tally.labels.length === 0 ? '' : ` (${tally.labels.join(', ')}${tally.count > tally.labels.length ? ', …' : ''})`}`)].join(' · ').slice(0, 120),
  numbers: [{ value: members, decimals: 0 }, ...tallies.map(tally => ({ value: tally.count, decimals: 0 }))].slice(0, 8),
})

/** A compared unit in words: each column's reading in column order, "—" where it reads none and "not measured" where it does not measure it. */
export const compareRowItem = (row: CompareRow, columns: ReadonlyArray<SetColumn>, value: (ref: string) => Observation | undefined): Item => {
  const cells = row.refs.map((ref, at) => {
    if (ref === null) return { text: 'not measured' }
    const observation = value(ref)
    const reading = observation?.value
    if (typeof reading === 'number' && observation?.quality !== 'not-applicable') {
      const words = setNumber(reading, columns[at]!)
      return { text: [words.text, ...priorityWord(observation?.priority ?? null)].join(' '), number: words.number }
    }
    return { text: reading === null || reading === undefined || observation?.quality === 'not-applicable' ? '—' : String(reading) }
  })
  return {
    label: row.label.slice(0, 80), reading: cells.map(cell => cell.text).join(' | ').slice(0, 120),
    numbers: cells.flatMap(cell => cell.number === undefined ? [] : [cell.number]).slice(0, 8),
    ...(row.priority === null ? {} : { priority: row.priority }), subject: { objectId: row.objectId },
  }
}

/** The columns a compare view's rows read in order. */
export const compareHeaderItem = (label: string, members: number, columns: ReadonlyArray<SetColumn>): Item => ({
  label: `${label} · ${members} ${members === 1 ? 'unit' : 'units'}`.slice(0, 80), reading: columns.map(column => column.label).join(' | ').slice(0, 120), numbers: [{ value: members, decimals: 0 }],
})

/** A quantity's band across a set now: min, median and max, and the units at its ends. */
export const bandItem = (column: SetColumn, band: SetBand, ends: { readonly min: string; readonly max: string }): Item => {
  const [min, median, max] = [band.min, band.median, band.max].map(value => setNumber(value, column))
  return {
    label: `${column.label} · ${band.count} units`.slice(0, 80), reading: `min ${min!.text} (${ends.min}) · median ${median!.text} · max ${max!.text} (${ends.max})`.slice(0, 120),
    ...(column.unit === '' ? {} : { unit: column.unit }), numbers: [min!.number, median!.number, max!.number],
  }
}

/**
 * Items in order, keyed from `firstKey`, within 48 items and the card's characters; `hidden` items the views left out
 * are counted in `more`, and so is any item the card itself trims, with an adjustment that says so.
 */
export const assembleCard = (at: DisplayCard['at'], items: ReadonlyArray<Item>, adjusted: ReadonlyArray<DisplayCardAdjustment>, hidden = 0, firstKey = 1): DisplayCard => {
  const keyed = items.map((item, index): DisplayCardItem => ({ key: `k${firstKey + index}`, ...item }))
  const fits = (count: number, notes: ReadonlyArray<DisplayCardAdjustment>): boolean => count <= DISPLAY_CARD_MAX_ITEMS
    && displayCardTextLength({ at, items: keyed.slice(0, count), more: hidden + keyed.length - count, adjusted: notes }) <= DISPLAY_CARD_MAX_TEXT
  if (fits(keyed.length, adjusted)) return displayCardSchema.parse({ at, items: keyed, more: hidden, adjusted })
  const trimmed = (count: number): ReadonlyArray<DisplayCardAdjustment> => [...adjusted.slice(0, 7),
    { kind: 'layout', text: `${keyed.length - count} items left off the card, which holds ${DISPLAY_CARD_MAX_ITEMS} items and ${DISPLAY_CARD_MAX_TEXT} characters` }]
  let count = Math.min(keyed.length, DISPLAY_CARD_MAX_ITEMS)
  while (count > 0 && !fits(count, trimmed(count))) count -= 1
  return displayCardSchema.parse({ at, items: keyed.slice(0, count), more: hidden + keyed.length - count, adjusted: trimmed(count) })
}
