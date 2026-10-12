import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcComparisonOperator, ProcessPlantIcSafetyFunctionCondition, ProcessPlantIcStatusTreeNode } from '../runtime/index.ts'
import { findProcessPlantSignalBinding } from '../signals.ts'

// The criteria a critical safety function's status tree asks of the Plant's
// readings, each with the question its branch asks: what a display reads a
// value against where the value is one a function judges (total feed flow to
// the steam generators against the heat sink's minimum). Read from the I&C
// configuration's trees, never from names.

/** A comparison or total a function's tree asks, of readings the Plant publishes or not. */
export interface SafetyFunctionCriterion {
  /** The function's short label ("HEAT SINK"). */
  readonly safetyFunction: string
  /** What its branch asks ("Total feed flow to the steam generators at least 27.8 kg/s (440 gpm)"). */
  readonly question: string
  readonly paths: ReadonlyArray<VariablePath>
  readonly operator: ProcessPlantIcComparisonOperator
  /** In the readings' native units. */
  readonly value: number
  /** Whether it judges the sum of its readings, not one. */
  readonly total: boolean
}

const criteriaOf = (plant: CompiledProcessPlant, safetyFunction: string, question: string, condition: ProcessPlantIcSafetyFunctionCondition): ReadonlyArray<SafetyFunctionCriterion> => {
  const pathOf = (reference: Parameters<typeof findProcessPlantSignalBinding>[1]): VariablePath | undefined => findProcessPlantSignalBinding(plant.graph, reference)?.path
  if (condition.type === 'comparison') {
    const path = pathOf(condition.signal)
    return path === undefined || typeof condition.value !== 'number' ? [] : [{ safetyFunction, question, paths: [path], operator: condition.operator, value: condition.value, total: false }]
  }
  if (condition.type === 'total') {
    const paths = condition.signals.map(pathOf)
    return paths.some(path => path === undefined) ? [] : [{ safetyFunction, question, paths: paths as ReadonlyArray<VariablePath>, operator: condition.operator, value: condition.value, total: true }]
  }
  if (condition.type === 'all' || condition.type === 'any') return condition.conditions.flatMap(child => criteriaOf(plant, safetyFunction, question, child))
  return []
}

const visit = (plant: CompiledProcessPlant, safetyFunction: string, node: ProcessPlantIcStatusTreeNode): ReadonlyArray<SafetyFunctionCriterion> =>
  'question' in node ? [...criteriaOf(plant, safetyFunction, node.question, node.condition), ...visit(plant, safetyFunction, node.yes), ...visit(plant, safetyFunction, node.no)] : []

const byPlant = new WeakMap<CompiledProcessPlant, ReadonlyArray<SafetyFunctionCriterion>>()

/** Every numeric comparison and total the Plant's critical safety function trees ask, in tree order, each once. */
export const safetyFunctionCriteria = (plant: CompiledProcessPlant): ReadonlyArray<SafetyFunctionCriterion> => {
  const cached = byPlant.get(plant)
  if (cached !== undefined) return cached
  const seen = new Set<string>()
  const criteria = plant.automation.safetyFunctions.flatMap(safetyFunction => visit(plant, safetyFunction.shortLabel, safetyFunction.tree)).filter(criterion => {
    const key = `${criterion.safetyFunction}|${criterion.total}|${criterion.operator}|${criterion.value}|${criterion.paths.join(',')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  byPlant.set(plant, criteria)
  return criteria
}

/** The criterion a row of exactly these readings is read against: a total of them, or a comparison of the one. */
export const criterionOfReadings = (plant: CompiledProcessPlant, paths: ReadonlyArray<VariablePath>): SafetyFunctionCriterion | undefined => {
  const wanted = new Set(paths.map(String))
  return safetyFunctionCriteria(plant).find(criterion => criterion.paths.length === wanted.size && criterion.paths.every(path => wanted.has(String(path))))
}
