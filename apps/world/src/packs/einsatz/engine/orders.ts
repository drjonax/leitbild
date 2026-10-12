import type { GeoJsonPoint } from '../../../core/model/index.ts'
import { isStandingOrderBy, standingOrderBy } from '../ids.ts'
import { maxHeldSteps, maxSteps, type Step, type StepTarget } from '../steps.ts'
import { activeStep, clearedByOrder, newStep, nextStepCause, restOf, skipSteps, started, targetLabel } from './chain-steps.ts'
import type { TrackRecord } from './combat-model.ts'
import { contributionOf, countedFor, residualNeed, roleViewFor } from './coverage.ts'
import { putUnit, setMotion, stageTask, taskIn, unitIn, type Draft } from './draft.ts'
import { engageRefusal } from './engagement-orders.ts'
import { actionBy, committedText, immobile, loadedText, notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan, RouteNeed } from './intents.ts'
import { clearAlerts, isLowerClass, motionOf, unitTypeOf, workReturnedCode, type EngineState, type LastAction, type Leg, type TaskRecord, type UnitRecord } from './model.ts'
import { releaseFromTask } from './phases.ts'
import { divertablePhases, hasLoad, isMoving, isSite, linksToSite, linksToTask } from './rules.ts'
import { patch } from './values.ts'
import { classCode, phaseWord, unitWord } from './wording.ts'

export type Target =
  | { readonly kind: 'task'; readonly task: TaskRecord }
  | { readonly kind: 'site'; readonly site: UnitRecord }
  | { readonly kind: 'point'; readonly point: GeoJsonPoint }
  | { readonly kind: 'track'; readonly track: TrackRecord }

export interface Mover { readonly unit: UnitRecord; readonly fromTaskId?: string }
type Checked = Refused | { readonly ok: true; readonly already?: string }

/**
 * The record a target names: an open task, a site, a point, or a track. An
 * id the state does not hold is not echoed. A site is any unit that cannot
 * move, a place such as a depot or a post: a unit goes there, and delivers
 * there only where it receives load (`siteRefusal`).
 */
export const resolveTarget = (state: EngineState, to: StepTarget): Target | Refused => {
  if ('taskId' in to) {
    const task = state.tasks.get(to.taskId)
    if (task === undefined) return notInPicture()
    return task.closedAtMs === undefined ? { kind: 'task', task } : refused('task_closed', `${task.label} is closed`)
  }
  if ('siteId' in to) {
    const site = state.units.get(to.siteId)
    if (site === undefined) return notInPicture()
    return unitTypeOf(state.catalog, site).components.mobility === undefined ? { kind: 'site', site } : refused('not_a_site', `${site.label} is no place to go to: it moves`)
  }
  if ('trackId' in to) {
    const track = state.combat.tracks.get(to.trackId)
    return track === undefined ? notInPicture() : { kind: 'track', track }
  }
  return { kind: 'point', point: to.point }
}

/** Where a unit travels for a target. An engage step does not move the unit, so a track has no point. */
export const targetPoint = (state: EngineState, target: Target): GeoJsonPoint | undefined =>
  target.kind === 'task' ? target.task.point : target.kind === 'site' ? motionOf(state, target.site.id).point : target.kind === 'point' ? target.point : undefined

/**
 * Whether a unit may deliver to or go to a site: its side's or public, and,
 * when it carries load, one that receives load and accepts every class it
 * carries. A place that receives nothing is a site to go to only.
 */
export const siteRefusal = (state: EngineState, unit: UnitRecord, site: UnitRecord, load: UnitRecord['load'] = unit.load): Refused | undefined => {
  if (!linksToSite(state.catalog, unit, site)) return refused('cross_side_reference', `${unit.label} cannot use another side's ${site.label}`)
  if (Object.keys(load).length === 0) return undefined
  if (!isSite(state.catalog, site)) return refused('not_a_site', `${site.label} does not receive load`)
  const accepts = unitTypeOf(state.catalog, site).components.receiving!.accepts
  if (site.accepting !== true) return refused('site_not_accepting', `${site.label} is not accepting`)
  const refusedClass = state.catalog.classes.find(loadClass => load[loadClass.id] !== undefined && !accepts.includes(loadClass.id))
  return refusedClass === undefined ? undefined : refused('site_not_accepting', `${site.label} does not accept ${refusedClass.code} ${refusedClass.noun.other}`)
}

