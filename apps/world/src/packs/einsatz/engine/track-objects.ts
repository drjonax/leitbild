import type { IsoTimestamp, ObjectId, OperationalObject, PackId } from '../../../core/model/index.ts'
import type { Lexicon } from '../lexicon.ts'
import { einsatzPackId } from '../ids.ts'
import { refusal } from '../refusal.ts'
import {
  trackDataSchema, trackIndexDataSchema, trackIndexId, trackIndexOf, trackingSides,
  type CombatRuntime, type CombatState, type Sighting, type TrackIndexRecord, type TrackRecord, type UnitCombat,
} from './combat-model.ts'

/**
 * Tracks and track indexes as objects. A track is an `observation` whose
 * audience is its observing side alone and whose id and label are that
 * side's own serial. It carries exactly: its position at the last detection
 * and when that was, its tier, its fire-control fix, and once identified the
 * type's label and icon, the unit's side and effector range. Its provenance
 * names only its source, never a command, since a command of another side
 * may cause the change. The per-side index of which unit each track follows
 * is an object only truth roles see.
 */

export interface TrackStamp {
  readonly at: IsoTimestamp
  readonly previous?: OperationalObject
}

const isoOf = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp

const envelope = (id: string, label: string, stamp: TrackStamp) => ({
  id: id as ObjectId,
  packId: einsatzPackId as PackId,
  label,
  revision: stamp.previous === undefined ? 0 : stamp.previous.revision + 1,
  provenance: { source: 'simulator' as const },
  timestamps: { createdAt: stamp.previous?.timestamps.createdAt ?? stamp.at, updatedAt: stamp.at },
})

export const trackObject = (record: TrackRecord, sighting: Sighting, stamp: TrackStamp): OperationalObject => {
  const { id, label, side, subjectId: _subjectId, ...data } = record
  return {
    ...envelope(id, label, stamp),
    kind: 'observation',
    lifecycle: record.tier === 'destroyed' ? 'inactive' : 'active',
    spatial: { frame: { kind: 'wgs84' }, position: { point: sighting.point, observedAt: isoOf(sighting.observedAtMs) } },
    operational: { status: record.tier, mode: 'simulated' },
    alerts: [],
    packData: data,
    audience: [side],
  }
}

export const trackIndexObject = (record: TrackIndexRecord, stamp: TrackStamp): OperationalObject => {
  const { id, label, ...data } = record
  return {
    ...envelope(id, label, stamp),
    kind: 'observation',
    lifecycle: 'active',
    spatial: { frame: { kind: 'wgs84' } },
    operational: { status: 'index', mode: 'simulated' },
    alerts: [],
    packData: data,
    audience: [],
  }
}

/** Every track and track index as the state holds it now, for a snapshot. */
export const trackObjects = (combat: CombatState, lexicon: Lexicon, stampFor: (id: string) => TrackStamp): OperationalObject[] => [
  ...trackingSides(combat).map(side => {
    const index = trackIndexOf(lexicon, side, combat.tracks, combat.serials)
    return trackIndexObject(index, stampFor(index.id))
  }),
  ...[...combat.tracks.values()].map(track => trackObject(track, sightingOf(combat, track.id), stampFor(track.id))),
]

export const sightingOf = (combat: Pick<CombatState, 'sightings'>, trackId: string): Sighting => {
  const sighting = combat.sightings.get(trackId)
  if (sighting === undefined) throw new Error(`${trackId}: no sighting`)
  return sighting
}

/**
 * Why the Run may not delete an object the engine holds as a track or a
 * track index, or nothing for any other id. A track ages out on its own: a
 * deleted one would come back with its next sighting, and its index would
 * name a track the Run no longer holds, so the Run could not be restored. A
 * track the engine drops is gone from its state before the deletion is
 * published, so that deletion passes.
 */
