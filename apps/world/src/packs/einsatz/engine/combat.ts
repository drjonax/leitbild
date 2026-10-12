import { routeDistanceMeters } from '../../../core/model/index.ts'
import type { UnitComponents } from '../config-schema.ts'
import { wordFor } from '../lexicon.ts'
import { refusalCode } from '../refusal.ts'
import { trackIndexOf, trackingSides, type TrackRecord } from './combat-model.ts'
import { combatOf, detect, firedRecently, firedWindowMs, pointIn, trackOn } from './detection.ts'
import { closeDraft, putUnit, setMotion, stageTask, type Draft } from './draft.ts'
import { commandsEveryUnit, type EngineActor } from './intents.ts'
import { clearAlerts, integrities, raiseAlert, templateOf, unitTypeOf, workReturnedCode, type RecordAlert, type Transition, type UnitRecord } from './model.ts'
import { planTaskCreate } from './records.ts'
import { boundaryMs } from './reflexes.ts'
import { isDestroyed, isMoving } from './rules.ts'
import { byId, patch, sameValue } from './values.ts'

/**
 * The engagement step, run at each absolute 2 s boundary of a Run that
 * declares sides, in this order: posture, then detection (tracks, fixes),
 * then the fire gate on the tracks as detection left them, then fire-seconds
 * from every shooter at once, from positions and integrity at the start of
 * the step, then transitions (integrity, alerts, observed kills, step-loss
 * tasks). Attrition is abstract, not weapon effects: each shooter adds
 * `2 × fireRate` fire-seconds to its target's unit; a unit is damaged at
 * `stepFireS` and destroyed at twice that. There is no randomness.
 *
 * `packData` changes only on transitions; fire-seconds received, when a unit
 * last fired or was hit, and each track's position, last detection and fix
 * time are per-cycle values.
 */

const boundaryS = boundaryMs / 1_000

export const underFireCode = 'under_fire'
export const damagedCode = 'damaged'
export const destroyedCode = 'destroyed'
export const stepTaskFailedCode = 'step_task_failed'

const hasAlert = (unit: UnitRecord, code: string): boolean => unit.alerts.some(alert => alert.code === code)

/**
 * Whether the engagement step has anything to do: only in a Run with sides,
 * while a sensor or effector exists, a track lives, or a unit still shows
 * fire it gave or took. While it does, the engine stops at every 2 s boundary.
 */
export const engagementActive = (state: Pick<Draft, 'sides' | 'units' | 'catalog' | 'combat'>): boolean =>
  state.sides.length > 0 && (state.combat.tracks.size > 0 || [...state.units.values()].some(unit => {
    if (unit.revealed === true || unit.target !== undefined || hasAlert(unit, underFireCode)) return true
    if (isDestroyed(unit) || unit.side === undefined) return false
    const { sensor, effector } = unitTypeOf(state.catalog, unit).components
    return sensor !== undefined || effector !== undefined
  }))

/** The engagement step is due at a boundary it has not run at yet. */
export const engagementDue = (draft: Draft): boolean =>
  draft.timeMs % boundaryMs === 0 && (draft.combat.cycleMs === undefined || draft.combat.cycleMs < draft.timeMs) && engagementActive(draft)

type Effector = NonNullable<UnitComponents['effector']>

const roeOf = (unit: UnitRecord): NonNullable<UnitRecord['roe']> => {
  if (unit.roe === undefined) throw new Error(`${unit.id}: a unit with an effector has no rules of engagement`)
  return unit.roe
}

/** The fire gate: an identified own-side track with a fix, on a hostile side, a target of the effector, in range, and allowed by the ROE. */
const eligibleTracks = (draft: Draft, shooter: UnitRecord, effector: Effector): TrackRecord[] => {
  const roe = roeOf(shooter)
  if (roe === 'hold') return []
  const hostile = draft.catalog.config.hostility[shooter.side!] ?? []
  const from = pointIn(draft, shooter.id)
  return [...draft.combat.tracks.values()].filter(track => {
    if (track.side !== shooter.side || track.tier !== 'identified' || !track.fix || !hostile.includes(track.identity!.side)) return false
    const subject = draft.units.get(track.subjectId)
    if (subject === undefined || !unitTypeOf(draft.catalog, subject).tags.some(tag => effector.targets.includes(tag))) return false
    if (routeDistanceMeters(from, draft.combat.sightings.get(track.id)!.point) > effector.rangeM) return false
    return roe === 'free' || firedRecently(combatOf(draft, subject.id), draft.timeMs)
  })
}

