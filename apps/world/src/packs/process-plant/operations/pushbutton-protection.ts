import type { ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { actionOf, firstOutGroupOf, icRuleKind } from '../displays/ic-thresholds.ts'
import { compareIcValues, type ControlRule, type OfferedControl } from './controls.ts'

// What a protective pushbutton does to the Plant's protection, read from the
// I&C config alone: it trips the reactor (a rule its press sets going acts
// in the reactor trip's first-out group), it actuates another protection
// function, or it blocks one (its press latches a memory that a protection
// rule's condition reads, in the direction that keeps the rule from acting).
// A display confirms each by a slide and orders them so: trips first, then
// actuations, then blocks (actuate before defeat). Where a permissive or an
// interlock gates the press, the button carries it and whether it allows the
// press now; a block says whether it stands now.

export type PushbuttonRole = 'trip' | 'actuation' | 'block'

export interface PushbuttonProtection {
  readonly role: PushbuttonRole
  /** A block: the protection rules its press keeps from acting, and whether the block stands now. */
  readonly blocks?: { readonly rules: ReadonlyArray<ControlRule>; readonly blocked: boolean }
  /** The permissive or interlock that gates the press, in its declared words, and whether it allows the press now. */
  readonly gate?: { readonly ruleId: string; readonly kind: 'permissive' | 'interlock'; readonly label: string; readonly allows: boolean; readonly message?: string }
}

type Leaf = { readonly leaf: Extract<ProcessPlantIcCondition, { type: 'comparison' }>; readonly positive: boolean }

const leavesOf = (condition: ProcessPlantIcCondition, positive = true): ReadonlyArray<Leaf> =>
  condition.type === 'comparison' ? [{ leaf: condition, positive }]
    : condition.type === 'not' ? leavesOf(condition.condition, !positive)
      : condition.conditions.flatMap(child => leavesOf(child, positive))

/** The leaves of a trip rule's condition that a value of a variable leaves false as they sit: what keeps the rule from acting. */
const defeatedBy = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, path: VariablePath, value: ProcessVariableValue): ReadonlyArray<Leaf> =>
  leavesOf(rule.condition).filter(({ leaf, positive }) =>
    resolveProcessPlantSignalBinding(plant.graph, leaf.signal).path === path && compareIcValues(value, leaf.operator, leaf.value) !== positive)

const ruleRef = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): ControlRule => ({ ruleId: rule.id, label: rule.label ?? rule.id, action: actionOf(plant, rule) })

/**
 * What a pushbutton does to the Plant's protection, and where its block and
 * its gate stand: `read` reads a variable now, `holds` evaluates an I&C
 * condition now. Undefined for any other control, and for a pushbutton that
 * neither sets protection going nor blocks it.
 */
export const pushbuttonProtection = (
  plant: CompiledProcessPlant,
  control: OfferedControl,
  now: { readonly read: (path: VariablePath) => ProcessVariableValue | undefined; readonly holds: (condition: ProcessPlantIcCondition) => boolean },
): PushbuttonProtection | undefined => {
  if (control.form !== 'pushbutton') return undefined
  const rules = plant.automation.rules.filter(rule => rule.enabled)
  const ruleOf = (id: string): ProcessPlantIcRule | undefined => rules.find(rule => rule.id === id)
  const consequences = control.options.flatMap(option => option.consequences)
  const trips = consequences.some(entry => {
    const rule = ruleOf(entry.ruleId)
    return rule !== undefined && firstOutGroupOf(plant, rule)?.reactorTrip === true
  })
  // A block: a memory the press latches keeps a protection rule from acting while it reads so.
  const latched = control.options.flatMap(option => option.moves.filter(move => move.path !== control.path && move.value !== 'unknown'))
  const blocked = rules.filter(rule => icRuleKind(rule) === 'trip').flatMap(rule => {
    const leaves = latched.flatMap(move => defeatedBy(plant, rule, move.path, move.value as ProcessVariableValue).map(entry => ({ ...entry, path: move.path })))
    return leaves.length === 0 ? [] : [{ rule, leaves }]
  })
  const role: PushbuttonRole | undefined = trips ? 'trip' : consequences.length > 0 ? 'actuation' : blocked.length > 0 ? 'block' : undefined
  if (role === undefined) return undefined
  const gateRule = rules.find(rule => (rule.ruleClass === 'permissive' || rule.ruleClass === 'interlock')
    && rule.commandGates.some(gate => resolveProcessPlantSignalBinding(plant.graph, gate.signal).path === control.path))
  const gate = gateRule === undefined ? undefined : (() => {
    const matches = now.holds(gateRule.condition)
    const message = gateRule.commandGates.find(entry => resolveProcessPlantSignalBinding(plant.graph, entry.signal).path === control.path)?.message
    return {
      ruleId: gateRule.id,
      kind: gateRule.ruleClass === 'permissive' ? 'permissive' as const : 'interlock' as const,
      label: gateRule.label ?? gateRule.id,
      allows: gateRule.ruleClass === 'permissive' ? matches : !matches,
      ...(message === undefined ? {} : { message }),
    }
  })()
  return {
    role,
    ...(role === 'block'
      ? {
        blocks: {
          rules: blocked.map(entry => ruleRef(plant, entry.rule)),
          // It stands while every memory it latched reads what keeps its rules from acting.
          blocked: blocked.every(entry => entry.leaves.every(({ leaf, positive, path }) => {
            const value = now.read(path)
            return value !== undefined && compareIcValues(value, leaf.operator, leaf.value) !== positive
          })),
        },
      }
      : {}),
    ...(gate === undefined ? {} : { gate }),
  }
}

/** Where a control stands in its item's list: trips first, then actuations, then whatever else it offers, blocks last. */
export const protectionRank = (protection: PushbuttonProtection | undefined): number =>
  protection === undefined ? 2 : protection.role === 'trip' ? 0 : protection.role === 'actuation' ? 1 : 3
