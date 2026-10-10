// Pure derivations for composed-display panels. Thresholds come from World;
// these functions only relate them to the latest sampled values.
import { displayValue, formatValue, marginTextForms, thresholdName, unitLabel, type ThresholdMargin } from '../../../packs/process-plant/displays/display-text.ts'
import type { ComposedDisplayThreshold } from '../../../packs/process-plant/displays/ic-thresholds.ts'
import type { ComposedDisplayAlarm, ComposedDisplaySample } from './composed-display-client.ts'
import type { TrendPoint } from './trend-geometry.ts'

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
  const label = unitLabel(unit)
  return `${rate > 0 ? '▲ +' : '▼ −'}${formatValue(displayValue(Math.abs(rate), unit))}${label === '' ? '' : ` ${label}`}/min${window}${change}`
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

/**
 * "≈45 s" or "≈4 min" to the threshold at the current rate; where the
 * tendency gives no basis for a time (projectionBasis), "approaching, not
 * projected" instead; empty when not approaching it within half an hour.
 */
export const timeToThresholdText = (value: number, rate: number | null, threshold: ComposedDisplayThreshold, projectable: boolean): string => {
  const minutes = minutesToThreshold(value, rate, threshold)
  if (minutes === null || minutes > 30) return ''
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

/** The fullest wording of a margin that fits its room (marginTextForms); the shortest where none does. */
export const fitMarginText = (margin: ThresholdMargin, unit: string, fits: (text: string) => boolean): string => {
  const forms = marginTextForms(margin, unit)
  return forms.find(fits) ?? forms.at(-1)!
}

/** Whether the value moves away from every limit it has not passed ("no HI limit ahead"). */
export const movingAwayFromLimits = (value: number, rate: number | null, thresholds: ReadonlyArray<ComposedDisplayThreshold>): 'rising' | 'falling' | null => {
  if (rate === null || isSteady(rate, value) || thresholds.every(threshold => threshold.kind === 'control')) return null
  return limitAhead(value, rate, thresholds) === null ? (rate > 0 ? 'rising' : 'falling') : null
}

export const agoText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

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
  mode: ComposedDisplaySample['mode'],
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

export const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const

/** The OpenBridge alert type each severity is drawn as, everywhere an alarm shows: list, tiles and drawing. */
export const alertTypeOf = (severity: ComposedDisplayAlarm['severity']): 'alarm' | 'warning' | 'caution' =>
  severity === 'critical' ? 'alarm' : severity === 'warning' ? 'warning' : 'caution'

/**
 * Alarms in reading order: the first-out alarm, then by severity so trips are
 * never hidden behind warnings, then by onset. "related" keeps only the rules
 * acting on the display.
 */
export const visibleAlarms = (
  alarms: ReadonlyArray<ComposedDisplayAlarm>,
  scope: 'related' | 'plant',
  ruleIds: ReadonlyArray<string>,
): ReadonlyArray<ComposedDisplayAlarm> => {
  const related = new Set(ruleIds)
  return alarms
    .filter(alarm => scope === 'plant' || related.has(alarm.ruleId))
    .sort((left, right) =>
      Number(right.firstOut) - Number(left.firstOut)
      || Number(right.kind === 'trip') - Number(left.kind === 'trip')
      || severityRank[left.severity] - severityRank[right.severity]
      || Number(right.active) - Number(left.active)
      || (left.firstActiveElapsedMs ?? Number.POSITIVE_INFINITY) - (right.firstActiveElapsedMs ?? Number.POSITIVE_INFINITY)
      || left.title.localeCompare(right.title))
}

/** Age as m:ss under an hour, otherwise h:mm, so onset order is readable at a glance. */
export const alarmAge = (plantElapsedMs: number, firstActiveElapsedMs: number | undefined): string => {
  if (firstActiveElapsedMs === undefined) return ''
  const seconds = Math.max(0, Math.round((plantElapsedMs - firstActiveElapsedMs) / 1000))
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`
}

export interface AnnunciatorState {
  readonly id: string
  readonly name: string
  readonly active: number
  readonly unacknowledged: number
  /** The most severe active alarm's severity; null while the system is quiet. */
  readonly severity: ComposedDisplayAlarm['severity'] | null
  readonly trip: boolean
  readonly firstOut: boolean
}

/** Each annunciator system's share of the active alarms, in the order the model declares the systems. */
export const annunciatorStates = (
  systems: ReadonlyArray<{ readonly id: string; readonly name: string; readonly ruleIds: ReadonlyArray<string> }>,
  alarms: ReadonlyArray<ComposedDisplayAlarm>,
): ReadonlyArray<AnnunciatorState> => systems.map(system => {
  const rules = new Set(system.ruleIds)
  const active = alarms.filter(alarm => alarm.active && rules.has(alarm.ruleId))
  const worst = [...active].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0]
  return {
    id: system.id,
    name: system.name,
    active: active.length,
    unacknowledged: active.filter(alarm => !alarm.acknowledged).length,
    severity: worst?.severity ?? null,
    trip: active.some(alarm => alarm.kind === 'trip'),
    firstOut: active.some(alarm => alarm.firstOut),
  }
})
