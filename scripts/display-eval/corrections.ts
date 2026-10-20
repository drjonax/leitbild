/** Why a turn paid a correction round. Agents appends each correction as a
 * user message to the turn's context (agents/evaluation.ts correctResponse,
 * REQUIRED_VIEW_CORRECTION), and the answer's generation query keeps the
 * whole context, so the causes are read exactly from it. The prefixes are
 * the ones evaluation.ts writes at bacf7a115; an unknown one is reported as
 * "other" with its opening words, never dropped. */

export type CorrectionCause = 'fence' | 'consistency' | 'claim' | 'required-view' | 'other'

export interface Correction {
  readonly cause: CorrectionCause
  /** A finer class: which fence error, which consistency rule. */
  readonly detail: ReadonlyArray<string>
}

const PREFIXES: ReadonlyArray<readonly [string, CorrectionCause]> = [
  ['Your previous response contained one or more invalid fenced blocks', 'fence'],
  ['The answer and the display it presents disagree', 'consistency'],
  ['The answer says something happened that did not', 'claim'],
  ['The reader asked for a live display, and this response presents none', 'required-view'],
]

const FENCE_DETAILS: ReadonlyArray<readonly [RegExp, string]> = [
  [/but the response does not present it/, 'view-not-presented'],
  [/is not a display composed in this turn/, 'view-not-composed'],
  [/Show at most one display per answer/, 'several-views'],
  [/```(?:map|geojson)`? block/, 'map-fence'],
]

// answer-consistency.ts issue sentences at bacf7a115, by the rule that wrote them.
const CONSISTENCY_DETAILS: ReadonlyArray<readonly [RegExp, string]> = [
  [/leads with|leaves out what the display leads with/, 'lead'],
  [/says to watch/, 'watch'],
  [/recorded samples.*reach back only|time axis spans/, 'span'],
  [/cites a first-out/, 'first-out'],
  [/more precisely than the display shows/, 'precision'],
  [/as the limit ahead/, 'limit-name'],
  [/projects no time|projects \d|give that time or none/, 'time-to-limit'],
  [/but the display shows (?:it|them) /, 'direction'],
  [/as current, but the display reads|which the display does not show|shows no value in/, 'value'],
]

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : ''

const classify = (text: string): Correction => {
  const cause = PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? 'other'
  const bullets = text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2))
  const detail = cause === 'fence' ? FENCE_DETAILS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name)
    : cause === 'consistency' || cause === 'claim'
      ? bullets.map(bullet => CONSISTENCY_DETAILS.find(([pattern]) => pattern.test(bullet))?.[1] ?? (cause === 'claim' ? 'execution-claim' : 'unclassified'))
      : cause === 'other' ? [text.slice(0, 160)] : []
  return { cause, detail }
}

// How Agents marks the message a turn answers: a person's new message, or the "Show display" request.
const TURN_MARKERS = ['[NEW]', '[Display request]'] as const

/**
 * The corrections in one answer's final generation query: every user message
 * after the turn's own question (the last message Agents marks as one).
 */
export const correctionsIn = (messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>): ReadonlyArray<Correction> => {
  let question = -1
  messages.forEach((message, index) => { if (message.role === 'user' && TURN_MARKERS.some(marker => textOf(message.content).startsWith(marker))) question = index })
  if (question < 0) throw new Error(`Generation query holds no question marked ${TURN_MARKERS.join(' or ')}; Agents changed how it marks the turn`)
  return messages.slice(question + 1).filter(message => message.role === 'user').map(message => classify(textOf(message.content)))
}
