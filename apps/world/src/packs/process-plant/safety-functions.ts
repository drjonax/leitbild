import type { CompiledProcessPlant } from './plant-compiler.ts'
import type {
  ProcessPlantIcComparisonOperator,
  ProcessPlantIcSafetyFunction,
  ProcessPlantIcSafetyFunctionColour,
  ProcessPlantIcSafetyFunctionCondition,
  ProcessPlantIcStatusTreeNode,
  ProcessPlantRuntime,
} from './runtime/index.ts'
import type { VariablePath } from './graph/index.ts'
import { findProcessPlantSignalBinding, type ProcessPlantSignalReference } from './signals.ts'

// Critical safety function status: each function the Plant's I&C declares
// (control-protection-model.ts) is judged by walking its status tree on the
// Plant's current readings. A branch whose signal the Plant does not publish,
// cannot read, or reads outside its declared range is unknown, and so is the
// function from there: the walk never stands in a value. Read-only; the
// result is reference-model evidence, not a qualified plant assessment.

export type SafetyFunctionStatus = ProcessPlantIcSafetyFunctionColour | 'unknown' | 'not-monitored'
export type SafetyFunctionAnswer = 'yes' | 'no' | 'unknown'

/** A signal a comparison read, as it reads now, in its native unit. */
export interface SafetyFunctionReading {
  /** Its tag, or its path where it has none. */
  readonly signal: string
  readonly path: string
  readonly label: string
  readonly value: number | boolean
  readonly unit: string
}

export interface SafetyFunctionComparison {
  readonly reads: ReadonlyArray<SafetyFunctionReading>
  /** Where it compares no single reading: how they combine, the total of several or one less another, and what that measured. */
  readonly combines?: 'total' | 'difference'
  readonly measured?: number
  readonly operator: ProcessPlantIcComparisonOperator
  readonly threshold: number | boolean
  readonly unit: string
  readonly answer: SafetyFunctionAnswer
  /** Why it is unknown. */
  readonly reason?: string
}

/** A question of the tree, how it was answered and on what. */
export interface SafetyFunctionStep {
  readonly question: string
  readonly basis: string
  readonly answer: SafetyFunctionAnswer
  readonly comparisons: ReadonlyArray<SafetyFunctionComparison>
}

export interface SafetyFunctionCheck {
  readonly label: string
  readonly basis: string
  readonly met: SafetyFunctionAnswer
  /** What it means, where it is not met. */
  readonly notMet?: string
  readonly comparisons: ReadonlyArray<SafetyFunctionComparison>
}

export interface SafetyFunctionEvaluation {
  readonly id: string
  readonly label: string
  readonly shortLabel: string
  readonly basis: string
  readonly status: SafetyFunctionStatus
  /** The function restoration procedure its colour sends operators to. */
  readonly procedure?: string
  /** What the status means, or why it is unknown or not judged. */
  readonly meaning: string
  /** The questions answered on the way to it, in order. */
  readonly path: ReadonlyArray<SafetyFunctionStep>
  /** The further criteria that apply now. */
  readonly checks: ReadonlyArray<SafetyFunctionCheck>
  /** Trends the tree treats as expected in the state the Plant is in. */
  readonly expected: ReadonlyArray<string>
  /** Signals it reads that the Plant does not publish. */
  readonly missingSignals: ReadonlyArray<string>
}

const named = (reference: ProcessPlantSignalReference): string => reference.tagId ?? String(reference.path)

const compare = (left: number | boolean, operator: ProcessPlantIcComparisonOperator, right: number | boolean): boolean => {
  if (operator === '==') return left === right
  if (operator === '!=') return left !== right
  if (typeof left !== 'number' || typeof right !== 'number') throw new Error(`operator ${operator} requires numeric values`)
  if (operator === '<') return left < right
  if (operator === '<=') return left <= right
  if (operator === '>') return left > right
  return left >= right
}

