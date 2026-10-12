import type { Recommendation } from '../recommendation-schema.ts'
import { queueCall, releaseText, sendFromMap, stepText, type CallDraft, type SendTarget } from './calls.ts'
import { candidateIn } from './recommendations.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import { observingSide } from './contacts.ts'
import { hasLoad, holdsWork, notOrderedText, usableSite, type BoardRules, type DeclaredRole } from './rules.ts'
import { classCode, etaText, loadText, namedOnce, unitWord, word } from './text.ts'
import type { MapTarget, TargetPreview } from './types.ts'

/**
 * What a tap on a target means for the highlighted asset (A9): the order it
 * sends, or why it sends nothing. These are judgements over the records and
 * the cached recommendations only; the controller owns the state a tap
 * changes (highlight, "Move here", choices, Undo). Job chains add their
 * targets and the per-step verbs here.
 */

/**
 * What a target tap would do for a unit: send, nothing and why, or nothing
 * to say. An order carries both ways to give it: `call` does it now, `queue`
 * adds it to the end of the unit's job chain. A unit that holds work
 * (`busy`) asks which; `release` names what doing it now takes from it.
 */
export type MapOrder =
  | {
    readonly kind: 'order'
    readonly unit: BoardUnit
    readonly target: SendTarget
    readonly call: CallDraft
    readonly queue: CallDraft
    readonly busy: boolean
    /** What "Do now" drops: the task it leaves and the load returning there, or the step it stops; null when it drops nothing. */
    readonly release: string | null
  }
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

/**
 * What a target names for the unit: a task, a site, a ground point, or an
 * enemy track it engages if armed; otherwise why it is no target. A track
 * the Board can tell is no target (the asset cannot fire, the track is
 * another side's, destroyed or a contact report only) is refused in the
 * engine's words; whether it is hostile and of a type the asset engages is
 * the engine's to judge, since the side knows only what it identified.
 */
export const mapOrderFor = (context: TapContext, unitId: string, target: MapTarget): MapOrder => {
  const { rules, records: shown } = context
  const refused = (text: string): MapOrder => ({ kind: 'refused', text })
  const unit = shown?.units.get(unitId)
  if (shown === null || unit === undefined) return refused('Not in your picture')
  if (!rules.ordersOnMap(unit)) return refused(notOrderedText(rules, context.declaredRoles, unit))
  const order = (to: SendTarget): MapOrder => {
    const both = { kind: 'order' as const, unit, target: to, call: sendFromMap(rules, shown, unit, to), queue: queueCall(shown, unit, to), busy: holdsWork(unit) }
    if (unit.taskId === undefined) return { ...both, release: dropText(shown, unit) }
    const from = shown.tasks.get(unit.taskId)
    if (from === undefined) throw new Error(`${unit.id} is committed to ${unit.taskId}, which is not in the picture`)
    return { ...both, release: releaseText(rules, shown, unit, { taskId: from.id, label: from.label, code: classCode(rules, from.rank) }) }
  }
  if (target.kind === 'point') return order({ point: target.point })
  const task = shown.tasks.get(target.objectId)
  if (task !== undefined) {
    if (task.closedAtMs !== undefined) return refused(`${task.label} is closed`)
    if (unit.taskId === task.id) return refused(`${unit.label} already ${unitWord(rules, unit, unit.phase)} to ${task.label}`)
    if (context.pending.some(call => call.taskId === task.id && call.unitIds.includes(unit.id))) return refused(`${unit.label} already ${unitWord(rules, unit, 'en-route')} to ${task.label}`)
    return order({ taskId: task.id })
  }
  const track = shown.tracks.get(target.objectId)
  if (track !== undefined) {
    if (rules.typeOf(unit).components.effector === undefined) return refused(`${unit.label} cannot fire`)
    if (observingSide(track) !== unit.side) return refused(`${unit.label} cannot engage another side's track`)
    if (track.tier === 'destroyed') return refused(`${track.label} is ${word(rules, 'destroyed').toLowerCase()}`)
    if (track.tier === 'contact') return refused(`${track.label} is a ${word(rules, 'contact').toLowerCase()} report only`)
    return order({ trackId: track.id })
  }
  const other = shown.units.get(target.objectId)
  if (other === undefined) return { kind: 'elsewhere', text: `Not a target for ${unit.label}` }
  // A unit that does not move is a site: a receiving one takes deliveries, any other is a place to go to; another side's only where it is public.
  if (other.id !== unit.id && rules.typeOf(other).components.mobility === undefined) {
    if (!usableSite(rules, unit, other)) return refused(`${unit.label} cannot use another side's ${other.label}`)
    return order({ siteId: other.id })
  }
  if (rules.typeOf(other).components.mobility !== undefined && !rules.ordersOnMap(other)) return refused(notOrderedText(rules, context.declaredRoles, other))
  return refused(`${other.label} is not a target for ${unit.label}`)
}

/** What doing a new target now stops of a unit that holds no task: its active step; nothing while it is paused with its first step waiting. */
export const dropText = (records: BoardRecords, unit: BoardUnit): string | null => {
  const active = unit.orders[0]?.state === 'active' ? unit.orders[0] : undefined
  if (active !== undefined) return `${unit.label} stops: ${stepText(records, active)}`
  return null
}

/** What a busy asset's choice says when doing it now drops nothing: the steps it holds, or the load it carries. */
export const holdingText = (rules: BoardRules, unit: BoardUnit): string => {
  const steps = unit.orders.length
  if (steps > 0) return `${unit.label} holds ${steps} ${steps === 1 ? 'step' : 'steps'}`
  return hasLoad(unit) ? `${unit.label} carries ${loadText(rules, unit.load)}` : unit.label
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

/** Why an order is not sent before it is: a call's refusal (`taskRefusal`); a site, a point or a track leaves it to the engine. */
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