/** The track a unit engages by its active step, if that is what it carries out. */
const engagingTrack = (unit: UnitRecord): string | undefined => {
  const step = activeStep(unit)
  return step !== undefined && 'trackId' in step.target ? step.target.trackId : undefined
}

/** Whether one unit may take part in a send, before coverage is counted. */
const checkSender = (state: EngineState, unit: UnitRecord, target: Target, fromTaskId: string | undefined): Checked => {
  // An engage step does not move the unit, so a unit that cannot move may still take one.
  const cannotMove = target.kind === 'track' ? undefined : immobile(state, unit)
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
  else if (target.kind === 'track' && engagingTrack(unit) === target.track.id) return { ok: true, already: `${unit.label} already engaging ${target.track.label}` }
  else if (hasLoad(unit)) {
    if (target.kind !== 'site') return refused('unit_loaded', loadedText(state, unit))
    if (unit.phase === 'at-site' && unit.phaseDueMs !== undefined) return refused('unit_committed', `${unit.label} is handing over at ${unitIn(state, unit.siteId!).label}`)
    if (unit.siteId === target.site.id) return already(`to ${target.site.label}`)
  } else if (unit.taskId !== undefined) return refused('unit_committed', committedText(state, unit))
  if (target.kind === 'task' && !linksToTask(unit, target.task)) return refused('cross_side_reference', `${unit.label} cannot serve another side's ${target.task.label}`)
  if (target.kind === 'site') return siteRefusal(state, unit, target.site) ?? { ok: true }
  if (target.kind === 'track') return engageRefusal(state, unit, target.track) ?? { ok: true }
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

/**
 * How a send names the step each unit starts: `now` adds a new active step
 * ahead of the unit's queued ones and drops the step it was carrying out;
 * `next` starts the unit's queued first step in place, keeping its id.
 */
export type StartMode = { readonly kind: 'now' } | { readonly kind: 'next'; readonly step: Step }

const releaseCause = (target: Target): string => target.kind === 'task' ? 'divert' : target.kind === 'track' ? 'engage' : 'move'

/**
 * The steps a do-now send keeps behind the one it starts: every queued
 * step, except those leading to the task it now serves, which the new
 * active step carries out.
 */
const keptBehind = (unit: UnitRecord, target: Target): Step[] =>
  restOf(unit).filter(step => target.kind !== 'task' || !('taskId' in step.target) || step.target.taskId !== target.task.id)

/**
 * A do-now send drops the active step but keeps the queued ones, so a unit
 * paused or waiting for a route grows by one. An actor's send leaves at
 * most `maxSteps`; the deliver standing order may put its one delivery in
 * front of a full chain.
 */
const chainRoom = (movers: ReadonlyArray<Mover>, target: Target, actor: EngineActor): Refused | undefined => {
  const limit = actor.by === standingOrderBy('deliver') ? maxHeldSteps : maxSteps
  const full = movers.find(mover => 1 + keptBehind(mover.unit, target).length > limit)
  return full === undefined ? undefined : refused('chain_full', `${full.unit.label} already holds ${full.unit.orders.length} steps; remove one first`)
}

const applySend = (draft: Draft, actor: EngineActor, to: StepTarget, target: Target, movers: ReadonlyArray<Mover>, legs: ReadonlyMap<string, Leg>, mode: StartMode): void => {
  for (const mover of movers) {
    const before = unitIn(draft, mover.unit.id)
    const fromTask = mover.fromTaskId === undefined ? undefined : taskIn(draft, mover.fromTaskId)
    const unit = fromTask === undefined ? before : releaseFromTask(draft, before, actionBy(draft, actor, 'release', fromTask.id, releaseCause(target)))
    const { step, stepSerial } = mode.kind === 'now'
      ? newStep(before, to, hasLoad(before), 'active', actor.by)
      : { step: started(before, mode.step), stepSerial: before.stepSerial }
    // A dropped engage step takes its priority target with it.
    const dropped = mode.kind === 'now' ? engagingTrack(before) : undefined
    const action = (verb: LastAction['verb'], targetId?: string, cause?: string): LastAction =>
      ({ ...actionBy(draft, actor, verb, targetId, cause ?? (mode.kind === 'next' ? nextStepCause : undefined)), stepId: step.id })
    const chain = {
      orders: [step, ...(mode.kind === 'now' ? keptBehind(before, target) : before.orders.slice(1))],
      stepSerial,
      paused: undefined,
      engage: dropped !== undefined && unit.engage === dropped ? undefined : unit.engage,
      alerts: clearAlerts(unit.alerts, clearedByOrder(actor)),
    }
    if (target.kind === 'track') {
      // Engaging does not move the unit: one under way or on task stops where it is.
      const stops = unit.leg !== undefined || unit.phase === 'on-task'
      if (stops) setMotion(draft, unit.id, { progressMs: 0 })
      const halt = stops ? { leg: undefined, phase: 'holding' as const, phaseSinceMs: draft.timeMs, phaseDueMs: undefined } : {}
      putUnit(draft, patch(unit, { ...chain, ...halt, engage: target.track.id, lastAction: action('engage', target.track.id) }))
      continue
    }
    setMotion(draft, unit.id, { progressMs: 0 })
    // A unit leaves its base when it departs; while it turns out it is still there.
    const departing = { ...chain, leg: legs.get(unit.id)!, atBase: false, phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
    if (target.kind === 'task') {
      const mobilizeMs = unitTypeOf(draft.catalog, unit).components.mobility!.mobilizeS * 1_000
      const turnout = before.phase === 'mobilizing'
        ? { phase: 'mobilizing' as const, atBase: unit.atBase, phaseSinceMs: before.phaseSinceMs, phaseDueMs: before.phaseDueMs }
        : !isMoving(before) && mobilizeMs > 0 ? { phase: 'mobilizing' as const, atBase: unit.atBase, phaseDueMs: draft.timeMs + mobilizeMs } : { phase: 'en-route' as const }
      const cause = fromTask === undefined ? undefined : `from ${fromTask.label}`
      putUnit(draft, patch(unit, { ...departing, ...turnout, taskId: target.task.id, lastAction: action(fromTask === undefined ? 'send' : 'divert', target.task.id, cause) }))
    } else if (target.kind === 'site' && hasLoad(unit)) {
      putUnit(draft, patch(unit, { ...departing, phase: 'transporting', siteId: target.site.id, lastAction: action('deliver', target.site.id) }))
    } else {
      const toSite = target.kind === 'site' ? target.site.id : undefined
      putUnit(draft, patch(unit, { ...departing, phase: 'en-route', siteId: undefined, lastAction: action('move', toSite) }))
    }
  }
  // Work returned to the task is taken up only when a unit joins it; a re-send of units already on it changes nothing.
  if (target.kind === 'task' && movers.length > 0) {
    const task = taskIn(draft, target.task.id)
    const alerts = clearAlerts(task.alerts, [workReturnedCode])
    if (alerts.length !== task.alerts.length) stageTask(draft, patch(task, { alerts }))
  }
}

/**
 * Validates and plans starting a step towards `to` on each mover: the
 * checks a send makes, then the routes. `notes` say what already holds.
 */
export const planStart = (state: EngineState, to: StepTarget, movers: ReadonlyArray<Mover>, notes: ReadonlyArray<string>, actor: EngineActor, mode: StartMode): Plan => {
  const target = resolveTarget(state, to)
  if ('ok' in target) return target
  for (const mover of movers) {
    const checked = checkSender(state, mover.unit, target, mover.fromTaskId)
    if (!checked.ok) return checked
  }
  const noRoom = mode.kind === 'now' ? chainRoom(movers, target, actor) : undefined
  if (noRoom) return noRoom
  if (target.kind === 'task') {
    const uncovered = checkTaskCoverage(state, target.task, movers, actor)
    if (uncovered) return uncovered
  }
  const point = targetPoint(state, target)
  const routes: RouteNeed[] = point === undefined ? [] : movers.map(mover => ({ unitId: mover.unit.id, from: motionOf(state, mover.unit.id).point, to: point }))
  return { ok: true, routes, notes, apply: (draft, legs) => applySend(draft, actor, to, target, movers, legs, mode) }
}

/** Do it now: each unit's target becomes its active step, ahead of the steps it has queued. */
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
  return planStart(state, intent.to, movers, notes, actor, { kind: 'now' })
}

/**
 * Release from the task, if any, clear the chain and return to base. A
 * loaded unit delivers first. Steps an actor gave are skipped under an alert
 * when a standing order withdraws the unit; an actor's own recall drops them
 * as it asks.
 */
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
      const withdrawn = isStandingOrderBy(actor.by) ? skipSteps(released, draft.timeMs, step => ({ label: targetLabel(draft, step.target), reason: 'withdrawn' })) : released
      const engaging = engagingTrack(current)
      const order = actionBy(draft, actor, 'recall')
      setMotion(draft, unit.id, { progressMs: 0 })
      const leg = legs.get(unit.id)
      putUnit(draft, patch(withdrawn, {
        phase: leg === undefined ? 'available' : 'returning', leg, phaseSinceMs: draft.timeMs, phaseDueMs: undefined, alerts: clearAlerts(withdrawn.alerts, clearedByOrder(actor)), lastAction: order,
        orders: [], paused: undefined, engage: engaging !== undefined && current.engage === engaging ? undefined : current.engage,
      }))
    },
  }
}