/** Judges one declared safety function on the Plant's readings now. */
export const evaluateSafetyFunction = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly safetyFunction: ProcessPlantIcSafetyFunction
}): SafetyFunctionEvaluation => {
  const { system, runtime, safetyFunction } = config
  const missing = new Set<string>()
  const readings = new Map<string, SafetyFunctionReading | { readonly reason: string }>()

  const read = (reference: ProcessPlantSignalReference): SafetyFunctionReading | { readonly reason: string } => {
    const key = named(reference)
    const known = readings.get(key)
    if (known !== undefined) return known
    const binding = findProcessPlantSignalBinding(system.graph, reference)
    const reading = ((): SafetyFunctionReading | { readonly reason: string } => {
      if (binding === undefined) {
        missing.add(key)
        return { reason: `${key} is not published by this Plant` }
      }
      try {
        const variable = runtime.readVariableSnapshot(binding.path)
        const range = variable.limits?.hardRange
        if (typeof variable.value === 'number' && (!Number.isFinite(variable.value) || (range !== undefined && (variable.value < range.min || variable.value > range.max)))) {
          return { reason: `${key} reads outside its declared range` }
        }
        return { signal: binding.tagId ?? String(binding.path), path: String(binding.path), label: binding.label, value: variable.value, unit: variable.unit }
      } catch (error) {
        return { reason: `${key} cannot be read: ${error instanceof Error ? error.message : String(error)}` }
      }
    })()
    readings.set(key, reading)
    return reading
  }

  // Every leaf is read, so the evidence of a step is whole even where one comparison decides it.
  const evaluate = (condition: ProcessPlantIcSafetyFunctionCondition, comparisons: SafetyFunctionComparison[]): SafetyFunctionAnswer => {
    if (condition.type === 'all' || condition.type === 'any') {
      const answers = condition.conditions.map(child => evaluate(child, comparisons))
      if (condition.type === 'all') return answers.includes('no') ? 'no' : answers.includes('unknown') ? 'unknown' : 'yes'
      return answers.includes('yes') ? 'yes' : answers.includes('unknown') ? 'unknown' : 'no'
    }
    const references = condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]
    const taken = references.map(read)
    const reads = taken.filter((entry): entry is SafetyFunctionReading => 'value' in entry)
    const unit = reads[0]?.unit ?? ''
    const unread = taken.find((entry): entry is { readonly reason: string } => 'reason' in entry)
    if (unread !== undefined) {
      comparisons.push({ reads, operator: condition.operator, threshold: condition.value, unit, answer: 'unknown', reason: unread.reason })
      return 'unknown'
    }
    if (condition.type === 'comparison') {
      const answer = compare(reads[0]!.value, condition.operator, condition.value) ? 'yes' : 'no'
      comparisons.push({ reads, operator: condition.operator, threshold: condition.value, unit, answer })
      return answer
    }
    const values = reads.map(entry => entry.value as number)
    const measured = condition.type === 'total' ? values.reduce((sum, value) => sum + value, 0) : values[0]! - values[1]!
    const answer = compare(measured, condition.operator, condition.value) ? 'yes' : 'no'
    comparisons.push({ reads, combines: condition.type, measured, operator: condition.operator, threshold: condition.value, unit, answer })
    return answer
  }

  const step = (question: string, basis: string, condition: ProcessPlantIcSafetyFunctionCondition): SafetyFunctionStep => {
    const comparisons: SafetyFunctionComparison[] = []
    const answer = evaluate(condition, comparisons)
    return { question, basis, answer, comparisons }
  }
  const holds = (condition: ProcessPlantIcSafetyFunctionCondition | undefined): SafetyFunctionAnswer =>
    condition === undefined ? 'yes' : evaluate(condition, [])

  const identity = { id: safetyFunction.id, label: safetyFunction.label, shortLabel: safetyFunction.shortLabel, basis: safetyFunction.basis }
  const expected = safetyFunction.expectations.filter(expectation => holds(expectation.when) === 'yes').map(expectation => expectation.text)
  const checks = safetyFunction.checks.flatMap((check): ReadonlyArray<SafetyFunctionCheck> => {
    if (holds(check.when) !== 'yes') return []
    const { answer, comparisons } = step(check.label, check.basis, check.condition)
    return [{ label: check.label, basis: check.basis, met: answer, ...(answer === 'no' ? { notMet: check.notMet } : {}), comparisons }]
  })

  const path: SafetyFunctionStep[] = []
  const finish = (fields: Pick<SafetyFunctionEvaluation, 'status' | 'meaning'> & { readonly procedure?: string }): SafetyFunctionEvaluation =>
    ({ ...identity, ...fields, path, checks, expected, missingSignals: [...missing] })

  if (safetyFunction.monitored !== undefined) {
    const monitored = holds(safetyFunction.monitored.when)
    if (monitored === 'unknown') return finish({ status: 'unknown', meaning: 'Whether it is judged now cannot be read.' })
    if (monitored === 'no') return finish({ status: 'not-monitored', meaning: safetyFunction.monitored.otherwise })
  }
  let node: ProcessPlantIcStatusTreeNode = safetyFunction.tree
  while ('question' in node) {
    const taken = step(node.question, node.basis, node.condition)
    path.push(taken)
    if (taken.answer === 'unknown') {
      const reasons = [...new Set(taken.comparisons.flatMap(comparison => comparison.reason === undefined ? [] : [comparison.reason]))]
      return finish({ status: 'unknown', meaning: `"${node.question}" cannot be answered: ${reasons.join('; ')}.` })
    }
    node = taken.answer === 'yes' ? node.yes : node.no
  }
  return finish({ status: node.status, meaning: node.meaning, ...(node.procedure === undefined ? {} : { procedure: node.procedure }) })
}

/** Every critical safety function the Plant declares, judged now, in declaration order. */
export const evaluateSafetyFunctions = (system: CompiledProcessPlant, runtime: ProcessPlantRuntime): ReadonlyArray<SafetyFunctionEvaluation> =>
  system.automation.safetyFunctions.map(safetyFunction => evaluateSafetyFunction({ system, runtime, safetyFunction }))

/**
 * The signals the Plant's critical safety functions judge: those their status
 * trees and checks compare, not those that only say when a function or check
 * is judged. A value a function judges says more about the Plant than one only
 * an alarm judges, so a display short of room keeps it first.
 */
export const safetyFunctionSignals = (system: CompiledProcessPlant): ReadonlySet<VariablePath> => {
  const paths = new Set<VariablePath>()
  const visit = (condition: ProcessPlantIcSafetyFunctionCondition): void => {
    if (condition.type === 'all' || condition.type === 'any') {
      for (const child of condition.conditions) visit(child)
      return
    }
    const references = condition.type === 'comparison' ? [condition.signal] : condition.type === 'total' ? condition.signals : [condition.signal, condition.minus]
    for (const reference of references) {
      const binding = findProcessPlantSignalBinding(system.graph, reference)
      if (binding !== undefined) paths.add(binding.path)
    }
  }
  const walk = (node: ProcessPlantIcStatusTreeNode): void => {
    if (!('question' in node)) return
    visit(node.condition)
    walk(node.yes)
    walk(node.no)
  }
  for (const safetyFunction of system.automation.safetyFunctions) {
    walk(safetyFunction.tree)
    for (const check of safetyFunction.checks) visit(check.condition)
  }
  return paths
}
