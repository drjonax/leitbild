import { displayValue, formatValue, isPast, marginText, nearestThresholdMargin, thresholdName, unitLabel, type ThresholdMargin } from './display-text.ts'
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
export const trendPoints = (samples: ReadonlyArray<{ readonly simulationTime?: string; readonly value: unknown }>): ReadonlyArray<TrendPoint> => samples
  .flatMap(sample => typeof sample.value === 'number' && sample.simulationTime !== undefined
    ? [{ t: Date.parse(sample.simulationTime), v: sample.value }]
    : [])
  .sort((left, right) => left.t - right.t)

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

// A change below 0.1 % of the value per minute reads as steady.
const isSteady = (rate: number, value: number): boolean => Math.abs(rate) <= Math.abs(value) * 0.001

export type Travel = 'rising' | 'falling' | 'steady'

/** Which way the value is going at this rate, as the rate reads ("► steady" below 0.1 % a minute); null without a rate. */
export const travelOf = (rate: number | null, value: number): Travel | null =>
  rate === null ? null : isSteady(rate, value) ? 'steady' : rate > 0 ? 'rising' : 'falling'

export type RateChange = 'accelerating' | 'slowing' | 'reversing'

// A tendency needs enough history to mean something: half a minute at least,
// with several distinct values in it, so sample-and-hold steps never read as
// accelerating or reversing (HMI review).
const CHANGE_MIN_WINDOW_MS = 30_000
const CHANGE_MIN_DISTINCT_VALUES = 5

/**
 * How the rate over the window, half a minute at least, compares with the
 * rate over three such windows, so a curve that has flattened is not reported
 * only by its older, steeper slope.
 */
export const rateChange = (points: ReadonlyArray<TrendPoint>, windowMs: number, value: number): RateChange | null => {
  const window = Math.max(windowMs, CHANGE_MIN_WINDOW_MS)
  const last = points.at(-1)
  if (last === undefined || new Set(points.filter(point => point.t >= last.t - window).map(point => point.v)).size < CHANGE_MIN_DISTINCT_VALUES) return null
  const recent = ratePerMinute(points, window)
  const longer = ratePerMinute(points, window * 3)
  if (recent === null || longer === null || isSteady(longer, value)) return null
  if (!isSteady(recent, value) && Math.sign(recent) !== Math.sign(longer)) return 'reversing'
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
  detail: { readonly windowMs?: number; readonly change?: RateChange | null } = {},
): string => {
  if (rate === null) return ''
  const window = detail.windowMs === undefined ? '' : ` · ${windowText(detail.windowMs)}`
  if (isSteady(rate, value)) return `► steady${window}`
  const change = detail.change === undefined || detail.change === null ? '' : ` · ${detail.change}`
  return `${rate > 0 ? '▲ +' : '▼ −'}${rateMagnitude(rate, unit)}${window}${change}`
}

/** The same rate in words, for text beside the display: "falling 1.80 %/min, slowing"; empty without a rate. */
export const travelText = (rate: number | null, value: number, unit: string, change: RateChange | null): string => {
  const travel = travelOf(rate, value)
  if (travel === null || travel === 'steady') return travel ?? ''
  return `${travel} ${rateMagnitude(rate!, unit)}${change === null ? '' : `, ${change}`}`
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
export const projectionBasis = (points: ReadonlyArray<TrendPoint>, windowMs: number, unit: string): boolean => {
  const last = points.at(-1)
  if (last === undefined || points[0]!.t > last.t - PROJECTION_BASIS_MS) return false
  const rate = ratePerMinute(points, windowMs)
  if (rate === null || isSteady(rate, last.v)) return false
  const change = rateChange(points, windowMs, last.v)
  if (change === 'slowing' || change === 'reversing') return false
  const recent = points.filter(point => point.t >= last.t - PROJECTION_BASIS_MS)
  const shown = recent.map(point => formatValue(displayValue(point.v, unit)))
  let steps = 0
  for (let index = 1; index < recent.length; index += 1) {
    if (shown[index] === shown[index - 1]) continue
    if (Math.sign(recent[index]!.v - recent[index - 1]!.v) !== Math.sign(rate)) return false
    steps += 1
  }
  return steps >= CHANGE_MIN_DISTINCT_VALUES - 1
}

/** Minutes until the value reaches the threshold at the current rate, if moving toward it. */
export const minutesToThreshold = (value: number, rate: number | null, threshold: ComposedDisplayThreshold): number | null => {
  if (rate === null || rate === 0) return null
  const distance = threshold.value - value
  if (Math.sign(distance) !== Math.sign(rate)) return null
  const already = threshold.direction === 'low' ? value <= threshold.value : value >= threshold.value
  return already ? null : distance / rate
}

// A time beyond this is not shown: the rate now says little about half an hour on.
const PROJECTION_MAX_MINUTES = 30

/** Minutes to the threshold where the display shows a time to it: projectable, approaching and within half an hour. */
export const projectedMinutes = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, projectable: boolean): number | null => {
  const minutes = minutesToThreshold(value, rate, threshold)
  return minutes === null || minutes > PROJECTION_MAX_MINUTES || !projectable ? null : minutes
}

