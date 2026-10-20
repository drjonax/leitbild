import type { AlertSeverity, Priority } from '../../../core/model/index.ts'
import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type {
  ProcessPlantIcAnnunciatorPriority,
  ProcessPlantIcFirstOutGroup,
  ProcessPlantIcLifecycleState,
  ProcessPlantIcRule,
  ProcessPlantIcSeverity,
  ProcessPlantIcSnapshot,
} from '../runtime/index.ts'
import { conditionBindings } from './actuations.ts'
import { icThresholdsForSignal, NAMED_DELAY_MIN_MS } from './thresholds.ts'

// The Plant's alarm philosophy in World's terms, in one place: the priority
// an alarm or trip has (its limit tick, the value it colours and its alert in
// the core slot all read it, so they agree), which alarms come in as the
// expected consequence of a first-out, which rule is counting down to act,
// and when an acknowledged alarm becomes a standing one.

/** The coarse alert severity: a notice is information. */
export const plantAlertSeverity = (severity: ProcessPlantIcSeverity): AlertSeverity =>
  severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info'

/**
 * The priority, agreeing with the severity (core/model/alerts.ts): a critical
 * alarm or trip is an alarm, never an emergency; a warning is a warning where
 * its annunciator is urgent or high, else a caution; information is a notice.
 */
export const plantAlarmPriority = (severity: ProcessPlantIcSeverity, annunciator: ProcessPlantIcAnnunciatorPriority | undefined): Exclude<Priority, 'none'> => {
  if (severity === 'critical') return 'alarm'
  if (severity === 'warning') return annunciator === 'urgent' || annunciator === 'high' ? 'warning' : 'caution'
  return 'notice'
}

export const priorityOrder: Readonly<Record<Priority, number>> = { none: 0, notice: 1, caution: 2, warning: 3, alarm: 4, emergency: 5 }

/** The alarms and trips that annunciate now: active, and neither shelved, suppressed nor out of service. */
export const annunciating = (snapshot: ProcessPlantIcSnapshot): ReadonlyArray<ProcessPlantIcLifecycleState> =>
  [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active && !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService)

/**
 * The first-out group an alarm came in as the expected consequence of, or
 * null (panel-presenters.ts expectedAfter, the same rule): its annunciator
 * declares it expected after that group's actuation; it is not first out
 * itself; it came in after the group's first-out, or with it on other
 * equipment, within the declared time.
 */
export const expectedAfterGroup = (
  plant: CompiledProcessPlant,
  lifecycle: ProcessPlantIcLifecycleState,
  all: ReadonlyArray<ProcessPlantIcLifecycleState>,
): ProcessPlantIcFirstOutGroup | null => {
  const expected = lifecycle.annunciator?.expectedAfter
  if (expected === undefined || lifecycle.firstOut || lifecycle.firstActiveElapsedMs === undefined) return null
  const trigger = all.find(candidate => candidate.firstOut && candidate.annunciator?.firstOutGroup === expected.firstOutGroup && candidate.firstActiveElapsedMs !== undefined)
  if (trigger === undefined) return null
  const lag = lifecycle.firstActiveElapsedMs - trigger.firstActiveElapsedMs!
  const own = lifecycle.annunciator?.equipmentId !== undefined && lifecycle.annunciator.equipmentId === trigger.annunciator?.equipmentId
  return (lag > 0 || (lag === 0 && !own)) && lag <= expected.withinMs ? plant.automation.firstOutGroups.find(group => group.id === expected.firstOutGroup) ?? null : null
}

const watchedByRule = new WeakMap<CompiledProcessPlant['automation'], ReadonlyMap<string, ReadonlyArray<VariablePath>>>()

/** The signals each rule's condition watches. */
export const ruleWatches = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): ReadonlyArray<VariablePath> => {
  const known = watchedByRule.get(plant.automation) ?? new Map(plant.automation.rules.map(each => [each.id, [...new Set(conditionBindings(plant, each.condition).map(binding => binding.path))]]))
  watchedByRule.set(plant.automation, known)
  return known.get(rule.id)!
}

const limitedByRule = new WeakMap<CompiledProcessPlant['automation'], Map<string, ReadonlyArray<VariablePath>>>()

/**
 * The published signals a rule sets a limit on (ic/thresholds.ts, the limits
 * every display draws): what its alarm or trip colours, and names in the
 * alert slot. A gate, a permissive or a state the rule only reads is none.
 */
