import { z } from 'zod'
import { geoJsonPosition2DSchema, idSchema, meters, type AlertState, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId, type Provenance } from '../../../core/model/index.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import { einsatzPackId } from '../ids.ts'
import { einsatzDataSchema, emptyEngineState, motionOf, templateOf, unitTypeOf, type EngineState, type Leg, type RecordAlert, type TaskRecord, type Transition, type UnitMotion, type UnitRecord } from './model.ts'
import { legPosition, speedFactor } from './movement.ts'
import { committedPhases, isMoving, isSite, linksToSite, linksToTask, movingPhases } from './rules.ts'
import { sameValue } from './values.ts'

/**
 * Canonical objects and the engine state. Units and tasks are
 * `OperationalObject`s whose truth is `packData`; position, route progress
 * and ETA are snapshot-only. Leg progress and failed reflex attempts are
 * per-cycle values kept in the runtime state store, never journaled.
 */

/**
 * Names the leg a saved progress measures: its router, travel time,
 * distance and end points. Legs are journaled at once while the runtime
 * state is saved later, so after a crash the saved progress may belong to
 * a leg the unit has since left; it is never applied to another leg.
 */
const legKeySchema = z.object({
  provider: z.string().min(1),
  durationMs: z.number().finite().nonnegative(),
  distanceM: z.number().finite().nonnegative(),
  from: geoJsonPosition2DSchema,
  to: geoJsonPosition2DSchema,
}).strict()
type LegKey = z.output<typeof legKeySchema>

const legKeyOf = (leg: Leg): LegKey => {
  const [from, to] = [leg.geometry.coordinates[0]!, leg.geometry.coordinates.at(-1)!]
  return { provider: leg.provider, durationMs: leg.durationMs, distanceM: leg.distanceM, from: [from[0], from[1]], to: [to[0], to[1]] }
}

export const einsatzRuntimeStateSchema = z.object({
  timeMs: z.number().finite().nonnegative(),
  units: z.record(idSchema, z.object({
    progressMs: z.number().finite().nonnegative(),
    /** The leg `progressMs` measures; absent while the unit has no leg. */
    leg: legKeySchema.optional(),
    reflexAttemptMs: z.number().finite().nonnegative().optional(),
  }).strict()),
}).strict()
export type EinsatzRuntimeState = z.output<typeof einsatzRuntimeStateSchema>

export const runtimeStateOf = (state: EngineState): EinsatzRuntimeState => ({
  timeMs: state.timeMs,
  units: Object.fromEntries([...state.motion].map(([id, motion]) => {
    const leg = state.units.get(id)?.leg
    return [id, {
      progressMs: motion.progressMs,
      ...(leg === undefined ? {} : { leg: legKeyOf(leg) }),
      ...(motion.reflexAttemptMs === undefined ? {} : { reflexAttemptMs: motion.reflexAttemptMs }),
    }]
  })),
})

const fail = (id: string, message: string): never => { throw new Error(`${id}: ${message}`) }

