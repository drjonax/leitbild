import { routeDistanceMeters, type GeoJsonPoint } from '../../../core/model/index.ts'
import type { UnitComponents } from '../config-schema.ts'
import { trackId, type TrackRecord, type TrackTier, type UnitCombat } from './combat-model.ts'
import type { Draft } from './draft.ts'
import { unitTypeOf, type UnitRecord } from './model.ts'
import { boundaryMs } from './reflexes.ts'
import { isDestroyed } from './rules.ts'
import { byId } from './values.ts'

/**
 * Detection at each 2 s boundary. Every sensor tests every unit of another
 * side that is not destroyed, not public and has a signature; hostility
 * gates only fire. With `f = factor × (halted ? haltedFactor : 1) × (fired
 * in the last 60 s ? firedFactor : 1)`, a unit within `detectM × f` is a
 * contact and within `identifyM × f` identified. Abstract: range ×
 * signature × posture; no terrain or line of sight.
 *
 * Track rules: one track per (observing side, unit); any detection refreshes
 * its position and time; identification is sticky; a track is dropped after
 * `trackTimeoutMs` without detection. The fire-control fix is the last
 * detection, at either tier, by a sensor of the side with `identifyM > 0`,
 * and holds for three cycles; contact-only sensors never refresh it.
 */

export const firedWindowMs = 60_000
export const fixWindowMs = 3 * boundaryMs
export const trackTimeoutMs = 300_000

type Sensor = NonNullable<UnitComponents['sensor']>
type Signature = NonNullable<UnitComponents['signature']>

export const pointIn = (draft: Pick<Draft, 'motion'>, unitId: string): GeoJsonPoint => {
  const motion = draft.motion.get(unitId)
  if (motion === undefined) throw new Error(`${unitId}: no motion state`)
  return motion.point
}

export const combatOf = (draft: Pick<Draft, 'combat'>, unitId: string): UnitCombat => draft.combat.units.get(unitId) ?? { fireS: 0 }

/** Halted: still for at least `concealAfterS`. */
export const isHalted = (signature: Signature, unit: UnitRecord, atMs: number): boolean =>
  unit.stillSinceMs !== undefined && atMs - unit.stillSinceMs >= signature.concealAfterS * 1_000

export const firedRecently = (combat: UnitCombat, atMs: number): boolean => combat.firedAtMs !== undefined && atMs - combat.firedAtMs < firedWindowMs

/** The signature factor `f` of a unit at a Run time. */
export const signatureFactor = (signature: Signature, unit: UnitRecord, combat: UnitCombat, atMs: number): number =>
  signature.factor * (isHalted(signature, unit, atMs) ? signature.haltedFactor : 1) * (firedRecently(combat, atMs) ? signature.firedFactor : 1)

/** What one sensor makes of a unit at a distance: identified, a contact, or nothing. A sensor with `identifyM: 0` reports contacts only. */
export const sense = (sensor: Sensor, distanceM: number, factor: number): Exclude<TrackTier, 'destroyed'> | undefined => {
  if (sensor.identifyM > 0 && distanceM <= sensor.identifyM * factor) return 'identified'
  return distanceM <= sensor.detectM * factor ? 'contact' : undefined
}

/** A side's best detection of one unit this cycle, and whether an identifying sensor saw it. */
interface Detection {
  readonly tier: Exclude<TrackTier, 'destroyed'>
  readonly fixing: boolean
}

const detectionOf = (draft: Draft, sensors: ReadonlyArray<UnitRecord>, subject: UnitRecord, signature: Signature): Detection | undefined => {
  const factor = signatureFactor(signature, subject, combatOf(draft, subject.id), draft.timeMs)
  const at = pointIn(draft, subject.id)
  let tier: Detection['tier'] | undefined
  let fixing = false
  for (const unit of sensors) {
    const sensor = unitTypeOf(draft.catalog, unit).components.sensor!
    const sensed = sense(sensor, routeDistanceMeters(pointIn(draft, unit.id), at), factor)
    if (sensed === undefined) continue
    if (sensed === 'identified' || tier === undefined) tier = sensed
    if (sensor.identifyM > 0) fixing = true
  }
  return tier === undefined ? undefined : { tier, fixing }
}

const identityOf = (draft: Draft, subject: UnitRecord): NonNullable<TrackRecord['identity']> => {
  const type = unitTypeOf(draft.catalog, subject)
  const effector = type.components.effector
  return { typeLabel: type.label, icon: type.icon, side: subject.side!, ...(effector === undefined ? {} : { rangeM: effector.rangeM }) }
}

