import type { GeoJsonPoint } from '../../../core/model/index.ts'
import { contributionOf, countedFor, residualNeed, roleViewFor } from './coverage.ts'
import { putUnit, setMotion, stageTask, taskIn, unitIn, type Draft } from './draft.ts'
import { actionBy, committedText, immobile, loadedText, notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan, RouteNeed } from './intents.ts'
import { clearAlerts, isLowerClass, motionOf, unitTypeOf, workReturnedCode, type EngineState, type Leg, type TaskRecord, type UnitRecord } from './model.ts'
import { releaseFromTask } from './phases.ts'
import { orderAlertCodes } from './reflexes.ts'
import { divertablePhases, hasLoad, isMoving, isSite, linksToSite, linksToTask } from './rules.ts'
import { patch } from './values.ts'
import { classCode, phaseWord } from './wording.ts'

type Target =
  | { readonly kind: 'task'; readonly task: TaskRecord }
  | { readonly kind: 'site'; readonly site: UnitRecord }
  | { readonly kind: 'point'; readonly point: GeoJsonPoint }

interface Mover { readonly unit: UnitRecord; readonly fromTaskId?: string }
type Checked = Refused | { readonly ok: true; readonly already?: string }

const resolveTarget = (state: EngineState, to: IntentOf<'send'>['to']): Target | Refused => {
  if ('taskId' in to) {
    const task = state.tasks.get(to.taskId)
    if (task === undefined) return notInPicture()
    return task.closedAtMs === undefined ? { kind: 'task', task } : refused('task_closed', `${task.label} is closed`)
  }
  if ('siteId' in to) {
    const site = state.units.get(to.siteId)
    if (site === undefined) return notInPicture()
    return isSite(state.catalog, site) ? { kind: 'site', site } : refused('not_a_site', `${site.label} does not receive load`)
  }
  return { kind: 'point', point: to.point }
}

const targetPoint = (state: EngineState, target: Target): GeoJsonPoint =>
  target.kind === 'task' ? target.task.point : target.kind === 'site' ? motionOf(state, target.site.id).point : target.point

const siteRefusal = (state: EngineState, unit: UnitRecord, site: UnitRecord): Refused | undefined => {
  if (!linksToSite(state.catalog, unit, site)) return refused('cross_side_reference', `${unit.label} cannot use another side's ${site.label}`)
  if (!hasLoad(unit)) return undefined
  const accepts = unitTypeOf(state.catalog, site).components.receiving!.accepts
  if (site.accepting !== true) return refused('site_not_accepting', `${site.label} is not accepting`)
  const refusedClass = state.catalog.classes.find(loadClass => unit.load[loadClass.id] !== undefined && !accepts.includes(loadClass.id))
  return refusedClass === undefined ? undefined : refused('site_not_accepting', `${site.label} does not accept ${refusedClass.noun.other}`)
}

/** Whether one unit may take part in a send, before coverage is counted. */
const checkSender = (state: EngineState, unit: UnitRecord, target: Target, fromTaskId: string | undefined): Checked => {
  const cannotMove = immobile(state, unit)
  if (cannotMove) return cannotMove
  const already = (where: string): Checked => ({ ok: true, already: `${unit.label} already ${phaseWord(state.catalog, unit)} ${where}` })
  if (fromTaskId !== undefined) {
    if (unit.taskId !== fromTaskId) return refused('unit_committed', committedText(state, unit))
    if (hasLoad(unit)) return refused('unit_loaded', loadedText(state, unit))
    if (target.kind === 'task' && fromTaskId === target.task.id) return already(`to ${target.task.label}`)
    if (target.kind === 'task' && !divertablePhases.includes(unit.phase)) {
      return refused('divert_after_arrival', `${unit.label} is ${phaseWord(state.catalog, unit)} at ${taskIn(state, fromTaskId).label}; recall it or move it`)
    }
  } else if (target.kind === 'task' && unit.taskId === target.task.id) return already(`to ${target.task.label}`)
  else if (hasLoad(unit)) {
    if (target.kind !== 'site') return refused('unit_loaded', loadedText(state, unit))
    if (unit.phase === 'at-site' && unit.phaseDueMs !== undefined) return refused('unit_committed', `${unit.label} is handing over at ${unitIn(state, unit.siteId!).label}`)
    if (unit.siteId === target.site.id) return already(`to ${target.site.label}`)
  } else if (unit.taskId !== undefined) return refused('unit_committed', committedText(state, unit))
  if (target.kind === 'task' && !linksToTask(unit, target.task)) return refused('cross_side_reference', `${unit.label} cannot serve another side's ${target.task.label}`)
  if (target.kind === 'site') return siteRefusal(state, unit, target.site) ?? { ok: true }
  return { ok: true }
}

