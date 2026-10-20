import type { ComposedDisplayThreshold } from '../ic/thresholds.ts'
import { displayValue, formatQuantity, unitLabel } from '../quantity-text.ts'

// Operator wording shared by the compose result (what the agent is told the
// display shows) and the embedded view (what the operator reads), so an answer
// can name values and thresholds exactly as the display does. Quantities are
// written as quantity-text.ts writes them.

/**
 * A limit's step from normal on its side, as every display names it: LO
 * or HI for the first, LO-LO or HI-HI beyond it, then LO-3, LO-4 (HI-3,
 * HI-4). Past the second step the count is written, not a third repeat:
 * "LO-LO-LO" differs from "LO-LO" only by its length and is miscounted at a
 * glance, while "LO-3" reads apart from both (NUREG-0700: labels that
 * differ in shape, not only in length) and keeps a badge short.
 */
export const limitOrderName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order'>): string => {
  const direction = threshold.direction === 'low' ? 'LO' : 'HI'
  return threshold.order <= 1 ? direction : threshold.order === 2 ? `${direction}-${direction}` : `${direction}-${threshold.order}`
}

/**
 * A limit as a chip, a drawing's badge and an alarm row name it: its order
 * and what the I&C does there ("LO-LO · RX TRIP", "LO · ALM"). An actuation
 * that is not the reactor trip is never called TRIP.
 */
export const limitKindName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'action'>): string =>
  `${limitOrderName(threshold)} · ${threshold.action}`

/**
 * A limit acting now as its chip names it: as its alarm row is tagged, by
 * what its rule watches where it watches more than this value ("L LO & F LO ·
 * ALM"), else by order and action ("LO-LO · RX TRIP"). Compact, the action
 * is left to the margin line under it.
 */
export const chipName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'action' | 'watches'>, compact = false): string => {
  const head = threshold.watches ?? limitOrderName(threshold)
  return compact ? head : `${head} · ${threshold.action}`
}

/**
 * What the I&C does at a limit as its name says it: its action, and how long
 * the value must stay past it where the rule waits that long ("TURB TRIP
 * after 30 min": HMI review, plan C1). A chip, a badge and an alarm row name
 * the action alone (limitKindName); the limit's name says when.
 */
export const limitAction = (threshold: Pick<ComposedDisplayThreshold, 'action' | 'delayMs'>): string =>
  threshold.delayMs === undefined ? threshold.action : `${threshold.action} after ${durationWords(threshold.delayMs)}`