const unchanged = (note: string): Plan => ({ ok: true, routes: [], notes: [note], apply: () => undefined })

/** Phases in which a unit travels or turns out: a hold stops it where it is. */
const stoppingPhases: ReadonlyArray<UnitRecord['phase']> = ['mobilizing', 'en-route', 'transporting', 'returning']

/**
 * Pause a unit's chain where it is. Only `paused` holds the chain and the
 * reflexes back, so a unit standing (available or holding), on task or
 * handing over keeps its phase: work in hand finishes in place, an engage
 * step stays since engaging moves nothing, and resuming carries on exactly
 * as before. A unit under way or turning out stops and holds: its active
 * step goes back to the queue, releasing a task as a recall releases it, so
 * a paused unit counts towards nothing. A unit returning home stops and
 * stands available there, so its return order brings it home again once it
 * is resumed. A unit that cannot move pauses the engage steps it holds;
 * with none it has nothing to pause. No further step starts, and no deliver
 * or return order runs, until `unit.resume` or a new order.
 */
export const planHold = (state: EngineState, intent: IntentOf<'hold'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const cannotMove = unit.orders.length === 0 ? immobile(state, unit) : undefined
  if (cannotMove) return cannotMove
  if (unit.paused === true) return unchanged(`${unit.label} already ${unitWord(state.catalog, unit, 'holding')}`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      const order = actionBy(draft, actor, 'hold')
      const paused = { paused: true as const, alerts: clearAlerts(current.alerts, clearedByOrder(actor)), lastAction: order }
      if (!stoppingPhases.includes(current.phase)) {
        putUnit(draft, patch(current, paused))
        return
      }
      setMotion(draft, unit.id, { progressMs: 0 })
      const stopped = { ...paused, leg: undefined, phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
      if (current.phase === 'returning') {
        putUnit(draft, patch(current, { ...stopped, phase: 'available' }))
        return
      }
      const head = activeStep(current)
      const halted = head === undefined || head.kind === 'engage' ? current.orders : [{ ...head, state: 'queued' as const }, ...current.orders.slice(1)]
      const released = head?.kind === 'serve' ? releaseFromTask(draft, current, order) : current
      putUnit(draft, patch(released, { ...stopped, phase: 'holding', siteId: undefined, orders: halted }))
    },
  }
}