/** A new track for a side, numbered from the side's own serial, so its id says nothing of the unit or of other sides. */
const openTrack = (draft: Draft, side: string, subject: UnitRecord, detection: Detection): TrackRecord => {
  const number = draft.combat.serials.get(side) ?? 1
  draft.combat.serials.set(side, number + 1)
  return {
    id: trackId(side, number),
    label: `T-${number}`,
    side,
    subjectId: subject.id,
    type: 'track',
    tier: detection.tier,
    fix: false,
    ...(detection.tier === 'identified' ? { identity: identityOf(draft, subject) } : {}),
  }
}

const observe = (draft: Draft, side: string, subject: UnitRecord, detection: Detection, existing: TrackRecord | undefined): void => {
  const atMs = draft.timeMs
  const track = existing ?? openTrack(draft, side, subject, detection)
  const sighting = draft.combat.sightings.get(track.id)
  draft.combat.sightings.set(track.id, {
    point: pointIn(draft, subject.id),
    observedAtMs: atMs,
    ...(detection.fixing ? { fixAtMs: atMs } : sighting?.fixAtMs === undefined ? {} : { fixAtMs: sighting.fixAtMs }),
  })
  const identified = track.tier === 'contact' && detection.tier === 'identified' ? { tier: 'identified' as const, identity: identityOf(draft, subject) } : {}
  draft.combat.tracks.set(track.id, { ...track, ...identified })
}

/** Units that sense: not destroyed, on a side, with a sensor. */
const sensorsOf = (draft: Draft, units: ReadonlyArray<UnitRecord>): UnitRecord[] =>
  units.filter(unit => !isDestroyed(unit) && unit.side !== undefined && unitTypeOf(draft.catalog, unit).components.sensor !== undefined)

/** Units that can be detected: not destroyed, not public, on a side, with a signature. */
const detectable = (draft: Draft, units: ReadonlyArray<UnitRecord>): UnitRecord[] => units.filter(unit => {
  const type = unitTypeOf(draft.catalog, unit)
  return !isDestroyed(unit) && !type.public && unit.side !== undefined && type.components.signature !== undefined
})

const trackKey = (side: string, subjectId: string): string => `${side}\u0000${subjectId}`

/** Drops a track; orders naming it are cleared when the engagement step chooses targets. */
const dropTrack = (draft: Draft, track: TrackRecord): void => {
  draft.combat.tracks.delete(track.id)
  draft.combat.sightings.delete(track.id)
}

/**
 * Runs detection at the draft's time: opens and refreshes tracks, upgrades
 * tiers, refreshes fixes, then sets each track's fix flag and drops tracks
 * not detected for `trackTimeoutMs`. Transitions are recorded by the
 * engagement step once the whole step has run.
 */
export const detect = (draft: Draft): void => {
  const atMs = draft.timeMs
  const units = [...draft.units.values()].sort(byId)
  const sensors = sensorsOf(draft, units)
  const subjects = detectable(draft, units)
  const tracked = new Map([...draft.combat.tracks.values()].map(track => [trackKey(track.side, track.subjectId), track]))
  for (const side of [...new Set(sensors.map(unit => unit.side!))].sort()) {
    const own = sensors.filter(unit => unit.side === side)
    for (const subject of subjects) {
      if (subject.side === side) continue
      const detection = detectionOf(draft, own, subject, unitTypeOf(draft.catalog, subject).components.signature!)
      if (detection !== undefined) observe(draft, side, subject, detection, tracked.get(trackKey(side, subject.id)))
    }
  }
  for (const track of [...draft.combat.tracks.values()].sort(byId)) {
    const sighting = draft.combat.sightings.get(track.id)
    if (sighting === undefined) throw new Error(`${track.id}: no sighting`)
    if (atMs - sighting.observedAtMs >= trackTimeoutMs) {
      dropTrack(draft, track)
      continue
    }
    const fix = track.tier !== 'destroyed' && sighting.fixAtMs !== undefined && atMs - sighting.fixAtMs < fixWindowMs
    if (fix !== track.fix) draft.combat.tracks.set(track.id, { ...track, fix })
  }
}

/** A side's track on a unit, if it holds one. */
export const trackOn = (draft: Pick<Draft, 'combat'>, side: string, subjectId: string): TrackRecord | undefined =>
  [...draft.combat.tracks.values()].find(track => track.side === side && track.subjectId === subjectId)
