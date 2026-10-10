// Pure geometry for composed-display trends. Time is Simulation Run time in
// epoch milliseconds; values are the signal's native unit.
import { formatValue, trendSpanMs } from '../../../packs/process-plant/displays/display-text.ts'

export interface TrendPoint {
  readonly t: number
  readonly v: number
}

export interface ValueDomain {
  readonly min: number
  readonly max: number
}

// The operations Historian re-records an unchanged value at most once per
// minute, so a held value is drawn across gaps up to this length and broken
// beyond it.
export const HOLD_GAP_MS = 90_000

const PAD_FRACTION = 0.08

/** Smallest domain containing every value, or null when there are none. */
export const rawDomain = (values: ReadonlyArray<number>): ValueDomain | null => {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return null
  return { min: Math.min(...finite), max: Math.max(...finite) }
}

// A scale spans at least this share of the value, and at least one unit for
// values of one or more, so a nearly steady signal does not fill its strip
// with noise-sized swings, even near zero (a 5 °C subcooling margin).
const MIN_SPAN_FRACTION = 0.04

/** Fixed display scale: padded, never zero-height, never narrower than 4 % of the value or one unit. */
export const paddedDomain = (raw: ValueDomain): ValueDomain => {
  const span = raw.max - raw.min
  const magnitude = Math.max(Math.abs(raw.max), Math.abs(raw.min))
  const minimum = magnitude >= 1 ? Math.max(magnitude * MIN_SPAN_FRACTION, 1) : magnitude * MIN_SPAN_FRACTION
  if (span === 0 && minimum === 0) return { min: raw.min - 1, max: raw.max + 1 }
  if (span < minimum) {
    const middle = (raw.max + raw.min) / 2
    return { min: middle - minimum / 2, max: middle + minimum / 2 }
  }
  return { min: raw.min - span * PAD_FRACTION, max: raw.max + span * PAD_FRACTION }
}

const niceStep = (span: number, count: number): number => {
  const rough = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10
  return nice * magnitude
}

// Few gridlines: a mini trend is read for direction and margin, not exact
// values; but never a single one, which gives no scale.
export const valueTicks = (domain: ValueDomain, count = 3): ReadonlyArray<number> => {
  const ticksFor = (wanted: number): number[] => {
    const step = niceStep(domain.max - domain.min, wanted)
    const first = Math.ceil(domain.min / step) * step
    const ticks: number[] = []
    for (let tick = first; tick <= domain.max + step * 1e-9; tick += step) ticks.push(Number(tick.toPrecision(12)))
    return ticks
  }
  const ticks = ticksFor(count)
  return ticks.length >= 2 ? ticks : ticksFor(count + 2)
}

/** Tick labels share the precision of the step, so an axis never reads "5.00" beside "10.0". */
export const tickLabels = (ticks: ReadonlyArray<number>): ReadonlyArray<string> => {
  if (ticks.length < 2) return ticks.map(formatValue)
  const step = Math.abs(ticks[1]! - ticks[0]!)
  const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))
  return ticks.map(tick => tick.toFixed(digits))
}

/**
 * Whether a limit is close enough to the values to share their scale: within
 * three times their spread, or a quarter of their magnitude. A farther limit
 * (generator low alarm 450 MW under 1,100 MW) would flatten the curve, so it
 * is named at the plot edge instead.
 */
export const limitInScale = (limit: number, range: ValueDomain | null): boolean => {
  if (range === null) return true
  const reach = Math.max(3 * (range.max - range.min), 0.25 * Math.max(Math.abs(range.max), Math.abs(range.min)))
  return limit >= range.min - reach && limit <= range.max + reach
}

export interface TimeTick {
  readonly t: number
  readonly label: string
}

const relativeLabel = (backMs: number): string => {
  if (backMs === 0) return 'now'
  return backMs % 60_000 === 0 ? `−${backMs / 60_000} min` : `−${Math.round(backMs / 1000)} s`
}

const tickStepMs = (windowMs: number): number =>
  windowMs <= 150_000 ? 30_000 : windowMs <= 300_000 ? 60_000 : windowMs <= 600_000 ? 120_000 : windowMs <= 1_200_000 ? 300_000 : 600_000

/**
 * Ticks counted back from "now" in round steps, so the trend reads the same at
 * any Simulation Run date and while a short window grows toward its horizon.
 */
export const timeTicks = (now: number, windowMs: number): ReadonlyArray<TimeTick> => {
  const stepMs = tickStepMs(windowMs)
  const ticks: TimeTick[] = []
  for (let back = 0; back <= windowMs; back += stepMs) ticks.unshift({ t: now - back, label: relativeLabel(back) })
  return ticks
}

/** The time a trend spans now (trendSpanMs); its full horizon until the Run's start is known. */
export const trendWindowMs = (horizonMs: number, now: number, runStartedAt: number | null): number =>
  runStartedAt === null ? horizonMs : trendSpanMs(horizonMs, now - runStartedAt)

/** Keeps points ordered and drops those that can no longer influence the window. */
export const appendPoint = (
  points: ReadonlyArray<TrendPoint>,
  point: TrendPoint,
  windowStart: number,
): ReadonlyArray<TrendPoint> => {
  const kept = points.filter(existing => existing.t >= windowStart - HOLD_GAP_MS && existing.t < point.t)
  return [...kept, point]
}

/**
 * Step-hold SVG path: a sampled value holds until the next sample. Holds end
 * at `holdUntil` (the latest Run time) and are broken across gaps longer than
 * HOLD_GAP_MS so missing data is visible rather than interpolated.
 */
export const stepPath = (
  points: ReadonlyArray<TrendPoint>,
  x: (t: number) => number,
  y: (v: number) => number,
  window: { readonly start: number; readonly end: number },
): string => {
  const commands: string[] = []
  let open = false
  points.forEach((point, index) => {
    const next = points[index + 1]
    const holdEnd = Math.min(next?.t ?? window.end, point.t + HOLD_GAP_MS, window.end)
    if (holdEnd < window.start) { open = false; return }
    const start = Math.max(point.t, window.start)
    const yv = y(point.v).toFixed(1)
    commands.push(`${open ? 'L' : 'M'}${x(start).toFixed(1)} ${yv}`)
    commands.push(`L${x(holdEnd).toFixed(1)} ${yv}`)
    open = next !== undefined && next.t <= point.t + HOLD_GAP_MS
  })
  return commands.join(' ')
}

