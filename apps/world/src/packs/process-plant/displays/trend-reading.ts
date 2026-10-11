import { displayValue, formatValue, isPast, marginTo, marginText, nearestThresholdMargin, offScale, RESOLUTION_FRACTION, unitLabel, type ThresholdMargin } from './display-text.ts'
import type { ComposedDisplayThreshold } from './ic-thresholds.ts'

// How a signal's recent history reads: its rate over the display's window,
// which way it is going, the limit ahead of it and the time to that limit.
// The trend legend draws these and the compose result states them, so the
// answer beside a display names the same direction and limit as the display.

/** One sampled value at Simulation Run time, in epoch milliseconds and the signal's native unit. */
export interface TrendPoint {
  readonly t: number
  readonly v: number
}

// The operations Historian re-records an unchanged value at most once per
// minute, so a held value is drawn across gaps up to this length and broken
// beyond it.
export const HOLD_GAP_MS = 90_000

/** Keeps points ordered and drops those that can no longer influence the window. */
export const appendPoint = (
  points: ReadonlyArray<TrendPoint>,
  point: TrendPoint,
  windowStart: number,
): ReadonlyArray<TrendPoint> => {
  const kept = points.filter(existing => existing.t >= windowStart - HOLD_GAP_MS && existing.t < point.t)
  return [...kept, point]
}

// One window of a 30 minute horizon at the operations interval is 1 800
// samples; the page size leaves room for faster recording profiles.
export const TREND_HISTORY_LIMIT = 4_000

/** A recorded page as points: numeric samples with a Run time, oldest first. */
export const trendPoints = (samples: ReadonlyArray<{ readonly simulationTime?: string | undefined; readonly value: unknown }>): ReadonlyArray<TrendPoint> => samples
  .flatMap(sample => typeof sample.value === 'number' && sample.simulationTime !== undefined
    ? [{ t: Date.parse(sample.simulationTime), v: sample.value }]
    : [])
  .sort((left, right) => left.t - right.t)

// A comparison keeps ten minutes of each signal and reads its rate as a
// 10-minute trend's legend does, so one signal never shows two rates.
export const COMPARISON_HISTORY_MS = 600_000

// A rate needs some history: two points at least this far apart.
const RATE_MIN_SPAN_MS = 10_000

/**
 * The window a rate is measured over: short enough that the number states the
 * present tendency of the curve the operator sees (a minute-long window still
 * reported a fall after the curve had flattened), between 10 s for 1 s samples
 * and 30 s. The change qualifier compares it with three windows.
 */
export const rateWindowMs = (horizonMs: number): number =>
  Math.min(30_000, Math.max(RATE_MIN_SPAN_MS, Math.round(horizonMs / 16 / 5_000) * 5_000))

/** Least-squares slope over the window, per minute; null unless the data spans most of it. */
export const ratePerMinute = (points: ReadonlyArray<TrendPoint>, windowMs: number): number | null => {
  const last = points.at(-1)
  if (last === undefined) return null
  const recent = points.filter(point => point.t >= last.t - windowMs)
  if (recent.length < 2 || last.t - recent[0]!.t < Math.max(RATE_MIN_SPAN_MS, windowMs * 0.75)) return null
  const meanT = recent.reduce((sum, point) => sum + point.t, 0) / recent.length
  const meanV = recent.reduce((sum, point) => sum + point.v, 0) / recent.length
  const covariance = recent.reduce((sum, point) => sum + (point.t - meanT) * (point.v - meanV), 0)
  const variance = recent.reduce((sum, point) => sum + (point.t - meanT) ** 2, 0)
  return variance === 0 ? null : (covariance / variance) * 60_000
}

// A change below 0.1 % of the value a minute reads as steady, and so does one
// of less than a resolution step a minute: noise the display does not show.
const isSteady = (rate: number, value: number, resolution: number | null = null): boolean =>
  Math.abs(rate) <= Math.max(Math.abs(value) * 0.001, resolution ?? 0)

export type Travel = 'rising' | 'falling' | 'steady'

/** Which way the value is going at this rate, as the rate reads ("► steady" below 0.1 % a minute or a resolution step); null without a rate. */
export const travelOf = (rate: number | null, value: number, resolution: number | null = null): Travel | null =>
  rate === null ? null : isSteady(rate, value, resolution) ? 'steady' : rate > 0 ? 'rising' : 'falling'

export type RateChange = 'accelerating' | 'slowing' | 'reversing'

