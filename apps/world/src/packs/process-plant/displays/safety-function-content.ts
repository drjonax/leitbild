import type { EmbeddedViewContent } from '@leitbild/contracts'
import type { CompiledPlantGraph, VariablePath } from '../graph/index.ts'
import type { ProcessPlantIcComparisonOperator } from '../runtime/index.ts'
import type { SafetyFunctionComparison, SafetyFunctionEvaluation, SafetyFunctionStatus, SafetyFunctionStep } from '../safety-functions.ts'
import { displayValue, formatValue, unitLabel, valueDigits, writtenDecimals } from './display-text.ts'

// How a display words the critical safety functions the Plant declares: a
// chip per function in its header, its status tree's path behind it, and the
// same in what the view publishes for an answer to cite. Every word comes
// from the declared trees and what they read; none names a function itself.

/** A status as a chip and an answer word it: "GREEN", "NOT JUDGED". */
export const safetyFunctionStatusWords = (status: SafetyFunctionStatus): string =>
  status === 'not-monitored' ? 'NOT JUDGED' : status.toUpperCase()

/** The status with the procedure its colour sends operators to: "YELLOW · FR-H.5". */
const statusText = (evaluation: SafetyFunctionEvaluation): string =>
  `${safetyFunctionStatusWords(evaluation.status)}${evaluation.procedure === undefined ? '' : ` · ${evaluation.procedure}`}`

const OPERATORS: Readonly<Record<ProcessPlantIcComparisonOperator, string>> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠' }

const quantityText = (value: number | boolean, unit: string): string => {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  const label = unitLabel(unit)
  return `${formatValue(displayValue(value, unit))}${label === '' ? '' : ` ${label}`}`.replace('-', '−')
}

/** What a comparison read: "SG-A-LVL-NR 0 %", "total 114 kg/s", "TE-411-COLD − sgA.secondaryTemperatureC −0.02 °C". */
const readText = (comparison: SafetyFunctionComparison): string => {
  if (comparison.combines === 'total' && comparison.measured !== undefined) return `total ${quantityText(comparison.measured, comparison.unit)}`
  if (comparison.combines === 'difference' && comparison.measured !== undefined) return `${comparison.reads.map(read => read.signal).join(' − ')} ${quantityText(comparison.measured, comparison.unit)}`
  const read = comparison.reads[0]
  return read === undefined ? comparison.reason ?? 'not read' : `${read.signal} ${quantityText(read.value, read.unit)}`
}

/**
 * A question as it was answered, with the readings that decided it: those
 * that answered as the question did ("no (SG-B-LVL-NR 0 %)"), or every one
 * where it is unknown.
 */
const stepText = (step: Pick<SafetyFunctionStep, 'question' | 'answer' | 'comparisons'>): string => {
  const deciding = step.comparisons.filter(comparison => comparison.answer === step.answer)
  return `${step.question}: ${step.answer} (${(deciding.length > 0 ? deciding : step.comparisons).map(readText).join(', ')})`
}

/** The path to the status in words, then the checks that apply and the trends expected. */
const pathText = (evaluation: SafetyFunctionEvaluation): ReadonlyArray<string> => [
  ...evaluation.path.map(stepText),
  `${statusText(evaluation)}: ${evaluation.meaning}`,
  ...evaluation.checks.map(check => `Check, ${stepText({ question: check.label, answer: check.met, comparisons: check.comparisons })}${check.notMet === undefined ? '' : `: ${check.notMet}`}`),
  ...evaluation.expected.map(text => `Expected: ${text}`),
]

/** One function as its header chip shows it, its path behind it. */
export interface SafetyFunctionChip {
  readonly id: string
  readonly label: string
  readonly shortLabel: string
  readonly status: SafetyFunctionStatus
  readonly procedure?: string
  readonly text: string
  /**
   * The equipment on the tree's deciding branch, by component id: what owns
   * the readings that answered its last question as it was answered (the
   * steam generators whose levels are below 10 %, the vessel whose subcooling
   * margin holds). A click on the chip opens it. Absent where the tree read
   * nothing (a function not judged).
   */
  readonly opens?: ReadonlyArray<string>
}

