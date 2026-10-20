// How the Plant's quantities are written wherever a person or an agent reads
// them: units as operators read them, the step a reading is shown in, values
// off their instrument's span, a valve's position at the ends of its travel.
// Displays, operations, proposals and the map card write a value alike, so an
// answer can name it exactly as each shows it.

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

/** A valve reads SHUT below and OPEN above these fractions of its travel, between them its opening, as its drawing words it (mimic/evaluate.ts). */
export const POSITION_SHUT_BELOW = 0.05
export const POSITION_OPEN_ABOVE = 0.95

/** A valve's position (or demand) as a fraction of its travel, in the words its drawing uses at its ends; null between them, where its opening is the value. */
export const positionWord = (fraction: number): 'SHUT' | 'OPEN' | null =>
  fraction < POSITION_SHUT_BELOW ? 'SHUT' : fraction > POSITION_OPEN_ABOVE ? 'OPEN' : null

/**
 * A reading as a value cell writes it, with its unit: a valve's position (or
 * its demand) SHUT or OPEN at the ends of its travel, as its drawing, its
 * faceplate and every row and readout word it (HMI review of run 26: the
 * PORV block valve read "100 %" in a readout and OPEN on its drawing); else
 * as readingText writes it.
 */
export const valueText = (value: number, unit: string, resolution: number | null, span: NumericSpan | undefined, position: boolean): string =>
  (position ? positionWord(value) : null) ?? readingText(value, unit, resolution, span)