/** Priority target if eligible, else the current target, else the nearest, ties by track id. */
const pickTarget = (draft: Draft, shooter: UnitRecord, eligible: ReadonlyArray<TrackRecord>): TrackRecord | undefined => {
  const named = (id: string | undefined) => id === undefined ? undefined : eligible.find(track => track.id === id)
  const from = pointIn(draft, shooter.id)
  const nearest = [...eligible]
    .map(track => ({ track, distance: routeDistanceMeters(from, draft.combat.sightings.get(track.id)!.point) }))
    .sort((a, b) => a.distance - b.distance || byId(a.track, b.track))[0]?.track
  return named(shooter.engage) ?? named(shooter.target) ?? nearest
}

const contactWord = (draft: Draft): string => wordFor(draft.catalog.config.lexicon, 'contact').toLowerCase()
const unseen = 'unseen fire'

/** Who fired on a unit, at its side's knowledge: "T-7 (Type)", "contact T-9" or "unseen fire". */
const causeText = (draft: Draft, victim: UnitRecord, shooters: ReadonlyArray<UnitRecord>): string => {
  const known = shooters.map(shooter => trackOn(draft, victim.side!, shooter.id))
  const named = known.flatMap(track => track === undefined ? [] : [track])
    .sort((a, b) => Number(a.identity === undefined) - Number(b.identity === undefined) || a.label.localeCompare(b.label, 'en', { numeric: true }))
    .map(track => track.identity === undefined ? `${contactWord(draft)} ${track.label}` : `${track.label} (${track.identity.typeLabel})`)
  const causes = [...new Set(named), ...(known.includes(undefined) ? [unseen] : [])]
  return causes.join(', ')
}

const integrityRank = (integrity: UnitRecord['integrity']): number => integrities.indexOf(integrity)

/** Stand-still since for a unit with a signature: kept while still, set when it stops, cleared while it moves. */
const posture = (draft: Draft): void => {
  for (const unit of [...draft.units.values()].sort(byId)) {
    if (isDestroyed(unit) || unitTypeOf(draft.catalog, unit).components.signature === undefined) continue
    const stillSinceMs = isMoving(unit) ? undefined : unit.stillSinceMs ?? draft.timeMs
    draft.units.set(unit.id, patch(unit, { stillSinceMs }))
  }
}

interface Shot { readonly shooter: UnitRecord; readonly effector: Effector; readonly track: TrackRecord }

/** Chooses each shooter's target from the tracks as detection left them; orders naming a dropped or destroyed track are cleared. */
const chooseTargets = (draft: Draft): Shot[] => {
  const shots: Shot[] = []
  for (const shooter of [...draft.units.values()].sort(byId)) {
    const effector = unitTypeOf(draft.catalog, shooter).components.effector
    if (effector === undefined || isDestroyed(shooter) || shooter.side === undefined) continue
    const live = (id: string | undefined): string | undefined => {
      const track = id === undefined ? undefined : draft.combat.tracks.get(id)
      return track === undefined || track.tier === 'destroyed' ? undefined : track.id
    }
    const target = pickTarget(draft, shooter, eligibleTracks(draft, shooter, effector))
    draft.units.set(shooter.id, patch(shooter, { engage: live(shooter.engage), target: target?.id }))
    if (target !== undefined) shots.push({ shooter, effector, track: target })
  }
  return shots
}

/** Every shot at once: fire-seconds per unit and who fired at it. Shooters fired now. */
const fire = (draft: Draft, shots: ReadonlyArray<Shot>): { readonly received: ReadonlyMap<string, number>; readonly shooters: ReadonlyMap<string, UnitRecord[]> } => {
  const received = new Map<string, number>()
  const shooters = new Map<string, UnitRecord[]>()
  for (const { shooter, effector, track } of shots) {
    received.set(track.subjectId, (received.get(track.subjectId) ?? 0) + boundaryS * effector.fireRate)
    shooters.set(track.subjectId, [...shooters.get(track.subjectId) ?? [], shooter])
  }
  for (const { shooter } of shots) draft.combat.units.set(shooter.id, { ...combatOf(draft, shooter.id), firedAtMs: draft.timeMs })
  return { received, shooters }
}