/** The invariants every engine call relies on; canonical objects that break one are refused as a whole. */
const assertConsistent = (state: EngineState): void => {
  const sided = state.sides.length > 0
  const sideOk = (side: string | undefined, isPublic: boolean): boolean =>
    isPublic ? side === undefined : sided ? side !== undefined && state.sides.includes(side) : side === undefined
  for (const task of state.tasks.values()) {
    templateOf(state.catalog, task)
    if (!sideOk(task.side, false)) fail(task.id, 'task side does not match the Run\'s declared sides')
  }
  for (const unit of state.units.values()) {
    if (!sideOk(unit.side, unitTypeOf(state.catalog, unit).public)) fail(unit.id, 'unit side does not match the Run\'s declared sides')
    if (isSite(state.catalog, unit) !== (unit.accepting !== undefined && unit.received !== undefined)) fail(unit.id, 'only a site, and every site, holds acceptance and received counts')
    if (unit.taskId !== undefined) {
      const task = state.tasks.get(unit.taskId) ?? fail(unit.id, `committed to missing task ${unit.taskId}`)
      if (task.closedAtMs !== undefined || !linksToTask(unit, task)) fail(unit.id, `cannot be committed to ${task.id}`)
    }
    if (unit.taskId !== undefined ? !committedPhases.includes(unit.phase) : unit.phase === 'mobilizing' || unit.phase === 'on-task') fail(unit.id, `phase ${unit.phase} does not match its task`)
    if ((movingPhases.includes(unit.phase) || unit.phase === 'mobilizing') !== (unit.leg !== undefined)) fail(unit.id, `phase ${unit.phase} does not match its leg`)
    if ((['mobilizing', 'on-task'] as const).some(phase => phase === unit.phase) && unit.phaseDueMs === undefined) fail(unit.id, `timed phase ${unit.phase} has no deadline`)
    if ((unit.phase === 'transporting' || unit.phase === 'at-site') !== (unit.siteId !== undefined)) fail(unit.id, `phase ${unit.phase} does not match its site`)
    if (unit.siteId !== undefined) {
      const site = state.units.get(unit.siteId) ?? fail(unit.id, `delivering to missing site ${unit.siteId}`)
      if (!isSite(state.catalog, site) || !linksToSite(state.catalog, unit, site)) fail(unit.id, `cannot deliver to ${site.id}`)
    }
  }
}

/** Rebuilds the engine state from canonical Einsatz objects and the runtime state saved with them. */
export const readEngineState = (input: {
  readonly config: EinsatzConfig
  readonly sides: ReadonlyArray<string>
  readonly objects: ReadonlyArray<OperationalObject>
  readonly runtime: unknown
}): EngineState => {
  const runtime = einsatzRuntimeStateSchema.parse(input.runtime)
  const empty = emptyEngineState({ config: input.config, sides: input.sides, timeMs: runtime.timeMs })
  const units = new Map<string, UnitRecord>()
  const tasks = new Map<string, TaskRecord>()
  const motion = new Map<string, UnitMotion>()
  for (const object of input.objects) {
    if (object.packId !== einsatzPackId) continue
    const data = einsatzDataSchema.parse(object.packData)
    if (data.type === 'task') {
      tasks.set(object.id, { ...data, id: object.id, label: object.label })
      continue
    }
    const point = object.spatial.position?.point ?? fail(object.id, 'an Einsatz unit needs a canonical point')
    const saved = runtime.units[object.id]
    if (data.leg !== undefined && saved === undefined) fail(object.id, 'leg progress is missing from the runtime state')
    if (data.leg !== undefined && !sameValue(saved!.leg, legKeyOf(data.leg))) {
      fail(object.id, 'the saved leg progress measures another leg than the unit\'s canonical one, so where the unit is on its route is unknown')
    }
    units.set(object.id, { ...data, id: object.id, label: object.label })
    motion.set(object.id, {
      point,
      progressMs: data.leg === undefined ? 0 : saved!.progressMs,
      impacts: object.spatial.route?.impacts ?? [],
      ...(saved?.reflexAttemptMs === undefined ? {} : { reflexAttemptMs: saved.reflexAttemptMs }),
    })
  }
  const state: EngineState = { ...empty, units, tasks, motion }
  assertConsistent(state)
  return state
}

/** When and by whom an object is written; `previous` carries its revision and creation time forward. */
export interface ObjectStamp {
  readonly at: IsoTimestamp
  readonly provenance: Provenance
  readonly previous?: OperationalObject
}

const isoOf = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp

const alertsOf = (id: string, alerts: ReadonlyArray<RecordAlert>): AlertState[] => alerts.map(alert => ({
  id: `${id}:${alert.code}`, kind: alert.code, severity: 'warning', message: alert.message, raisedAt: isoOf(alert.sinceMs), acknowledged: false,
}))

