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
  m3: 'm³',
  boolean: '',
}

export const unitLabel = (unit: string): string => unitLabels[unit] ?? unit

/** A native value in the unit the display shows it in. */
export const displayValue = (value: number, unit: string): number =>
  unit === 'fraction' ? Number((value * 100).toPrecision(12)) : unit === 'Pa' ? Number((value / 1000).toPrecision(12)) : value

/**
 * The finest step a signal's reading is shown in, in its native unit: a
 * thousandth of what the model declares it reads over (its instrument span,
 * else its hard range, else the reach of its I&C limits from zero). Null
 * where it declares none of them, or a span read over decades (a positive
 * lower end three or more decades below its top, as an intermediate-range
 * current's): such a reading is shown as it is, to its magnitude.
 */
export const readingResolution = (
  limits: { readonly instrumentSpan?: NumericSpan | undefined; readonly hardRange?: NumericSpan | undefined } | undefined,
  thresholds: ReadonlyArray<{ readonly value: number }>,
): number | null => {
  const values = thresholds.map(threshold => threshold.value)
  const span = limits?.instrumentSpan ?? limits?.hardRange ?? (values.length === 0 ? undefined : { min: Math.min(0, ...values), max: Math.max(0, ...values) })
  if (span === undefined || (span.min > 0 && span.max / span.min >= LOGARITHMIC_DECADES_RATIO)) return null
  const width = span.max - span.min
  return width > 0 ? width * RESOLUTION_FRACTION : null
}

const LOGARITHMIC_DECADES_RATIO = 1_000

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

/** Where a reading sits at an end of the span its instrument declares: its indication says only that the quantity is there or beyond. */
export const offScale = (value: number, span: NumericSpan | undefined): 'below' | 'above' | null =>
  span === undefined ? null : value <= span.min ? 'below' : value >= span.max ? 'above' : null

/** A reading's number as its value cell shows it, in display units without the unit: "<0" at the bottom of its span, ">100" at the top. */
export const readingValueText = (value: number, unit: string, resolution: number | null, span: NumericSpan | undefined): string => {
  const end = offScale(value, span)
  return `${end === 'below' ? '<' : end === 'above' ? '>' : ''}${formatValue(displayValue(value, unit), resolution === null ? null : displayValue(resolution, unit))}`
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
  readonly threshold: ComposedDisplayThreshold
  /** Distance before the rule acts, in native units; negative once the value is beyond it. */
  readonly margin: number
}

/** How far a value is from acting on a threshold: negative once beyond it. */
export const marginTo = (value: number, threshold: ComposedDisplayThreshold): ThresholdMargin => ({
  threshold,
  margin: threshold.operator === '<' || threshold.operator === '<=' ? value - threshold.value : threshold.value - value,
})

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
 * A margin worded from whole to shortest, each form dropping one more whole
 * part so a narrow tile never cuts a word: first the mode qualifier, then the
 * limit's unit, then its value. How far away the limit is, with its unit, and
 * which limit it is (its order and action) always stay.
 */
export const marginTextForms = (margin: ThresholdMargin, unit: string, resolution: number | null = null): ReadonlyArray<string> => {
  const threshold = margin.threshold
  const lead = isPast(margin) ? 'past' : `${formatQuantity(margin.margin, unit, resolution)} ${threshold.direction === 'low' ? 'above' : 'below'}`
  return [...new Set([
    `${lead} ${thresholdFullName(threshold, unit)}`,
    `${lead} ${thresholdName(threshold, unit)}`,
    `${lead} ${thresholdName(threshold, unit, { withUnit: false })}`,
    `${lead} ${limitKindName(threshold)}`,
  ])]
}

/**
 * "4.50 % above LO 30 % · ALM", or "past LO-LO 20 % · AFW START" once the
 * value is beyond it: the margin first, with its unit, so a narrow tile drops
 * the limit's value rather than how far away it is (marginTextForms).
 */
export const marginText = (margin: ThresholdMargin, unit: string, resolution: number | null = null): string => marginTextForms(margin, unit, resolution)[0]!

/** Simulation time of day as the display header shows it: "10:01:00". */
export const simulationClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19)

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