interface StepLoss { readonly unit: UnitRecord; readonly steps: ReadonlyArray<number> }

/** A destroyed unit stops where it is and takes no further part; work it was on returns to its task. */
const destroy = (draft: Draft, unit: UnitRecord, alerts: RecordAlert[]): UnitRecord => {
  const task = unit.taskId === undefined ? undefined : draft.tasks.get(unit.taskId)
  if (task !== undefined && task.closedAtMs === undefined) {
    const message = `${unit.label} ${wordFor(draft.catalog.config.lexicon, 'destroyed', unitTypeOf(draft.catalog, unit).lexicon).toLowerCase()} on ${task.label}`
    stageTask(draft, patch(task, { alerts: raiseAlert(task.alerts, { code: workReturnedCode, message, sinceMs: draft.timeMs }) }))
  }
  setMotion(draft, unit.id, { progressMs: 0 })
  return patch(unit, {
    integrity: 'destroyed', phase: 'destroyed', phaseSinceMs: draft.timeMs, phaseDueMs: undefined, leg: undefined, taskId: undefined, siteId: undefined,
    engage: undefined, target: undefined, revealed: undefined, stillSinceMs: undefined, alerts,
  })
}

/** Fire received becomes integrity and alerts; fire given shows as revealed for 60 s; a unit no longer hit for 60 s is no longer under fire. */
const applyFire = (draft: Draft, received: ReadonlyMap<string, number>, shooters: ReadonlyMap<string, UnitRecord[]>): { readonly losses: StepLoss[]; readonly destroyed: UnitRecord[] } => {
  const atMs = draft.timeMs
  const losses: StepLoss[] = []
  const destroyed: UnitRecord[] = []
  for (const unit of [...draft.units.values()].sort(byId)) {
    if (isDestroyed(unit)) continue
    const type = unitTypeOf(draft.catalog, unit)
    const combat = combatOf(draft, unit.id)
    const revealed = type.components.signature !== undefined && firedRecently(combat, atMs) ? true : undefined
    const hit = received.get(unit.id)
    if (hit === undefined) {
      const calm = hasAlert(unit, underFireCode) && (combat.hitAtMs === undefined || atMs - combat.hitAtMs >= firedWindowMs)
      draft.units.set(unit.id, patch(unit, { revealed, alerts: calm ? clearAlerts(unit.alerts, [underFireCode]) : unit.alerts }))
      continue
    }
    const durability = type.components.durability
    const fireS = combat.fireS + (durability === undefined ? 0 : hit)
    draft.combat.units.set(unit.id, { ...combat, fireS, hitAtMs: atMs })
    const cause = causeText(draft, unit, shooters.get(unit.id)!)
    const integrity = durability === undefined ? unit.integrity : fireS >= 2 * durability.stepFireS ? 'destroyed' : fireS >= durability.stepFireS ? 'damaged' : 'healthy'
    const lost = integrityRank(integrity) - integrityRank(unit.integrity)
    if (lost <= 0) {
      draft.units.set(unit.id, patch(unit, { revealed, alerts: raiseAlert(unit.alerts, { code: underFireCode, message: `Under fire: ${cause}`, sinceMs: atMs }) }))
      continue
    }
    const first = integrityRank(unit.integrity) + 1
    losses.push({ unit, steps: Array.from({ length: lost }, (_, index) => first + index) })
    if (integrity === 'destroyed') {
      const alerts = raiseAlert(clearAlerts(unit.alerts, [underFireCode, damagedCode]), { code: destroyedCode, message: `${wordFor(draft.catalog.config.lexicon, 'destroyed', type.lexicon)}: ${cause}`, sinceMs: atMs })
      const record = destroy(draft, patch(unit, { integritySinceMs: atMs }), alerts)
      draft.units.set(unit.id, record)
      destroyed.push(record)
      continue
    }
    const alerts = raiseAlert(raiseAlert(unit.alerts, { code: underFireCode, message: `Under fire: ${cause}`, sinceMs: atMs }), { code: damagedCode, message: `Damaged: ${cause}`, sinceMs: atMs })
    draft.units.set(unit.id, patch(unit, { revealed, integrity, integritySinceMs: atMs, alerts }))
  }
  return { losses, destroyed }
}

