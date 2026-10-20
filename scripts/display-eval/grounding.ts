/** Grounding metrics: offline measures of how an answer cites the display it
 * presents. They were blocking corrections in the answer path until P0
 * (register A6): only a contradicted value still holds an answer back there
 * (apps/agents/src/agents/answer-consistency.ts). Everything else is measured
 * here, over recorded answers and the view content their displays published:
 *
 * - contradiction: a value the display contradicts (the live check's verdict)
 * - not-shown: a value in a unit the display does not show, or that no shown item reads
 * - precision: a value cited more finely than the display writes it
 * - watch: a "watch …" item the display does not show
 * - span: a time window longer than the display's axis or record
 * - first-out: a first-out cited beside a display without alarms
 * - lead: the display's lead left out, or another item named as its lead
 * - direction: a direction the display shows otherwise
 * - limit-ahead: a limit named other than the one the display names ahead
 * - time-to-limit: a time to a limit the display does not project
 *
 *   bun scripts/display-eval/grounding.ts <answers.json> [...]
 *
 * Each file holds one record or an array of records { id?, answer, viewContent },
 * viewContent as the presenting display's compose result published it. Prints
 * per-check counts and every finding as JSON. Reads only the files it is given.
 */
import { embeddedViewContentSchema, type EmbeddedViewContent } from '../../packages/contracts/src/index.ts'
import { contradictionsOf } from '../../apps/agents/src/agents/answer-consistency.ts'
import {
  CURRENT,
  NOT_SHOWN,
  canonicalUnit,
  clausesOf,
  content,
  decimalsOf,
  derivedPercent,
  inUnit,
  isCited,
  itemsNamed,
  limitsNamed,
  names,
  quantitiesIn,
  reads,
  sentencesOf,
  shortOf,
  shownQuantities,
  stripMarkdown,
  wordsOf,
  type Direction,
  type Item,
  type NamedLimit,
} from '../../apps/agents/src/agents/answer-reading.ts'

export type GroundingCheck =
  | 'contradiction' | 'not-shown' | 'precision' | 'watch' | 'span' | 'first-out'
  | 'lead' | 'direction' | 'limit-ahead' | 'time-to-limit'

export interface GroundingFinding {
  readonly check: GroundingCheck
  readonly text: string
}

// --- Values the display does not show ------------------------------------------

/** Values no shown item reads, other than those the live check finds contradicted. */
const notShownIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent, contradicted: ReadonlySet<string>): ReadonlyArray<string> => {
  const shown = shownQuantities(view)
  return sentences.flatMap(sentence => NOT_SHOWN.test(sentence) ? [] : quantitiesIn(sentence).flatMap(cited => {
    if (contradicted.has(`${cited.index}\u0000${sentence}`)) return []
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
    if (trendedNamed.length > 0 && !CURRENT.test(sentence.slice(0, cited.index))) return []
    return [`It cites ${cited.text}, which the display does not show${trended.length === 0 ? '' : ` (it trends ${cited.unit} only for ${trended.map(item => item.name).join(', ')})`}.`]
  }))
}

// --- Watch items ------------------------------------------------------------------

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

// --- Time spans --------------------------------------------------------------------

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

// --- First-outs and the lead ---------------------------------------------------------

// A first-out the answer cites: "the first-out was Manual turbine trip", "1st TURB TRIP".
const FIRST_OUT = /\bfirst[- ]out\b|\b1st\s+[A-Z]/i
// What a display names first-outs in: its alarms panel, an annunciator.
const ANNUNCIATION_WORDS = ['alarm', 'annunciator', 'annunciation', 'first']

/**
 * A first-out the answer cites while its display shows no alarms or
 * annunciation that could name it (run 26 why-turbine-trip: the answer cited
 * "Manual turbine trip", which its display did not show).
 */
const firstOutIssues = (sentences: ReadonlyArray<string>, view: EmbeddedViewContent): ReadonlyArray<string> => {
  const shown = new Set(view.items.flatMap(item => [...item.names, item.state ?? ''].flatMap(wordsOf)))
  if (ANNUNCIATION_WORDS.some(word => shown.has(word))) return []
  return sentences.flatMap(sentence => FIRST_OUT.test(sentence) && !NOT_SHOWN.test(sentence)
    ? [`It cites a first-out ("${sentence}"), but the display shows no alarms that name it: show the alarms panel, or mark the citation "(not shown)".`]
    : [])
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

// --- Precision -------------------------------------------------------------------------

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

// --- Direction and the limit ahead -------------------------------------------------------

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

// --- Times to a limit ----------------------------------------------------------------

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

// --- All checks ------------------------------------------------------------------------

/**
 * Every way an answer departs from the display it presents, by check: the
 * contradictions the live check corrects, and the softer findings measured
 * only here.
 */
export const groundingFindings = (answer: string, view: EmbeddedViewContent): ReadonlyArray<GroundingFinding> => {
  const prose = stripMarkdown(answer)
  const sentences = sentencesOf(prose)
  const contradictions = contradictionsOf(answer, view)
  const claimed = leadClaimIssues(sentences, view)
  const findings: ReadonlyArray<readonly [GroundingCheck, ReadonlyArray<string>]> = [
    // An answer that names another lead is told the display's lead once.
    ['lead', claimed.length > 0 ? claimed : leadIssues(prose, view)],
    ['contradiction', contradictions.map(contradiction => contradiction.issue)],
    ['not-shown', notShownIssues(sentences, view, new Set(contradictions.map(contradiction => `${contradiction.index}\u0000${contradiction.sentence}`)))],
    ['precision', precisionIssues(sentences, view)],
    ['watch', watchIssues(sentences, view)],
    ['span', spanIssues(sentences, view)],
    ['first-out', firstOutIssues(sentences, view)],
    ['direction', directionIssues(sentences, view)],
    ['limit-ahead', limitAheadIssues(sentences, view)],
    ['time-to-limit', projectionIssues(sentences, view)],
  ]
  return findings.flatMap(([check, texts]) => [...new Set(texts)].map(text => ({ check, text })))
}

// --- Command line ----------------------------------------------------------------------

interface AnswerRecord { readonly id?: string; readonly answer: string; readonly viewContent: unknown }

const recordsIn = async (path: string): Promise<ReadonlyArray<AnswerRecord>> => {
  const parsed = await Bun.file(path).json() as AnswerRecord | ReadonlyArray<AnswerRecord>
  const records = Array.isArray(parsed) ? parsed : [parsed as AnswerRecord]
  for (const [index, record] of records.entries()) {
    if (typeof record?.answer !== 'string') throw new Error(`${path} record ${index}: answer must be a string`)
  }
  return records
}

if (import.meta.main) {
  const paths = Bun.argv.slice(2)
  if (paths.length === 0) throw new Error('Usage: bun scripts/display-eval/grounding.ts <answers.json> [...]')
  const results = (await Promise.all(paths.map(recordsIn))).flat().map((record, index) => ({
    id: record.id ?? String(index),
    findings: groundingFindings(record.answer, embeddedViewContentSchema.parse(record.viewContent)),
  }))
  const checks: ReadonlyArray<GroundingCheck> = ['lead', 'contradiction', 'not-shown', 'precision', 'watch', 'span', 'first-out', 'direction', 'limit-ahead', 'time-to-limit']
  const counts = Object.fromEntries(checks.map(check => [check, {
    answers: results.filter(result => result.findings.some(finding => finding.check === check)).length,
    findings: results.reduce((sum, result) => sum + result.findings.filter(finding => finding.check === check).length, 0),
  }]))
  console.log(JSON.stringify({ answers: results.length, counts, results }, null, 2))
}