// A tendency needs enough history to mean something: half a minute at least,
// with several distinct values in it, so sample-and-hold steps never read as
// accelerating or reversing (HMI review).
const CHANGE_MIN_WINDOW_MS = 30_000
const CHANGE_MIN_DISTINCT_VALUES = 5

/**
 * How the rate the legend states compares with what the curve does at its
 * end and did before: slowing or reversing where the last third of the
 * window (10 s at least) moves at less than half the window's rate or the
 * other way, so a curve that has just flattened is never read by its steeper
 * slope (evaluation run 22: "≈5 s to LO TRIP" from a 30-s rate over a trace
 * already flat); else as the rate over the window, half a minute at least,
 * compares with three such windows.
 */
export const rateChange = (points: ReadonlyArray<TrendPoint>, windowMs: number, value: number, resolution: number | null = null): RateChange | null => {
  const window = Math.max(windowMs, CHANGE_MIN_WINDOW_MS)
  const last = points.at(-1)
  if (last === undefined || new Set(points.filter(point => point.t >= last.t - window).map(point => point.v)).size < CHANGE_MIN_DISTINCT_VALUES) return null
  const stated = ratePerMinute(points, windowMs)
  const end = ratePerMinute(points, Math.max(RATE_MIN_SPAN_MS, windowMs / 3))
  if (stated !== null && end !== null && !isSteady(stated, value, resolution)) {
    if (!isSteady(end, value, resolution) && Math.sign(end) !== Math.sign(stated)) return 'reversing'
    if (Math.abs(end) < Math.abs(stated) * 0.5) return 'slowing'
  }
  const recent = ratePerMinute(points, window)
  const longer = ratePerMinute(points, window * 3)
  if (recent === null || longer === null || isSteady(longer, value, resolution)) return null
  if (!isSteady(recent, value, resolution) && Math.sign(recent) !== Math.sign(longer)) return 'reversing'
  if (Math.abs(recent) < Math.abs(longer) * 0.5) return 'slowing'
  if (Math.abs(recent) > Math.abs(longer) * 1.5) return 'accelerating'
  return null
}

export const windowText = (windowMs: number): string => `${Math.round(windowMs / 1000)} s`

/** How fast, in display units: "1.80 %/min". */
const rateMagnitude = (rate: number, unit: string): string => {
  const label = unitLabel(unit)
  return `${formatValue(displayValue(Math.abs(rate), unit))}${label === '' ? '' : ` ${label}`}/min`
}

/** "▼ −1.80 %/min · 15 s · slowing" in display units; the window and change only when given. */
export const rateText = (
  rate: number | null,
  value: number,
  unit: string,
  detail: { readonly windowMs?: number; readonly change?: RateChange | null; readonly resolution?: number | null } = {},
): string => {
  if (rate === null) return ''
  const window = detail.windowMs === undefined ? '' : ` · ${windowText(detail.windowMs)}`
  if (isSteady(rate, value, detail.resolution ?? null)) return `► steady${window}`
  const change = detail.change === undefined || detail.change === null ? '' : ` · ${detail.change}`
  return `${rate > 0 ? '▲ +' : '▼ −'}${rateMagnitude(rate, unit)}${window}${change}`
}

/**
 * The same rate in words, for text beside the display: "falling 1.80 %/min
 * over 30 s, slowing", the window as the legend states it where given;
 * empty without a rate.
 */
export const travelText = (rate: number | null, value: number, unit: string, change: RateChange | null, resolution: number | null = null, windowMs?: number): string => {
  const travel = travelOf(rate, value, resolution)
  if (travel === null || travel === 'steady') return travel ?? ''
  return `${travel} ${rateMagnitude(rate!, unit)}${windowMs === undefined ? '' : ` over ${windowText(windowMs)}`}${change === null ? '' : `, ${change}`}`
}

// A time to a limit is projected only from a tendency with a basis: half a
// minute of change the display can show, all of it one way, and not slowing.
// A curve bending over (pressure settling while a PORV stays stuck open) would
// otherwise be extrapolated straight to a limit it may never reach.
const PROJECTION_BASIS_MS = 30_000

/**
 * Whether the latest tendency supports projecting a time to a limit: the
 * points reach back half a minute, the value moved through several values the
 * display can tell apart in it, each step the way the rate goes, and the rate
 * is neither slowing nor reversing (rateChange, as the legend says it).
 */
