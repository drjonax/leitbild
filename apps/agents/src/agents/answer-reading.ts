// ============================================================================
// Answer reading — how an answer's prose is read against what its display
// shows (the contract's embedded view content).
//
// Shared by the live contradiction check (answer-consistency.ts), which
// blocks an answer only where a value it cites for a shown item contradicts
// what the display reads, and by the offline grounding metrics
// (scripts/display-eval/grounding.ts), which measure everything softer. It
// errs towards silence: a cited quantity counts as shown when the display
// reads anything close to it in the same unit, and anything the answer marks
// "not shown" is left alone.
// ============================================================================

import type { EmbeddedViewContent } from '@leitbild/contracts'

export type Quantity = { readonly value: number; readonly unit: string }
export type Item = EmbeddedViewContent['items'][number]
export type Direction = NonNullable<Item['trend']>['direction']

// Unit spellings an answer uses, by the symbol a display shows. Durations and
// one-letter units (s, min, h, A, V) are left out: "pump A", "10:02:00".
const UNIT_SPELLINGS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['%', ['%', 'percent', 'per cent', 'percentage points', 'percentage point']],
  ['°C/s', ['°C/s', 'degC/s']],
  ['°C', ['°C', '° C', 'ºC', 'degC', 'deg C']],
  ['MPa', ['MPa']],
  ['kPa', ['kPa']],
  ['bar', ['bar']],
  ['kg/s', ['kg/s']],
  ['t/h', ['t/h']],
  ['MW', ['MW', 'MWe', 'MWt', 'MWth']],
  ['kW', ['kW']],
  ['kV', ['kV']],
  ['V DC', ['V DC']],
  ['mSv/h', ['mSv/h']],
  ['µSv/h', ['µSv/h', 'uSv/h']],
  ['rpm', ['rpm']],
  ['Hz', ['Hz']],
  ['ppm', ['ppm']],
  ['pcm', ['pcm']],
  ['cps', ['cps']],
  ['kJ/kg', ['kJ/kg']],
  ['MJ', ['MJ']],
  ['m³', ['m³', 'm3']],
]
const UNIT_BY_SPELLING = new Map(UNIT_SPELLINGS.flatMap(([unit, spellings]) => spellings.map(spelling => [spelling.toLowerCase(), unit] as const)))
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
// Longest spellings first, so "percentage points" wins over "percent" and "°C/s" over "°C".
export const UNIT_PATTERN = [...UNIT_BY_SPELLING.keys()].sort((left, right) => right.length - left.length).map(escape).join('|')
// A number and a unit not continued by a rate ("%/min") or a longer word ("MPa" in "MPag").
const QUANTITY = new RegExp(`(?<![\\w.,])([-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)\\s?(${UNIT_PATTERN})(?![\\w/])`, 'gi')

export const canonicalUnit = (unit: string): string => UNIT_BY_SPELLING.get(unit.toLowerCase()) ?? unit

// Units that measure one quantity, by their exact factor to a common base, so
// a value cited in one is compared with a value shown in another ("15.5 MPa"
// beside a display reading 15500 kPa). Any other unit compares only with
// itself.
const SCALES = new Map<string, { readonly base: string; readonly factor: number }>([
  ['kPa', { base: 'Pa', factor: 1e3 }],
  ['bar', { base: 'Pa', factor: 1e5 }],
  ['MPa', { base: 'Pa', factor: 1e6 }],
  ['kW', { base: 'W', factor: 1e3 }],
  ['MW', { base: 'W', factor: 1e6 }],
  ['µSv/h', { base: 'Sv/h', factor: 1e-6 }],
  ['mSv/h', { base: 'Sv/h', factor: 1e-3 }],
  ['kg/s', { base: 'kg/s', factor: 1 }],
  ['t/h', { base: 'kg/s', factor: 1 / 3.6 }],
])

/** A quantity in the unit an answer cites, where both measure the same thing; undefined across quantities. */
export const inUnit = (quantity: Quantity, unit: string): number | undefined => {
  const from = canonicalUnit(quantity.unit)
  if (from === unit) return quantity.value
  const source = SCALES.get(from)
  const target = SCALES.get(unit)
  return source !== undefined && target !== undefined && source.base === target.base ? quantity.value * source.factor / target.factor : undefined
}

export const quantitiesIn = (text: string): ReadonlyArray<Quantity & { readonly text: string; readonly index: number }> =>
  [...text.matchAll(QUANTITY)].map(match => ({
    value: Number(match[1]!.replace(/,/g, '').replace('−', '-')),
    unit: canonicalUnit(match[2]!),
    text: match[0],
    index: match.index,
  }))

/** Rounded as written ("83" covers 82.5-83.5), and a little more for values read moments apart. */
export const near = (cited: number, written: string, shown: number): boolean => {
  const decimals = written.match(/\.(\d+)/)?.[1]?.length ?? 0
  return Math.abs(cited - shown) <= Math.max(0.5 * 10 ** -decimals, 0.03 * Math.max(Math.abs(cited), Math.abs(shown)))
}