/**
 * "≈45 s" or "≈4 min" to the threshold at the current rate; where the
 * tendency gives no basis for a time (projectionBasis), "approaching, not
 * projected" instead; empty when not approaching it within half an hour.
 */
export const timeToThresholdText = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, projectable: boolean): string => {
  const minutes = minutesToThreshold(value, rate, threshold)
  if (minutes === null || minutes > PROJECTION_MAX_MINUTES) return ''
  if (!projectable) return 'approaching, not projected'
  return minutes < 2 ? `≈${Math.max(1, Math.round(minutes * 60))} s` : `≈${Math.round(minutes)} min`
}

/**
 * The limit the value is heading for: the nearest alarm or trip threshold not
 * yet passed in the direction it is moving, or either way while it is steady.
 * Null when it moves away from every limit it has not passed.
 */
export const limitAhead = (
  value: number,
  rate: number | null,
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
): ThresholdMargin | null => {
  const unpassed = thresholds
    .filter(threshold => threshold.kind !== 'control')
    .map(threshold => ({ threshold, margin: threshold.direction === 'low' ? value - threshold.value : threshold.value - value }))
    .filter(candidate => candidate.margin >= 0)
  const moving = rate !== null && !isSteady(rate, value)
  const ahead = moving ? unpassed.filter(candidate => (candidate.threshold.direction === 'low') === (rate < 0)) : unpassed
  return ahead.length === 0 ? null : ahead.reduce((nearest, candidate) => candidate.margin < nearest.margin ? candidate : nearest)
}

/**
 * For a value past an active limit and moving back: when it will be back
 * inside it, always with a time ("back above LO ALM 30 % in ≈2 min", "back
 * above LO TRIP 13.8 MPa in over 30 min"), so a slow drift never reads as a
 * recovery already made; "recovering, not projected" where the tendency gives
 * no basis for a time (projectionBasis); empty otherwise.
 */
export const returningText = (value: number, rate: number | null, active: ComposedDisplayThreshold, unit: string, projectable: boolean): string => {
  if (rate === null || isSteady(rate, value)) return ''
  const returning = active.direction === 'low' ? rate > 0 : rate < 0
  if (!returning) return ''
  if (!projectable) return 'recovering, not projected'
  const eta = timeToThresholdText(value, rate, { ...active, direction: active.direction === 'low' ? 'high' : 'low' }, true)
  return `back ${active.direction === 'low' ? 'above' : 'below'} ${thresholdName(active, unit)} in ${eta === '' ? 'over 30 min' : eta}`
}

/** Whether the value moves away from every limit it has not passed ("no HI limit ahead"). */
export const movingAwayFromLimits = (value: number, rate: number | null, thresholds: ReadonlyArray<ComposedDisplayThreshold>): 'rising' | 'falling' | null => {
  if (rate === null || isSteady(rate, value) || thresholds.every(threshold => threshold.kind === 'control')) return null
  return limitAhead(value, rate, thresholds) === null ? (rate > 0 ? 'rising' : 'falling') : null
}

/**
 * The Plant's operating mode as a sample reads it: undefined where the Plant
 * declares none (or before the first sample), null where none of its modes
 * holds.
 */
export type PlantModeNow = { readonly id: string; readonly label: string } | null | undefined

/**
 * Whether a limit acts now: one the I&C applies in every mode always; a
 * mode-qualified one while the Plant is in one of its modes, or while its rule
 * is still active (a trip latched in power operation stays until it is reset).
 */
export const limitInForce = (threshold: Pick<ComposedDisplayThreshold, 'modeIds'>, mode: { readonly id: string } | null, active: boolean): boolean =>
  active || threshold.modeIds === undefined || (mode !== null && threshold.modeIds.includes(mode.id))

/**
 * A signal's limits that act in the Plant's current mode, so no margin or
 * time is read against one that does not. The mode is unknown only where the
 * Plant declares none (no limit is qualified) or before the first sample
 * (no value is compared), so then every limit is kept.
 */
