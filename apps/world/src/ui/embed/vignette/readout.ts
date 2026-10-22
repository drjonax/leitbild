// How one value reads (architecture B): a number with its limit bar and the
// chip of the limit it is past, or a state as a word, in OpenBridge's
// readout block, bar and status indicator. Colour comes only from the
// observation's own priority; a value without one (an entity's telemetry, a
// core slot) is neutral, whatever its source calls it.
import type { Priority } from '../../../core/model/alerts.ts'
import { numberShown, numberText, unitSymbol, type Observable, type Observation, type Quantity } from '../../../core/observation/model.ts'
import { clockText, durationText } from './format.ts'

type Threshold = Observable['thresholds'][number]

/** The priorities drawn in colour; notice is bold without a hue, none is plain. */
export type AlertTone = 'caution' | 'warning' | 'alarm' | 'critical'

export const toneOf = (priority: Priority | undefined): AlertTone | null =>
  priority === 'emergency' ? 'critical' : priority === 'alarm' || priority === 'warning' || priority === 'caution' ? priority : null

/** What a readout reads: an observation's fields where there is one, the bare value otherwise. */
export interface ReadingInput {
  readonly value: Observation['value'] | undefined
  readonly unit: string
  /** The declared quantity, where there is one: a count reads whole, as the card writes it. */
  readonly quantity?: Quantity
  /** Declared read over decades: below its step a power of ten, never 0 (numberShown). */
  readonly decades?: true
  readonly thresholds: ReadonlyArray<Threshold>
  readonly quality?: Observation['quality']
  readonly priority?: Priority
  /** The threshold id the value is past. */
  readonly past?: string
  readonly since?: Observation['since']
  readonly timeToAct?: Observation['timeToAct']
  readonly why?: string
}

/** LO, LO-LO, HI, HI-HI: the limit's direction once per order. */
export const orderWord = (threshold: Pick<Threshold, 'direction' | 'order'>): string =>
  Array.from({ length: threshold.order }, () => (threshold.direction === 'low' ? 'LO' : 'HI')).join('-')

/** An `obc-bar-horizontal`: its scale, the value, and each limit as an advice zone beyond it (OpenBridge's LinearAdvice). */
export interface LimitBar {
  readonly min: number
  readonly max: number
  readonly value: number
  /** Hinted until the value is past that limit. */
  readonly advices: ReadonlyArray<{ readonly min: number; readonly max: number; readonly type: 'caution'; readonly hinted: boolean }>
}

const BAR_PAD = 0.15

/** The bar spans the limits, padded, and reaches the value only where it lies beyond them; no limits, no bar. */
export const limitBar = (value: number, thresholds: ReadonlyArray<Threshold>, past?: string): LimitBar | null => {
  if (thresholds.length === 0) return null
  const limits = thresholds.map(threshold => threshold.value)
  const low = Math.min(value, ...limits)
  const high = Math.max(value, ...limits)
  const span = high > low ? high - low : Math.max(Math.abs(low), 1)
  const min = low - span * BAR_PAD
  const max = high + span * BAR_PAD
  return {
    min,
    max,
    value,
    advices: thresholds.map(threshold => ({
      min: threshold.direction === 'high' ? threshold.value : min,
      max: threshold.direction === 'high' ? max : threshold.value,
      type: 'caution' as const,
      hinted: threshold.id !== past,
    })),
  }
}

export interface ReadingLook {
  readonly kind: 'number' | 'state'
  /** The number at its decimals, the state's word, "?" for a bad or absent reading, "—" where none applies. */
  readonly text: string
  /**
   * What a readout block shows: the number as the card writes it, read back (never "-0"), with its decimals; a
   * reading written over decades (4.4×10⁻⁸) as its text, which the block shows as written; null for a state or where
   * there is none (the block then shows `text` in its off style).
   */
  readonly value: number | string | null
  readonly decimals: number
  readonly unit: string
  readonly tone: AlertTone | null
  /** Notice: bold, no hue. */
  readonly emphasis: boolean
  /** Uncertain or stale: drawn faint, its quality in the title. */
  readonly doubtful: boolean
  /** A state: active while true, inactive while false or for an enum's word, unknown (dashed "?") while unknown. */
  readonly fill: 'filled' | 'hollow' | 'unknown'
  /** The limit the value is past: its order word alone in a table cell, with value and consequence on a row. */
  readonly chip: { readonly word: string; readonly text: string; readonly tone: AlertTone | null } | null
  readonly note: string | null
  readonly bar: LimitBar | null
  readonly title: string
}

/**
 * Whether a state reads "on" (ruling Q8): a boolean true, or a value whose
 * declared state says `active`; never inferred from the order of the states.
 * Where no declared state says it, an enum value reads neither (null).
 */
