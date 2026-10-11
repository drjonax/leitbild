import type { CompiledPlantGraph } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { findProcessPlantSignalBinding, resolveProcessPlantSignalBinding } from '../../signals.ts'
import type { ProcessPlantSignalReference } from '../../signals.ts'
import { assertProcessPlantVariableValueValid } from '../variable-validation.ts'
import type {
  ProcessPlantIcCondition,
  ProcessPlantIcEffect,
  ProcessPlantIcOperatingMode,
  ProcessPlantIcRule,
  ProcessPlantIcSafetyFunction,
  ProcessPlantIcSafetyFunctionCondition,
  ProcessPlantIcStatusTreeNode,
} from './control-protection-model.ts'

/** `owner` names what holds the condition in messages: "rule pzr-high", "operating mode power-operation". */
const assertConditionSignalsValid = (
  graph: CompiledPlantGraph,
  owner: string,
  condition: ProcessPlantIcCondition,
): void => {
  if (condition.type === 'comparison') {
    const binding = resolveProcessPlantSignalBinding(graph, condition.signal)
    const signalType = binding.quantity === 'boolean' ? 'boolean' : 'number'
    const valueType = typeof condition.value
    if (condition.operator !== '==' && condition.operator !== '!=' && signalType !== 'number') {
      throw new Error(`process plant I&C ${owner} uses numeric operator ${condition.operator} with non-numeric signal ${binding.path}`)
    }
    if (signalType !== valueType) {
      throw new Error(`process plant I&C ${owner} compares signal ${binding.path} ${signalType} value with ${valueType} threshold`)
    }
    return
  }
  if (condition.type === 'not') {
    assertConditionSignalsValid(graph, owner, condition.condition)
    return
  }
  for (const child of condition.conditions) {
    assertConditionSignalsValid(graph, owner, child)
  }
}

/** Each operating mode's condition reads signals of the Plant, compared by their type. */
export const assertProcessPlantIcOperatingModesValid = (
  graph: CompiledPlantGraph,
  modes: ReadonlyArray<ProcessPlantIcOperatingMode>,
): void => {
  for (const mode of modes) assertConditionSignalsValid(graph, `operating mode ${mode.id}`, mode.condition)
}

/**
 * Each critical safety function compares the signals it reads by their type:
 * a total or difference of numbers, an on/off state only for (in)equality. A
 * signal the Plant does not publish is left to its evaluation, which reads
 * the branch as unknown.
 */
export const assertProcessPlantIcSafetyFunctionsValid = (
  graph: CompiledPlantGraph,
  safetyFunctions: ReadonlyArray<ProcessPlantIcSafetyFunction>,
): void => {
  const numeric = (owner: string, reference: ProcessPlantSignalReference): void => {
    const binding = findProcessPlantSignalBinding(graph, reference)
    if (binding !== undefined && binding.quantity === 'boolean') throw new Error(`process plant I&C ${owner} adds or subtracts on/off signal ${binding.path}`)
  }
  const check = (owner: string, condition: ProcessPlantIcSafetyFunctionCondition): void => {
    if (condition.type === 'all' || condition.type === 'any') {
      for (const child of condition.conditions) check(owner, child)
      return
    }
    if (condition.type === 'total') {
      for (const signal of condition.signals) numeric(owner, signal)
      return
    }
    if (condition.type === 'difference') {
      numeric(owner, condition.signal)
      numeric(owner, condition.minus)
      return
    }
    if (findProcessPlantSignalBinding(graph, condition.signal) !== undefined) assertConditionSignalsValid(graph, owner, condition)
  }
  const nodes = (owner: string, node: ProcessPlantIcStatusTreeNode): void => {
    if (!('question' in node)) return
    check(owner, node.condition)
    nodes(owner, node.yes)
    nodes(owner, node.no)
  }
  for (const safetyFunction of safetyFunctions) {
    const owner = `safety function ${safetyFunction.id}`
    if (safetyFunction.monitored !== undefined) check(owner, safetyFunction.monitored.when)
    nodes(owner, safetyFunction.tree)
    for (const item of safetyFunction.checks) {
      if (item.when !== undefined) check(owner, item.when)
      check(owner, item.condition)
    }
    for (const expectation of safetyFunction.expectations) check(owner, expectation.when)
  }
}