/** A rule's wait in whole words: "30 min", "1.5 min", "2 h". */
const durationWords = (ms: number): string => {
  const minutes = ms / 60_000
  return minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} h` : `${Number(minutes.toFixed(1))} min`
}

/** Order, exact configured value and action, as a limit's line is labelled: "LO-LO 20 % · RX TRIP", "LO 49 Hz · TURB TRIP after 30 min". */
export const thresholdName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'value' | 'action' | 'delayMs'>,
  unit: string,
  options: { readonly withUnit: boolean } = { withUnit: true },
): string => {
  const label = options.withUnit ? unitLabel(unit) : ''
  return `${limitOrderName(threshold)} ${displayValue(threshold.value, unit)}${label === '' ? '' : ` ${label}`} · ${limitAction(threshold)}`
}

/** The whole name, with the modes it alone acts in: "LO-LO 20 % · RX TRIP (Modes 1–2)". */
export const thresholdFullName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'value' | 'action' | 'modeLabel'>,
  unit: string,
): string => `${thresholdName(threshold, unit)}${threshold.modeLabel === undefined ? '' : ` (${threshold.modeLabel})`}`

export interface ThresholdMargin {
  /** The most severe limit at that value (bySeverity); the margin is to it. */
  readonly threshold: ComposedDisplayThreshold
  /** Distance before the rule acts, in native units; negative once the value is beyond it. */
  readonly margin: number
  /**
   * The other limits in force at the same value and side, most severe first:
   * the reactor trip and the AFW start at 20 % act together, and a margin
   * names both ("LO-LO 20 % · RX TRIP + AFW START").
   */
  readonly alongside?: ReadonlyArray<ComposedDisplayThreshold>
}

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/**
 * Most severe first, as a chip, a margin and a line's label order limits
 * that act together: the reactor trip, then other automatic actions, then
 * alarms by their severity.
 */
export const bySeverity = (
  left: Pick<ComposedDisplayThreshold, 'kind' | 'severity' | 'reactorTrip'>,
  right: Pick<ComposedDisplayThreshold, 'kind' | 'severity' | 'reactorTrip'>,
): number =>
  Number(right.reactorTrip === true) - Number(left.reactorTrip === true)
  || Number(right.kind === 'trip') - Number(left.kind === 'trip')
  || severityRank[left.severity ?? 'warning'] - severityRank[right.severity ?? 'warning']

/** How far a value is from acting on a threshold: negative once beyond it. */
export const marginTo = (value: number, threshold: ComposedDisplayThreshold): ThresholdMargin => ({
  threshold,
  margin: threshold.operator === '<' || threshold.operator === '<=' ? value - threshold.value : threshold.value - value,
})

/**
 * A margin to a limit with every other limit among `thresholds` that acts at
 * its value on its side, named by the most severe of them: the QA review's
 * "8.7 % above LO-LO 20 % · AFW START" hid the reactor trip at the same 20 %.
 */
export const coincidentMargin = (margin: ThresholdMargin, thresholds: ReadonlyArray<ComposedDisplayThreshold>): ThresholdMargin => {
  const at = margin.threshold
  const together = thresholds
    .filter(threshold => threshold.kind !== 'control' && threshold.value === at.value && threshold.direction === at.direction)
  const ordered = [...new Set([at, ...together])].sort(bySeverity)
  const [first, ...alongside] = ordered
  return { threshold: first!, margin: margin.margin, ...(alongside.length === 0 ? {} : { alongside }) }
}

/**
 * Whether the value is past the threshold, so its rule acts: beyond it, or on
 * it where the rule acts at equality ("≤ 0 °C" at 0 °C).
 */
export const isPast = (margin: ThresholdMargin): boolean =>
  margin.margin < 0 || (margin.margin === 0 && (margin.threshold.operator === '<=' || margin.threshold.operator === '>='))

/**
 * The alarm or trip threshold the value is closest to acting on or, once it
 * is past some, the outermost it has passed: 19.5 % is past LO-LO 20 %, not
 * only past LO 30 % (evaluation run 19: steam generators below their
 * low-low trip read as merely past the low alarm). For a value seen once,
 * with no direction to read.
 */
export const nearestThresholdMargin = (
  value: number,
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const margins = thresholds
    .filter(threshold => threshold.kind !== 'control')
    .map(threshold => marginTo(value, threshold))
  if (margins.length === 0) return null
  const passed = margins.filter(isPast)
  if (passed.length > 0) return passed.reduce((outermost, candidate) => candidate.margin > outermost.margin ? candidate : outermost)
  return margins.reduce((nearest, candidate) => candidate.margin < nearest.margin ? candidate : nearest)
}

/**
 * What the limits a margin names do, most severe first, each action once
 * (two alarms at one leak rate read "ALM", not "ALM + ALM": HMI review of
 * run 25), with the modes it alone acts in where `modes`: "RX TRIP (Modes
 * 1–2) + AFW START". An action one of them does in every mode names none.
 */
const actionsText = (margin: ThresholdMargin, modes: boolean): string => {
  const limits = [margin.threshold, ...(margin.alongside ?? [])]
  return [...new Set(limits.map(limitAction))].map(action => {
    const modeLabels = limits.filter(threshold => limitAction(threshold) === action).map(threshold => threshold.modeLabel)
    const qualified = modes && modeLabels.every(label => label !== undefined)
    return `${action}${qualified ? ` (${[...new Set(modeLabels)].join(', ')})` : ''}`
  }).join(' + ')
}

/**
 * The limit a margin names, as its line is labelled, with every action at
 * it: "LO-LO 20 % · RX TRIP + AFW START"; its order and value lead, as an
 * answer cites it.
 */
export const marginLimitName = (margin: ThresholdMargin, unit: string): string => {
  const label = unitLabel(unit)
  return `${limitOrderName(margin.threshold)} ${displayValue(margin.threshold.value, unit)}${label === '' ? '' : ` ${label}`} · ${actionsText(margin, false)}`
}

/**
 * A margin worded from whole to shortest, each form dropping one more whole
 * part so a narrow tile never cuts a word: first the mode qualifiers, then
 * the limit's unit, then its value. How far away the limit is, with its
 * unit, which limit it is (its order) and every action at it always stay.
 */
export const marginTextForms = (margin: ThresholdMargin, unit: string, resolution: number | null = null): ReadonlyArray<string> => {
  const threshold = margin.threshold
  // A difference of percentages is in percentage points, spelled out where
  // there is room and "pp" in a tile's shortest forms.
  const percent = unitLabel(unit) === '%'
  const distance = (spelled: boolean): string => percent
    ? `${formatQuantity(margin.margin, unit, resolution).replace(/ %$/, '')} ${spelled ? 'percentage points' : 'pp'}`
    : formatQuantity(margin.margin, unit, resolution)
  const leadOf = (spelled: boolean): string => isPast(margin) ? 'past' : `${distance(spelled)} ${threshold.direction === 'low' ? 'above' : 'below'}`
  const lead = leadOf(true)
  const short = leadOf(false)
  const label = unitLabel(unit)
  const value = `${displayValue(threshold.value, unit)}`
  const order = limitOrderName(threshold)
  return [...new Set([
    `${lead} ${order} ${value}${label === '' ? '' : ` ${label}`} · ${actionsText(margin, true)}`,
    `${lead} ${order} ${value}${label === '' ? '' : ` ${label}`} · ${actionsText(margin, false)}`,
    `${short} ${order} ${value} · ${actionsText(margin, false)}`,
    `${short} ${order} · ${actionsText(margin, false)}`,
  ])]
}

/**
 * "4.50 percentage points above LO 30 % · ALM", or "past LO-LO 20 % ·
 * AFW START" once the value is beyond it: the margin first, with its unit, so
 * a narrow tile drops the limit's value rather than how far away it is
 * (marginTextForms).
 */
export const marginText = (margin: ThresholdMargin, unit: string, resolution: number | null = null): string => marginTextForms(margin, unit, resolution)[0]!

/** Simulation time of day, labelled independently of the browser timezone. */
export const simulationClock = (ms: number): string => Number.isFinite(new Date(ms).getTime())
  ? `${new Date(ms).toISOString().slice(11, 19)} UTC`
  : '--:--:-- UTC'

// A trend never spans less than this, so a Run's first minute still reads as a curve.
const MIN_TREND_SPAN_MS = 60_000
const TREND_SPAN_STEP_MS = 30_000

/**
 * The time a trend's axis spans: its horizon, or the Run's history rounded up
 * to 30 s while that is shorter, so a young Run is not drawn as a mostly
 * hatched plot. The compose result states it as the embedded view draws it.
 */
export const trendSpanMs = (horizonMs: number, historyMs: number): number => {
  const history = Math.ceil(Math.max(0, historyMs) / TREND_SPAN_STEP_MS) * TREND_SPAN_STEP_MS
  return Math.min(horizonMs, Math.max(MIN_TREND_SPAN_MS, history))
}
