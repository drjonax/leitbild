import { isStandingOrderBy, standingOrderBy } from '../ids.ts'
import { wordFor } from '../lexicon.ts'
import { stepIdOf, stepKindFor, type Step, type StepTarget } from '../steps.ts'
import type { TrackRecord } from './combat-model.ts'
import { putUnit, setMotion, type Draft } from './draft.ts'
import type { EngineActor } from './intents.ts'
import { raiseAlert, type LastAction, type TaskRecord, type UnitRecord } from './model.ts'
import { orderAlertCodes } from './reflexes.ts'
import { hasLoad, isDestroyed } from './rules.ts'
import { byId, patch } from './values.ts'

/**
 * The step helpers every part of the engine shares: the head of a chain, a
 * new step, and skipping steps that can no longer be carried out. They plan
 * nothing and route nothing.
 */

/** The alert a unit raises when steps an actor gave it are skipped: it names each one and why. Standing orders re-plan their own steps without one. */
export const stepSkippedCode = 'step_skipped'

/** How `lastAction.by` names the engine starting a unit's next step: run like a standing order, so it never counts as a person's order. */
export const chainBy = standingOrderBy('chain')
/** The cause an automatic start of the next step records. */
export const nextStepCause = 'next step'

/** The alerts an actor's order clears on its unit: failed reflexes, and skipped steps once someone has given it a new order. */
export const clearedByOrder = (actor: EngineActor): ReadonlyArray<string> =>
  isStandingOrderBy(actor.by) ? orderAlertCodes : [...orderAlertCodes, stepSkippedCode]

/** The step the unit carries out now, if any. */
export const activeStep = (unit: UnitRecord): Step | undefined => unit.orders[0]?.state === 'active' ? unit.orders[0] : undefined

/** The steps behind the active one, or all of them while none is active. */
export const restOf = (unit: UnitRecord): Step[] => activeStep(unit) === undefined ? [...unit.orders] : unit.orders.slice(1)

/** A new step for a unit, numbered after its last one; the verb follows from the target and the load the unit will carry then. */
export const newStep = (unit: UnitRecord, target: StepTarget, loaded: boolean, state: Step['state'], by: string): { readonly step: Step; readonly stepSerial: number } => {
  const stepSerial = (unit.stepSerial ?? 0) + 1
  return { step: { id: stepIdOf(stepSerial), kind: stepKindFor(target, loaded), target, state, by }, stepSerial }
}

/** A queued step started now: active, with the verb its target gives for the load the unit carries now. */
export const started = (unit: UnitRecord, step: Step): Step => ({ ...step, kind: stepKindFor(step.target, hasLoad(unit)), state: 'active' })

/** The records a step's target is named from. */
export interface StepRecords {
  readonly units: ReadonlyMap<string, UnitRecord>
  readonly tasks: ReadonlyMap<string, TaskRecord>
  readonly combat: { readonly tracks: ReadonlyMap<string, TrackRecord> }
}

/** A step's target by label: its task, site or track, or "a map point"; a record no longer held is named by its id. */
export const targetLabel = (records: StepRecords, target: StepTarget): string => {
  if ('point' in target) return 'a map point'
  if ('taskId' in target) return records.tasks.get(target.taskId)?.label ?? target.taskId
  if ('siteId' in target) return records.units.get(target.siteId)?.label ?? target.siteId
  return records.combat.tracks.get(target.trackId)?.label ?? target.trackId
}

const alertLimit = 500

/** "Skipped C-12 (closed); Site 2 (deleted)", within an alert's length. */
const skippedText = (parts: ReadonlyArray<string>): string => {
  const text = `Skipped ${parts.join('; ')}`
  if (text.length <= alertLimit) return text
  const short = `Skipped ${parts.length} steps: ${parts[0]}`
  return short.length <= alertLimit ? short : `${short.slice(0, alertLimit - 1)}…`
}

/**
 * The unit without the steps `why` names a reason for. Steps an actor gave
 * raise one `step_skipped` alert naming each with its reason; steps a
 * standing order added leave without one, since the order re-plans them. An
 * active step stays first only if it is kept; the caller stops the unit or
 * releases it from what it was doing. Nothing is skipped: the same record.
 */
export const skipSteps = (unit: UnitRecord, atMs: number, why: (step: Step) => { readonly label: string; readonly reason: string } | undefined): UnitRecord => {
  const kept: Step[] = []
  const named: string[] = []
  for (const step of unit.orders) {
    const skip = why(step)
    if (skip === undefined) kept.push(step)
    else if (!isStandingOrderBy(step.by)) named.push(`${skip.label} (${skip.reason})`)
  }
  if (kept.length === unit.orders.length) return unit
  // Only the first step can be active, so dropping steps keeps every other one queued.
  const orders = kept
  const alerts = named.length === 0 ? unit.alerts : raiseAlert(unit.alerts, { code: stepSkippedCode, message: skippedText(named), sinceMs: atMs })
  return patch(unit, { orders, alerts })
}