export const projectionBasis = (points: ReadonlyArray<TrendPoint>, windowMs: number, unit: string, resolution: number | null = null): boolean => {
  const last = points.at(-1)
  if (last === undefined || points[0]!.t > last.t - PROJECTION_BASIS_MS) return false
  const rate = ratePerMinute(points, windowMs)
  if (rate === null || isSteady(rate, last.v, resolution)) return false
  const change = rateChange(points, windowMs, last.v, resolution)
  if (change === 'slowing' || change === 'reversing') return false
  const recent = points.filter(point => point.t >= last.t - PROJECTION_BASIS_MS)
  const shown = recent.map(point => formatValue(displayValue(point.v, unit), resolution === null ? null : displayValue(resolution, unit)))
  let steps = 0
  for (let index = 1; index < recent.length; index += 1) {
    if (shown[index] === shown[index - 1]) continue
    if (Math.sign(recent[index]!.v - recent[index - 1]!.v) !== Math.sign(rate)) return false
    steps += 1
  }
  return steps >= CHANGE_MIN_DISTINCT_VALUES - 1
}

/**
 * How far back a reading over this window looks: every point it weighs lies
 * this close to the latest (the change qualifier's three windows); of older
 * points it asks only whether there is one (projectionBasis). So the points
 * within it and the newest one before it read exactly as the whole history.
 */
export const readingLookBackMs = (windowMs: number): number => 3 * Math.max(windowMs, CHANGE_MIN_WINDOW_MS, PROJECTION_BASIS_MS)

/**
 * Minutes until the value reaches the threshold's value at the current rate,
 * if moving toward it: before acting on it, or (`back`) moving back across a
 * limit it is past.
 */
export const minutesToThreshold = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, back = false): number | null => {
  if (rate === null || rate === 0) return null
  const distance = threshold.value - value
  if (Math.sign(distance) !== Math.sign(rate)) return null
  const already = threshold.direction === 'low' ? value <= threshold.value : value >= threshold.value
  return already !== back ? null : distance / rate
}

// A time beyond this is not shown: the rate now says little about half an hour on.
const PROJECTION_MAX_MINUTES = 30

/** Minutes to the threshold where the display shows a time to it: projectable, approaching and within half an hour. */
export const projectedMinutes = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, projectable: boolean, back = false): number | null => {
  const minutes = minutesToThreshold(value, rate, threshold, back)
  return minutes === null || minutes > PROJECTION_MAX_MINUTES || !projectable ? null : minutes
}

/** What a time to a limit says where the tendency gives no basis for one (projectionBasis). */
export const NOT_PROJECTED = 'approaching, not projected'

/**
 * "≈45 s" or "≈4 min" to the threshold at the current rate; where the
 * tendency gives no basis for a time (projectionBasis), "approaching, not
 * projected" instead; empty when not approaching it within half an hour.
 */
export const timeToThresholdText = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, projectable: boolean, back = false): string => {
  const minutes = minutesToThreshold(value, rate, threshold, back)
  if (minutes === null || minutes > PROJECTION_MAX_MINUTES) return ''
  if (!projectable) return NOT_PROJECTED
  return minutes < 2 ? `≈${Math.max(1, Math.round(minutes * 60))} s` : `≈${Math.round(minutes)} min`
}

/**
 * The limit a moving value heads for: of the limits in force, the nearest
 * whose value lies ahead of it in the direction it moves, whether it has not
 * reached that limit yet or is past it and moving back across it. Null where
 * none lies ahead.
 */
export const limitAhead = (
  value: number,
  travel: 'rising' | 'falling',
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const ahead = thresholds
    .filter(threshold => threshold.kind !== 'control' && (travel === 'rising' ? threshold.value > value : threshold.value < value))
  if (ahead.length === 0) return null
  const nearest = ahead.reduce((best, candidate) => Math.abs(candidate.value - value) < Math.abs(best.value - value) ? candidate : best)
  return marginTo(value, nearest)
}

/** Of the limits in force the value is past, the outermost on the side it is past: 0 % is past LO-LO 20 %, not only past LO 30 %. */
const outermostPassed = (value: number, thresholds: ReadonlyArray<ComposedDisplayThreshold>): ThresholdMargin | null => {
  const passed = thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => marginTo(value, threshold)).filter(isPast)
  return passed.length === 0 ? null : passed.reduce((outermost, candidate) => candidate.margin > outermost.margin ? candidate : outermost)
}

/**
 * The Plant's operating mode as a sample reads it: undefined where the Plant
 * declares none (or before the first sample), null where none of its modes
 * holds.
 */
