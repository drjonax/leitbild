import type { ComposedDisplayThreshold } from './ic-thresholds.ts'

// Operator wording shared by the compose result (what the agent is told the
// display shows) and the embedded view (what the operator reads), so an answer
// can name values and thresholds exactly as the display does.

const unitLabels: Readonly<Record<string, string>> = {
  percent: '%',
  degC: '°C',
  'degC/s': '°C/s',
  // Fractions (speeds, positions, bus voltages) read as percent: 1.00 → 100 %.
  fraction: '%',
  // Pressures in pascals (condenser vacuum, developed head) read in kilopascals: 12388 Pa → 12.4 kPa.
  Pa: 'kPa',
  amps: 'A',
  volts_dc: 'V DC',
  // A count reads as a bare number: a load sequencer at step 3.
  count: '',
  m3: 'm³',
  boolean: '',
}

export const unitLabel = (unit: string): string => unitLabels[unit] ?? unit

/** A native value in the unit the display shows it in. */
export const displayValue = (value: number, unit: string): number =>
  unit === 'fraction' ? Number((value * 100).toPrecision(12)) : unit === 'Pa' ? Number((value / 1000).toPrecision(12)) : value

/**
 * The finest step a signal's reading is shown in, in its native unit: a
 * thousandth of what the model declares it reads over: its instrument span,
 * else its hard range, else the reach from zero of its I&C limits and of
 * what it reads at the Plant's declared operating point (`nominal`). Where
 * no span is declared, never finer than a tenth of the step its limits are
 * set in, so a deviation with limits at ±1.7 °C reads no "0.004 °C" (QA
 * review of run 22). Null where it declares none of them, or a span read
 * over decades (a positive lower end three or more decades below its top,
 * as an intermediate-range current's): such a reading is shown as it is.
 */
export const readingResolution = (
  limits: { readonly instrumentSpan?: NumericSpan | undefined; readonly hardRange?: NumericSpan | undefined } | undefined,
  thresholds: ReadonlyArray<{ readonly value: number }>,
  nominal?: number,
): number | null => {
  const declared = limits?.instrumentSpan ?? limits?.hardRange
  if (declared !== undefined) return logarithmicSpan(declared) || declared.max <= declared.min ? null : (declared.max - declared.min) * RESOLUTION_FRACTION
  const values = thresholds.map(threshold => threshold.value)
  const reach = [...values, ...(nominal === undefined ? [] : [nominal])]
  const width = reach.length === 0 ? 0 : Math.max(0, ...reach) - Math.min(0, ...reach)
  if (width <= 0) return null
  return Math.max(width * RESOLUTION_FRACTION, values.length === 0 ? 0 : limitStep(values) / 10)
}

/** The finest step limits are set in: 0.1 for 1.7 and 20.5, 1 for 75, 0.01 for 0.11. */
const limitStep = (values: ReadonlyArray<number>): number =>
  Math.min(...values.map(value => {
    const decimals = (Number(value.toPrecision(12)).toString().split('.')[1] ?? '').length
    return 10 ** -decimals
  }))

const LOGARITHMIC_DECADES_RATIO = 1_000

/** Whether a span is read over decades: a positive lower end three or more decades below its top, as an intermediate-range current's. */
export const logarithmicSpan = (span: NumericSpan | undefined): boolean =>
  span !== undefined && span.min > 0 && span.max / span.min >= LOGARITHMIC_DECADES_RATIO

const SUPERSCRIPTS: Readonly<Record<string, string>> = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }

/** A value read over decades, to two significant digits and its power of ten: "2.2×10⁻⁶" (QA review: "0.0000022 A"). */
export const scientificText = (value: number): string => {
  if (value === 0) return '0'
  const [mantissa, exponent] = value.toExponential(1).split('e') as [string, string]
  return `${mantissa.replace('-', '−')}×10${[...String(Number(exponent))].map(character => SUPERSCRIPTS[character] ?? character).join('')}`
}

/** A span's end as declared, never padded to a resolution, with a true minus: "−0.5". */
const boundText = (bound: number, unit: string, span: NumericSpan): string => {
  const shown = displayValue(bound, unit)
  return logarithmicSpan(span) ? scientificText(shown) : String(shown).replace('-', '−')
}

interface NumericSpan {
  readonly min: number
  readonly max: number
}

/** A reading's resolution is this share of the scale it reads over (readingResolution). */
export const RESOLUTION_FRACTION = 0.001

/**
 * A reading as a display shows it: a magnitude below the signal's resolution
 * is no reading at all, so it shows as 0 rather than as the tail of a decay
 * or solver noise ("0.0000098 MW" for a tripped generator, "−3e-12 kg/s" for
 * no leak).
 */
export const shownReading = (value: number, resolution: number | null): number =>
  resolution !== null && Math.abs(value) < resolution ? 0 : value