/** The chain once the active step is done: the steps behind it. A unit finishing work it holds no active step for breaks the engine's invariants. */
export const afterActive = (unit: UnitRecord): Step[] => {
  if (activeStep(unit) === undefined) throw new Error(`${unit.id}: finished a step its chain does not hold`)
  return unit.orders.slice(1)
}

/** The word for a destroyed record, as a reason or a cause. */
const destroyedWord = (draft: Draft): string => wordFor(draft.catalog.config.lexicon, 'destroyed').toLowerCase()

/**
 * Why a step can no longer be carried out, if it cannot: its task is closed
 * or gone, its site gone, its track lost or seen destroyed. A site that
 * stops accepting is judged when a delivery starts, since it may open again.
 */
const impossible = (draft: Draft, step: Step): { readonly label: string; readonly reason: string } | undefined => {
  const label = targetLabel(draft, step.target)
  if ('taskId' in step.target) {
    const task = draft.tasks.get(step.target.taskId)
    return task === undefined ? { label, reason: 'deleted' } : task.closedAtMs === undefined ? undefined : { label, reason: 'closed' }
  }
  if ('siteId' in step.target) return draft.units.has(step.target.siteId) ? undefined : { label, reason: 'deleted' }
  if ('trackId' in step.target) {
    const track = draft.combat.tracks.get(step.target.trackId)
    if (track === undefined) return { label, reason: 'lost' }
    return track.tier === 'destroyed' ? { label, reason: destroyedWord(draft) } : undefined
  }
  return undefined
}

/**
 * An active engage step whose track its side saw destroyed has succeeded:
 * it leaves the chain without an alert, its end is the unit's last action,
 * and the unit's priority target goes with it. Any other unit is returned
 * as it is.
 */
const endKill = (draft: Draft, unit: UnitRecord): UnitRecord => {
  const head = activeStep(unit)
  if (head === undefined || !('trackId' in head.target)) return unit
  const trackId = head.target.trackId
  if (draft.combat.tracks.get(trackId)?.tier !== 'destroyed') return unit
  const done: LastAction = { verb: 'engage', target: trackId, by: head.by, cause: destroyedWord(draft), atMs: draft.timeMs, stepId: head.id }
  return patch(unit, { orders: unit.orders.slice(1), lastAction: done, engage: unit.engage === trackId ? undefined : unit.engage })
}

/**
 * Ends every active engage step whose track was seen destroyed, skips every
 * step that became impossible, wherever it stands in a chain, and records
 * each unit that changed. A skipped active engage step takes the unit's
 * priority target with it; a skipped active move stops the unit where it
 * is. Whoever ended a task, site or delivery has already released the
 * units carrying it out. Returns whether anything changed.
 */
export const refreshChains = (draft: Draft): boolean => {
  let changed = false
  for (const unit of [...draft.units.values()].sort(byId)) {
    if (unit.orders.length === 0) continue
    if (isDestroyed(unit)) throw new Error(`${unit.id}: a destroyed unit holds steps`)
    const ended = endKill(draft, unit)
    const skipped = skipSteps(ended, draft.timeMs, step => impossible(draft, step))
    if (skipped === unit) continue
    const head = activeStep(ended)
    const lost = head !== undefined && skipped.orders[0]?.id !== head.id ? head : undefined
    if (lost?.kind === 'move') setMotion(draft, unit.id, { progressMs: 0 })
    const stop = lost?.kind === 'move' ? { leg: undefined, phase: 'available' as const, phaseSinceMs: draft.timeMs, phaseDueMs: undefined } : {}
    const engage = lost !== undefined && 'trackId' in lost.target && skipped.engage === lost.target.trackId ? undefined : skipped.engage
    putUnit(draft, patch(skipped, { ...stop, engage }))
    changed = true
  }
  return changed
}

/**
 * Skips the steps naming tracks that detection has just dropped, while
 * their records still name them as their side knew them: "Skipped T-3
 * (lost)". It runs inside the engagement step, which records the units it
 * changes.
 */
export const skipLostTracks = (draft: Draft, dropped: ReadonlyArray<TrackRecord>): void => {
  if (dropped.length === 0) return
  const tracks = new Map(dropped.map(track => [track.id, track]))
  for (const unit of [...draft.units.values()].sort(byId)) {
    const skipped = skipSteps(unit, draft.timeMs, step => {
      const track = 'trackId' in step.target ? tracks.get(step.target.trackId) : undefined
      return track === undefined ? undefined : { label: track.label, reason: 'lost' }
    })
    if (skipped !== unit) draft.units.set(unit.id, skipped)
  }
}