export type PlantModeNow = { readonly id: string; readonly label: string } | null | undefined

/**
 * Whether a limit acts now: one the I&C applies in every mode always; a
 * mode-qualified one only while the Plant is in one of its modes. A trip
 * latched in another mode stays in the alarm list until reset, but its limit
 * no longer acts: it is drawn as not in force even with the value past it.
 */
export const limitInForce = (threshold: Pick<ComposedDisplayThreshold, 'modeIds'>, mode: { readonly id: string } | null): boolean =>
  threshold.modeIds === undefined || (mode !== null && threshold.modeIds.includes(mode.id))

/**
 * A signal's limits that act in the Plant's current mode, so no margin or
 * time is read against one that does not. The mode is unknown only where the
 * Plant declares none (no limit is qualified) or before the first sample
 * (no value is compared), so then every limit is kept.
 */
export const limitsInForce = (
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
  mode: PlantModeNow,
): ReadonlyArray<ComposedDisplayThreshold> =>
  mode === undefined ? thresholds : thresholds.filter(threshold => limitInForce(threshold, mode))

/**
 * The most severe of a signal's limits in force whose I&C rule is active now,
 * trips first: what its chip and its drawing's badge both name.
 */
export const activeThreshold = <T extends ComposedDisplayThreshold>(
  thresholds: ReadonlyArray<T>,
  activeRuleIds: ReadonlySet<string>,
  mode: PlantModeNow,
): T | null =>
  limitsInForce(thresholds, mode).filter(threshold => threshold.kind !== 'control' && activeRuleIds.has(threshold.ruleId))
    .sort((left, right) => Number(right.kind === 'trip') - Number(left.kind === 'trip') || severityRank[left.severity ?? 'warning'] - severityRank[right.severity ?? 'warning'])[0] as T | undefined ?? null

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/**
 * What a legend row says of a signal's limits, read in the direction the
 * value moves: the nearest limit in force ahead of it, with the time to it;
 * past one it is moving back across, with the time to it; past the
 * outermost on the side it has gone (moving on or steady); no limit in force
 * that way; no I&C limit at all; or none acting in the current mode. A value
 * with no direction (steady, or seen once) names the limit it is past, else
 * the nearest either way where it is near. Null where it says nothing.
 */
export type LimitState =
  | {
    readonly kind: 'margin'
    readonly margin: ThresholdMargin
    /** "≈45 s", "approaching, not projected", or empty where the row shows no time. */
    readonly eta: string
    /** Minutes to the limit where the row shows a projected time. */
    readonly minutes: number | null
  }
  | {
    readonly kind: 'past'
    readonly margin: ThresholdMargin
    /** Moving back across it: which way, and the time to it as a margin's eta; null while it goes on or holds. */
    readonly back: { readonly travel: 'rising' | 'falling'; readonly eta: string; readonly minutes: number | null } | null
  }
  | { readonly kind: 'clear'; readonly direction: 'low' | 'high' }
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'idle'; readonly mode: { readonly label: string } | null }

export interface TrendReading {
  /** Change per minute over the window, in native units; null without history enough for one. */
  readonly rate: number | null
  readonly travel: Travel | null
  readonly change: RateChange | null
  /** The most severe of its limits in force active now: the alarm chip beside it. */
  readonly inAlarm: ComposedDisplayThreshold | null
  /** Where the reading sits at an end of its instrument's span: it says only that the quantity is there or beyond. */
  readonly offScale: 'below' | 'above' | null
  readonly limit: LimitState | null
}

/**
 * How a legend row reads a numeric signal now. `points` is the recorded
 * history and the samples since, oldest first, read over `windowMs`; null for
 * a row shown live only (not recorded by the Run), which has no rate and names
 * the nearest limit. A reading at an end of its span has no rate: the
 * indication is saturated, and how far beyond it the quantity goes is unknown.
 */