/** A kill a side watched under a fire-control fix turns its track to the terminal tier; other tracks on the unit just age. */
const observeKills = (draft: Draft, destroyed: ReadonlyArray<UnitRecord>): void => {
  const ids = new Set(destroyed.map(unit => unit.id))
  for (const track of [...draft.combat.tracks.values()].sort(byId)) {
    if (ids.has(track.subjectId) && track.fix) draft.combat.tracks.set(track.id, { ...track, tier: 'destroyed', fix: false })
  }
}

const stepLossActor: EngineActor = { by: 'standing-order:onStepLost', commandable: commandsEveryUnit }

/**
 * The `onStepLost` standing order: each step lost creates a task from its
 * template on the unit's side at the unit's position, with `perStep` load,
 * through the same validation as `task.create`. A task that cannot be
 * created raises an alert on the unit.
 */
const reportLosses = (draft: Draft, losses: ReadonlyArray<StepLoss>): void => {
  for (const { unit, steps } of losses) {
    const order = unitTypeOf(draft.catalog, unit).standingOrders?.onStepLost
    if (order === undefined) continue
    const template = templateOf(draft.catalog, { id: unit.id, template: order.createTask })
    for (const step of steps) {
      const plan = planTaskCreate(closeDraft(draft), {
        kind: 'task.create',
        id: `${unit.id}:loss-${step}`,
        template: order.createTask,
        ...(unit.side === undefined ? {} : { side: unit.side }),
        at: pointIn(draft, unit.id),
        loads: order.perStep,
        label: `${template.label} · ${unit.label}`,
      }, stepLossActor)
      if (plan.ok) {
        plan.apply(draft, new Map())
        continue
      }
      const current = draft.units.get(unit.id)!
      const message = `No task created: ${plan.reason.slice(refusalCode(plan.reason).length + 2)}`
      draft.units.set(unit.id, patch(current, { alerts: raiseAlert(current.alerts, { code: stepTaskFailedCode, message, sinceMs: draft.timeMs }) }))
    }
  }
}

/** Records what the step changed: each unit once, the side indexes, then each track created, changed or dropped. */
const recordStep = (draft: Draft, units: ReadonlyMap<string, UnitRecord>, tracks: ReadonlyMap<string, TrackRecord>, serials: ReadonlyMap<string, number>): void => {
  for (const id of [...draft.units.keys()].sort()) {
    const after = draft.units.get(id)!
    const before = units.get(id)!
    if (sameValue(before, after)) continue
    draft.units.set(id, before)
    putUnit(draft, after)
  }
  const lexicon = draft.catalog.config.lexicon
  const recorded: Transition[] = []
  for (const side of trackingSides(draft.combat)) {
    const index = trackIndexOf(lexicon, side, draft.combat.tracks, draft.combat.serials)
    if (!sameValue(trackIndexOf(lexicon, side, tracks, serials), index)) recorded.push({ kind: 'track-index', atMs: draft.timeMs, record: index })
  }
  for (const id of [...new Set([...tracks.keys(), ...draft.combat.tracks.keys()])].sort()) {
    const after = draft.combat.tracks.get(id)
    const before = tracks.get(id)
    if (after === undefined) recorded.push({ kind: 'track-dropped', atMs: draft.timeMs, record: { id, side: before!.side } })
    else if (before === undefined || !sameValue(before, after)) recorded.push({ kind: 'track', atMs: draft.timeMs, record: after, sighting: draft.combat.sightings.get(id)! })
  }
  draft.transitions.push(...recorded)
}

/** Runs the engagement step at the draft's time, a 2 s boundary. */
export const runEngagement = (draft: Draft): void => {
  const units = new Map(draft.units)
  const tracks = new Map(draft.combat.tracks)
  const serials = new Map(draft.combat.serials)
  posture(draft)
  detect(draft)
  const shots = chooseTargets(draft)
  const { received, shooters } = fire(draft, shots)
  const { losses, destroyed } = applyFire(draft, received, shooters)
  observeKills(draft, destroyed)
  reportLosses(draft, losses)
  recordStep(draft, units, tracks, serials)
  draft.combat.cycleMs = draft.timeMs
}
