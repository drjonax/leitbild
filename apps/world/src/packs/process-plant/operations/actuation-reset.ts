import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule, ProcessPlantIcSnapshot } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { actionOf, conditionText, icRuleKind } from '../displays/ic-thresholds.ts'
import { ruleStatesFrom } from './control-standing.ts'

// A person resets a latched protection actuation (C2b R1): every one that
// stands sealed in is listed with a RESET, offered once its initiating
// condition no longer holds and the least time its rule declares after it
// acted has passed (the SI reset timer). A reset clears the latch and
// nothing else: the equipment stays as the actuation left it, and is the
// operators' again, the QA-2 hold on what it wrote lifted. A person executes
// it; an AI agent proposes it for a person to approve. Nothing here names a
// Plant, an actuation or a signal: the rules' own declarations decide.

export interface ActuationReset {
  readonly ruleId: string
  /** The actuation as the I&C config labels it. */
  readonly label: string
  /** What it does, as displays name it ("SI", "AFW START", "RX TRIP"). */
  readonly action: string
  /** What the control says: "RESET <label>". */
  readonly word: string
  /** Plant time it acted at. */
  readonly actedAtElapsedMs: number
  readonly offered: boolean
  /** Why it is not offered now: its condition still present, or its reset time still to run. */
  readonly reason?: string
  /** The commands and isolation inputs its effects wrote: the QA-2 hold on them lifts with the reset. */
  readonly holds: ReadonlyArray<VariablePath>
}

/** The Plant now, as a reset is judged against it. */
export interface ResetContext {
  /** Whether a condition holds now (evaluateProcessPlantIcCondition). */
  readonly holds: (condition: ProcessPlantIcCondition) => boolean
  readonly elapsedMs: number
}

const resetWord = (rule: ProcessPlantIcRule): string => `RESET ${rule.label ?? rule.id}`

/** A latched protection actuation: what a person may be offered to reset. */
const resettableKind = (rule: ProcessPlantIcRule): boolean => rule.enabled && rule.ruleClass === 'protection' && rule.latch && icRuleKind(rule) === 'trip'

/**
 * Every latched protection actuation that stands sealed in now, with its
 * RESET and whether it is offered, in the order the I&C config declares
 * them.
 */
export const actuationResets = (plant: CompiledProcessPlant, snapshot: ProcessPlantIcSnapshot, context: ResetContext): ReadonlyArray<ActuationReset> => {
  const states = ruleStatesFrom(snapshot)
  return plant.automation.rules.flatMap((rule): ReadonlyArray<ActuationReset> => {
    const state = states.get(rule.id)
    if (!resettableKind(rule) || state === undefined || !state.latched) return []
    if (state.actedAtElapsedMs === undefined) throw new Error(`I&C rule ${rule.id} stands sealed in without the time it acted`)
    const why = (() => {
      if (context.holds(rule.condition)) {
        const words = conditionText(plant, rule.condition)
        return `condition still present${words === null ? '' : `: ${words}`}`
      }
      const remainingMs = rule.resetAfterMs === undefined ? 0 : state.actedAtElapsedMs + rule.resetAfterMs - context.elapsedMs
      return remainingMs > 0 ? `it may be reset ${rule.resetAfterMs! / 1_000} s after it acted: ${Math.ceil(remainingMs / 1_000)} s to go` : null
    })()
    const holds = [...new Set(rule.effects.flatMap(effect => effect.type === 'writeSignal' ? [resolveProcessPlantSignalBinding(plant.graph, effect.signal).path] : []))]
    return [{
      ruleId: rule.id,
      label: rule.label ?? rule.id,
      action: actionOf(plant, rule),
      word: resetWord(rule),
      actedAtElapsedMs: state.actedAtElapsedMs,
      offered: why === null,
      ...(why === null ? {} : { reason: why }),
      holds,
    }]
  })
}

/** Why a reset of this rule is refused now; null where it is offered. */
export const resetRefusal = (plant: CompiledProcessPlant, snapshot: ProcessPlantIcSnapshot, ruleId: string, context: ResetContext): string | null => {
  const rule = plant.automation.rules.find(candidate => candidate.id === ruleId)
  if (rule === undefined) return `${ruleId} is no I&C rule of this Plant`
  if (!resettableKind(rule)) return `${rule.label ?? rule.id} is no latched protection actuation: it has nothing to reset`
  const reset = actuationResets(plant, snapshot, context).find(candidate => candidate.ruleId === ruleId)
  if (reset === undefined) return `${rule.label ?? rule.id} does not stand sealed in: it has nothing to reset`
  return reset.offered ? null : `${reset.word} is not offered: ${reset.reason}`
}

/** What the hold sentence adds about the actuation's reset: offered, or why not yet. */
export const resetClause = (reset: ActuationReset | undefined): string =>
  reset === undefined ? '' : reset.offered ? `; ${reset.word} is offered` : `; it cannot be reset yet: ${reset.reason}`

/**
 * Holds a declared reset time to what it can mean: only a latched
 * protection actuation is reset by a person.
 */
export const assertResetTimesValid = (rules: ReadonlyArray<ProcessPlantIcRule>): void => {
  for (const rule of rules) {
    if (rule.resetAfterMs !== undefined && !resettableKind(rule)) throw new Error(`I&C rule ${rule.id} declares a reset time but is no latched protection actuation`)
  }
}