/**
 * Coverage at commit: every unit must add something the task still lacks
 * beside the assigned units and every other unit of the send, so the outcome
 * never depends on the order the send names them in. Then each divert must
 * come from a task strictly lower than the residual need the send's
 * non-divert units leave.
 */
const checkTaskCoverage = (state: EngineState, task: TaskRecord, movers: ReadonlyArray<Mover>, actor: EngineActor): Refused | undefined => {
  const counted = countedFor(state, task, movers.map(mover => mover.unit))
  for (const { unit } of movers) {
    const contribution = contributionOf(state.catalog, task, counted, unit)
    if (contribution.adds) continue
    if (contribution.unmet[0] !== undefined) return refused('requirement_unmet', contribution.unmet[0])
    if (contribution.covered) return refused('requirement_covered', `${task.label} needs nothing more that ${unit.label} provides`)
    return refused('requirement_unmet', `${unit.label} provides nothing ${task.label} needs`)
  }
  const diverted = movers.filter(mover => mover.fromTaskId !== undefined)
  if (diverted.length === 0) return undefined
  const plain = movers.filter(mover => mover.fromTaskId === undefined).map(mover => mover.unit)
  const residual = residualNeed(state, task, roleViewFor(state, actor.commandable, task), plain)
  for (const mover of diverted) {
    const from = taskIn(state, mover.fromTaskId!)
    if (residual === undefined) return refused('divert_not_lower_priority', `${task.label} needs nothing ${mover.unit.label} could be diverted for`)
    if (!isLowerClass(state.catalog, from.rank, residual)) {
      return refused('divert_not_lower_priority', `${from.label} (${classCode(state.catalog, from.rank)}) is not lower than ${classCode(state.catalog, residual)} at ${task.label}`)
    }
  }
  return undefined
}