const envelope = (id: string, label: string, stamp: ObjectStamp) => ({
  id: id as ObjectId,
  packId: einsatzPackId as PackId,
  label,
  revision: stamp.previous === undefined ? 0 : stamp.previous.revision + 1,
  provenance: stamp.provenance,
  timestamps: { createdAt: stamp.previous?.timestamps.createdAt ?? stamp.at, updatedAt: stamp.at },
})

/** A unit as an object: its record is `packData`; position, route progress and ETA come from its motion. */
export const unitObject = (state: EngineState, record: UnitRecord, motion: Pick<UnitMotion, 'point' | 'progressMs' | 'impacts'>, stamp: ObjectStamp): OperationalObject => {
  const { id, label, ...data } = record
  const type = unitTypeOf(state.catalog, record)
  const factor = speedFactor(motion.impacts)
  const leg = record.leg
  const impacts = motion.impacts.length > 0 ? { impacts: motion.impacts } : {}
  const route = leg === undefined
    ? motion.impacts.length > 0 ? { source: 'simulator' as const, ...impacts } : undefined
    : {
      planned: leg.geometry,
      source: 'simulator' as const,
      ...(factor > 0 ? { etaSeconds: (leg.durationMs - motion.progressMs) / 1_000 / factor } : {}),
      progress: {
        segmentIndex: legPosition(leg, motion.progressMs).segmentIndex,
        remainingDistanceM: meters(leg.distanceM * (leg.durationMs === 0 ? 0 : 1 - motion.progressMs / leg.durationMs)),
        updatedAt: stamp.at,
      },
      ...impacts,
    }
  const travelling = isMoving(record) && leg !== undefined && leg.durationMs > 0
  return {
    ...envelope(id, label, stamp),
    kind: type.components.mobility === undefined ? 'facility' : 'mobile_entity',
    lifecycle: record.integrity === 'destroyed' ? 'inactive' : 'active',
    spatial: {
      frame: { kind: 'wgs84' },
      position: { point: motion.point, observedAt: stamp.at, ...(type.components.mobility === undefined ? {} : { speedMps: travelling ? leg.distanceM / (leg.durationMs / 1_000) * factor : 0 }) },
      ...(route === undefined ? {} : { route }),
    },
    operational: { status: record.phase, mode: 'simulated' },
    ...(record.taskId === undefined ? {} : { tasking: { currentTaskId: record.taskId as ObjectId } }),
    alerts: alertsOf(id, record.alerts),
    packData: data,
  }
}

/** A task as an object: located demand of core kind `incident`, resolved once closed. */
export const taskObject = (record: TaskRecord, stamp: ObjectStamp): OperationalObject => {
  const { id, label, ...data } = record
  const closed = record.closedAtMs !== undefined
  return {
    ...envelope(id, label, stamp),
    kind: 'incident',
    lifecycle: closed ? 'resolved' : 'active',
    spatial: { frame: { kind: 'wgs84' }, position: { point: record.point, observedAt: stamp.at } },
    operational: { status: closed ? 'closed' : 'open', mode: 'simulated' },
    alerts: alertsOf(id, record.alerts),
    packData: data,
  }
}

/** The object a transition records: the record as it was then, the unit where it was then. */
export const transitionObject = (state: EngineState, transition: Transition, stamp: ObjectStamp): OperationalObject => transition.kind === 'task'
  ? taskObject(transition.record, stamp)
  : unitObject(state, transition.record, { point: transition.point, progressMs: transition.progressMs, impacts: motionOf(state, transition.record.id).impacts }, stamp)

/** Every Einsatz object as the state holds it now, for a snapshot. */
export const engineObjects = (state: EngineState, stampFor: (id: string) => ObjectStamp): OperationalObject[] => [
  ...[...state.units.values()].map(unit => unitObject(state, unit, motionOf(state, unit.id), stampFor(unit.id))),
  ...[...state.tasks.values()].map(task => taskObject(task, stampFor(task.id))),
]