/** Precision follows magnitude, never finer than the resolution (in display units) a reading is shown in. */
export const valueDigits = (value: number, resolution: number | null = null): number => {
  const magnitude = Math.abs(value)
  // An exact zero (a closed valve, a stopped flow) reads "0", not "0.000".
  if (magnitude === 0) return 0
  // Below a thousandth, two significant digits: an intermediate-range current of 5e-4 A reads 0.00050, never 0.000.
  const byMagnitude = magnitude < 1e-3 ? Math.min(12, 1 - Math.floor(Math.log10(magnitude)))
    : magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3
  return resolution === null ? byMagnitude : Math.min(byMagnitude, Math.max(0, -Math.floor(Math.log10(resolution))))
}

export const formatValue = (value: number, resolution: number | null = null): string => {
  const digits = valueDigits(value, resolution)
  const text = value.toFixed(digits)
  // A value rounded away at the resolution reads as zero, unsigned.
  return Number(text) === 0 ? (0).toFixed(digits) : text
}

/** A native value as the display shows it, with its unit: "100 %", "15.7 MPa"; at a resolution in native units where one is given. */
export const formatQuantity = (value: number, unit: string, resolution: number | null = null): string => {
  const label = unitLabel(unit)
  return `${formatValue(displayValue(value, unit), resolution === null ? null : displayValue(resolution, unit))}${label === '' ? '' : ` ${label}`}`
}

/** The decimals a number written as declared carries, as a limit's label or a span's end writes it: 14.8 → 1, 20 → 0. */
export const writtenDecimals = (value: number): number => (String(Number(value.toPrecision(12))).split('.')[1] ?? '').length

/** Where a reading sits at an end of the span its instrument declares: its indication says only that the quantity is there or beyond. */
export const offScale = (value: number, span: NumericSpan | undefined): 'below' | 'above' | null =>
  span === undefined ? null : value <= span.min ? 'below' : value >= span.max ? 'above' : null

/**
 * A reading's number as its value cell shows it, in display units without
 * the unit: "<0" at the bottom of its span and ">100" at the top, the span's
 * end as declared ("< −0.5", a space keeping the two signs apart); a reading
 * over decades in powers of ten ("2.2×10⁻⁶").
 */
export const readingValueText = (value: number, unit: string, resolution: number | null, span: NumericSpan | undefined): string => {
  const end = offScale(value, span)
  if (end !== null) {
    const bound = boundText(end === 'below' ? span!.min : span!.max, unit, span!)
    return `${end === 'below' ? '<' : '>'}${bound.startsWith('−') ? ' ' : ''}${bound}`
  }
  if (logarithmicSpan(span)) return scientificText(displayValue(value, unit))
  return formatValue(displayValue(value, unit), resolution === null ? null : displayValue(resolution, unit))
}

/** How many decimals a reading's value cell writes it with (readingValueText); null where it writes powers of ten. */
export const readingDecimals = (value: number, unit: string, resolution: number | null, span: NumericSpan | undefined): number | null => {
  const end = offScale(value, span)
  if (end !== null) return writtenDecimals(displayValue(end === 'below' ? span!.min : span!.max, unit))
  if (logarithmicSpan(span)) return null
  return valueDigits(displayValue(value, unit), resolution === null ? null : displayValue(resolution, unit))
}

/** A reading as its value cell shows it: "<0 %" at the bottom of its span, ">100 %" at the top, else the value. */
export const readingText = (value: number, unit: string, resolution: number | null, span: NumericSpan | undefined): string => {
  const label = unitLabel(unit)
  return `${readingValueText(value, unit, resolution, span)}${label === '' ? '' : ` ${label}`}`
}

/** "below range" or "above range" for a reading at an end of its span; empty otherwise. */
export const offScaleText = (value: number, span: NumericSpan | undefined): string => {
  const end = offScale(value, span)
  return end === null ? '' : `${end} range`
}

/** LO or HI for the first limit on its side, LO-LO or HI-HI beyond it. */
export const limitOrderName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order'>): string => {
  const direction = threshold.direction === 'low' ? 'LO' : 'HI'
  return threshold.order > 1 ? `${direction}-${direction}` : direction
}

/**
 * A limit as a chip, a drawing's badge and an alarm row name it: its order
 * and what the I&C does there ("LO-LO · RX TRIP", "LO · ALM"). An actuation
 * that is not the reactor trip is never called TRIP.
 */
export const limitKindName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'action'>): string =>
  `${limitOrderName(threshold)} · ${threshold.action}`

/** Order, exact configured value and action, as a limit's line is labelled: "LO-LO 20 % · RX TRIP". */
export const thresholdName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'order' | 'value' | 'action'>,
  unit: string,
  options: { readonly withUnit: boolean } = { withUnit: true },
): string => {
  const label = options.withUnit ? unitLabel(unit) : ''
  return `${limitOrderName(threshold)} ${displayValue(threshold.value, unit)}${label === '' ? '' : ` ${label}`} · ${threshold.action}`
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
 * What the limits a margin names do, most severe first, with the modes each
 * alone acts in where `modes`: "RX TRIP (Modes 1–2) + AFW START".
 */
const actionsText = (margin: ThresholdMargin, modes: boolean): string =>
  [margin.threshold, ...(margin.alongside ?? [])]
    .map(threshold => `${threshold.action}${modes && threshold.modeLabel !== undefined ? ` (${threshold.modeLabel})` : ''}`)
    .join(' + ')

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
