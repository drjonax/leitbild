import { undoCause } from '../ids.ts'
import { refusalCode } from '../refusal.ts'
import { maxSteps, stepKindFor, stepTargetId, type Step, type StepKind } from '../steps.ts'
import { activeStep, clearedByOrder, newStep, skipSteps, targetLabel } from './chain-steps.ts'
import { assignedTo, contributionOf, loadAllocation } from './coverage.ts'
import { putUnit, setMotion, unitIn, type Draft } from './draft.ts'
import { engageRefusal } from './engagement-orders.ts'
import { actionBy, immobile, loadedText, notInPicture, refused, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan } from './intents.ts'
import { clearAlerts, unitTypeOf, type EngineState, type LastAction, type TaskRecord, type UnitRecord } from './model.ts'
import { planSend, planStart, resolveTarget, siteRefusal, type Target } from './orders.ts'
import { releaseFromTask } from './phases.ts'
import { hasLoad, linksToTask } from './rules.ts'
import { countOf, countsOf, patch, total, type Counts } from './values.ts'
import { loadText, unitWord } from './wording.ts'

/**
 * Job chains: adding a step at the end, removing one, pausing and resuming,
 * clearing, and the engine starting the next step once the active one is
 * done. Every change is a transition of the unit; motion is not. Only the
 * active step counts towards a task's coverage.
 */

const unchanged = (note: string): Plan => ({ ok: true, routes: [], notes: [note], apply: () => undefined })

const orderOn = (draft: Draft, actor: EngineActor, verb: LastAction['verb'], step?: Step): LastAction => ({
  ...actionBy(draft, actor, verb, step === undefined ? undefined : stepTargetId(step.target)),
  ...(step === undefined ? {} : { stepId: step.id }),
})

/** What a unit's carry takes from a task's waiting load, most urgent class first, up to its free capacity. */
const withPickup = (state: EngineState, unit: UnitRecord, load: Counts, taskId: string): Counts => {
  const carry = unitTypeOf(state.catalog, unit).components.carry
  const task = state.tasks.get(taskId)
  if (carry === undefined || task === undefined) return load
  let room = carry.capacity - total(load)
  return countsOf(state.catalog.classIds.map(classId => {
    const take = carry.classes.includes(classId) ? Math.max(0, Math.min(room, countOf(task.loads, classId))) : 0
    room -= take
    return [classId, countOf(load, classId) + take] as const
  }))
}

/** A unit whose deliver order takes its load to the nearest accepting site before any other step. */
const deliversByOrder = (state: EngineState, unit: UnitRecord): boolean => unitTypeOf(state.catalog, unit).standingOrders?.deliver === 'nearest-accepting'

/**
 * What a unit will carry once it has carried out its first `count` steps,
 * all of them by default: a step to a site delivers what it carries, a
 * deliver order delivers before any other step, and a task fills its free
 * capacity with waiting load it can carry. It reads waiting load as it
 * stands now.
 */
const loadAfter = (state: EngineState, unit: UnitRecord, count = unit.orders.length): Counts => {
  const delivers = deliversByOrder(state, unit)
  let load: Counts = unit.load
  for (const step of unit.orders.slice(0, count)) {
    if ('siteId' in step.target && total(load) > 0) {
      load = {}
      continue
    }
    if (delivers) load = {}
    if ('taskId' in step.target) load = withPickup(state, unit, load, step.target.taskId)
  }
  return load
}

/**
 * Whether a unit that already holds a task leaves waiting load there for
 * one more trip: what it can carry of the task's waiting load, beyond what
 * the units on the task take and what its own queued trips there will take.
 */
const loadLeftFor = (state: EngineState, unit: UnitRecord, task: TaskRecord, trips: number): boolean => {
  const carry = unitTypeOf(state.catalog, unit).components.carry
  if (carry === undefined) return false
  const carried = (counts: Counts): number => carry.classes.reduce((sum, classId) => sum + countOf(counts, classId), 0)
  const taken = [...loadAllocation(state.catalog, task, assignedTo(state.units.values(), task)).values()].reduce((sum, share) => sum + carried(share), 0)
  const queuedTrips = trips - (unit.taskId === task.id ? 1 : 0)
  return carried(task.loads) - taken - queuedTrips * carry.capacity > 0
}

