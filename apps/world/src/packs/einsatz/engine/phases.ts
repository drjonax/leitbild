import { assignedTo, coverageOf, isDone, rankOf } from './coverage.ts'
import { closeDraft, openDraft, putUnit, recordTask, setMotion, stageTask, taskIn, unitIn, type Draft } from './draft.ts'
import { templateOf, unitTypeOf, type EngineState, type LastAction, type TaskRecord, type Transition, type UnitRecord } from './model.ts'
import { advanceProgress, hasArrived, legEnd, legPosition, msToArrival, speedFactor } from './movement.ts'
import { dueReflexes, reflexDueMs, type DueReflex } from './reflexes.ts'
import { isDestroyed, isMoving, meetsRequirement } from './rules.ts'
import { addCounts, byId, countOf, countsOf, patch, total } from './values.ts'
import { loadText } from './wording.ts'

/**
 * The phase machine. Units move through the closed phases: `mobilizing`
 * (turnout, from `mobility.mobilizeS`), `en-route`, `on-task` (from
 * `service.onSceneS`; a unit without a service spends no time on task),
 * `holding` (stopped by order, or waiting with load to deliver),
 * `transporting`, `at-site` (queued, then handing over for
 * `receiving.handoverS` in one of the site's FIFO slots), `returning` and
 * `available`. `destroyed` units take no further part.
 */

const settleBudget = 10_000
const advanceBudget = 100_000
const maxAdvanceMs = 86_400_000

/** Releases a unit from its task: un-picked load stays with the task at its original age, under a "work returned" alert. */
export const releaseFromTask = (draft: Draft, unit: UnitRecord, action: LastAction): UnitRecord => {
  if (unit.taskId === undefined) return unit
  const task = taskIn(draft, unit.taskId)
  if (task.closedAtMs === undefined) {
    const waiting = total(task.loads) > 0 ? ` · ${loadText(draft.catalog, task.loads)} waiting` : ''
    stageTask(draft, patch(task, { alert: { code: 'work_returned', message: `${unit.label} released from ${task.label}${waiting}`, sinceMs: draft.timeMs } }))
  }
  return patch(unit, { taskId: undefined, lastAction: action })
}