const variableFor = (
  system: CompiledProcessPlant,
  reference: ProcessPlantSignalReference,
) => {
  const binding = resolveProcessPlantSignalBinding(system.graph, reference)
  const variable = system.graph.variables.find(candidate => candidate.path === binding.path)
  if (!variable) throw new Error(`process plant signal binding references unknown variable path: ${binding.path}`)
  return { binding, variable }
}

const assertWriteEffectValid = (
  system: CompiledProcessPlant,
  rule: ProcessPlantIcRule,
  effect: Extract<ProcessPlantIcEffect, { readonly type: 'writeSignal' }>,
): void => {
  const { binding, variable } = variableFor(system, effect.signal)
  if (!binding.writable) throw new Error(`process plant I&C rule ${rule.id} writes non-writable signal ${binding.path}`)
  try {
    assertProcessPlantVariableValueValid(variable, effect.value)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`process plant I&C rule ${rule.id} writes invalid value for ${binding.path}: ${message}`)
  }
}

const assertRuleShapeValid = (rule: ProcessPlantIcRule): void => {
  const effectTypes = new Set(rule.effects.map(effect => effect.type))
  const hasGates = rule.commandGates.length > 0
  if (rule.ruleClass === 'alarm') {
    if (hasGates) throw new Error(`process plant I&C alarm rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type !== 'alarm.enter')) {
      throw new Error(`process plant I&C alarm rule ${rule.id} must only define alarm.enter effects`)
    }
    return
  }
  if (rule.ruleClass === 'normalControl') {
    if (hasGates) throw new Error(`process plant I&C normalControl rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type !== 'writeSignal')) {
      throw new Error(`process plant I&C normalControl rule ${rule.id} must only define writeSignal effects`)
    }
    return
  }
  if (rule.ruleClass === 'protection') {
    if (hasGates) throw new Error(`process plant I&C protection rule ${rule.id} cannot define command gates`)
    if (rule.effects.length === 0 || [...effectTypes].some(type => type === 'alarm.enter')) {
      throw new Error(`process plant I&C protection rule ${rule.id} must define trip.enter and/or writeSignal effects`)
    }
    return
  }
  if (!hasGates) throw new Error(`process plant I&C ${rule.ruleClass} rule ${rule.id} must define command gates`)
  if (rule.effects.length > 0) throw new Error(`process plant I&C ${rule.ruleClass} rule ${rule.id} cannot define effects`)
}

/** An alarm or trip names the equipment it concerns by a component of the Plant, so readers can find it. */
export const assertProcessPlantIcAnnunciatorEquipmentValid = (
  graph: CompiledPlantGraph,
  rules: ReadonlyArray<ProcessPlantIcRule>,
): void => {
  for (const rule of rules) {
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') continue
      const equipmentId = effect.annunciator?.equipmentId
      if (equipmentId === undefined || graph.componentIndexById.has(equipmentId as never)) continue
      throw new Error(`process plant I&C rule ${rule.id} annunciates ${effect.id} on equipment ${equipmentId}, which is not a component of the Plant`)
    }
  }
}

export const assertProcessPlantIcRulesValid = (
  system: CompiledProcessPlant,
  rules: ReadonlyArray<ProcessPlantIcRule>,
): void => {
  assertProcessPlantIcAnnunciatorEquipmentValid(system.graph, rules)
  for (const rule of rules) {
    assertRuleShapeValid(rule)
    assertConditionSignalsValid(system.graph, `rule ${rule.id}`, rule.condition)
    if (rule.clearCondition !== undefined) assertConditionSignalsValid(system.graph, `rule ${rule.id}`, rule.clearCondition)
    if (rule.resetCondition !== undefined) assertConditionSignalsValid(system.graph, `rule ${rule.id}`, rule.resetCondition)
    for (const gate of rule.commandGates) {
      variableFor(system, gate.signal)
    }
    for (const effect of rule.effects) {
      if (effect.type === 'writeSignal') assertWriteEffectValid(system, rule, effect)
    }
  }
}