/** Whether a shown quantity reads as the cited one, in the cited unit and rounded as it was written. */
export const reads = (cited: Quantity & { readonly text: string }, shown: Quantity): boolean => {
  const value = inUnit(shown, cited.unit)
  return value !== undefined && near(cited.value, cited.text, value)
}

// A clause that says it cites something the display does not show.
export const NOT_SHOWN = /\bnot (?:shown|displayed|drawn|trended|on (?:the|this) (?:display|view|mimic|trend))\b|\b(?:isn't|aren't|is not|are not) (?:shown|displayed|drawn|on the display)\b|\boutside (?:the|this) display\b|\boff[- ]display\b/i

// A percentage in parentheses after another figure in its clause is derived
// from it ("a 7.2 MW increase (about 0.2%)"), not a reading.
export const derivedPercent = (sentence: string, index: number): boolean => {
  const open = sentence.lastIndexOf('(', index)
  if (open < 0 || sentence.lastIndexOf(')', index) > open) return false
  return /\d/.test(sentence.slice(0, open).split(/[,;:]/).at(-1)!)
}

export const stripMarkdown = (answer: string): string => answer
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/[*_`]/g, '')

export const sentencesOf = (prose: string): ReadonlyArray<string> =>
  prose.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 0)

// --- Words ------------------------------------------------------------------

const singular = (word: string): string => {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses') || word.endsWith('uses') || word.endsWith('xes')) return word.slice(0, -2)
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

/** Lowercase singular words, camelCase and tags split: "sgB.levelPercent" → sg, b, level, percent. */
export const wordsOf = (text: string): ReadonlyArray<string> => text
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^\p{L}\p{N}]+/u)
  .filter(word => word.length > 0)
  .map(singular)

// Words that say how to look, not what at.
export const FILLER = new Set([
  'the', 'a', 'an', 'its', 'their', 'his', 'her', 'this', 'that', 'these', 'those', 'both', 'all', 'each', 'every', 'any',
  'some', 'other', 'also', 'still', 'now', 'next', 'first', 'then', 'again', 'further', 'just', 'only', 'more', 'most',
  'very', 'here', 'there', 'current', 'closely', 'carefully', 'continuously', 'especially', 'particularly', 'mainly',
  'and', 'or', 'plus', 'out',
])
export const content = (words: ReadonlyArray<string>): ReadonlyArray<string> =>
  words.filter(word => !FILLER.has(word) && !word.endsWith('ly') && word.length > 1 && !/^\d+$/.test(word))

// Unit words in paths ("levelPercent", "flowKgPerS") name no item.
export const UNIT_WORDS = new Set([...UNIT_BY_SPELLING.keys()].flatMap(wordsOf).concat(['per', 'kg', 'mw', 'mpa', 'deg', 'c']))

// --- What the display shows ---------------------------------------------------

/** A critical-safety-function status the display shows, read as an item: its words and values. */
export const statusItem = (status: NonNullable<EmbeddedViewContent['statuses']>[number]): Item =>
  ({ names: [...status.names], values: [...status.values], limits: [], history: false })

/** Every item the display shows, its statuses read as items. */
export const shownItems = (view: EmbeddedViewContent): ReadonlyArray<Item> => [...view.items, ...(view.statuses ?? []).map(statusItem)]

/**
 * Quantities an item shows: what it reads now, the limits it marks, how far
 * one is from another, and those written in a drawn state ("35 % open").
 */
export const itemQuantities = (item: Item): ReadonlyArray<Quantity> => {
  const readings = [...item.values, ...quantitiesIn(item.state ?? '').map(({ value, unit }) => ({ value, unit }))]
  return [
    ...readings,
    ...item.limits,
    ...readings.flatMap(reading => item.limits.filter(limit => limit.unit === reading.unit).map(limit => ({ value: Math.abs(reading.value - limit.value), unit: reading.unit }))),
  ].map(quantity => ({ ...quantity, unit: canonicalUnit(quantity.unit) }))
}

// Quantities the display shows, by item: its name, the words naming it,
// whether it trends, what it reads now and every quantity it shows.
export const shownQuantities = (view: EmbeddedViewContent) => shownItems(view).map(item => ({
  name: item.names[0]!,
  words: content(item.names.flatMap(wordsOf)).filter(word => !UNIT_WORDS.has(word)),
  history: item.history,
  now: item.values,
  quantities: itemQuantities(item),
}))

// A value said to be the current one ("is currently 99 %", "now at 20 %"):
// it must be what the display reads now, not an earlier value of a trend.
export const CURRENT = /\b(?:currently|now|presently|at present)(?:\s+(?:at|reads?|reading|is|are|stands?|about|around|approximately|roughly))*\s*[~≈]?\s*$/i

export const decimalsOf = (written: string): number => written.match(/\.(\d+)/)?.[1]?.length ?? 0

// --- Items a clause names --------------------------------------------------------

/** Word pairs and the longer words of an item's names: "SG B" tells SG B from SG A, where "level" does not. */
const itemTerms = (item: Item) => {
  const sequences = item.names.map(wordsOf)
  return {
    pairs: new Set(sequences.flatMap(sequence => sequence.slice(1).map((word, at) => `${sequence[at]} ${word}`))),
    words: new Set(sequences.flat().filter(word => word.length >= 3 && !FILLER.has(word) && !UNIT_WORDS.has(word))),
  }
}

/**
 * The items a clause is about: those it names best by their word pairs and
 * longer words, or whose current value it cites; none where nothing names an
 * item at least by a pair or two words.
 */
export const itemsNamed = (clause: string, items: ReadonlyArray<Item>): ReadonlyArray<Item> => {
  const said = wordsOf(clause)
  const pairs = new Set(said.slice(1).map((word, at) => `${said[at]} ${word}`))
  const words = new Set(said)
  const cited = quantitiesIn(clause)
  const scored = items.map(item => {
    const terms = itemTerms(item)
    const valued = cited.some(quantity => item.values.some(value => reads(quantity, value)))
    return { item, score: 2 * [...terms.pairs].filter(pair => pairs.has(pair)).length + [...terms.words].filter(word => words.has(word)).length + (valued ? 2 : 0) }
  })
  const best = Math.max(0, ...scored.map(entry => entry.score))
  return best < 2 ? [] : scored.filter(entry => entry.score === best).map(entry => entry.item)
}

/** Clauses of a sentence, split where it may turn to another item: "SG A is rising, while SG B is falling". */
export const clausesOf = (sentence: string): ReadonlyArray<string> =>
  sentence.split(/;|—|–|,\s*(?:but|while|whereas|and|although|though|yet)\s+/i).map(clause => clause.trim()).filter(clause => clause.length > 0)

export const names = (items: ReadonlyArray<Item>): string => items.map(item => item.names[0]!).join(', ')

// --- Limits an answer names ----------------------------------------------------

// A limit named as the display names them or in words: "HI ALM 16 MPa",
// "LO-LO TRIP 20%", "LO-3 12.7 MPa · SI", "LO TRIP", "low alarm at 14.8 MPa".
// Without a kind (ALM, TRIP) only the display's capitals with a value name
// one, and without a value only its capitals with a kind: "low 20 %" and "the
// low trip" are words. The value's unit may be left out ("LO-LO 12.7").
const LIMIT = new RegExp(`\\b(HI(?:-HI|-\\d)?|LO(?:-LO|-\\d)?|high(?:[- ]high)?|low(?:[- ]low)?)(?:[- ](ALM|TRIP|alarm|trip))?(?:\\s+(?:limit|threshold|line|set ?point))?(?:(?:\\s+(?:at|of))?\\s+([-−]?\\d+(?:\\.\\d+)?)(?!\\.?\\d)(?:\\s?(${UNIT_PATTERN})(?![\\w/]))?)?`, 'gi')
// Past its second step a display writes the step's count: "LO-3".
const DISPLAY_ORDER = /^(?:HI|LO)(?:-(?:HI|LO|\d))?$/

export type CitedLimit = { readonly value: number; readonly written: string; readonly unit: string | undefined }
export type NamedLimit = { readonly text: string; readonly index: number; readonly low: boolean; readonly cited: CitedLimit | undefined }

export const limitsNamed = (text: string): ReadonlyArray<NamedLimit> => [...text.matchAll(LIMIT)].flatMap(match => {
  const [whole, order, kind, written, unit] = match
  const capitals = DISPLAY_ORDER.test(order!)
  if (kind === undefined ? !capitals || written === undefined : !capitals && written === undefined) return []
  return [{
    text: whole,
    index: match.index,
    low: /^lo/i.test(order!),
    cited: written === undefined ? undefined : { value: Number(written.replace('−', '-')), written, unit: unit === undefined ? undefined : canonicalUnit(unit) },
  }]
})

/** Whether a limit the display marks is the one cited: the same value as written, in the unit the answer gives, if any. */
export const isCited = (cited: CitedLimit, limit: Quantity): boolean => {
  const value = cited.unit === undefined ? limit.value : inUnit(limit, cited.unit)
  return value !== undefined && near(cited.value, cited.written, value)
}

/** Whether an item's value is still short of a limit cited for it, read in the cited unit (or that limit's). */
export const shortOf = (item: Item, cited: CitedLimit, low: boolean): boolean => {
  const unit = cited.unit ?? item.limits.find(limit => isCited(cited, limit))?.unit
  // An item that marks no such limit, or reads no value in its unit, is short of nothing.
  if (unit === undefined) return false
  const value = item.values.map(reading => inUnit(reading, canonicalUnit(unit))).find(reading => reading !== undefined)
  return value !== undefined && (low ? value > cited.value : value < cited.value)
}
