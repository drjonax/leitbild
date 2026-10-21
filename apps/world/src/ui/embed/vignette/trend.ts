// Trend strip geometry (architecture B): recorded points drawn step-and-hold,
// a value holding until the next one and broken where the record has a gap,
// so missing data shows. A strip names a limit only where every pen on it
// declares that threshold at one value; pens are told apart by dash, never
// by hue (colour is kept for alerts).
import { decimalsFor, numberText, type Observable, type Observation } from '../../../core/observation/model.ts'
import type { SeriesPoint, VignetteValue } from '../../../features/displays/compose/model.ts'
import { orderWord, toneOf, type AlertTone } from './readout.ts'

type Threshold = Observable['thresholds'][number]

/** A recorded value holds for this many of its recording intervals; a longer silence is a gap. */
export const HOLD_INTERVALS = 3

export interface Window {
  readonly start: number
  readonly end: number
}

/** Step-and-hold SVG path: each point holds until the next, until `window.end` at most, and breaks after the hold gap. */
export const stepPath = (points: ReadonlyArray<SeriesPoint>, x: (t: number) => number, y: (v: number) => number, window: Window, holdMs: number): string => {
  const commands: string[] = []
  let open = false
  points.forEach((point, index) => {
    const next = points[index + 1]
    const holdEnd = Math.min(next?.t ?? window.end, point.t + holdMs, window.end)
    if (holdEnd < window.start || point.t > window.end) { open = false; return }
    const level = y(point.v).toFixed(1)
    commands.push(`${open ? 'L' : 'M'}${x(Math.max(point.t, window.start)).toFixed(1)} ${level}`, `L${x(holdEnd).toFixed(1)} ${level}`)
    open = next !== undefined && next.t <= point.t + holdMs
  })
  return commands.join(' ')
}

/** A live point added to a pen's record, which keeps its window and the one point before it (the value held at its start). */
export const appendPoint = (points: ReadonlyArray<SeriesPoint>, point: SeriesPoint, windowStart: number): ReadonlyArray<SeriesPoint> => {
  const kept = [...points.filter(existing => existing.t < point.t), point]
  const first = kept.findIndex(existing => existing.t >= windowStart)
  return first <= 0 ? kept : kept.slice(first - 1)
}

/** Thresholds every pen of a strip declares under one id at one value and direction: the only limits the strip draws. */
export const sharedLimits = (pens: ReadonlyArray<Pick<VignetteValue, 'thresholds'>>): ReadonlyArray<Threshold> => {
  const [first, ...rest] = pens
  if (first === undefined) return []
  return first.thresholds.filter(threshold => rest.every(pen => pen.thresholds.some(other =>
    other.id === threshold.id && other.value === threshold.value && other.direction === threshold.direction)))
}

export interface Domain {
  readonly min: number
  readonly max: number
}

const PAD = 0.08
// A steady value is not magnified into noise: a scale spans at least this share of the value, and twenty steps of its decimals.
const MIN_SPAN_SHARE = 0.04
const MIN_SPAN_STEPS = 20

/** Whether a limit is near enough to share the values' scale (within three spreads or a quarter of their size); a farther one would flatten them. */
export const limitInReach = (limit: number, values: Domain): boolean => {
  const reach = Math.max(3 * (values.max - values.min), 0.25 * Math.max(Math.abs(values.max), Math.abs(values.min)))
  return limit >= values.min - reach && limit <= values.max + reach
}

/** The strip's scale: the values seen, widened to a minimum span and to the limits in reach, padded. */
export const stripDomain = (seen: Domain, limits: ReadonlyArray<number>, decimals: number): Domain => {
  const middle = (seen.min + seen.max) / 2
  const minimum = Math.max(Math.abs(middle) * MIN_SPAN_SHARE, MIN_SPAN_STEPS * 10 ** -decimals)
  const core = seen.max - seen.min >= minimum ? seen : { min: middle - minimum / 2, max: middle + minimum / 2 }
  const reached = limits.filter(limit => limitInReach(limit, seen))
  const low = Math.min(core.min, ...reached)
  const high = Math.max(core.max, ...reached)
  return { min: low - (high - low) * PAD, max: high + (high - low) * PAD }
}

const niceStep = (span: number, count: number): number => {
  const rough = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  return (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude
}

/** Two to four gridlines at round values; labels share the step's precision. */
export const valueTicks = (domain: Domain): ReadonlyArray<{ readonly value: number; readonly label: string }> => {
  const step = niceStep(domain.max - domain.min, 3)
  const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))
  const ticks: Array<{ value: number; label: string }> = []
  for (let tick = Math.ceil(domain.min / step) * step; tick <= domain.max + step * 1e-9; tick += step) ticks.push({ value: tick, label: tick.toFixed(digits) })
  return ticks
}

const tickStepMs = (windowMs: number): number =>
  windowMs <= 150_000 ? 30_000 : windowMs <= 300_000 ? 60_000 : windowMs <= 600_000 ? 120_000 : windowMs <= 1_200_000 ? 300_000 : 600_000

