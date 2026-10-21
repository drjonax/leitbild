// How one value reads (architecture B): a number with its limit bar and the
// chip of the limit it is past, or a state as a word with a fill. Colour comes
// only from the observation's own priority; a value without one (an entity's
// telemetry, a core slot) is neutral, whatever its source calls it.
import type { Priority } from '../../../core/model/alerts.ts'
import { numberText, unitSymbol, type Observable, type Observation } from '../../../core/observation/model.ts'
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

export interface LimitBar {
  /** Where the value sits along the bar, 0 to 1. */
  readonly at: number
  readonly ticks: ReadonlyArray<{ readonly id: string; readonly at: number; readonly priority: Threshold['priority'] }>
}

const BAR_PAD = 0.15

/** The bar spans the limits, padded, and reaches the value only where it lies beyond them; no limits, no bar. */
export const limitBar = (value: number, thresholds: ReadonlyArray<Threshold>): LimitBar | null => {
  if (thresholds.length === 0) return null
  const limits = thresholds.map(threshold => threshold.value)
  const low = Math.min(value, ...limits)
  const high = Math.max(value, ...limits)
  const span = high > low ? high - low : Math.max(Math.abs(low), 1)
  const min = low - span * BAR_PAD
  const width = span * (1 + 2 * BAR_PAD)
  const at = (point: number): number => (point - min) / width
  return { at: at(value), ticks: thresholds.map(threshold => ({ id: threshold.id, at: at(threshold.value), priority: threshold.priority })) }
}

export interface ReadingLook {
  readonly kind: 'number' | 'state'
  /** The number at its decimals, the state's word, "?" for a bad or absent reading, "—" where none applies. */
  readonly text: string
  readonly unit: string
  readonly tone: AlertTone | null
  /** Notice: bold, no hue. */
  readonly emphasis: boolean
  /** Uncertain or stale: drawn faint, its quality in the title. */
  readonly doubtful: boolean
  /** A state: filled while true, hollow while false or for an enum's word, dashed while unknown. */
  readonly fill: 'filled' | 'hollow' | 'unknown'
  /** The limit the value is past: its order word alone in a table cell, with value and consequence on a row. */
  readonly chip: { readonly word: string; readonly text: string; readonly tone: AlertTone | null } | null
  readonly note: string | null
  readonly bar: LimitBar | null
  readonly title: string
}

const stateWord = (value: string | boolean, states: Observable['states']): string =>
  states?.find(state => state.value === String(value))?.label ?? (typeof value === 'boolean' ? (value ? 'yes' : 'no') : value)

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
  const text = quality === 'not-applicable' ? '—' : unknown ? '?' : typeof value === 'number' ? numberText(value, input.unit)
    : valueType === 'instant' && typeof value === 'string' ? clockText(value) : stateWord(value, states)
  return {
    kind: state ? 'state' : 'number',
    text,
    unit: state || unknown ? '' : unitSymbol(input.unit),
    tone,
    emphasis: input.priority === 'notice',
    doubtful: quality === 'uncertain' || quality === 'stale',
    fill: unknown ? 'unknown' : value === true ? 'filled' : 'hollow',
    chip: passed === undefined ? null : { word: orderWord(passed), text: `${orderWord(passed)} ${numberText(passed.value, input.unit)}${passed.consequence === undefined ? '' : ` · ${passed.consequence}`}`, tone },
    note,
    bar: typeof value === 'number' && !unknown ? limitBar(value, input.thresholds) : null,
    title: [label, quality === 'good' ? '' : `quality: ${quality}`, input.why ?? ''].filter(part => part !== '').join(' · '),
  }
}

/** How a declared value reads in a sample. */
export const valueLook = (value: Pick<Observable, 'valueType' | 'states' | 'unit' | 'thresholds'> & { readonly label: string }, observations: ReadonlyArray<Observation>, ref: string): ReadingLook =>
  readingLook(value.label, value.valueType, value.states, observedInput(value, observations.find(observation => observation.ref === ref)))

/** An observation as a readout's input. */
export const observedInput = (observable: Pick<Observable, 'unit' | 'thresholds'>, observation: Observation | undefined): ReadingInput => ({
  value: observation?.value,
  unit: observable.unit,
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
