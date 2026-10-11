// ============================================================================
// Answer consistency — does an answer cite only what its display shows?
//
// The operator reads the answer and its display together. An HMI review of
// evaluation run 19 found answers citing flows, levels and "watch" items the
// display did not show, promising a 10-minute window over a 1 min axis, and
// leaving out what the display led with. This check compares the answer's
// prose with the content the owning Module published for the view (the
// contract's embedded view content). It is deterministic and errs towards
// silence: a cited quantity counts as shown when the display reads anything
// close to it in the same unit, a "watch" item when any word of what the
// display shows names it, and anything the answer marks "not shown" is left
// alone. Each issue names what to fix; evaluation.ts turns them into one
// bounded correction turn.
// ============================================================================

import type { EmbeddedViewContent } from '@leitbild/contracts'

type Quantity = { readonly value: number; readonly unit: string }

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
const UNIT_PATTERN = [...UNIT_BY_SPELLING.keys()].sort((left, right) => right.length - left.length).map(escape).join('|')
// A number and a unit not continued by a rate ("%/min") or a longer word ("MPa" in "MPag").
const QUANTITY = new RegExp(`(?<![\\w.,])([-−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)\\s?(${UNIT_PATTERN})(?![\\w/])`, 'gi')

const canonicalUnit = (unit: string): string => UNIT_BY_SPELLING.get(unit.toLowerCase()) ?? unit

const quantitiesIn = (text: string): ReadonlyArray<Quantity & { readonly text: string; readonly index: number }> =>
  [...text.matchAll(QUANTITY)].map(match => ({
    value: Number(match[1]!.replace(/,/g, '').replace('−', '-')),
    unit: canonicalUnit(match[2]!),
    text: match[0],
    index: match.index,
  }))

/** Rounded as written ("83" covers 82.5-83.5), and a little more for values read moments apart. */
const near = (cited: number, written: string, shown: number): boolean => {
  const decimals = written.match(/\.(\d+)/)?.[1]?.length ?? 0
  return Math.abs(cited - shown) <= Math.max(0.5 * 10 ** -decimals, 0.03 * Math.max(Math.abs(cited), Math.abs(shown)))
}

// A clause that says it cites something the display does not show.
const NOT_SHOWN = /\bnot (?:shown|displayed|drawn|trended|on (?:the|this) (?:display|view|mimic|trend))\b|\b(?:isn't|aren't|is not|are not) (?:shown|displayed|drawn|on the display)\b|\boutside (?:the|this) display\b|\boff[- ]display\b/i

// A percentage in parentheses after another figure in its clause is derived
// from it ("a 7.2 MW increase (about 0.2%)"), not a reading.
const derivedPercent = (sentence: string, index: number): boolean => {
  const open = sentence.lastIndexOf('(', index)
  if (open < 0 || sentence.lastIndexOf(')', index) > open) return false
  return /\d/.test(sentence.slice(0, open).split(/[,;:]/).at(-1)!)
}