/** Why a step for this target cannot join the end of the unit's chain, judged on what the unit will carry by then and on the task's coverage now. */
const queueRefusal = (state: EngineState, unit: UnitRecord, target: Target, load: Counts, kind: StepKind): Refused | undefined => {
  if (kind !== 'deliver' && total(load) > 0 && !deliversByOrder(state, unit)) {
    return refused('unit_loaded', `${unit.label} will have ${loadText(state.catalog, load)} on board by then; queue a delivery first`)
  }
  if (target.kind === 'track') return engageRefusal(state, unit, target.track)
  const cannotMove = immobile(state, unit)
  if (cannotMove) return cannotMove
  if (target.kind === 'site') return siteRefusal(state, unit, target.site, kind === 'deliver' ? load : {})
  if (target.kind !== 'task') return undefined
  const task = target.task
  if (!linksToTask(unit, task)) return refused('cross_side_reference', `${unit.label} cannot serve another side's ${task.label}`)
  // A task the chain already holds is taken again only as a further trip for load still waiting.
  const trips = unit.orders.filter(step => 'taskId' in step.target && step.target.taskId === task.id).length
  if (trips > 0) return loadLeftFor(state, unit, task, trips) ? undefined : refused('requirement_covered', `${task.label} needs nothing more that ${unit.label} provides`)
  // By then the unit carries nothing and serves no other task.
  const free = patch(unit, { load: {}, taskId: undefined })
  const contribution = contributionOf(state.catalog, task, assignedTo(state.units.values(), task), free)
  if (contribution.adds) return undefined
  if (contribution.unmet[0] !== undefined) return refused('requirement_unmet', contribution.unmet[0])
  if (contribution.covered) return refused('requirement_covered', `${task.label} needs nothing more that ${unit.label} provides`)
  return refused('requirement_unmet', `${unit.label} provides nothing ${task.label} needs`)
}

/**
 * Add a step at the end of a unit's chain. A unit holding no step and not
 * paused starts it at once, exactly as a send. Otherwise the step is judged
 * as the unit will stand when it comes up: its load then (a capacity it
 * cannot use before delivering is refused), its side, and the task's
 * coverage now. Queued, it counts towards nothing.
 */
export const planQueue = (state: EngineState, intent: IntentOf<'queue'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  if (unit.orders.length === 0 && unit.paused !== true) return planSend(state, { kind: 'send', units: [unit.id], to: intent.to }, actor)
  if (unit.orders.length >= maxSteps) return refused('chain_full', `${unit.label} already holds ${unit.orders.length} steps; remove one first`)
  const target = resolveTarget(state, intent.to)
  if ('ok' in target) return target
  const load = loadAfter(state, unit)
  const loaded = total(load) > 0
  const refusal = queueRefusal(state, unit, target, load, stepKindFor(intent.to, loaded))
  if (refusal) return refusal
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      const { step, stepSerial } = newStep(current, intent.to, loaded, 'queued', actor.by)
      putUnit(draft, patch(current, { orders: [...current.orders, step], stepSerial, alerts: clearAlerts(current.alerts, clearedByOrder(actor)), lastAction: orderOn(draft, actor, 'queue', step) }))
    },
  }
}

/**
 * Why the step at `index` may not leave the chain: it leads to a site and
 * delivers what the unit will carry there. The load the unit carries now
 * keeps its first site step; load it will pick up on the way keeps the step
 * unless its deliver order would deliver that load anyway.
 */
const deliveryRefusal = (state: EngineState, unit: UnitRecord, index: number): Refused | undefined => {
  if (!('siteId' in unit.orders[index]!.target)) return undefined
  if (hasLoad(unit) && unit.orders.findIndex(entry => 'siteId' in entry.target) === index) return refused('unit_loaded', loadedText(state, unit))
  const load = loadAfter(state, unit, index)
  if (total(load) === 0 || deliversByOrder(state, unit)) return undefined
  return refused('unit_loaded', `${unit.label} will have ${loadText(state.catalog, load)} on board by then; that step delivers it`)
}

/**
 * Remove one step. A queued step simply leaves. The active step is released
 * as a recall releases it: a task gets its work back, the unit stops where
 * it is and starts its next step, or, with none, its return order applies.
 * A unit keeps the step that delivers the load it carries, or will carry,
 * there (see `deliveryRefusal`). An undo takes back only the step the
 * unit's last order created (else `step_not_undoable`), raises no
 * work-returned alert and records `undo` as the order's cause.
 */