const applySend = (draft: Draft, actor: EngineActor, target: Target, movers: ReadonlyArray<Mover>, legs: ReadonlyMap<string, Leg>): void => {
  for (const mover of movers) {
    const before = unitIn(draft, mover.unit.id)
    const fromTask = mover.fromTaskId === undefined ? undefined : taskIn(draft, mover.fromTaskId)
    const unit = fromTask === undefined ? before : releaseFromTask(draft, before, actionBy(draft, actor, 'release', fromTask.id, target.kind === 'task' ? 'divert' : 'move'))
    setMotion(draft, unit.id, { progressMs: 0 })
    const departing = { leg: legs.get(unit.id)!, atBase: false, alerts: clearAlerts(unit.alerts, orderAlertCodes), phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
    if (target.kind === 'task') {
      const mobilizeMs = unitTypeOf(draft.catalog, unit).components.mobility!.mobilizeS * 1_000
      const turnout = before.phase === 'mobilizing'
        ? { phase: 'mobilizing' as const, phaseSinceMs: before.phaseSinceMs, phaseDueMs: before.phaseDueMs }
        : !isMoving(before) && mobilizeMs > 0 ? { phase: 'mobilizing' as const, phaseDueMs: draft.timeMs + mobilizeMs } : { phase: 'en-route' as const }
      const cause = fromTask === undefined ? undefined : `from ${fromTask.label}`
      putUnit(draft, patch(unit, { ...departing, ...turnout, taskId: target.task.id, lastAction: actionBy(draft, actor, fromTask === undefined ? 'send' : 'divert', target.task.id, cause) }))
    } else if (target.kind === 'site' && hasLoad(unit)) {
      putUnit(draft, patch(unit, { ...departing, phase: 'transporting', siteId: target.site.id, lastAction: actionBy(draft, actor, 'deliver', target.site.id) }))
    } else {
      const to = target.kind === 'site' ? target.site.id : undefined
      putUnit(draft, patch(unit, { ...departing, phase: 'en-route', siteId: undefined, lastAction: actionBy(draft, actor, 'move', to) }))
    }
  }
  if (target.kind === 'task') {
    const task = taskIn(draft, target.task.id)
    const alerts = clearAlerts(task.alerts, [workReturnedCode])
    if (alerts.length !== task.alerts.length) stageTask(draft, patch(task, { alerts }))
  }
}

export const planSend = (state: EngineState, intent: IntentOf<'send'>, actor: EngineActor): Plan => {
  const target = resolveTarget(state, intent.to)
  if ('ok' in target) return target
  const fromTasks = new Map((intent.divert ?? []).map(entry => [entry.unitId, entry.fromTaskId]))
  const movers: Mover[] = []
  const notes: string[] = []
  for (const id of intent.units) {
    const unit = state.units.get(id)
    if (unit === undefined) return notInPicture()
    const fromTaskId = fromTasks.get(id)
    const checked = checkSender(state, unit, target, fromTaskId)
    if (!checked.ok) return checked
    if (checked.already !== undefined) notes.push(checked.already)
    else movers.push(fromTaskId === undefined ? { unit } : { unit, fromTaskId })
  }
  if (target.kind === 'task') {
    const uncovered = checkTaskCoverage(state, target.task, movers, actor)
    if (uncovered) return uncovered
  }
  const to = targetPoint(state, target)
  const routes: RouteNeed[] = movers.map(mover => ({ unitId: mover.unit.id, from: motionOf(state, mover.unit.id).point, to }))
  return { ok: true, routes, notes, apply: (draft, legs) => applySend(draft, actor, target, movers, legs) }
}

/** Release from the task, if any, and return to base. A loaded unit delivers first. */
export const planRecall = (state: EngineState, intent: IntentOf<'recall'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const cannotMove = immobile(state, unit)
  if (cannotMove) return cannotMove
  if (hasLoad(unit)) return refused('unit_loaded', loadedText(state, unit))
  if (intent.fromTaskId !== undefined && unit.taskId !== intent.fromTaskId) return refused('unit_committed', committedText(state, unit))
  const routes: RouteNeed[] = unit.atBase ? [] : [{ unitId: unit.id, from: motionOf(state, unit.id).point, to: unit.base }]
  return {
    ok: true, routes, notes: [],
    apply: (draft, legs) => {
      const current = unitIn(draft, unit.id)
      const released = releaseFromTask(draft, current, actionBy(draft, actor, 'release', current.taskId, 'recall'))
      const order = actionBy(draft, actor, 'recall')
      setMotion(draft, unit.id, { progressMs: 0 })
      const leg = legs.get(unit.id)
      putUnit(draft, patch(released, {
        phase: leg === undefined ? 'available' : 'returning', leg, phaseSinceMs: draft.timeMs, phaseDueMs: undefined, alerts: clearAlerts(released.alerts, orderAlertCodes), lastAction: order,
      }))
    },
  }
}

/** Halt a free unit where it is. A committed unit is recalled or moved instead. */
export const planHold = (state: EngineState, intent: IntentOf<'hold'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const cannotMove = immobile(state, unit)
  if (cannotMove) return cannotMove
  if (hasLoad(unit)) return refused('unit_loaded', loadedText(state, unit))
  if (unit.taskId !== undefined) return refused('unit_committed', `${committedText(state, unit)}; recall first (R), or move it (M)`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      setMotion(draft, unit.id, { progressMs: 0 })
      const current = unitIn(draft, unit.id)
      putUnit(draft, patch(current, { phase: 'holding', leg: undefined, phaseSinceMs: draft.timeMs, phaseDueMs: undefined, alerts: clearAlerts(current.alerts, orderAlertCodes), lastAction: actionBy(draft, actor, 'hold') }))
    },
  }
}