export const trackDeletionRefusal = (combat: Pick<CombatState, 'tracks' | 'serials'>, objectId: string): string | undefined => {
  const track = combat.tracks.get(objectId)
  if (track !== undefined) return refusal('track_not_deletable', `${track.label} is a track of ${track.side}; the runtime keeps it until it ages out`)
  const side = trackingSides(combat).find(entry => trackIndexId(entry) === objectId)
  return side === undefined ? undefined : refusal('track_not_deletable', `${objectId} is the runtime's index of the tracks of ${side}`)
}

const packDataType = (object: OperationalObject): unknown => (object.packData as { readonly type?: unknown } | undefined)?.type

/** Whether an Einsatz object is a track or a track index rather than a unit or task. */
export const isTrackObject = (object: OperationalObject): boolean => packDataType(object) === 'track' || packDataType(object) === 'track-index'

const fail = (id: string, message: string): never => { throw new Error(`${id}: ${message}`) }

/** Rebuilds the engagement state from track objects, track indexes and the saved per-cycle values. */
export const readCombatState = (objects: ReadonlyArray<OperationalObject>, runtime: CombatRuntime): CombatState => {
  const owners = new Map<string, { readonly side: string; readonly subjectId: string }>()
  const serials = new Map<string, number>()
  for (const object of objects.filter(entry => packDataType(entry) === 'track-index')) {
    const index = trackIndexDataSchema.parse(object.packData)
    if (serials.has(index.side)) fail(object.id, `a second track index for side ${index.side}`)
    serials.set(index.side, index.next)
    for (const [trackId, subjectId] of Object.entries(index.subjects)) {
      if (owners.has(trackId)) fail(trackId, 'named by two track indexes')
      owners.set(trackId, { side: index.side, subjectId })
    }
  }
  const tracks = new Map<string, TrackRecord>()
  const sightings = new Map<string, Sighting>()
  for (const object of objects.filter(entry => packDataType(entry) === 'track')) {
    const data = trackDataSchema.parse(object.packData)
    const owner = owners.get(object.id) ?? fail(object.id, 'no track index names this track')
    const position = object.spatial.position ?? fail(object.id, 'a track needs the point of its last detection')
    const fixAtMs = runtime.tracks[object.id]?.fixAtMs
    if (data.fix && fixAtMs === undefined) fail(object.id, 'the track holds a fire-control fix, but its time is missing from the runtime state')
    tracks.set(object.id, { ...data, id: object.id, label: object.label, side: owner.side, subjectId: owner.subjectId })
    sightings.set(object.id, { point: position.point, observedAtMs: Date.parse(position.observedAt), ...(fixAtMs === undefined ? {} : { fixAtMs }) })
  }
  for (const trackId of owners.keys()) if (!tracks.has(trackId)) fail(trackId, 'a track index names a track the Run does not hold')
  const units = new Map(Object.entries(runtime.units).map(([id, entry]): [string, UnitCombat] => [id, {
    fireS: entry.fireS,
    ...(entry.firedAtMs === undefined ? {} : { firedAtMs: entry.firedAtMs }),
    ...(entry.hitAtMs === undefined ? {} : { hitAtMs: entry.hitAtMs }),
  }]))
  return { ...(runtime.cycleMs === undefined ? {} : { cycleMs: runtime.cycleMs }), tracks, sightings, units, serials }
}

/** The per-cycle engagement values to save: those of units the state still holds, and each track's last fix. */
export const combatRuntimeOf = (combat: CombatState, unitIds: ReadonlySet<string>): CombatRuntime => ({
  ...(combat.cycleMs === undefined ? {} : { cycleMs: combat.cycleMs }),
  units: Object.fromEntries([...combat.units].filter(([id]) => unitIds.has(id)).sort(([a], [b]) => a < b ? -1 : 1)),
  tracks: Object.fromEntries([...combat.sightings].flatMap(([id, sighting]) => sighting.fixAtMs === undefined ? [] : [[id, { fixAtMs: sighting.fixAtMs }] as const])),
})