export const trendReading = (config: {
  readonly value: number
  readonly points: ReadonlyArray<TrendPoint> | null
  readonly windowMs: number
  readonly unit: string
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly mode: PlantModeNow
  readonly activeRuleIds: ReadonlySet<string>
  readonly resolution?: number | null
  readonly span?: { readonly min: number; readonly max: number }
}): TrendReading => {
  const { value, points, windowMs, unit, thresholds, mode, activeRuleIds } = config
  const resolution = config.resolution ?? null
  const end = offScale(value, config.span)
  const rate = points === null || end !== null ? null : ratePerMinute(points, windowMs)
  const travel = travelOf(rate, value, resolution)
  const inForce = limitsInForce(thresholds, mode).filter(threshold => threshold.kind !== 'control')
  const reading = {
    rate,
    travel,
    change: rate === null || points === null ? null : rateChange(points, windowMs, value, resolution),
    inAlarm: activeThreshold(thresholds, activeRuleIds, mode),
    offScale: end,
  }
  if (!thresholds.some(threshold => threshold.kind !== 'control')) return { ...reading, limit: { kind: 'unlimited' } }
  if (inForce.length === 0) return { ...reading, limit: mode === undefined ? null : { kind: 'idle', mode } }
  // Off scale, the quantity lies at or beyond the end of the span: its limits are read that way, with no time to any.
  const heading = end === 'below' ? 'falling' : end === 'above' ? 'rising' : travel
  if (heading === 'rising' || heading === 'falling') {
    const projectable = points !== null && projectionBasis(points, windowMs, unit, resolution)
    const ahead = limitAhead(value, heading, inForce)
    if (ahead !== null && isPast(ahead)) {
      return { ...reading, limit: { kind: 'past', margin: ahead, back: { travel: heading, eta: timeToThresholdText(value, rate, ahead.threshold, projectable, true), minutes: projectedMinutes(value, rate, ahead.threshold, projectable, true) } } }
    }
    if (ahead !== null) {
      return { ...reading, limit: { kind: 'margin', margin: ahead, eta: timeToThresholdText(value, rate, ahead.threshold, projectable), minutes: projectedMinutes(value, rate, ahead.threshold, projectable) } }
    }
    const behind = outermostPassed(value, inForce)
    return { ...reading, limit: behind !== null ? { kind: 'past', margin: behind, back: null } : { kind: 'clear', direction: heading === 'falling' ? 'low' : 'high' } }
  }
  const margin = nearestThresholdMargin(value, inForce)!
  if (isPast(margin)) return { ...reading, limit: { kind: 'past', margin, back: null } }
  // Going nowhere, a value is near a limit only within a quarter of the scale
  // it reads over: farther, a margin says nothing an operator acts on (a
  // tripped core at 0 MW is no "3600 MW below HI ALM").
  const reach = resolution === null ? Number.POSITIVE_INFINITY : resolution / RESOLUTION_FRACTION * NEAR_FRACTION
  return { ...reading, limit: margin.margin <= reach ? { kind: 'margin', margin, eta: '', minutes: null } : null }
}

const NEAR_FRACTION = 0.25

/**
 * A legend row's limit state in its words: "0.66 MPa above LO 14.8 MPa · ALM
 * · ≈2 min", "past LO-LO 20 % · AFW START", "past LO 35 % · ALM · rising,
 * back above it in ≈2 min", "no LO limit in force". A value moving back
 * across a limit it is past is said to rise or fall, with the time back
 * across it where the tendency gives one, never to recover: a pressurizer
 * level rising while a relief valve discharges is no recovery (evaluation
 * run 22's "recovering, not projected").
 */
export const limitStateText = (state: LimitState, unit: string, resolution: number | null = null): string => {
  if (state.kind === 'margin') return `${marginText(state.margin, unit, resolution)}${state.eta === '' ? '' : ` · ${state.eta}`}`
  if (state.kind === 'past') {
    const back = state.back
    if (back === null) return marginText(state.margin, unit, resolution)
    const across = `back ${state.margin.threshold.direction === 'low' ? 'above' : 'below'} it`
    return `${marginText(state.margin, unit, resolution)} · ${back.travel}, ${back.eta === NOT_PROJECTED ? 'not projected' : `${across} in ${back.eta === '' ? 'over 30 min' : back.eta}`}`
  }
  if (state.kind === 'clear') return `no ${state.direction === 'low' ? 'LO' : 'HI'} limit in force`
  if (state.kind === 'unlimited') return 'no I&C limit'
  return `no limit acts ${state.mode === null ? 'now' : `in ${state.mode.label}`}`
}

/** A reading's state in words: off scale first, then its limit state; empty where it says nothing. */
export const readingStateText = (reading: Pick<TrendReading, 'offScale' | 'limit'>, unit: string, resolution: number | null = null): string =>
  [reading.offScale === null ? '' : `${reading.offScale} range`, reading.limit === null ? '' : limitStateText(reading.limit, unit, resolution)].filter(part => part !== '').join(' · ')
