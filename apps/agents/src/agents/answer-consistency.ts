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
// display shows names it, a time to a limit when the display projects one
// near it, and anything the answer marks "not shown" is left alone. Each
// issue names what to fix; evaluation.ts turns them into one bounded
// correction turn.
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
const inUnit = (quantity: Quantity, unit: string): number | undefined => {
  const from = canonicalUnit(quantity.unit)
  if (from === unit) return quantity.value
  const source = SCALES.get(from)
  const target = SCALES.get(unit)
  return source !== undefined && target !== undefined && source.base === target.base ? quantity.value * source.factor / target.factor : undefined
}

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

/** Whether a shown quantity reads as the cited one, in the cited unit and rounded as it was written. */
const reads = (cited: Quantity & { readonly text: string }, shown: Quantity): boolean => {
  const value = inUnit(shown, cited.unit)
  return value !== undefined && near(cited.value, cited.text, value)
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
const STATUS_WORDS = ['status', 'colour', 'color', 'branch', 'tree', 'function']

const shownWords = (view: EmbeddedViewContent): ReadonlySet<string> => new Set([
  ...view.items.flatMap(item => [...item.names, item.state ?? ''].flatMap(wordsOf)),
  ...(view.statuses ?? []).flatMap(status => [...status.names, status.status].flatMap(wordsOf)),
  ...VIEW_WORDS,
  ...(view.span !== null || view.items.some(item => item.history) ? TREND_WORDS : []),
  ...(view.items.some(item => item.limits.length > 0) ? LIMIT_WORDS : []),
  ...(view.items.some(item => item.state !== undefined) ? DRAWING_WORDS : []),
  ...((view.statuses ?? []).length > 0 ? STATUS_WORDS : []),
])

// --- Checks -----------------------------------------------------------------

// Quantities the display shows: what it reads now, the limits it marks, how
// far one is from another, those written in a drawn state ("35 % open"), and
// the values and thresholds behind a status it shows.
const statusItem = (status: NonNullable<EmbeddedViewContent['statuses']>[number]): Item =>
  ({ names: [...status.names], values: [...status.values], limits: [], history: false })
const shownQuantities = (view: EmbeddedViewContent) => [...view.items, ...(view.statuses ?? []).map(statusItem)].map(item => {
  const readings = [...item.values, ...quantitiesIn(item.state ?? '').map(({ value, unit }) => ({ value, unit }))]
  const marked = [...readings, ...item.limits]
  return {
    name: item.names[0]!,
    words: content(item.names.flatMap(wordsOf)).filter(word => !UNIT_WORDS.has(word)),
    history: item.history,
    now: item.values,
    quantities: [
      ...marked,
      ...readings.flatMap(reading => item.limits.filter(limit => limit.unit === reading.unit).map(limit => ({ value: Math.abs(reading.value - limit.value), unit: reading.unit }))),
    ].map(quantity => ({ ...quantity, unit: canonicalUnit(quantity.unit) })),
  }
})

// Unit words in paths ("levelPercent", "flowKgPerS") name no item.
const UNIT_WORDS = new Set([...UNIT_BY_SPELLING.keys()].flatMap(wordsOf).concat(['per', 'kg', 'mw', 'mpa', 'deg', 'c']))

// A value said to be the current one ("is currently 99 %", "now at 20 %"):
// it must be what the display reads now, not an earlier value of a trend.
const CURRENT = /\b(?:currently|now|presently|at present)(?:\s+(?:at|reads?|reading|is|are|stands?|about|around|approximately|roughly))*\s*[~≈]?\s*$/i

const quantityIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const shown = shownQuantities(view)
  return sentences.flatMap(sentence => NOT_SHOWN.test(sentence) ? [] : quantitiesIn(sentence).flatMap(cited => {
    if (cited.unit === '%' && derivedPercent(sentence, cited.index)) return []
    const comparable = shown.filter(item => item.quantities.some(quantity => inUnit(quantity, cited.unit) !== undefined))
    if (comparable.length === 0) return [`It cites ${cited.text}, but the display shows no value in ${cited.unit}.`]
    if (comparable.some(item => item.quantities.some(quantity => reads(cited, quantity)))) return []
    // A trend shows earlier values too, so a value of its unit is shown if
    // the sentence names a trended item before it or its clause right after
    // it ("SG A was 53.8 %", "157 kg/s steam outflow"; not "the valve's
    // position feedback is 35 %"), unless the value is said to be current.
    const trended = comparable.filter(item => item.history)
    const after = sentence.slice(cited.index + cited.text.length).split(/[,;:(]/)[0]!
    const named = new Set(content(wordsOf(`${sentence.slice(0, cited.index)} ${after}`)))
    const trendedNamed = trended.filter(item => item.words.some(word => named.has(word)))
    if (trendedNamed.length > 0 && CURRENT.test(sentence.slice(0, cited.index))) {
      const now = trendedNamed.flatMap(item => item.now.flatMap(value => inUnit(value, cited.unit) === undefined ? [] : [`${item.name} ${Number(value.value.toPrecision(3))} ${value.unit}`]))
      return [`It cites ${cited.text} as current, but the display reads ${now.join(', ')} now.`]
    }
    if (trendedNamed.length > 0) return []
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

// Half a step of the axis's growth for rounding ("the last 1.5 minutes").
const WINDOW_ROUNDING_MS = 30_000

/**
 * A time window the answer claims, longer than what the display can back:
 * its time axis, and where it says how far back the recorded samples reach,
 * that record. A sentence naming trended items is held to their records
 * (run 25: "35.0 % throughout the last 10 min" on a 3-min record); one
 * naming none, to the longest record the display shows.
 */
const spanIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const span = view.span
  const recordedItems = view.items.filter(item => item.recordedMs !== undefined)
  if (span === null && recordedItems.length === 0) return []
  return sentences.flatMap(sentence => WINDOW_PHRASES.flatMap(pattern => [...sentence.matchAll(pattern)].flatMap(match => {
    // The first pattern's count is required; the second's is optional ("the recorded minute").
    const said = durationMs(match[1], match[2]!)
    const named = itemsNamed(sentence, recordedItems)
    const recorded = named.length > 0 ? named : recordedItems
    const recordMs = recorded.length === 0 ? undefined : Math.max(...recorded.map(item => item.recordedMs!))
    if (recordMs !== undefined && said > recordMs + WINDOW_ROUNDING_MS && (span === null || recordMs < span.shownMs)) {
      const whose = named.length > 0 ? ` of ${names(named)}` : ''
      return [`It says "${match[0]}", but the display's recorded samples${whose} reach back only ${minutes(recordMs)}: claim no more than the record covers.`]
    }
    if (span === null || said <= span.shownMs + WINDOW_ROUNDING_MS) return []
    const widens = span.shownMs < span.horizonMs ? ` now; it widens to ${minutes(span.horizonMs)} as the Run continues` : ''
    return [`It says "${match[0]}", but the display's time axis spans the last ${minutes(span.shownMs)}${widens}.`]
  })))
}

const leadIssues = (prose: string, view: EmbeddedViewContent): ReadonlyArray<string> => {
  if (view.lead === null) return []
  const item = view.items[view.lead.item]!
  const said = ` ${wordsOf(prose).join(' ')} `
  if (item.names.some(name => said.includes(` ${wordsOf(name).join(' ')} `))) return []
  if (quantitiesIn(prose).some(cited => item.values.some(value => reads(cited, value)))) return []
  return [`It leaves out what the display leads with: ${view.lead.reason}.`]
}

// What an answer says the display leads with: "the display leads with
// pressurizer pressure at 13.8 MPa", "SG-A level leads the display". The
// claim runs to the end of its clause.
const LEADS_WITH = /\b(?:display|view|overview|it)\s+(?:now\s+)?(?:leads|is leading|opens)\s+with\s+(.+)$/i
const LEADS_THE = /^(.+?)\s+leads\s+the\s+(?:display|view|overview)\b/i

/**
 * A lead the answer names that is not the display's: the items its claim
 * names best, none of them the item the display leads with (its first
 * margin). A claim that names no item ("that power trend", "the line-up"),
 * or a display without a lead, is left alone.
 */
const leadClaimIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  if (view.lead === null) return []
  const lead = view.items[view.lead.item]!
  return sentences.flatMap(sentence => sentence.split(/[,;:(]|\s[—–]\s|\s-\s/).flatMap(clause => {
    const claim = (LEADS_WITH.exec(clause)?.[1] ?? LEADS_THE.exec(clause.trim())?.[1])?.trim()
    if (claim === undefined) return []
    const named = itemsNamed(claim, view.items)
    return named.length === 0 || named.includes(lead) ? [] : [`It says the display leads with ${claim}, but it leads with ${view.lead!.reason}: name that.`]
  }))
}

// --- Precision ----------------------------------------------------------------

const decimalsOf = (written: string): number => written.match(/\.(\d+)/)?.[1]?.length ?? 0

/**
 * A value cited more finely than the display writes it ("107.33 kg/s" beside
 * a display reading 107 kg/s, evaluation run 23): read as each value it may
 * be, at the decimals the display writes that one with, in the cited unit.
 * Left alone where it may also be a value the display writes no decimals
 * for, such as a margin worked out between two of them.
 */
const precisionIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const written = [...view.items.flatMap(item => [...item.values, ...item.limits]), ...(view.statuses ?? []).flatMap(status => status.values)]
  const derived = shownQuantities(view).flatMap(item => item.quantities.filter(quantity => !written.some(shown => shown.value === quantity.value && canonicalUnit(shown.unit) === quantity.unit)))
  return sentences.flatMap(sentence => NOT_SHOWN.test(sentence) ? [] : quantitiesIn(sentence).flatMap(cited => {
    if (cited.unit === '%' && derivedPercent(sentence, cited.index)) return []
    const shown = written.filter(quantity => reads(cited, quantity))
    if (shown.length === 0 || shown.some(quantity => quantity.decimals === undefined) || derived.some(quantity => reads(cited, quantity))) return []
    const step = 10 ** -decimalsOf(cited.text)
    const finest = shown.reduce((best, quantity) => quantity.decimals! > best.decimals! ? quantity : best)
    if (shown.some(quantity => step >= inUnit({ value: 10 ** -quantity.decimals!, unit: quantity.unit }, cited.unit)! * (1 - 1e-9))) return []
    return [`It cites ${cited.text}, more precisely than the display shows it (${finest.value.toFixed(finest.decimals)} ${finest.unit}): cite it as the display does.`]
  }))
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
    const valued = cited.some(quantity => item.values.some(value => reads(quantity, value)))
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
// "LO-LO TRIP 20%", "LO-3 12.7 MPa · SI", "LO TRIP", "low alarm at 14.8 MPa".
// Without a kind (ALM, TRIP) only the display's capitals with a value name
// one, and without a value only its capitals with a kind: "low 20 %" and "the
// low trip" are words. The value's unit may be left out ("LO-LO 12.7").
const LIMIT = new RegExp(`\\b(HI(?:-HI|-\\d)?|LO(?:-LO|-\\d)?|high(?:[- ]high)?|low(?:[- ]low)?)(?:[- ](ALM|TRIP|alarm|trip))?(?:\\s+(?:limit|threshold|line|set ?point))?(?:(?:\\s+(?:at|of))?\\s+([-−]?\\d+(?:\\.\\d+)?)(?!\\.?\\d)(?:\\s?(${UNIT_PATTERN})(?![\\w/]))?)?`, 'gi')
// Past its second step a display writes the step's count: "LO-3".
const DISPLAY_ORDER = /^(?:HI|LO)(?:-(?:HI|LO|\d))?$/

type CitedLimit = { readonly value: number; readonly written: string; readonly unit: string | undefined }
type NamedLimit = { readonly text: string; readonly index: number; readonly low: boolean; readonly cited: CitedLimit | undefined }

const limitsNamed = (text: string): ReadonlyArray<NamedLimit> => [...text.matchAll(LIMIT)].flatMap(match => {
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
const isCited = (cited: CitedLimit, limit: Quantity): boolean => {
  const value = cited.unit === undefined ? limit.value : inUnit(limit, cited.unit)
  return value !== undefined && near(cited.value, cited.written, value)
}

/** Whether an item's value is still short of a limit cited for it, read in the cited unit (or that limit's). */
const shortOf = (item: Item, cited: CitedLimit, low: boolean): boolean => {
  const unit = cited.unit ?? item.limits.find(limit => isCited(cited, limit))?.unit
  // An item that marks no such limit, or reads no value in its unit, is short of nothing.
  if (unit === undefined) return false
  const value = item.values.map(reading => inUnit(reading, canonicalUnit(unit))).find(reading => reading !== undefined)
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

// --- Times to a limit ----------------------------------------------------------

// A time to a limit is the display's to project: it gives one only where the
// recent trend is a basis for it. Evaluation run 22 repeated "≈5 s to LO TRIP"
// beside a trace that had flattened; an answer that works out its own time
// from a rate is the same claim without even the display's basis.
const TIME = `(\\d+(?:\\.\\d+)?)\\s?(s|secs?|seconds?|mins?|minutes?)(?![\\w/])`
const ABOUT = '(?:about|approximately|roughly|around|nearly|only|just|under|less than|some)'
// "≈5 s": the display's own sign for a projected time.
const SIGNED_TIME = new RegExp(`[≈~]\\s?${TIME}`, 'gi')
// "about 48 s from LO ALM 16.7 °C", "2 min to the LO TRIP": a time, then the limit it leads to.
const TIME_TO = new RegExp(`(?<![\\w.,])(?:${ABOUT}\\s+|[≈~]\\s?)?${TIME}\\s+(?:away\\s+)?(?:to|until|from|before|short of)\\s`, 'gi')
// "will reach LO TRIP 20 % in about 5 s": a limit, then when, said of what is to come.
const IN_TIME = new RegExp(`\\b(?:in|within)\\s+((?:${ABOUT}\\s+|[≈~]\\s?)?${TIME})`, 'gi')
const TO_COME = /\b(?:will|would|could|may|might|reach(?:es)?|hits?|cross(?:es)?|at (?:this|that|the current|the sampled|its) rate|projected|expected)\b/i
// A condition, not a projection: "if subcooling reaches LO ALM 16.7 °C within 1 min, …".
const CONDITION = /^\s*(?:if|when|once|should|unless)\b/i
// Words between "… s to" and the limit it leads to: "48 s from LO ALM", "2 min to reaching the LO TRIP".
const LEADS_TO = /^(?:(?:the|its|reaching|hitting|crossing|go|going|before)\s+)*$/i
// What a value did, not what it will do: "fell below LO TRIP 20 % in 45 s".
const DONE = /\b(?:was|were|had|fell|rose|dropped|reached|crossed|passed|came|took|tripped|actuated|went)\b/i
// Time gone by, not to come: "≈2 min ago", "≈30 s after the trip", "for ≈1 min".
const ELAPSED_AFTER = /^\s*(?:ago|earlier|later|after|since|into|of)\b/i
const ELAPSED_BEFORE = /\b(?:last|past|previous|first|recorded|over|for|after|since)\s+(?:the\s+)?$/i
// A return inside a limit already passed ("back above LO ALM 14.8 MPa in ≈23 s")
// has no time in what the display publishes, so it is left alone.
const RETURN = /\b(?:back|recover(?:s|ing)?|return(?:s|ing)?)\s+(?:above|below|inside|within|over|under|to)\b/i

type Projection = { readonly text: string; readonly ms: number; readonly limit: NamedLimit }

const projectionMs = (count: string, unit: string): number => Number(count) * (unit.toLowerCase().startsWith('m') ? 60_000 : 1_000)

/**
 * The times to a limit a clause gives, each with the limit it is to: the one
 * named right after "… s to" or before "in … s", else the nearest. None in a
 * clause about a return or time gone by, or naming no limit.
 */
const projectionsIn = (clause: string): ReadonlyArray<Projection> => {
  const limits = limitsNamed(clause)
  if (RETURN.test(clause) || limits.length === 0) return []
  const elapsed = (start: number, end: number): boolean => ELAPSED_BEFORE.test(clause.slice(0, start)) || ELAPSED_AFTER.test(clause.slice(end))
  const nearest = (at: number): NamedLimit => limits.reduce((best, limit) => Math.abs(limit.index - at) < Math.abs(best.index - at) ? limit : best)
  const found = new Map<number, Projection>()
  const add = (at: number, projection: Projection): void => {
    if (![...found.keys()].some(index => Math.abs(index - at) <= 2)) found.set(at, projection)
  }
  for (const match of clause.matchAll(TIME_TO)) {
    const end = match.index + match[0].length
    const limit = limits.find(candidate => candidate.index >= end && LEADS_TO.test(clause.slice(end, candidate.index)))
    if (limit !== undefined) add(match.index, { text: match[0].replace(/\s+(?:away\s+)?(?:to|until|from|before|short of)\s$/i, ''), ms: projectionMs(match[1]!, match[2]!), limit })
  }
  for (const match of clause.matchAll(IN_TIME)) {
    const at = match.index + match[0].length - match[1]!.length
    const limit = limits.filter(candidate => candidate.index < match.index).at(-1)
    if (limit === undefined || CONDITION.test(clause) || !TO_COME.test(clause.slice(0, match.index)) || DONE.test(clause.slice(limit.index, match.index)) || elapsed(at, match.index + match[0].length)) continue
    add(at, { text: match[1]!, ms: projectionMs(match[2]!, match[3]!), limit })
  }
  for (const match of clause.matchAll(SIGNED_TIME)) {
    if (!elapsed(match.index, match.index + match[0].length)) add(match.index, { text: match[0], ms: projectionMs(match[1]!, match[2]!), limit: nearest(match.index) })
  }
  return [...found.values()]
}

/** A projected time as the display words it: "≈48 s", "≈4 min". */
const shownTime = (ms: number): string => ms < 120_000 ? `≈${Math.max(1, Math.round(ms / 1_000))} s` : `≈${Math.round(ms / 60_000)} min`

// Read as the display's projection where within a factor of two of it: the
// display rounds, and an answer may round further ("about a minute").
const sameTime = (said: number, shown: number): boolean => Math.abs(said - shown) <= 1_500 || (said >= shown / 2 && said <= shown * 2)

/**
 * A time to a limit the answer gives that the display does not project. The
 * time is for the items with the limit the clause names, still short of it
 * (a passed one is a return), and of those the ones it names; without a
 * value, for the items the clause names or the clause before it named.
 * Where the display projects a time for one of them, a time far from it is
 * flagged; where it can tell no item, only a display projecting none at all.
 */
const projectionIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => sentences.flatMap(sentence => {
  let about: ReadonlyArray<Item> = []
  return clausesOf(sentence).flatMap(clause => {
    const named = itemsNamed(clause, view.items)
    about = named.length > 0 ? named : about
    return projectionsIn(clause).flatMap(({ text, ms, limit }) => {
      const cited = limit.cited
      const marked = cited === undefined ? [] : view.items.filter(item => item.limits.some(candidate => isCited(cited, candidate)))
      // Every item marking the limit is past it: a return, of which the display publishes no time.
      const limited = cited === undefined ? about : marked.filter(item => shortOf(item, cited, limit.low))
      if (marked.length > 0 && limited.length === 0) return []
      const chosen = itemsNamed(clause, limited)
      const items = chosen.length > 0 ? chosen : limited
      const timed = items.filter(item => item.timeToLimitMs !== undefined)
      if (items.length === 0) {
        return view.items.some(item => item.timeToLimitMs !== undefined) ? [] : [`It gives ${text} to ${limit.text}, but the display projects no time to a limit: give the rate and margin it shows, without a time.`]
      }
      if (timed.length === 0) return [`It gives ${text} to ${limit.text} for ${names(items)}, but the display projects no time to it: give the rate and margin it shows, without a time.`]
      if (timed.some(item => sameTime(ms, item.timeToLimitMs!))) return []
      return [`It gives ${text} to ${limit.text} for ${names(timed)}, but the display projects ${shownTime(timed[0]!.timeToLimitMs!)}: give that time or none.`]
    })
  })
})

/**
 * Where an answer and the display it presents disagree: quantities and
 * "watch" items the display does not show (unless the answer says so), a
 * value cited more finely than the display writes it, a time window longer
 * than the display's axis, the display's lead left out or another named as
 * its lead, a direction the display shows otherwise, a limit other than the
 * one the display names ahead, and a time to a limit the display does not
 * project.
 */
export const answerViewIssues = (answer: string, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const prose = stripMarkdown(answer)
  const sentences = sentencesOf(prose)
  const claimed = leadClaimIssues(sentences, view)
  return [...new Set([
    // An answer that names another lead is told the display's lead once.
    ...(claimed.length > 0 ? claimed : leadIssues(prose, view)),
    ...quantityIssues(sentences, view),
    ...precisionIssues(sentences, view),
    ...watchIssues(sentences, view),
    ...spanIssues(sentences, view),
    ...directionIssues(sentences, view),
    ...limitAheadIssues(sentences, view),
    ...projectionIssues(sentences, view),
  ])]
}