export const ruleLimits = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): ReadonlyArray<VariablePath> => {
  const known = limitedByRule.get(plant.automation) ?? new Map<string, ReadonlyArray<VariablePath>>()
  limitedByRule.set(plant.automation, known)
  const limits = known.get(rule.id) ?? ruleWatches(plant, rule).filter(path => plant.graph.signalBindingByPath.get(path)?.published === true
    && icThresholdsForSignal(plant, path).thresholds.some(threshold => threshold.ruleId === rule.id))
  known.set(rule.id, limits)
  return limits
}

/**
 * The value an annunciating alarm or trip colours, by the one rule the read
 * and the alert slot share: its rule's condition holds now (a latched trip
 * whose condition has cleared colours nothing; a stop valve shut after its
 * trip reads neutral) and the value is past that rule's limit on it.
 */
export const colours = (
  snapshot: ProcessPlantIcSnapshot,
  lifecycle: ProcessPlantIcLifecycleState,
  limits: ReadonlyArray<{ readonly direction: 'low' | 'high'; readonly value: number }>,
  reading: number | null,
): boolean => reading !== null && snapshot.rules.find(state => state.ruleId === lifecycle.ruleId)?.activeSinceElapsedMs !== undefined
  && limits.some(limit => (limit.direction === 'low' ? reading < limit.value : reading > limit.value))

/** The rules whose condition holds and whose named delay (an hour-scale wait, never a confirming second) is running down: their limit and plant milliseconds left. */
export const pendingActions = (plant: CompiledProcessPlant, snapshot: ProcessPlantIcSnapshot, elapsedMs: number): ReadonlyArray<{ readonly rule: ProcessPlantIcRule; readonly leftMs: number }> => {
  const states = new Map(snapshot.rules.map(state => [state.ruleId, state]))
  return plant.automation.rules.flatMap(rule => {
    const state = states.get(rule.id)
    if (!rule.enabled || rule.delayMs < NAMED_DELAY_MIN_MS || state === undefined || state.active || state.activeSinceElapsedMs === undefined) return []
    return [{ rule, leftMs: Math.max(0, state.activeSinceElapsedMs + rule.delayMs - elapsedMs) }]
  })
}

/**
 * How long an acknowledged alarm stands unchanged before it is standing (R27):
 * ten plant minutes is past every transient the reference I&C answers (its
 * automatic actions and the expected consequences of a trip come in within
 * five minutes, expectedAfterReactorTrip), so what still stands then is a
 * known condition the operators live with, not news.
 */
export const STANDING_AFTER_MS = 10 * 60_000

/**
 * Whether an annunciating alarm is standing (R27): an alarm, never a trip, a
 * first-out or an emergency; acknowledged; standing past STANDING_AFTER_MS
 * since it came in; with no consequence pending on what it watches (a named
 * delay running down) and nothing worse come in on the same equipment since
 * its acknowledgement. Any change reverts it.
 */
export const isStanding = (
  plant: CompiledProcessPlant,
  lifecycle: ProcessPlantIcLifecycleState,
  context: { readonly all: ReadonlyArray<ProcessPlantIcLifecycleState>; readonly pending: ReturnType<typeof pendingActions>; readonly elapsedMs: number; readonly priority: Priority },
): boolean => {
  if (lifecycle.kind !== 'alarm' || lifecycle.firstOut || context.priority === 'emergency' || !lifecycle.acknowledged) return false
  if (lifecycle.lastActiveElapsedMs === undefined || context.elapsedMs - lifecycle.lastActiveElapsedMs < STANDING_AFTER_MS) return false
  const rule = plant.automation.rules.find(candidate => candidate.id === lifecycle.ruleId)!
  const watches = new Set(ruleWatches(plant, rule))
  if (context.pending.some(pending => ruleWatches(plant, pending.rule).some(path => watches.has(path)))) return false
  const equipment = lifecycle.annunciator?.equipmentId
  const acknowledgedAt = lifecycle.lastAcknowledgedElapsedMs ?? lifecycle.lastActiveElapsedMs
  return equipment === undefined || !context.all.some(other => other.id !== lifecycle.id && other.annunciator?.equipmentId === equipment
    && other.lastActiveElapsedMs !== undefined && other.lastActiveElapsedMs > acknowledgedAt)
}
