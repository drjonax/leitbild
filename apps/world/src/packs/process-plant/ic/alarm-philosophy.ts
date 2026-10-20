import type { Priority } from '../../../core/model/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type {
  ProcessPlantIcAnnunciatorPriority,
  ProcessPlantIcFirstOutGroup,
  ProcessPlantIcLifecycleState,
  ProcessPlantIcRule,
  ProcessPlantIcSeverity,
  ProcessPlantIcSnapshot,
} from '../runtime/index.ts'
import { NAMED_DELAY_MIN_MS } from './thresholds.ts'

// The Plant's alarm philosophy in World's terms, in one place: the priority
// an alarm or trip has (its limit tick and the value it colours both read it,
// so they agree), which alarms come in as the expected consequence of a
// first-out, and which rule is counting down to act.

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

/** The rules whose condition holds and whose named delay (an hour-scale wait, never a confirming second) is running down: their limit and plant milliseconds left. */
export const pendingActions = (plant: CompiledProcessPlant, snapshot: ProcessPlantIcSnapshot, elapsedMs: number): ReadonlyArray<{ readonly rule: ProcessPlantIcRule; readonly leftMs: number }> => {
  const states = new Map(snapshot.rules.map(state => [state.ruleId, state]))
  return plant.automation.rules.flatMap(rule => {
    const state = states.get(rule.id)
    if (!rule.enabled || rule.delayMs < NAMED_DELAY_MIN_MS || state === undefined || state.active || state.activeSinceElapsedMs === undefined) return []
    return [{ rule, leftMs: Math.max(0, state.activeSinceElapsedMs + rule.delayMs - elapsedMs) }]
  })
}