export const limitsInForce = (
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
  mode: PlantModeNow,
  activeRuleIds: ReadonlySet<string>,
): ReadonlyArray<ComposedDisplayThreshold> =>
  mode === undefined ? thresholds : thresholds.filter(threshold => limitInForce(threshold, mode, activeRuleIds.has(threshold.ruleId)))

/** The most severe of a signal's thresholds whose I&C rule is active now. */
export const activeThreshold = (
  thresholds: ReadonlyArray<ComposedDisplayThreshold>,
  activeRuleIds: ReadonlySet<string>,
): ComposedDisplayThreshold | null =>
  thresholds.filter(threshold => threshold.kind !== 'control' && activeRuleIds.has(threshold.ruleId))
    .sort((left, right) => Number(right.kind === 'trip') - Number(left.kind === 'trip'))[0] ?? null

/**
 * What a legend row says of a signal's limits, in the order it chooses:
 * coming back inside an active limit; the limit ahead (for a row shown live
 * only, the nearest) with the time to it; moving away from every limit; no
 * I&C limit at all; or none acting in the current mode. Null where it says
 * nothing.
 */
export type LimitState =
  | { readonly kind: 'returning'; readonly text: string }
  | {
    readonly kind: 'margin'
    readonly margin: ThresholdMargin
    /** "≈45 s", "approaching, not projected", or empty where the row shows no time. */
    readonly eta: string
    /** Minutes to the limit where the row shows a projected time. */
    readonly minutes: number | null
  }
  | { readonly kind: 'away'; readonly travel: 'rising' | 'falling' }
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'idle'; readonly mode: { readonly label: string } | null }

export interface TrendReading {
  /** Change per minute over the window, in native units; null without history enough for one. */
  readonly rate: number | null
  readonly travel: Travel | null
  readonly change: RateChange | null
  /** The most severe of its limits active now: the alarm chip beside it. */
  readonly inAlarm: ComposedDisplayThreshold | null
  readonly limit: LimitState | null
}

/**
 * How a legend row reads a numeric signal now. `points` is the recorded
 * history and the samples since, oldest first, read over `windowMs`; null for
 * a row shown live only (not recorded by the Run), which has no rate and names
 * the nearest limit.
 */
export const trendReading = (config: {
  readonly value: number
  readonly points: ReadonlyArray<TrendPoint> | null
  readonly windowMs: number
  readonly unit: string
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly mode: PlantModeNow
  readonly activeRuleIds: ReadonlySet<string>
}): TrendReading => {
  const { value, points, windowMs, unit, thresholds, mode, activeRuleIds } = config
  const rate = points === null ? null : ratePerMinute(points, windowMs)
  const inForce = limitsInForce(thresholds, mode, activeRuleIds)
  const inAlarm = activeThreshold(thresholds, activeRuleIds)
  const projectable = points !== null && projectionBasis(points, windowMs, unit)
  const reading = { rate, travel: travelOf(rate, value), change: points === null ? null : rateChange(points, windowMs, value), inAlarm }
  const back = inAlarm === null ? '' : returningText(value, rate, inAlarm, unit, projectable)
  if (back !== '') return { ...reading, limit: { kind: 'returning', text: back } }
  const margin = points === null ? nearestThresholdMargin(value, inForce) : limitAhead(value, rate, inForce)
  if (margin !== null) {
    const past = isPast(margin)
    return {
      ...reading,
      limit: {
        kind: 'margin',
        margin,
        eta: past ? '' : timeToThresholdText(value, rate, margin.threshold, projectable),
        minutes: past ? null : projectedMinutes(value, rate, margin.threshold, projectable),
      },
    }
  }
  const away = points === null ? null : movingAwayFromLimits(value, rate, inForce)
  if (away !== null) return { ...reading, limit: { kind: 'away', travel: away } }
  const limited = thresholds.some(threshold => threshold.kind !== 'control')
  if (!limited) return { ...reading, limit: { kind: 'unlimited' } }
  const idle = inForce.every(threshold => threshold.kind === 'control')
  return { ...reading, limit: idle && mode !== undefined ? { kind: 'idle', mode } : null }
}

/** A legend row's limit state in its words: "0.658 MPa above LO ALM 14.8 MPa · ≈2 min", "no LO limit ahead". */
export const limitStateText = (state: LimitState, unit: string): string => {
  if (state.kind === 'returning') return state.text
  if (state.kind === 'margin') return `${marginText(state.margin, unit)}${state.eta === '' ? '' : ` · ${state.eta}`}`
  if (state.kind === 'away') return `no ${state.travel === 'rising' ? 'HI' : 'LO'} limit ahead`
  if (state.kind === 'unlimited') return 'no I&C limit'
  return `no limit acts ${state.mode === null ? 'now' : `in ${state.mode.label}`}`
}