/** Recomputes coverage and rank of open tasks, closes done ones and records every task that changed. */
export const refreshTasks = (draft: Draft): void => {
  for (const task of [...draft.tasks.values()].sort(byId)) {
    if (task.closedAtMs !== undefined) {
      recordTask(draft, task)
      continue
    }
    const assigned = assignedTo(draft.units.values(), task)
    const current = patch(task, { coverage: coverageOf(draft.catalog, task, assigned), rank: rankOf(draft.catalog, task) })
    if (!isDone(draft.catalog, current, current.coverage)) {
      recordTask(draft, current)
      continue
    }
    for (const unit of assigned) {
      setMotion(draft, unit.id, { progressMs: 0 })
      putUnit(draft, patch(unit, { taskId: undefined, leg: undefined, phase: 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
    }
    recordTask(draft, patch(current, { closedAtMs: draft.timeMs, alert: undefined, coverage: coverageOf(draft.catalog, current, []) }))
  }
}

/** On-task time is over: count the unit towards the requirements it meets and pick up load, most urgent class first, up to free capacity. */
const finishTask = (draft: Draft, unit: UnitRecord): void => {
  const task = taskIn(draft, unit.taskId!)
  const type = unitTypeOf(draft.catalog, unit)
  const served = Object.fromEntries(templateOf(draft.catalog, task).requires.flatMap(requirement => meetsRequirement(draft.catalog, unit, requirement)
    ? [[requirement.provides, Math.min(requirement.count, countOf(task.served, requirement.provides) + 1)] as const]
    : []))
  let room = type.components.carry === undefined ? 0 : type.components.carry.capacity - total(unit.load)
  const picked = new Map<string, number>()
  for (const classId of draft.catalog.classIds) {
    if (room <= 0 || type.components.carry?.classes.includes(classId) !== true) continue
    const taken = Math.min(room, countOf(task.loads, classId))
    if (taken > 0) picked.set(classId, taken)
    room -= taken
  }
  const ids = draft.catalog.classIds
  const pickedUp = countsOf(picked)
  stageTask(draft, patch(task, {
    served: { ...task.served, ...served },
    loads: countsOf(ids.map(id => [id, countOf(task.loads, id) - countOf(pickedUp, id)] as const)),
    pickedUp: addCounts(ids, task.pickedUp, pickedUp),
  }))
  const load = addCounts(ids, unit.load, pickedUp)
  putUnit(draft, patch(unit, { taskId: undefined, load, phase: total(load) > 0 ? 'holding' : 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
}

/** A handover slot finished: the site counts the load received and the unit is free where it stands. */
const finishHandover = (draft: Draft, unit: UnitRecord): void => {
  const site = unitIn(draft, unit.siteId!)
  putUnit(draft, patch(site, { received: addCounts(draft.catalog.classIds, site.received!, unit.load) }))
  putUnit(draft, patch(unit, { load: {}, siteId: undefined, phase: 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
}

const arrive = (draft: Draft, unit: UnitRecord): void => {
  setMotion(draft, unit.id, { point: legEnd(unit.leg!), progressMs: 0 })
  const arrived = { leg: undefined, phaseSinceMs: draft.timeMs, phaseDueMs: undefined }
  if (unit.phase === 'returning') putUnit(draft, patch(unit, { ...arrived, phase: 'available', atBase: true }))
  else if (unit.phase === 'transporting') putUnit(draft, patch(unit, { ...arrived, phase: 'at-site' }))
  else if (unit.taskId === undefined) putUnit(draft, patch(unit, { ...arrived, phase: 'holding' }))
  else {
    const onTaskMs = (unitTypeOf(draft.catalog, unit).components.service?.onSceneS ?? 0) * 1_000
    putUnit(draft, patch(unit, { ...arrived, phase: 'on-task', phaseDueMs: draft.timeMs + onTaskMs }))
  }
}

/** The transition a unit is due for at the draft's time, if any. */
const stepUnit = (draft: Draft, unit: UnitRecord): boolean => {
  if (isDestroyed(unit)) return false
  const due = unit.phaseDueMs !== undefined && unit.phaseDueMs <= draft.timeMs
  if (unit.phase === 'mobilizing' && due) putUnit(draft, patch(unit, { phase: 'en-route', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
  else if (unit.phase === 'on-task' && due) finishTask(draft, unit)
  else if (unit.phase === 'at-site' && due) finishHandover(draft, unit)
  else if (isMoving(unit) && unit.leg !== undefined && hasArrived(unit.leg, draft.motion.get(unit.id)!.progressMs)) arrive(draft, unit)
  else return false
  return true
}

const accepts = (draft: Draft, site: UnitRecord, unit: UnitRecord): boolean => {
  const accepted = unitTypeOf(draft.catalog, site).components.receiving!.accepts
  return Object.keys(unit.load).every(classId => accepted.includes(classId))
}

/** Starts handovers at accepting sites: queued units in arrival order (ties by id) take free slots; a unit whose load the site does not accept waits. */
export const startQueues = (draft: Draft): boolean => {
  let changed = false
  for (const site of [...draft.units.values()].sort(byId)) {
    const receiving = unitTypeOf(draft.catalog, site).components.receiving
    if (receiving === undefined || site.accepting !== true) continue
    const present = [...draft.units.values()].filter(unit => unit.phase === 'at-site' && unit.siteId === site.id)
    let free = receiving.slots - present.filter(unit => unit.phaseDueMs !== undefined).length
    const queue = present.filter(unit => unit.phaseDueMs === undefined).sort((a, b) => a.phaseSinceMs - b.phaseSinceMs || byId(a, b))
    for (const unit of queue) {
      if (free <= 0) break
      if (!accepts(draft, site, unit)) continue
      putUnit(draft, patch(unit, { phaseDueMs: draft.timeMs + receiving.handoverS * 1_000 }))
      free -= 1
      changed = true
    }
  }
  return changed
}

/** Applies every transition due at the draft's time until none is left, then brings task coverage up to date. */
export const settle = (draft: Draft): void => {
  for (let pass = 0; ; pass++) {
    if (pass > settleBudget) throw new Error('Einsatz transition budget exceeded')
    let changed = false
    for (const id of [...draft.units.keys()].sort()) {
      if (stepUnit(draft, unitIn(draft, id))) changed = true
    }
    if (startQueues(draft)) changed = true
    refreshTasks(draft)
    if (!changed) return
  }
}

/** The next Run time something happens: a timed phase ends, a unit arrives, or a standing order falls due. */
const nextEventMs = (draft: Draft, targetMs: number): number => {
  let next = targetMs
  for (const unit of draft.units.values()) {
    if (isDestroyed(unit)) continue
    const motion = draft.motion.get(unit.id)!
    if (unit.phaseDueMs !== undefined && unit.phaseDueMs > draft.timeMs) next = Math.min(next, unit.phaseDueMs)
    if (isMoving(unit) && unit.leg !== undefined) {
      const arrival = msToArrival(unit.leg, motion.progressMs, speedFactor(motion.impacts))
      if (arrival !== undefined) next = Math.min(next, draft.timeMs + arrival)
    }
    const reflex = reflexDueMs(draft.catalog, unit, motion)
    if (reflex !== undefined && reflex > draft.timeMs) next = Math.min(next, reflex)
  }
  return next
}

/** Moves every travelling unit to `timeMs` at its current pace. Motion is runtime state: no transition. */
const moveTo = (draft: Draft, timeMs: number): void => {
  const elapsedMs = timeMs - draft.timeMs
  for (const unit of draft.units.values()) {
    if (!isMoving(unit) || unit.leg === undefined || isDestroyed(unit)) continue
    const motion = draft.motion.get(unit.id)!
    const progressMs = advanceProgress(unit.leg, motion.progressMs, elapsedMs, speedFactor(motion.impacts))
    if (progressMs !== motion.progressMs) draft.motion.set(unit.id, { ...motion, progressMs, point: legPosition(unit.leg, progressMs).point })
  }
  draft.timeMs = timeMs
}

export interface StepResult {
  readonly state: EngineState
  readonly transitions: ReadonlyArray<Transition>
  /** Standing orders due at the returned state's time; the target is not reached while any is pending. */
  readonly reflexes: ReadonlyArray<DueReflex>
}

/**
 * Advances deterministically towards `targetMs`, stepping to each phase
 * deadline and arrival (rounded up to the Run clock's millisecond). It stops
 * early, at the exact Run time, when standing orders fall due; they need
 * routes, so the caller runs them and continues. Large and small steps reach
 * the same state.
 */
export const stepUntil = (state: EngineState, targetMs: number): StepResult => {
  if (!Number.isFinite(targetMs) || targetMs < state.timeMs) throw new Error('Einsatz simulation time must be finite and monotonic')
  if (targetMs - state.timeMs > maxAdvanceMs) throw new Error('Advance at most 24 simulated hours in one call')
  const draft = openDraft(state)
  for (let iteration = 0; ; iteration++) {
    if (iteration > advanceBudget) throw new Error('Einsatz advance budget exceeded; use bounded simulation steps')
    settle(draft)
    const reflexes = dueReflexes(draft)
    if (reflexes.length > 0 || draft.timeMs >= targetMs) return { state: closeDraft(draft), transitions: draft.transitions, reflexes }
    const next = nextEventMs(draft, targetMs)
    if (!Number.isFinite(next) || next <= draft.timeMs) throw new Error('Einsatz clock could not advance')
    moveTo(draft, next)
  }
}

/** Settles a draft built by an intent: transitions it makes due now, queue starts and coverage. */
export const settleState = (state: EngineState): { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition> } => {
  const draft = openDraft(state)
  settle(draft)
  return { state: closeDraft(draft), transitions: draft.transitions }
}