/** Times counted back from now in round steps: "now", "−2 min", "−30 s". */
export const timeTicks = (now: number, windowMs: number): ReadonlyArray<{ readonly t: number; readonly label: string }> => {
  const step = tickStepMs(windowMs)
  const ticks: Array<{ t: number; label: string }> = []
  for (let back = 0; back <= windowMs; back += step) {
    ticks.unshift({ t: now - back, label: back === 0 ? 'now' : back % 60_000 === 0 ? `−${back / 60_000} min` : `−${back / 1000} s` })
  }
  return ticks
}

/** Dash patterns that tell a strip's pens apart, in order (a strip holds at most four pens). */
export const PEN_DASHES: ReadonlyArray<string> = ['', '6 3', '2 3', '8 3 2 3']

export interface StripDrawing {
  readonly pens: ReadonlyArray<{ readonly ref: string; readonly path: string; readonly dash: string; readonly tone: AlertTone | null }>
  /** Shared limits within the scale, as lines; those beyond it named at the edge they lie past. */
  readonly limits: ReadonlyArray<{ readonly id: string; readonly y: number; readonly label: string; readonly labelY: number | null; readonly priority: Threshold['priority'] }>
  readonly beyond: ReadonlyArray<{ readonly id: string; readonly edge: 'top' | 'bottom'; readonly label: string }>
  readonly values: ReadonlyArray<{ readonly y: number; readonly label: string }>
  readonly times: ReadonlyArray<{ readonly x: number; readonly label: string }>
}

// The plot keeps its lines this far from its top and bottom edges.
const INSET = 4
// A limit's name sits just above its line, or just below where the name above would touch it; a third that would touch either is left to the line's title.
const LABEL_PX = 13

/** Where each limit line's name goes, top down, so no two touch; null where neither side of its line has room. */
export const limitLabelYs = (ys: ReadonlyArray<number>): ReadonlyArray<number | null> => {
  const order = ys.map((y, index) => ({ y, index })).sort((left, right) => left.y - right.y)
  const placed: Array<number | null> = ys.map(() => null)
  let last = -Infinity
  for (const { y, index } of order) {
    const spot = [y - 2, y + LABEL_PX - 1].find(candidate => candidate - last >= LABEL_PX && candidate >= LABEL_PX - 2)
    if (spot === undefined) continue
    placed[index] = spot
    last = spot
  }
  return placed
}

/** A strip as drawn over its window ending now; null while none of its pens has a value in the window. */
export const stripDrawing = (input: {
  readonly pens: ReadonlyArray<VignetteValue>
  readonly series: ReadonlyMap<string, ReadonlyArray<SeriesPoint>>
  readonly observations: ReadonlyArray<Pick<Observation, 'ref' | 'priority'>>
  readonly now: number
  readonly horizonMs: number
  readonly width: number
  readonly height: number
}): StripDrawing | null => {
  const window = { start: input.now - input.horizonMs, end: input.now }
  const shown = input.pens.flatMap(pen => (input.series.get(pen.ref) ?? []).filter((point, index, points) =>
    point.t <= window.end && (points[index + 1]?.t ?? window.end) >= window.start).map(point => point.v))
  if (shown.length === 0) return null
  const { unit, quantity } = input.pens[0]!
  const seen = { min: Math.min(...shown), max: Math.max(...shown) }
  const limits = sharedLimits(input.pens)
  const domain = stripDomain(seen, limits.map(limit => limit.value), decimalsFor(unit, (seen.min + seen.max) / 2, quantity))
  const x = (t: number): number => ((t - window.start) / input.horizonMs) * input.width
  const y = (v: number): number => INSET + (1 - (v - domain.min) / (domain.max - domain.min)) * (input.height - 2 * INSET)
  const name = (limit: Threshold): string => `${orderWord(limit)} ${numberText(limit.value, unit, quantity)}`
  const inside = (limit: Threshold): boolean => limit.value >= domain.min && limit.value <= domain.max
  const lines = limits.filter(inside)
  const labelYs = limitLabelYs(lines.map(limit => y(limit.value)))
  return {
    pens: input.pens.map((pen, index) => ({
      ref: pen.ref,
      path: pen.series === null ? '' : stepPath(input.series.get(pen.ref) ?? [], x, y, window, HOLD_INTERVALS * pen.series.intervalMs),
      dash: PEN_DASHES[index % PEN_DASHES.length]!,
      tone: toneOf(input.observations.find(observation => observation.ref === pen.ref)?.priority),
    })),
    limits: lines.map((limit, index) => ({ id: limit.id, y: y(limit.value), label: name(limit), labelY: labelYs[index]!, priority: limit.priority })),
    beyond: limits.filter(limit => !inside(limit)).map(limit => ({ id: limit.id, edge: limit.value > domain.max ? 'top' as const : 'bottom' as const, label: name(limit) })),
    values: valueTicks(domain).map(tick => ({ y: y(tick.value), label: tick.label })),
    times: timeTicks(input.now, input.horizonMs).map(tick => ({ x: x(tick.t), label: tick.label })),
  }
}
