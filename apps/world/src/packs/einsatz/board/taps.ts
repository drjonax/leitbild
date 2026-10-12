import type { Recommendation } from '../recommendation-schema.ts'
import { releaseText, sendFromMap, type CallDraft, type SendTarget } from './calls.ts'
import { candidateIn } from './recommendations.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import { notOrderedText, type BoardRules, type DeclaredRole } from './rules.ts'
import { classCode, etaText, namedOnce, unitWord } from './text.ts'
import type { MapTarget, TargetPreview } from './types.ts'

/**
 * What a tap on a target means for the highlighted asset (A9): the order it
 * sends, or why it sends nothing. These are judgements over the records and
 * the cached recommendations only; the controller owns the state a tap
 * changes (highlight, "Move here", choices, Undo). Job chains add their
 * targets and the per-step verbs here.
 */

/** What a target tap would do for a unit: send (asking first when that releases it), nothing and why, or nothing to say. */
export type MapOrder =
  | { readonly kind: 'order'; readonly unit: BoardUnit; readonly target: SendTarget; readonly call: CallDraft; readonly release: string | null }
  | { readonly kind: 'refused'; readonly text: string }
  /** The object is no Einsatz record in the picture: a tap says so, a hover shows nothing. */
  | { readonly kind: 'elsewhere'; readonly text: string }

export interface TapContext {
  readonly rules: BoardRules
  readonly records: BoardRecords | null
  /** The roles the Run declares, so a unit the screen cannot order names who can. */
  readonly declaredRoles: ReadonlyArray<DeclaredRole>
  /** Calls on their way, or accepted and not yet shown: a unit they send to a task is already going there. */
  readonly pending: ReadonlyArray<CallDraft>
}

/** What a target names for the unit: a task, a receiving site or a ground point; otherwise why it is no target. */
export const mapOrderFor = (context: TapContext, unitId: string, target: MapTarget): MapOrder => {
  const { rules, records: shown } = context
  const refused = (text: string): MapOrder => ({ kind: 'refused', text })
  const unit = shown?.units.get(unitId)
  if (shown === null || unit === undefined) return refused('Not in your picture')
  if (!rules.ordersOnMap(unit)) return refused(notOrderedText(rules, context.declaredRoles, unit))
  const order = (to: SendTarget): MapOrder => {
    const call = sendFromMap(rules, shown, unit, to)
    if (unit.taskId === undefined) return { kind: 'order', unit, target: to, call, release: null }
    const from = shown.tasks.get(unit.taskId)
    if (from === undefined) throw new Error(`${unit.id} is committed to ${unit.taskId}, which is not in the picture`)
    return { kind: 'order', unit, target: to, call, release: releaseText(rules, shown, unit, { taskId: from.id, label: from.label, code: classCode(rules, from.rank) }) }
  }
  if (target.kind === 'point') return order({ point: target.point })
  const task = shown.tasks.get(target.objectId)
  if (task !== undefined) {
    if (task.closedAtMs !== undefined) return refused(`${task.label} is closed`)
    if (unit.taskId === task.id) return refused(`${unit.label} already ${unitWord(rules, unit, unit.phase)} to ${task.label}`)
    if (context.pending.some(call => call.taskId === task.id && call.unitIds.includes(unit.id))) return refused(`${unit.label} already ${unitWord(rules, unit, 'en-route')} to ${task.label}`)
    return order({ taskId: task.id })
  }
  const other = shown.units.get(target.objectId)
  if (other === undefined) return { kind: 'elsewhere', text: `Not a target for ${unit.label}` }
  if (other.id !== unit.id && rules.typeOf(other).components.receiving !== undefined) return order({ siteId: other.id })
  if (rules.typeOf(other).components.mobility !== undefined && !rules.ordersOnMap(other)) return refused(notOrderedText(rules, context.declaredRoles, other))
  return refused(`${other.label} is not a target for ${unit.label}`)
}

/**
 * Why an asset tapped onto a call is not sent, known before sending, so the
 * asset stays highlighted: the call is a report, with nothing to send to; the
 * asset provides no service the call requires and carries no load class
 * waiting there; or the call's recommendation names it not eligible, with
 * its reasons, each naming it once. Null when the engine is to judge.
 */
export const taskRefusal = (rules: BoardRules, unit: BoardUnit, task: BoardTask, answer: Recommendation | undefined): string | null => {
  if (rules.isReport(task)) return `${task.label} is a report: nothing to send`
  const components = rules.typeOf(unit).components
  const serves = rules.templateOf(task).requires.some(requirement => components.service?.provides.includes(requirement.provides) === true)
    || Object.entries(task.loads).some(([classId, count]) => count > 0 && components.carry?.classes.includes(classId) === true)
  if (!serves) return `${unit.label} provides nothing ${task.label} needs`
  const ineligible = answer?.ineligible.find(entry => entry.unitId === unit.id)
  return ineligible === undefined ? null : ineligible.reasons.map(reason => namedOnce(ineligible.label, reason)).join(' · ')
}

/** Why an order is not sent before it is: a call's refusal (`taskRefusal`); a site or a point leaves it to the engine. */
export const orderRefusal = (rules: BoardRules, order: Extract<MapOrder, { kind: 'order' }>, answer: (taskId: string) => Recommendation | undefined, task: (taskId: string) => BoardTask): string | null =>
  'taskId' in order.target ? taskRefusal(rules, order.unit, task(order.target.taskId), answer(order.target.taskId)) : null

/**
 * The hover preview of an order: its verb and target, the ETA from the
 * cached recommendation for a call, and what a release drops; or why it
 * would not be sent. Whether a divert may go is the engine's to judge.
 */
export const orderPreview = (order: Extract<MapOrder, { kind: 'order' }>, answer: Recommendation | undefined, refusal: string | null): TargetPreview => {
  if (refusal !== null) return { text: refusal, refused: true }
  const candidate = answer === undefined ? undefined : candidateIn(answer, order.unit.id)
  const parts = [order.call.text, candidate === undefined ? null : etaText(candidate.eta), order.release]
  return { text: parts.filter(part => part !== null).join(' · '), refused: false }
}
