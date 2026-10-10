// Pure geometry and wording for the sparklines beside a generated display's
// lead values (ISA-101 Level 1): which way each value is going and how fast,
// at a glance, with no axes. Time is Simulation Run time in epoch
// milliseconds; values are the signal's native unit.
import { displayValue, formatQuantity, formatValue, nearestThresholdMargin, thresholdName } from '../../../packs/process-plant/displays/display-text.ts'
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import { HOLD_GAP_MS, paddedDomain, rawDomain, stepPath, type TrendPoint, type ValueDomain } from './trend-geometry.ts'

/** Every sparkline's size, so one window label over the column lines up with all of them. */
export const SPARKLINE_SIZE = { width: 112, height: 28 } as const

// The line stays clear of the frame, and the dot at its end (radius 2) fits inside it.
const INSET_Y = 3
const INSET_END = 4

export interface Sparkline {
  /** Step-hold path, broken wherever history is missing; empty when nothing falls in the window. */
  readonly path: string
  /** The latest value, while it still holds now: the line's end, drawn as a dot. */
  readonly end: { readonly x: number; readonly y: number } | null
  /** The nearest alarm or trip limit, drawn only where it lies inside the plotted range (a line on the frame would not read). */
  readonly limit: { readonly y: number; readonly threshold: ComposedDisplayThreshold } | null
  /** The lowest and highest value drawn; null when none is. */
  readonly range: ValueDomain | null
  /** The line breaks where nothing was recorded for longer than a value holds. */
  readonly broken: boolean
}

/**
 * A lead value's sparkline over one window ending now. The scale fits the
 * values the line draws, padded and never narrower than a share of the value
 * (paddedDomain), so a steady value reads as a flat line, not as noise. The
 * nearest limit is the one the row's margin line names; it never widens the
 * scale, which would flatten the line.
 */
export const sparkline = (input: {
  readonly points: ReadonlyArray<TrendPoint>
  readonly now: number
  readonly windowMs: number
  readonly size: { readonly width: number; readonly height: number }
  /** The latest sampled value, which the nearest limit is judged from. */
  readonly value: number | undefined
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
}): Sparkline => {
  const { points, now, windowMs, size } = input
  const start = now - windowMs
  // What the line draws: each value whose hold reaches into the window.
  const drawn = points.filter((point, index) => {
    const holdEnd = Math.min(points[index + 1]?.t ?? now, point.t + HOLD_GAP_MS, now)
    return point.t <= now && holdEnd >= start
  })
  const range = rawDomain(drawn.map(point => point.v))
  if (range === null) return { path: '', end: null, limit: null, range: null, broken: false }
  const domain = paddedDomain(range)
  const x = (t: number): number => ((t - start) / windowMs) * (size.width - INSET_END)
  const y = (v: number): number => INSET_Y + (1 - (v - domain.min) / (domain.max - domain.min)) * (size.height - 2 * INSET_Y)
  const last = drawn.at(-1)!
  const limit = input.value === undefined ? null : nearestThresholdMargin(input.value, input.thresholds)?.threshold ?? null
  return {
    path: stepPath(drawn, x, y, { start, end: now }),
    end: last.t >= now - HOLD_GAP_MS ? { x: x(now), y: y(last.v) } : null,
    limit: limit !== null && limit.value > domain.min && limit.value < domain.max ? { y: y(limit.value), threshold: limit } : null,
    range,
    broken: drawn.some((point, index) => index > 0 && point.t - drawn[index - 1]!.t > HOLD_GAP_MS),
  }
}

/** The window a sparkline spans, as its label says it: "10 min". */
export const sparklineWindowText = (windowMs: number): string =>
  windowMs % 60_000 === 0 ? `${windowMs / 60_000} min` : `${Math.round(windowMs / 1000)} s`

/**
 * What a lead value's sparkline shows, or why it has none: its tooltip and
 * accessible name. A sparkline has no value axis, so the words carry the range.
 */
export const sparklineText = (input: {
  readonly recorded: boolean
  readonly windowMs: number
  readonly unit: string
  readonly line: Sparkline | null
  /** The historian held nothing in the window when the display opened. */
  readonly historyMissing: boolean
  /** Why the history could not be read, when it could not. */
  readonly historyError: string | undefined
}): string => {
  const window = sparklineWindowText(input.windowMs)
  if (!input.recorded) return 'Not recorded by this Run\'s historian, so no trend: current value only'
  const since = input.historyError !== undefined
    ? ` · its history could not be read (${input.historyError}), so the line starts when this display opened`
    : input.historyMissing ? ' · nothing recorded before this display opened' : ''
  const range = input.line?.range ?? null
  if (range === null) return `No values in the last ${window} yet${since}`
  const spread = range.min === range.max
    ? `steady at ${formatQuantity(range.min, input.unit)}`
    : `${formatValue(displayValue(range.min, input.unit))} to ${formatQuantity(range.max, input.unit)}`
  const limit = input.line?.limit ?? null
  const broken = input.line?.broken === true ? ' · broken where nothing was recorded' : ''
  return `Last ${window}: ${spread}${limit === null ? '' : ` · dashed line: ${thresholdName(limit.threshold, input.unit)}`}${broken}${since}`
}