const stripMarkdown = (answer: string): string => answer
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/[*_`]/g, '')

const sentencesOf = (prose: string): ReadonlyArray<string> =>
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
const wordsOf = (text: string): ReadonlyArray<string> => text
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^\p{L}\p{N}]+/u)
  .filter(word => word.length > 0)
  .map(singular)

// Words that say how to look, not what at.
const FILLER = new Set([
  'the', 'a', 'an', 'its', 'their', 'his', 'her', 'this', 'that', 'these', 'those', 'both', 'all', 'each', 'every', 'any',
  'some', 'other', 'also', 'still', 'now', 'next', 'first', 'then', 'again', 'further', 'just', 'only', 'more', 'most',
  'very', 'here', 'there', 'current', 'closely', 'carefully', 'continuously', 'especially', 'particularly', 'mainly',
  'and', 'or', 'plus', 'out',
])
const content = (words: ReadonlyArray<string>): ReadonlyArray<string> =>
  words.filter(word => !FILLER.has(word) && !word.endsWith('ly') && word.length > 1 && !/^\d+$/.test(word))

// What any display shows, by what it is or how it reads: a "watch" item
// naming one of these points at the display itself.
const VIEW_WORDS = ['display', 'view', 'panel', 'mimic', 'drawing', 'diagram', 'readout', 'comparison', 'chart', 'plot', 'graph', 'value', 'reading', 'indication', 'line']
const TREND_WORDS = ['trend', 'rate', 'slope', 'direction', 'response', 'recovery', 'change', 'behavior', 'behaviour', 'rise', 'fall', 'drop', 'increase', 'decrease', 'history', 'curve']
const LIMIT_WORDS = ['limit', 'threshold', 'margin', 'setpoint', 'set', 'point']
const DRAWING_WORDS = ['lineup', 'line', 'up', 'path', 'route', 'alignment', 'state', 'status', 'supply', 'connection']

const shownWords = (view: EmbeddedViewContent): ReadonlySet<string> => new Set([
  ...view.items.flatMap(item => [...item.names, item.state ?? ''].flatMap(wordsOf)),
  ...VIEW_WORDS,
  ...(view.span !== null || view.items.some(item => item.history) ? TREND_WORDS : []),
  ...(view.items.some(item => item.limits.length > 0) ? LIMIT_WORDS : []),
  ...(view.items.some(item => item.state !== undefined) ? DRAWING_WORDS : []),
])

// --- Checks -----------------------------------------------------------------

// Quantities the display shows: what it reads now, the limits it marks, how
// far one is from another, and those written in a drawn state ("35 % open").
const shownQuantities = (view: EmbeddedViewContent) => view.items.map(item => {
  const readings = [...item.values, ...quantitiesIn(item.state ?? '').map(({ value, unit }) => ({ value, unit }))]
  const marked = [...readings, ...item.limits]
  return {
    name: item.names[0]!,
    words: content(item.names.flatMap(wordsOf)).filter(word => !UNIT_WORDS.has(word)),
    history: item.history,
    quantities: [
      ...marked,
      ...readings.flatMap(reading => item.limits.filter(limit => limit.unit === reading.unit).map(limit => ({ value: Math.abs(reading.value - limit.value), unit: reading.unit }))),
    ].map(quantity => ({ ...quantity, unit: canonicalUnit(quantity.unit) })),
  }
})

// Unit words in paths ("levelPercent", "flowKgPerS") name no item.
const UNIT_WORDS = new Set([...UNIT_BY_SPELLING.keys()].flatMap(wordsOf).concat(['per', 'kg', 'mw', 'mpa', 'deg', 'c']))

const quantityIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const shown = shownQuantities(view)
  return sentences.flatMap(sentence => NOT_SHOWN.test(sentence) ? [] : quantitiesIn(sentence).flatMap(cited => {
    if (cited.unit === '%' && derivedPercent(sentence, cited.index)) return []
    const sameUnit = shown.filter(item => item.quantities.some(quantity => quantity.unit === cited.unit))
    if (sameUnit.length === 0) return [`It cites ${cited.text}, but the display shows no value in ${cited.unit}.`]
    if (sameUnit.some(item => item.quantities.some(quantity => quantity.unit === cited.unit && near(cited.value, cited.text, quantity.value)))) return []
    // A trend shows earlier values too, so a value of its unit is shown if
    // the sentence names a trended item before it or its clause right after
    // it ("SG A was 53.8 %", "157 kg/s steam outflow"; not "the valve's
    // position feedback is 35 %").
    const trended = sameUnit.filter(item => item.history)
    const after = sentence.slice(cited.index + cited.text.length).split(/[,;:(]/)[0]!
    const named = new Set(content(wordsOf(`${sentence.slice(0, cited.index)} ${after}`)))
    if (trended.some(item => item.words.some(word => named.has(word)))) return []
    return [`It cites ${cited.text}, which the display does not show${trended.length === 0 ? '' : ` (it trends ${cited.unit} only for ${trended.map(item => item.name).join(', ')})`}.`]
  }))
}

const WATCH = /\b(?:watch(?:ing)?|monitor(?:ing)?|track(?:ing)?|keep (?:an eye on|watching|monitoring|checking|tracking))\b/gi
// A conjunct starting with another instruction ends what is watched: "watch the levels, and confirm…".
const INSTRUCTION = /^(?:confirm|check|verify|ensure|escalate|use|follow|assess|consider|call|start|stop|close|open|trip|initiate|prepare|notify|reduce|raise|compare|see|look|refer|apply|take|review|contact|record|expect|note|be|do|act|respond|evaluate|investigate|report)\b/i
// Where a watched item ends and what it is watched for begins.
const QUALIFIER = /\b(?:for|to|until|as|before|after|if|while|because|so|against|since|during|over|in|on|at|from|with|by|toward|towards|under|above|below|beyond|near|within|across|through|of|than|which|who|where|when)\b/i
const CLAUSE = /^(?:whether|if|how|that|when|until)\b/i

/** The things a "watch" sentence names: one word list per conjunct, whole (for a whether-clause) or up to its head. */
const watchedItems = (sentence: string): ReadonlyArray<{ readonly text: string; readonly words: ReadonlyArray<string>; readonly clause: boolean }> =>
  [...sentence.matchAll(WATCH)].flatMap((match, at, all) => {
    const end = all[at + 1]?.index ?? sentence.length
    const object = sentence.slice(match.index + match[0].length, end).replace(/\([^)]*\)?/g, ' ').split(/[;:!?—–]|\.(?!\d)/)[0]!
    const items: Array<{ readonly text: string; readonly words: ReadonlyArray<string>; readonly clause: boolean }> = []
    for (const segment of object.split(',')) {
      const trimmed = segment.trim().replace(/^(?:and|or|then|plus|as well as)\s+/i, '').replace(/^(?:out\s+)?for\s+/i, '')
      if (INSTRUCTION.test(trimmed)) break
      if (/^not\b/i.test(trimmed)) continue
      const clause = CLAUSE.test(trimmed)
      const kept = clause ? trimmed.replace(CLAUSE, '') : trimmed.split(QUALIFIER)[0]!
      for (const conjunct of kept.split(/\b(?:and|or|plus)\b/i)) {
        if (INSTRUCTION.test(conjunct.trim())) break
        const words = content(wordsOf(conjunct))
        if (words.length > 0) items.push({ text: conjunct.trim(), words, clause })
      }
    }
    return items
  })

const watchIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const shown = shownWords(view)
  return sentences.flatMap(sentence => NOT_SHOWN.test(sentence) ? [] : watchedItems(sentence).flatMap(item => {
    // A whether-clause names what it watches somewhere in it; a plain item by its last word ("SG levels": levels).
    const named = item.clause ? item.words.some(word => shown.has(word)) : shown.has(item.words.at(-1)!)
    return named ? [] : [`It says to watch "${item.text}", which the display does not show.`]
  }))
}

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 }
const DURATION_UNITS: Readonly<Record<string, number>> = { second: 1_000, sec: 1_000, minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000 }
const COUNT = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`
const UNIT = `(${Object.keys(DURATION_UNITS).join('|')})s?`
// "a 10-minute window", "the 2 min trend"; "the last 10 minutes", "over the recorded minute".
const WINDOW_PHRASES = [
  new RegExp(`\\b${COUNT}[- ]${UNIT}[- ](?:window|trend|plot|history|span|horizon|axis|chart|graph|record)\\b`, 'gi'),
  new RegExp(`\\b(?:last|past|previous|preceding|recorded)\\s+(?:${COUNT}\\s+)?${UNIT}\\b`, 'gi'),
]

const durationMs = (count: string | undefined, unit: string): number =>
  (count === undefined ? 1 : NUMBER_WORDS[count.toLowerCase()] ?? Number(count)) * DURATION_UNITS[unit.toLowerCase()]!

const minutes = (ms: number): string => `${Number((ms / 60_000).toFixed(1))} min`

const spanIssues = (prose: string, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const span = view.span
  if (span === null) return []
  return WINDOW_PHRASES.flatMap(pattern => [...prose.matchAll(pattern)].flatMap(match => {
    // The first pattern's count is required; the second's is optional ("the recorded minute").
    const said = durationMs(match[1], match[2]!)
    // Half a step of the axis's growth for rounding ("the last 1.5 minutes").
    if (said <= span.shownMs + 30_000) return []
    const widens = span.shownMs < span.horizonMs ? ` now; it widens to ${minutes(span.horizonMs)} as the Run continues` : ''
    return [`It says "${match[0]}", but the display's time axis spans the last ${minutes(span.shownMs)}${widens}.`]
  }))
}

const leadIssues = (prose: string, view: EmbeddedViewContent): ReadonlyArray<string> => {
  if (view.lead === null) return []
  const item = view.items[view.lead.item]!
  const said = ` ${wordsOf(prose).join(' ')} `
  if (item.names.some(name => said.includes(` ${wordsOf(name).join(' ')} `))) return []
  if (quantitiesIn(prose).some(cited => item.values.some(value => canonicalUnit(value.unit) === cited.unit && near(cited.value, cited.text, value.value)))) return []
  return [`It leaves out what the display leads with: ${view.lead.reason}.`]
}

// --- Direction and the limit ahead -------------------------------------------

type Item = EmbeddedViewContent['items'][number]
type Direction = NonNullable<Item['trend']>['direction']

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
const itemsNamed = (clause: string, items: ReadonlyArray<Item>): ReadonlyArray<Item> => {
  const said = wordsOf(clause)
  const pairs = new Set(said.slice(1).map((word, at) => `${said[at]} ${word}`))
  const words = new Set(said)
  const cited = quantitiesIn(clause)
  const scored = items.map(item => {
    const terms = itemTerms(item)
    const valued = cited.some(quantity => item.values.some(value => canonicalUnit(value.unit) === quantity.unit && near(quantity.value, quantity.text, value.value)))
    return { item, score: 2 * [...terms.pairs].filter(pair => pairs.has(pair)).length + [...terms.words].filter(word => words.has(word)).length + (valued ? 2 : 0) }
  })
  const best = Math.max(0, ...scored.map(entry => entry.score))
  return best < 2 ? [] : scored.filter(entry => entry.score === best).map(entry => entry.item)
}

// A direction stated as it is now. Past tenses ("fell", "had fallen") tell
// history the trend shows and are left alone.
const DIRECTIONS: ReadonlyArray<readonly [Direction, RegExp]> = [
  ['falling', /\b(?:falling|decreasing|dropping|declining|trending down|going down|continu(?:es|ing) to (?:fall|drop|decrease|decline))\b/i],
  ['rising', /\b(?:rising|increasing|climbing|trending up|going up|continu(?:es|ing) to (?:rise|increase|climb))\b/i],
  ['steady', /\b(?:stable|steady|flat|unchanged|constant|holding (?:steady|at)|level(?:l)?ing off|level(?:l)?ed off)\b/i],
]
// A clause that asks or supposes rather than states: "watch whether it keeps falling".
const HEDGED = /\b(?:watch|monitor|track|whether|if|could|can|may|might|would|will|should|expect(?:s|ed)?|risk|until|unless|confirm|verify|check|look for|for (?:a|any)|in case|once|when|before|after)\b/i
// A denial before the direction denies it: "does not establish that it is still falling", "no longer rising".
const DENIED = /\b(?:not|no longer|never|nor|neither|without|stopped|ceased|instead of|rather than)\b|n't\b/i
const WAS = /\b(?:was|were|had been)\s+(?:\w+\s+)?$/i
// A small change the display may still read as steady.
const SLIGHT = /\b(?:slightly|slowly|marginally|gently|barely|edging|a little|creeping)\b/i

/** Clauses of a sentence, split where it may turn to another item: "SG A is rising, while SG B is falling". */
const clausesOf = (sentence: string): ReadonlyArray<string> =>
  sentence.split(/;|—|–|,\s*(?:but|while|whereas|and|although|though|yet)\s+/i).map(clause => clause.trim()).filter(clause => clause.length > 0)

const directionStated = (clause: string): { readonly direction: Direction; readonly slight: boolean } | null => {
  if (HEDGED.test(clause)) return null
  const stated = DIRECTIONS.flatMap(([direction, pattern]) => {
    const match = pattern.exec(clause)
    if (match === null) return []
    const before = clause.slice(0, match.index)
    return WAS.test(before) || DENIED.test(before) ? [] : [direction]
  })
  // A clause saying two ways ("rising, then falling") states none plainly.
  return stated.length === 1 ? { direction: stated[0]!, slight: SLIGHT.test(clause) } : null
}

const contradicts = (stated: { readonly direction: Direction; readonly slight: boolean }, shown: Direction): boolean =>
  stated.direction !== shown && !(stated.slight && (stated.direction === 'steady' || shown === 'steady'))

const names = (items: ReadonlyArray<Item>): string => items.map(item => item.names[0]!).join(', ')
const travelShown = (trend: NonNullable<Item['trend']>): string =>
  trend.direction === 'steady' ? 'steady' : `${trend.direction} ${Number(Math.abs(trend.rate).toPrecision(3))} ${trend.unit}/min`

/**
 * A direction the answer states for an item that the display shows going
 * another way. A clause is about the items it names (or, naming none, those
 * of the clause before it in its sentence); only where the display shows a
 * rate for every one of them, and they all go another way, is it flagged.
 */
const directionIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => sentences.flatMap(sentence => {
  let about: ReadonlyArray<Item> = []
  return clausesOf(sentence).flatMap(clause => {
    const named = itemsNamed(clause, view.items)
    about = named.length > 0 ? named : about
    const stated = directionStated(clause)
    if (stated === null || about.length === 0 || !about.every(item => item.trend !== undefined && contradicts(stated, item.trend.direction))) return []
    const shown = [...new Set(about.map(item => travelShown(item.trend!)))]
    return [`It says ${names(about)} ${about.length === 1 ? 'is' : 'are'} ${stated.direction}, but the display shows ${about.length === 1 ? 'it' : 'them'} ${shown.join(', ')}.`]
  })
})

// A limit named as the display names them or in words: "HI ALM 16 MPa",
// "LO-LO TRIP 20%", "LO-LO 12.7 MPa · SI", "LO TRIP", "low alarm at 14.8 MPa".
// Without a kind (ALM, TRIP) only the display's capitals with a value name
// one, and without a value only its capitals with a kind: "low 20 %" and "the
// low trip" are words. The value's unit may be left out ("LO-LO 12.7").
const LIMIT = new RegExp(`\\b(HI(?:-HI)?|LO(?:-LO)?|high(?:[- ]high)?|low(?:[- ]low)?)(?:[- ](ALM|TRIP|alarm|trip))?(?:\\s+(?:limit|threshold|line|set ?point))?(?:(?:\\s+(?:at|of))?\\s+([-−]?\\d+(?:\\.\\d+)?)(?!\\.?\\d)(?:\\s?(${UNIT_PATTERN})(?![\\w/]))?)?`, 'gi')
const DISPLAY_ORDER = /^(?:HI|LO)(?:-(?:HI|LO))?$/

type CitedLimit = { readonly value: number; readonly written: string; readonly unit: string | undefined }
type NamedLimit = { readonly text: string; readonly low: boolean; readonly cited: CitedLimit | undefined }

const limitsNamed = (text: string): ReadonlyArray<NamedLimit> => [...text.matchAll(LIMIT)].flatMap(match => {
  const [whole, order, kind, written, unit] = match
  const capitals = DISPLAY_ORDER.test(order!)
  if (kind === undefined ? !capitals || written === undefined : !capitals && written === undefined) return []
  return [{
    text: whole,
    low: /^lo/i.test(order!),
    cited: written === undefined ? undefined : { value: Number(written.replace('−', '-')), written, unit: unit === undefined ? undefined : canonicalUnit(unit) },
  }]
})

/** Whether a limit the display marks is the one cited: the same value as written, in its unit where the answer gives one. */
const isCited = (cited: CitedLimit, limit: { readonly value: number; readonly unit: string }): boolean =>
  (cited.unit === undefined || canonicalUnit(limit.unit) === cited.unit) && near(cited.value, cited.written, limit.value)

/** Whether an item's value is still short of a limit cited for it, read in that limit's unit. */
const shortOf = (item: Item, cited: CitedLimit, low: boolean): boolean => {
  const unit = cited.unit ?? item.limits.find(limit => isCited(cited, limit))?.unit
  // An item that marks no such limit, or reads no value in its unit, is short of nothing.
  if (unit === undefined) return false
  const value = item.values.find(reading => canonicalUnit(reading.unit) === canonicalUnit(unit))?.value
  return value !== undefined && (low ? value > cited.value : value < cited.value)
}

/**
 * A limit the answer names for an item, not yet passed, other than the limit
 * ahead the display's legend names for it, where the answer never names that
 * one: "0.542 MPa below HI ALM 16 MPa" beside a legend reading "0.658 MPa
 * above LO ALM 14.8 MPa" for a falling pressure. A limit the value is past
 * ("below LO TRIP 20%") is what the display marks too, and is left alone.
 */
const limitAheadIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const aheadNamed = new Set<Item>()
  const other = new Map<Item, string>()
  for (const sentence of sentences) {
    for (const { text, low, cited } of limitsNamed(sentence)) {
      if (cited === undefined) continue
      const limited = view.items.filter(item => item.limitAhead !== undefined && item.limits.some(limit => isCited(cited, limit)))
      const named = itemsNamed(sentence, limited)
      for (const item of named.length > 0 ? named : limited) {
        if (isCited(cited, item.limitAhead!)) { aheadNamed.add(item); continue }
        if (shortOf(item, cited, low) && !other.has(item)) other.set(item, text)
      }
    }
  }
  const byFix = new Map<string, Item[]>()
  for (const [item, cited] of other) {
    if (aheadNamed.has(item)) continue
    const key = `${cited}|${item.limitAhead!.name}`
    byFix.set(key, [...(byFix.get(key) ?? []), item])
  }
  return [...byFix.entries()].map(([key, items]) => {
    const [cited, ahead] = key.split('|') as [string, string]
    const trend = items[0]!.trend
    const moving = trend === undefined || trend.direction === 'steady' ? '' : ` as ${items.length === 1 ? 'it is' : 'they are'} ${trend.direction}`
    return `It names ${cited} for ${names(items)}, but the display names ${ahead} as the limit ahead${moving}: name ${ahead} as the display does.`
  })
}

/**
 * Where an answer and the display it presents disagree: quantities and
 * "watch" items the display does not show (unless the answer says so), a time
 * window longer than the display's axis, the display's lead left out, a
 * direction the display shows otherwise, and a limit other than the one the
 * display names ahead.
 */
export const answerViewIssues = (answer: string, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const prose = stripMarkdown(answer)
  const sentences = sentencesOf(prose)
  return [...new Set([
    ...leadIssues(prose, view),
    ...quantityIssues(sentences, view),
    ...watchIssues(sentences, view),
    ...spanIssues(prose, view),
    ...directionIssues(sentences, view),
    ...limitAheadIssues(sentences, view),
  ])]
}
