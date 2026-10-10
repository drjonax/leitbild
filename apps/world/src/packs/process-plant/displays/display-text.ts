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

/** Precision follows magnitude; trend readers compare, they do not audit digits. */
export const valueDigits = (value: number): number => {
  const magnitude = Math.abs(value)
  // An exact zero (a closed valve, a stopped flow) reads "0", not "0.000".
  if (magnitude === 0) return 0
  // Below a thousandth, two significant digits: an intermediate-range current of 5e-4 A reads 0.00050, never 0.000.
  if (magnitude < 1e-3) return Math.min(12, 1 - Math.floor(Math.log10(magnitude)))
  return magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3
}

export const formatValue = (value: number): string => value.toFixed(valueDigits(value))

/** A native value as the display shows it, with its unit: "100 %", "15.7 MPa". */
export const formatQuantity = (value: number, unit: string): string => {
  const label = unitLabel(unit)
  return `${formatValue(displayValue(value, unit))}${label === '' ? '' : ` ${label}`}`
}

const kindAbbreviation = { trip: 'TRIP', alarm: 'ALM', control: 'CTL' } as const

/** Direction and kind, doubled for a limit beyond the first of its kind: "LO ALM", "LO-LO ALM", "HI TRIP". */
export const limitKindName = (threshold: Pick<ComposedDisplayThreshold, 'direction' | 'kind' | 'escalation'>): string => {
  const direction = threshold.direction === 'low' ? 'LO' : 'HI'
  return `${threshold.escalation > 1 ? `${direction}-${direction}` : direction} ${kindAbbreviation[threshold.kind]}`
}

/** Direction, kind and the exact configured value: "LO ALM 30 %". */
export const thresholdName = (
  threshold: Pick<ComposedDisplayThreshold, 'direction' | 'kind' | 'escalation' | 'value'>,
  unit: string,
  options: { readonly withUnit: boolean } = { withUnit: true },
): string => {
  const label = options.withUnit ? unitLabel(unit) : ''
  return `${limitKindName(threshold)} ${displayValue(threshold.value, unit)}${label === '' ? '' : ` ${label}`}`
}

export interface ThresholdMargin {
  readonly threshold: ComposedDisplayThreshold
  /** Distance before the rule acts, in native units; negative once the value is beyond it. */
  readonly margin: number
}

/**
 * The alarm or trip threshold the value is closest to acting on or, once it
 * is past some, the outermost it has passed: 19.5 % is past LO TRIP 20 %, not
 * only past LO ALM 30 % (evaluation run 19: steam generators below their
 * low-low trip read as merely past the low alarm).
 */
export const nearestThresholdMargin = (
  value: number,
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const margins = thresholds
    .filter(threshold => threshold.kind !== 'control')
    .map(threshold => ({
      threshold,
      margin: threshold.operator === '<' || threshold.operator === '<=' ? value - threshold.value : threshold.value - value,
    }))
  if (margins.length === 0) return null
  const passed = margins.filter(margin => margin.margin < 0)
  if (passed.length > 0) return passed.reduce((outermost, candidate) => candidate.margin > outermost.margin ? candidate : outermost)
  return margins.reduce((nearest, candidate) => candidate.margin < nearest.margin ? candidate : nearest)
}

/**
 * A margin worded from whole to shortest, each form dropping one more whole
 * part so a narrow tile never cuts a word: first the mode qualifier, then the
 * limit's unit, then its value. How far away the limit is, with its unit, and
 * which limit it is always stay.
 */
export const marginTextForms = (margin: ThresholdMargin, unit: string): ReadonlyArray<string> => {
  const threshold = margin.threshold
  const lead = margin.margin < 0 ? 'past' : `${formatQuantity(margin.margin, unit)} ${threshold.direction === 'low' ? 'above' : 'below'}`
  return [...new Set([
    `${lead} ${thresholdName(threshold, unit)}${threshold.modeLabel === undefined ? '' : ` (${threshold.modeLabel})`}`,
    `${lead} ${thresholdName(threshold, unit)}`,
    `${lead} ${thresholdName(threshold, unit, { withUnit: false })}`,
    `${lead} ${limitKindName(threshold)}`,
  ])]
}

/**
 * "4.50 % above LO ALM 30 %", or "past LO ALM 30 %" once the value is beyond
 * it: the margin first, with its unit, so a narrow tile drops the limit's
 * name rather than how far away it is (marginTextForms).
 */
export const marginText = (margin: ThresholdMargin, unit: string): string => marginTextForms(margin, unit)[0]!

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