/**
 * The components that own the readings deciding the tree's last answer; a
 * line's reading is the equipment's it flows into, as an evidence row counts
 * it. At most as many as one detail opens.
 */
const decidingEquipment = (evaluation: SafetyFunctionEvaluation, graph: CompiledPlantGraph, most: number): ReadonlyArray<string> => {
  const step = evaluation.path.at(-1)
  if (step === undefined) return []
  const deciding = step.comparisons.filter(comparison => comparison.answer === step.answer)
  const owners = (deciding.length > 0 ? deciding : step.comparisons).flatMap(comparison => comparison.reads).flatMap(read => {
    const owner = graph.signalBindingByPath.get(read.path as VariablePath)?.owner
    if (owner === undefined) return []
    return [String(graph.components[owner.type === 'component' ? owner.componentIndex : graph.links[owner.linkIndex]!.toComponentIndex]!.id)]
  })
  return [...new Set(owners)].slice(0, most)
}

export const safetyFunctionChip = (evaluation: SafetyFunctionEvaluation, graph: CompiledPlantGraph, most: number): SafetyFunctionChip => {
  const opens = decidingEquipment(evaluation, graph, most)
  return {
    id: evaluation.id,
    label: evaluation.label,
    shortLabel: evaluation.shortLabel,
    status: evaluation.status,
    ...(evaluation.procedure === undefined ? {} : { procedure: evaluation.procedure }),
    text: [`${evaluation.label}: ${statusText(evaluation)}`, ...pathText(evaluation), `${evaluation.basis}; not a qualified plant procedure.`].join('\n'),
    ...(opens.length === 0 ? {} : { opens }),
  }
}

/** One line naming every function's status, as what a display shows. */
export const safetyFunctionShows = (evaluations: ReadonlyArray<SafetyFunctionEvaluation>): ReadonlyArray<string> =>
  evaluations.length === 0 ? [] : [`Critical safety function status (reference-model status trees, not qualified plant procedures): ${evaluations.map(evaluation => `${evaluation.label} ${statusText(evaluation)}`).join(' · ')}`]

const PATH_MAX_CHARS = 1_500

/** What an answer may cite of the functions: status, the path in words and every value and threshold on it. */
export const safetyFunctionStatuses = (evaluations: ReadonlyArray<SafetyFunctionEvaluation>): NonNullable<EmbeddedViewContent['statuses']> =>
  evaluations.map(evaluation => {
    const comparisons = [...evaluation.path, ...evaluation.checks].flatMap(step => step.comparisons)
    // Readings and what they combine to are written as quantityText writes them; thresholds as declared.
    const values = comparisons.flatMap(comparison => [
      ...comparison.reads.flatMap(read => typeof read.value === 'number' ? [{ value: read.value, unit: read.unit, decimals: valueDigits(displayValue(read.value, read.unit)) }] : []),
      ...(comparison.measured === undefined ? [] : [{ value: comparison.measured, unit: comparison.unit, decimals: valueDigits(displayValue(comparison.measured, comparison.unit)) }]),
      ...(typeof comparison.threshold === 'number' ? [{ value: comparison.threshold, unit: comparison.unit, decimals: writtenDecimals(displayValue(comparison.threshold, comparison.unit)) }] : []),
    ]).filter(quantity => unitLabel(quantity.unit) !== '').map(quantity => ({ value: Number(displayValue(quantity.value, quantity.unit).toPrecision(6)), unit: unitLabel(quantity.unit), decimals: quantity.decimals }))
    const path = pathText(evaluation).join(' → ')
    return {
      names: [evaluation.label, `${evaluation.label} critical safety function`, evaluation.shortLabel],
      status: statusText(evaluation),
      path: path.length <= PATH_MAX_CHARS ? path : `${path.slice(0, PATH_MAX_CHARS - 1)}…`,
      values: [...new Map(values.map(quantity => [`${quantity.value}|${quantity.unit}|${quantity.decimals}`, quantity])).values()].slice(0, 48),
    }
  })
