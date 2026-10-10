import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding, resolveProcessPlantSignalPath } from '../signals.ts'

// Thresholds drawn on composed displays come only from the Plant's configured
// I&C rules. They are named I&C thresholds, not variable limits: they state
// where a rule acts, not a qualified operating envelope.
export type ComposedDisplayThresholdKind = 'trip' | 'alarm' | 'control'
/** Alarm priority of the rule's alarm or trip effect; it alone picks the alarm colour everywhere. */
export type ComposedDisplaySeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface ComposedDisplayThreshold {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
  /** Present for alarm and trip rules. */
  readonly severity?: ComposedDisplaySeverity
  readonly operator: '<' | '<=' | '>' | '>='
  /** Low thresholds act when the value falls; high ones when it rises. */
  readonly direction: 'low' | 'high'
  readonly value: number
  /** The declared operating modes the rule only acts in; drawn dashed. */
  readonly modeLabel?: string
}

/** A rule that watches the signal inside a combined condition (vote, all,
 * any, not). Its action does not follow from one value, so it is listed, not
 * drawn. */
export interface ComposedDisplayCombinedRule {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
}

export interface ComposedDisplayIcThresholds {
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
}

const kindFor = (rule: ProcessPlantIcRule): ComposedDisplayThresholdKind => {
  if (rule.effects.some(effect => effect.type === 'trip.enter')) return 'trip'
  if (rule.effects.some(effect => effect.type === 'alarm.enter')) return 'alarm'
  return 'control'
}

// Same defaults as the alarm lifecycle, so a threshold and its alarm row agree.
const severityFor = (rule: ProcessPlantIcRule): ComposedDisplaySeverity | undefined => {
  for (const effect of rule.effects) {
    if (effect.type === 'trip.enter') return effect.severity ?? 'critical'
    if (effect.type === 'alarm.enter') return effect.severity ?? 'warning'
  }
  return undefined
}

const labelFor = (rule: ProcessPlantIcRule): string => {
  for (const effect of rule.effects) {
    if (effect.type === 'trip.enter' || effect.type === 'alarm.enter') return effect.title
  }
  return rule.label ?? rule.id
}

// The declared operating modes a rule acts in, as the Plant names them ("Power operation").
const modeLabelFor = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): string | undefined =>
  rule.modes?.map(id => plant.automation.operatingModes.find(mode => mode.id === id)!.label).join(' or ')

const conditionWatches = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
  path: VariablePath,
): boolean => {
  if (condition.type === 'comparison') return resolveProcessPlantSignalPath(plant.graph, condition.signal) === path
  if (condition.type === 'not') return conditionWatches(plant, condition.condition, path)
  return condition.conditions.some(child => conditionWatches(plant, child, path))
}

export const icThresholdsForSignal = (
  plant: CompiledProcessPlant,
  path: VariablePath,
): ComposedDisplayIcThresholds => {
  const thresholds: ComposedDisplayThreshold[] = []
  const combinedRules: ComposedDisplayCombinedRule[] = []
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const condition = rule.condition
    if (condition.type === 'comparison') {
      if (resolveProcessPlantSignalPath(plant.graph, condition.signal) !== path) continue
      // Equality rules act on discrete states; they have no position on a value axis.
      if (typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=') continue
      const modeLabel = modeLabelFor(plant, rule)
      const severity = severityFor(rule)
      thresholds.push({
        ruleId: rule.id,
        label: labelFor(rule),
        kind: kindFor(rule),
        ...(severity === undefined ? {} : { severity }),
        operator: condition.operator,
        direction: condition.operator === '<' || condition.operator === '<=' ? 'low' : 'high',
        value: condition.value,
        ...(modeLabel === undefined ? {} : { modeLabel }),
      })
      continue
    }
    if (conditionWatches(plant, condition, path)) {
      combinedRules.push({ ruleId: rule.id, label: labelFor(rule), kind: kindFor(rule) })
    }
  }
  return {
    thresholds: thresholds.sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId)),
    combinedRules: combinedRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  }
}

// A signal belongs to its bound equipment and to the node that owns its path
// (a relief flow modelled on the pressurizer node belongs to the pressurizer).
const equipmentKeys = (binding: ProcessSignalBinding): ReadonlyArray<string> => [
  String(binding.path).split('.')[0]!,
  ...(binding.equipmentId === undefined ? [] : [String(binding.equipmentId)]),
]

const conditionBindings = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
): ReadonlyArray<ProcessSignalBinding> => {
  if (condition.type === 'comparison') return [resolveProcessPlantSignalBinding(plant.graph, condition.signal)]
  if (condition.type === 'not') return conditionBindings(plant, condition.condition)
  return condition.conditions.flatMap(child => conditionBindings(plant, child))
}

/**
 * Alarm and trip rules acting on any signal of the displayed signals'
 * equipment: beside a pressurizer pressure trend an operator expects the
 * pressurizer's other alarms (relief flow, level), not only the pressure ones.
 */
export const icAlarmRuleIdsForEquipment = (
  plant: CompiledProcessPlant,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<string> => {
  const equipment = new Set(paths.flatMap(path => {
    const binding = plant.graph.signalBindingByPath.get(path)
    return binding === undefined ? [] : equipmentKeys(binding)
  }))
  return plant.automation.rules
    .filter(rule => rule.enabled && kindFor(rule) !== 'control')
    .filter(rule => conditionBindings(plant, rule.condition).some(binding => equipmentKeys(binding).some(key => equipment.has(key))))
    .map(rule => rule.id)
}

/**
 * Single-signal alarm and trip rules on one component's signals: they frame
 * its mimic symbol. Combined and voted rules are left out, because they judge
 * several items at once (2-of-4 RCP low flow would frame every pump).
 */
export const icAlarmRuleIdsForComponent = (
  plant: CompiledProcessPlant,
  componentId: string,
): ReadonlyArray<string> => plant.automation.rules
  .filter(rule => rule.enabled && kindFor(rule) !== 'control' && rule.condition.type === 'comparison')
  .filter(rule => conditionBindings(plant, rule.condition).some(binding => equipmentKeys(binding).includes(componentId)))
  .map(rule => rule.id)

/** Single-signal alarm and trip rules on exactly these signals, for a symbol that is one item of a larger component. */
export const icAlarmRuleIdsForPaths = (
  plant: CompiledProcessPlant,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<string> => {
  const watched = new Set(paths.map(String))
  return plant.automation.rules
    .filter(rule => rule.enabled && kindFor(rule) !== 'control' && rule.condition.type === 'comparison')
    .filter(rule => conditionBindings(plant, rule.condition).some(binding => watched.has(String(binding.path))))
    .map(rule => rule.id)
}

/** Every signal an alarm or trip rule judges: trips first, each kind in rule order. */
export const icWatchedPaths = (plant: CompiledProcessPlant): ReadonlyArray<VariablePath> => [...new Set((['trip', 'alarm'] as const)
  .flatMap(kind => plant.automation.rules
    .filter(rule => rule.enabled && kindFor(rule) === kind)
    .flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path))))]

/** Every signal a trip rule judges, in rule order: what the Plant's protection treats as decisive. */
export const icTripWatchedPaths = (plant: CompiledProcessPlant): ReadonlyArray<VariablePath> => [...new Set(plant.automation.rules
  .filter(rule => rule.enabled && kindFor(rule) === 'trip')
  .flatMap(rule => conditionBindings(plant, rule.condition).map(binding => binding.path)))]