export const planStepRemove = (state: EngineState, intent: IntentOf<'step.remove'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const index = unit.orders.findIndex(step => step.id === intent.stepId)
  if (index < 0) return refused('step_not_found', `${unit.label} holds no step ${intent.stepId}`)
  const step = unit.orders[index]!
  if (intent.undo === true && unit.lastAction?.stepId !== step.id) return refused('step_not_undoable', `${unit.label}'s last order did not create ${step.id}: it can be removed, not undone`)
  const delivery = deliveryRefusal(state, unit, index)
  if (delivery) return delivery
  const undone = intent.undo === true
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      const order = { ...orderOn(draft, actor, 'remove', step), ...(undone ? { cause: undoCause } : {}) }
      const orders = current.orders.filter(entry => entry.id !== step.id)
      const alerts = clearAlerts(current.alerts, clearedByOrder(actor))
      if (step.state !== 'active') {
        putUnit(draft, patch(current, { orders, alerts, lastAction: order }))
        return
      }
      if ('trackId' in step.target) {
        putUnit(draft, patch(current, { orders, alerts, lastAction: order, engage: current.engage === step.target.trackId ? undefined : current.engage }))
        return
      }
      const released = releaseFromTask(draft, current, order, undone)
      setMotion(draft, unit.id, { progressMs: 0 })
      putUnit(draft, patch(released, { orders, alerts, lastAction: order, leg: undefined, phase: 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined }))
    },
  }
}

/**
 * Resume a paused unit: it carries on from the phase it was paused in, as
 * if it had never been. Its next step starts, or, holding none, its deliver
 * and return orders apply as they would have: a unit parked at a point
 * stays there, one stopped on its way home sets off again.
 */
export const planResume = (state: EngineState, intent: IntentOf<'resume'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  if (unit.paused !== true) return unchanged(`${unit.label} is not ${unitWord(state.catalog, unit, 'holding')}`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      putUnit(draft, patch(current, { paused: undefined, alerts: clearAlerts(current.alerts, clearedByOrder(actor)), lastAction: orderOn(draft, actor, 'resume') }))
    },
  }
}

/**
 * Remove every step, releasing the active one as a recall does: the unit
 * stops where it is, available, and its return order applies. A paused
 * unit holding no step is only resumed, in the phase it idles in, so a unit
 * parked at a point stays there. A loaded unit delivers first.
 */
export const planClear = (state: EngineState, intent: IntentOf<'clear'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  if (hasLoad(unit)) return refused('unit_loaded', loadedText(state, unit))
  if (unit.orders.length === 0 && unit.paused !== true) return unchanged(`${unit.label} holds no steps`)
  return {
    ok: true, routes: [], notes: [],
    apply: draft => {
      const current = unitIn(draft, unit.id)
      const order = orderOn(draft, actor, 'clear')
      const head = activeStep(current)
      const released = releaseFromTask(draft, current, order)
      const stops = current.orders.length > 0 && current.phase !== 'available'
      if (stops) setMotion(draft, unit.id, { progressMs: 0 })
      putUnit(draft, patch(released, {
        orders: [], paused: undefined, alerts: clearAlerts(current.alerts, clearedByOrder(actor)), lastAction: order,
        engage: head !== undefined && 'trackId' in head.target && current.engage === head.target.trackId ? undefined : current.engage,
        ...(stops ? { leg: undefined, phase: 'available' as const, phaseSinceMs: draft.timeMs, phaseDueMs: undefined } : {}),
      }))
    },
  }
}

/** The message of a refusal, without its code. */
const messageOf = (reason: string): string => reason.slice(refusalCode(reason).length + 2)

/** Skips a unit's queued first step, naming why; the chain goes on with the next one. */
export const skipHead = (draft: Draft, unitId: string, head: Step, reason: string): void => {
  const current = unitIn(draft, unitId)
  putUnit(draft, skipSteps(current, draft.timeMs, step => step.id === head.id ? { label: targetLabel(draft, step.target), reason: messageOf(reason) } : undefined))
}

/**
 * Starts an idle unit's queued first step as a send would, keeping its id:
 * the same checks, then the route. A step that can no longer be carried out
 * (its task covered or closed, its site not accepting, its track no longer
 * engageable, or one the unit cannot take while it carries load) is skipped
 * under an alert, and the next one comes up.
 */
export const planChainNext = (state: EngineState, intent: IntentOf<'chain.next'>, actor: EngineActor): Plan => {
  const unit = unitIn(state, intent.unitId)
  const head = unit.orders[0]
  if (head === undefined || head.state !== 'queued' || unit.paused === true) throw new Error(`${unit.id}: no queued step to start`)
  const skip = (reason: string): Plan => ({ ok: true, routes: [], notes: [], apply: draft => skipHead(draft, unit.id, head, reason) })
  if (hasLoad(unit) && !('siteId' in head.target)) return skip(refused('unit_loaded', loadedText(state, unit)).reason)
  const plan = planStart(state, head.target, [{ unit }], [], actor, { kind: 'next', step: head })
  return plan.ok ? plan : skip(plan.reason)
}
