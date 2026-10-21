import type { SimulationRunId } from '../../../core/model/index.ts'
import { workspaceApiPath } from '../../../ui/workspace-context.ts'
import { displayValue, formatQuantity, formatValue } from '../quantity-text.ts'

// A Plant card's energy lines: the Run's recorded points of a rate, how a
// line extends with the projection's readings, and the sparkline it draws,
// step and hold with no axes, which way the rate is going at a glance. Time
// is Simulation Run time in epoch milliseconds; values are the rate's unit.

export interface TrendPoint {
  readonly t: number
  readonly v: number
}

/** The operations Historian re-records an unchanged value at most once a minute: a held value is drawn across gaps up to this, and broken beyond. */
export const HOLD_GAP_MS = 90_000
/** One page of the Run's history: a ten-minute line at a second's interval with room to spare. */
const HISTORY_LIMIT = 4_000

/** Keeps points ordered and drops those that can no longer reach into a window starting at `windowStart`. */
export const appendPoint = (points: ReadonlyArray<TrendPoint>, point: TrendPoint, windowStart: number): ReadonlyArray<TrendPoint> =>
  [...points.filter(existing => existing.t >= windowStart - HOLD_GAP_MS && existing.t < point.t), point]

/** What the Run's historian recorded of a series in a window of Run time: its numeric samples, oldest first. */
export const readHistory = async (runId: SimulationRunId, seriesId: string, window: { readonly from: number; readonly to: number }): Promise<ReadonlyArray<TrendPoint>> => {
  const query = new URLSearchParams({ mode: 'raw', seriesId, timeAxis: 'simulation', from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(), limit: String(HISTORY_LIMIT) })
  const response = await fetch(`${workspaceApiPath(`/simulation-runs/${encodeURIComponent(runId)}/history/samples`)}?${query}`)
  if (!response.ok) throw new Error(`Reading history failed with HTTP ${response.status}`)
  const page = await response.json() as { readonly samples?: ReadonlyArray<{ readonly simulationTime?: string; readonly value: unknown }> }
  return (page.samples ?? []).flatMap(sample => typeof sample.value === 'number' && sample.simulationTime !== undefined ? [{ t: Date.parse(sample.simulationTime), v: sample.value }] : [])
    .sort((left, right) => left.t - right.t)
}

export interface Sparkline {
  readonly path: string
  /** The latest value, while it still holds now: drawn as a dot. */
  readonly end: { readonly x: number; readonly y: number } | null
  readonly range: { readonly min: number; readonly max: number }
  /** The line breaks where nothing was recorded for longer than a value holds. */
  readonly broken: boolean
}

// The line stays clear of the frame, and the dot at its end fits inside it.
const INSET_Y = 3
const INSET_END = 4
/** A scale spans at least this share of the value, and one unit for values of one or more, so a steady rate reads flat, not as noise. */
const MIN_SPAN_FRACTION = 0.04
const PAD_FRACTION = 0.08

/** The line over one window ending now; null where nothing recorded reaches into it. */
export const sparkline = (points: ReadonlyArray<TrendPoint>, now: number, windowMs: number, size: { readonly width: number; readonly height: number }): Sparkline | null => {
  const start = now - windowMs
  const readings = points.filter(point => Number.isFinite(point.v) && point.t <= now)
  const drawn = readings.filter((point, index) => Math.min(readings[index + 1]?.t ?? now, point.t + HOLD_GAP_MS, now) >= start)
  if (drawn.length === 0) return null
  const range = { min: Math.min(...drawn.map(point => point.v)), max: Math.max(...drawn.map(point => point.v)) }
  const magnitude = Math.max(Math.abs(range.min), Math.abs(range.max))
  const minimum = magnitude >= 1 ? Math.max(magnitude * MIN_SPAN_FRACTION, 1) : magnitude * MIN_SPAN_FRACTION
  const middle = (range.min + range.max) / 2
  const width = range.max - range.min
  // A moving rate is padded by a share of its width; one too small to scale (a decayed power near zero) spans one unit.
  const scaled = width >= minimum ? { min: range.min - width * PAD_FRACTION, max: range.max + width * PAD_FRACTION } : { min: middle - minimum / 2, max: middle + minimum / 2 }
  const domain = scaled.max - scaled.min > 0 && Number.isFinite(scaled.max - scaled.min) ? scaled : { min: middle - 1, max: middle + 1 }
  const x = (t: number): number => ((t - start) / windowMs) * (size.width - INSET_END)
  const y = (v: number): number => INSET_Y + (1 - (v - domain.min) / (domain.max - domain.min)) * (size.height - 2 * INSET_Y)
  const commands: string[] = []
  let open = false
  drawn.forEach((point, index) => {
    const next = drawn[index + 1]
    const holdEnd = Math.min(next?.t ?? now, point.t + HOLD_GAP_MS, now)
    const level = y(point.v).toFixed(1)
    commands.push(`${open ? 'L' : 'M'}${x(Math.max(point.t, start)).toFixed(1)} ${level}`, `L${x(holdEnd).toFixed(1)} ${level}`)
    open = next !== undefined && next.t <= point.t + HOLD_GAP_MS
  })
  const last = drawn.at(-1)!
  const broken = drawn.some((point, index) => index > 0 && point.t - drawn[index - 1]!.t > HOLD_GAP_MS)
  return { path: commands.join(' '), end: last.t >= now - HOLD_GAP_MS ? { x: x(now), y: y(last.v) } : null, range, broken }
}

/** What a line shows, for its tooltip and accessible name: it has no value axis, so the words carry the range. */
export const sparklineText = (line: Sparkline, windowMs: number, unit: string): string => {
  const spread = line.range.min === line.range.max ? `steady at ${formatQuantity(line.range.min, unit, null)}`
    : `${formatValue(displayValue(line.range.min, unit), null)} to ${formatQuantity(line.range.max, unit, null)}`
  return `Last ${Math.round(windowMs / 60_000)} min: ${spread}${line.broken ? ' · broken where nothing was recorded' : ''}`
}