export const activeState = (value: Observation['value'] | undefined, states: Observable['states']): boolean | null => {
  if (typeof value === 'boolean') return value
  const entries = states ?? []
  if (typeof value !== 'string' || !entries.some(entry => entry.active === true)) return null
  return entries.find(entry => entry.value === value)?.active === true
}

const stateWord = (value: string | boolean, states: Observable['states']): string =>
  states?.find(state => state.value === String(value))?.label ?? (typeof value === 'boolean' ? (value ? 'yes' : 'no') : value)

/** A number as numberText writes it at its decimals; anything else it writes (a power of ten) is shown as written. */
const NUMERAL = /^-?\d+(?:\.\d+)?$/

/** How a value reads, from its declaration and its observation. */
export const readingLook = (label: string, valueType: Observable['valueType'], states: Observable['states'], input: ReadingInput): ReadingLook => {
  const value = input.value
  const quality = input.quality ?? 'good'
  const tone = toneOf(input.priority)
  const unknown = value === null || value === undefined || quality === 'bad'
  const passed = input.past === undefined ? undefined : input.thresholds.find(threshold => threshold.id === input.past)
  const acting = input.timeToAct === undefined ? undefined : input.thresholds.find(threshold => threshold.id === input.timeToAct!.threshold)
  const note = input.timeToAct !== undefined && acting !== undefined ? `${acting.effect} in ${durationText(input.timeToAct.seconds)}`
    : input.since !== undefined && valueType !== 'number' ? `since ${clockText(input.since.at)}` : null
  // A number or a duration reads as a number; a state, a text and an instant as a word.
  const state = (valueType !== 'number' && valueType !== 'duration') || typeof value === 'string' || typeof value === 'boolean'
  const decades = input.decades === true
  const text = quality === 'not-applicable' ? '—' : unknown ? '?' : typeof value === 'number' ? numberText(value, input.unit, input.quantity, decades)
    : valueType === 'instant' && typeof value === 'string' ? clockText(value) : stateWord(value, states)
  const number = !state && !unknown && quality !== 'not-applicable' && typeof value === 'number'
  return {
    kind: state ? 'state' : 'number',
    text,
    // A numeral reads back as the number the block formats; a power of ten is no numeral (Number() would be NaN).
    value: !number ? null : NUMERAL.test(text) ? Number(text) : text,
    // The decimals the card writes it to: a value below its step reads as a zero does.
    decimals: typeof value === 'number' ? numberShown(value, input.unit, input.quantity, decades).decimals : 0,
    // No number, no unit: a state, a reading not known, or one outside its declared validity ("—").
    unit: state || unknown || quality === 'not-applicable' ? '' : unitSymbol(input.unit),
    tone,
    emphasis: input.priority === 'notice',
    doubtful: quality === 'uncertain' || quality === 'stale',
    fill: unknown ? 'unknown' : activeState(value, states) === true ? 'filled' : 'hollow',
    chip: passed === undefined || quality === 'not-applicable' ? null : { word: orderWord(passed), text: `${orderWord(passed)} ${numberText(passed.value, input.unit, input.quantity, decades)}${passed.consequence === undefined ? '' : ` · ${passed.consequence}`}`, tone },
    note,
    bar: typeof value === 'number' && !unknown && quality !== 'not-applicable' ? limitBar(value, input.thresholds, input.past) : null,
    title: [label, quality === 'good' ? '' : `quality: ${quality}`, input.why ?? ''].filter(part => part !== '').join(' · '),
  }
}

/** How a declared value reads in a sample. */
export const valueLook = (value: Pick<Observable, 'valueType' | 'states' | 'unit' | 'thresholds' | 'quantity' | 'decades'> & { readonly label: string }, observations: ReadonlyArray<Observation>, ref: string): ReadingLook =>
  readingLook(value.label, value.valueType, value.states, observedInput(value, observations.find(observation => observation.ref === ref)))

/** An observation as a readout's input. */
export const observedInput = (observable: Pick<Observable, 'unit' | 'thresholds' | 'quantity' | 'decades'>, observation: Observation | undefined): ReadingInput => ({
  value: observation?.value,
  unit: observable.unit,
  quantity: observable.quantity,
  ...(observable.decades === true ? { decades: true as const } : {}),
  thresholds: observable.thresholds,
  ...(observation === undefined ? {} : {
    quality: observation.quality,
    priority: observation.priority,
    ...(observation.since === undefined ? {} : { since: observation.since }),
    ...(observation.timeToAct === undefined ? {} : { timeToAct: observation.timeToAct }),
    ...(observation.why === undefined ? {} : { why: observation.why }),
    ...(observation.past === undefined ? {} : { past: observation.past }),
  }),
})
