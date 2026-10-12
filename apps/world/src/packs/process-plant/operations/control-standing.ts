import type { ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule, ProcessPlantIcSnapshot } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { actsIn } from '../displays/actuations.ts'
import { icRuleKind } from '../displays/ic-thresholds.ts'
import { compareIcValues, type ControlOption, type ControlRule, type OfferedControl, type OpposingRule } from './controls.ts'

// Where the rules a control names stand now, in the words an operator acts
// on: a rule that has not acted is armed, and acts if its condition comes to
// hold; one that acted stands active or sealed in, and acts again only after
// it clears and re-enters, so it will not restart what a person stops (the
// I&C writes its effects once, on entering: control-protection.ts). A
// protection actuation that stands and writes the opposite holds the
// equipment: a command against it is refused while it stands (plan QA-2).

/** A rule's state as the I&C snapshot holds it, with when it acted. */
export interface RuleStateView {
  readonly active: boolean
  readonly latched: boolean
  /** When it last entered active, while it stands active or sealed in. */
  readonly actedAtElapsedMs?: number
}

export type RuleStanding =
  | { readonly state: 'armed' }
  | { readonly state: 'acted'; readonly atElapsedMs: number; readonly sealedIn: boolean }

export interface StandingContext {
  readonly read: (path: VariablePath) => ProcessVariableValue
  /** The operating mode the Plant is in (processPlantOperatingMode); null where it declares none. */
  readonly mode: string | null
  readonly rules: ReadonlyMap<string, RuleStateView>
}

export interface OptionStanding {
  /** Consequences that can act: armed, as this option would set them going now, or acted already. */
  readonly consequences: ReadonlyArray<ControlRule & RuleStanding>
  /** Automation writing the opposite: armed while it may act, or acted. */
  readonly opposing: ReadonlyArray<OpposingRule & RuleStanding>
  /** The protection actuation that stands active or sealed in against this option: the command is refused while it stands. */
  readonly heldBy?: OpposingRule & { readonly atElapsedMs: number }
  /** The equipment's isolation input stands, so it stays shut whatever this option demands. */
  readonly isolated: boolean
}

/**
 * Each rule's state from the I&C snapshot, with when it acted: the time it
 * entered active while it stands, else the last time one of its alarms or
 * trips came in while it is sealed in.
 */
export const ruleStatesFrom = (snapshot: ProcessPlantIcSnapshot): ReadonlyMap<string, RuleStateView> => {
  const lastIn = new Map<string, number>()
  for (const lifecycle of [...snapshot.alarms, ...snapshot.trips]) {
    if (lifecycle.lastActiveElapsedMs === undefined) continue
    lastIn.set(lifecycle.ruleId, Math.max(lastIn.get(lifecycle.ruleId) ?? 0, lifecycle.lastActiveElapsedMs))
  }
  return new Map(snapshot.rules.map(rule => {
    const actedAt = rule.active ? rule.lastTransitionElapsedMs : rule.latched ? lastIn.get(rule.ruleId) : undefined
    return [rule.ruleId, { active: rule.active, latched: rule.latched, ...(actedAt === undefined ? {} : { actedAtElapsedMs: actedAt }) }]
  }))
}

// Whether a condition holds once the option's moves are made: a move whose
// value the model does not declare (a speed once started) counts as going
// the way that lets the condition hold.
const holdsWith = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, read: StandingContext['read'], moves: ReadonlyMap<VariablePath, ProcessVariableValue | 'unknown'>, positive = true): boolean => {
  if (condition.type === 'comparison') {
    const path = resolveProcessPlantSignalBinding(plant.graph, condition.signal).path
    const moved = moves.get(path)
    if (moved === 'unknown') return positive
    return compareIcValues(moved ?? read(path), condition.operator, condition.value)
  }
  if (condition.type === 'not') return !holdsWith(plant, condition.condition, read, moves, !positive)
  const results = condition.conditions.map(child => holdsWith(plant, child, read, moves, positive))
  if (condition.type === 'all') return results.every(Boolean)
  if (condition.type === 'any') return results.some(Boolean)
  return results.filter(Boolean).length >= condition.required
}

const ruleById = (plant: CompiledProcessPlant): ReadonlyMap<string, ProcessPlantIcRule> => new Map(plant.automation.rules.map(rule => [rule.id, rule]))

const acted = (rule: ProcessPlantIcRule, state: RuleStateView | undefined): RuleStanding | null => {
  if (state === undefined || !(state.active || (rule.latch && state.latched))) return null
  if (state.actedAtElapsedMs === undefined) throw new Error(`I&C rule ${rule.id} stands without the time it acted`)
  return { state: 'acted', atElapsedMs: state.actedAtElapsedMs, sealedIn: !state.active }
}

/** Where an offered option's consequences and opposing automation stand now. */
export const optionStanding = (plant: CompiledProcessPlant, control: OfferedControl, option: ControlOption, context: StandingContext): OptionStanding => {
  const rules = ruleById(plant)
  const moves = new Map(option.moves.map(move => [move.path, move.value]))
  const consequences = option.consequences.flatMap(reference => {
    const rule = rules.get(reference.ruleId)!
    const standing = acted(rule, context.rules.get(rule.id))
    if (standing !== null) return [{ ...reference, ...standing }]
    return actsIn(rule, context.mode) && holdsWith(plant, rule.condition, context.read, moves) ? [{ ...reference, state: 'armed' as const }] : []
  })
  const opposing = option.opposing.flatMap(reference => {
    const rule = rules.get(reference.ruleId)!
    const standing = acted(rule, context.rules.get(rule.id))
    if (standing !== null) return [{ ...reference, ...standing }]
    return actsIn(rule, context.mode) ? [{ ...reference, state: 'armed' as const }] : []
  })
  const holding = opposing.find((entry): entry is OpposingRule & Extract<RuleStanding, { state: 'acted' }> =>
    entry.state === 'acted' && rules.get(entry.ruleId)!.ruleClass === 'protection' && icRuleKind(rules.get(entry.ruleId)!) === 'trip')
  return {
    consequences,
    opposing,
    ...(holding === undefined ? {} : { heldBy: { ruleId: holding.ruleId, label: holding.label, action: holding.action, value: holding.value, via: holding.via, atElapsedMs: holding.atElapsedMs } }),
    isolated: control.isolation !== undefined && context.read(control.isolation) === true,
  }
}
