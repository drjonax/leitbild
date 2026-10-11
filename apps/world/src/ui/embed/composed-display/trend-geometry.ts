// Pure geometry for composed-display trends. Time is Simulation Run time in
// epoch milliseconds; values are the signal's native unit.
import { formatValue, trendSpanMs } from '../../../packs/process-plant/displays/display-text.ts'
import { HOLD_GAP_MS, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'

export interface ValueDomain {
  readonly min: number
  readonly max: number
}

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
// ... and at least this many steps of the resolution its reading is shown in,
// so solver noise around zero (a leak rate of ±3e-12 kg/s) is never magnified
// into a curve.
const MIN_SPAN_STEPS = 20
// ... and at least this share of the span its instrument indicates over (or
// its hard range), so a steady reading sits mid-strip on a scale an operator
// reads it against: a flat 35 % valve position on a 10 % scale, not a 1 % one
// (HMI review of run 23).
const MIN_SPAN_OF_INSTRUMENT = 0.1

/**
 * Fixed display scale over the values, never zero-height, never narrower
 * than 4 % of the value, one unit, twenty resolution steps or a tenth of the
 * instrument's span (`span`); a narrower range is widened about its middle,
 * kept inside the span. The limits drawn on it (`limits`) widen it to reach
 * them; a scale that reaches past the values is padded.
 */
export const paddedDomain = (
  raw: ValueDomain,
  resolution: number | null = null,
  options: { readonly span?: ValueDomain | undefined; readonly limits?: ReadonlyArray<number> } = {},
): ValueDomain => {
  const width = raw.max - raw.min
  const magnitude = Math.max(Math.abs(raw.max), Math.abs(raw.min))
  const span = options.span !== undefined && options.span.max > options.span.min ? options.span : undefined
  const minimum = Math.max(
    magnitude >= 1 ? Math.max(magnitude * MIN_SPAN_FRACTION, 1) : magnitude * MIN_SPAN_FRACTION,
    (resolution ?? 0) * MIN_SPAN_STEPS,
    span === undefined ? 0 : (span.max - span.min) * MIN_SPAN_OF_INSTRUMENT,
  )
  const middle = (raw.max + raw.min) / 2
  // Widened about the values' middle, then shifted back inside the instrument's span where it would leave it (a level at 0 %).
  const widened = width >= minimum ? raw : { min: middle - minimum / 2, max: middle + minimum / 2 }
  const shift = span === undefined || span.max - span.min < minimum ? 0
    : widened.min < span.min ? span.min - widened.min : widened.max > span.max ? span.max - widened.max : 0
  const core = width >= minimum ? raw : { min: widened.min + shift, max: widened.max + shift }
  const limits = options.limits ?? []
  const reach = { min: Math.min(core.min, ...limits), max: Math.max(core.max, ...limits) }
  const reachWidth = reach.max - reach.min
  const padded = width < minimum && reach.min === core.min && reach.max === core.max
    ? core
    : { min: reach.min - reachWidth * PAD_FRACTION, max: reach.max + reachWidth * PAD_FRACTION }
  // Values so near zero that their share underflows (a decayed power of
  // 1e-320 MW) would give a scale of no height and every point NaN: such a
  // scale spans one unit around them instead.
  return padded.max - padded.min > 0 && Number.isFinite(padded.max - padded.min) ? padded : { min: middle - 1, max: middle + 1 }
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


/**
 * Pens whose traces lie on one another over the window, at most a pixel and
 * a half apart wherever either changes: drawn as one line, they would read
 * as one signal (HMI review of run 23: four steam generator levels at 55 %
 * drawn as one). Groups of two or more, in the pens' order.
 */
export const coincidentPens = <K>(
  pens: ReadonlyArray<{ readonly key: K; readonly points: ReadonlyArray<TrendPoint> }>,
  y: (v: number) => number,
  window: { readonly start: number; readonly end: number },
): ReadonlyArray<ReadonlyArray<K>> => {
  const at = (points: ReadonlyArray<TrendPoint>, t: number): number | null => {
    let value: number | null = null
    for (const point of points) {
      if (point.t > t) break
      value = point.t >= t - HOLD_GAP_MS ? point.v : null
    }
    return value
  }
  const times = (points: ReadonlyArray<TrendPoint>) => points.filter(point => point.t >= window.start && point.t <= window.end).map(point => point.t)
  const together = (left: ReadonlyArray<TrendPoint>, right: ReadonlyArray<TrendPoint>): boolean => {
    const checked = [...new Set([...times(left), ...times(right), window.end])]
    return times(left).length > 0 && times(right).length > 0 && checked.every(t => {
      const [a, b] = [at(left, t), at(right, t)]
      return (a === null) === (b === null) && (a === null || Math.abs(y(a) - y(b!)) <= COINCIDENT_PX)
    })
  }
  const groups: Array<Array<{ readonly key: K; readonly points: ReadonlyArray<TrendPoint> }>> = []
  for (const pen of pens) {
    const group = groups.find(members => together(members[0]!.points, pen.points))
    if (group === undefined) groups.push([pen])
    else group.push(pen)
  }
  return groups.filter(group => group.length > 1).map(group => group.map(pen => pen.key))
}

const COINCIDENT_PX = 1.5

/**
 * How a note names coinciding traces by what tells them apart: a run of
 * consecutive letters or numbers as a range ("A–D"), else each ("A, C").
 */
export const runText = (parts: ReadonlyArray<string>): string => {
  const codes = parts.map(part => (/^[A-Z]$/.test(part) ? part.charCodeAt(0) : /^\d+$/.test(part) ? Number(part) : Number.NaN))
  const consecutive = parts.length > 2 && codes.every((code, index) => Number.isFinite(code) && (index === 0 || code === codes[index - 1]! + 1))
  return consecutive ? `${parts[0]}–${parts.at(-1)}` : parts.join(', ')
}
