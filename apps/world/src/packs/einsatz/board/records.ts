import { z } from 'zod'
import type { GeoJsonPoint, ObjectAudience, OperationalObject } from '../../../core/model/index.ts'
import { configIdSchema } from '../config-schema.ts'
import type { TaskData, Transition, UnitData } from '../engine/model.ts'
import { einsatzPackId } from '../ids.ts'
import { unitPhases } from '../lexicon.ts'

/**
 * What the Board reads from the Run's Einsatz objects. The Board runs in the
 * browser, so it parses only the `packData` fields it shows, the way the
 * Pack's presentation does, and imports no engine module: the engine's
 * configuration validation would pull the whole icon catalogue into the
 * browser. The type checks at the end of this file keep these fields in step
 * with the engine's own records.
 */

const ms = z.number().finite().nonnegative()
const counts = z.record(configIdSchema, z.number().int().positive())
const presentation = z.object({ icon: z.string().min(1), typeLabel: z.string().min(1) }).loose()
const lastAction = z.object({
  verb: z.string().min(1),
  target: z.string().min(1).optional(),
  by: z.string().min(1),
  cause: z.string().min(1).optional(),
  atMs: ms,
}).loose()
const alert = z.object({ code: z.string().min(1), message: z.string().min(1), sinceMs: ms }).loose()
const tally = z.number().int().nonnegative()
const coverage = z.object({
  requirements: z.array(z.object({ provides: configIdSchema, count: z.number().int().positive(), enRoute: tally, onTask: tally, completed: tally }).loose()),
  loads: z.array(z.object({ classId: configIdSchema, waiting: tally, covered: tally }).loose()),
}).loose()

const unitDataSchema = z.object({
  type: z.literal('unit'),
  unitType: configIdSchema,
  side: configIdSchema.optional(),
  presentation,
  atBase: z.boolean(),
  properties: z.record(configIdSchema, z.union([z.number(), z.boolean(), z.string()])),
  phase: z.enum(unitPhases),
  phaseSinceMs: ms,
  integrity: z.enum(['healthy', 'damaged', 'destroyed']),
  taskId: z.string().min(1).optional(),
  siteId: z.string().min(1).optional(),
  load: counts,
  accepting: z.boolean().optional(),
  lastAction: lastAction.optional(),
  alerts: z.array(alert),
}).loose()

const taskDataSchema = z.object({
  type: z.literal('task'),
  template: configIdSchema,
  side: configIdSchema.optional(),
  presentation,
  createdAtMs: ms,
  loads: counts,
  pickedUp: counts,
  served: counts,
  rank: configIdSchema,
  coverage,
  closedAtMs: ms.optional(),
  lastAction: lastAction.optional(),
  alerts: z.array(alert),
}).loose()

const recordSchema = z.discriminatedUnion('type', [unitDataSchema, taskDataSchema])

/**
 * The Pack's other records, whose data the Board does not read: a side's
 * tracks and the truth-only track indexes. They are named here, so a record
 * of any other type is still an error; the check at the end of this file
 * holds this list and the Board's own types to every record type the engine
 * writes. Of a track the Board keeps only its label and audience, so the
 * log can name a track a unit was ordered to engage.
 */
const passedOverTypes = ['track', 'track-index'] as const
const passedOverSchema = z.object({ type: z.enum(passedOverTypes) }).loose()

type BoardUnitData = z.output<typeof unitDataSchema>
type BoardTaskData = z.output<typeof taskDataSchema>

export type BoardAlert = z.output<typeof alert>
export type BoardLastAction = z.output<typeof lastAction>
export type BoardCoverage = z.output<typeof coverage>

/** A unit as the Board shows it: its record, where it is, and the time its current leg still needs. */
export type BoardUnit = BoardUnitData & {
  readonly id: string
  readonly label: string
  readonly point: GeoJsonPoint | undefined
  readonly etaSeconds: number | undefined
}
export type BoardTask = BoardTaskData & {
  readonly id: string
  readonly label: string
}

/** A side's track as the Board names it: its label, the side's own serial, and whose picture holds it. */
export interface BoardTrack {
  readonly id: string
  readonly label: string
  readonly audience: ObjectAudience | undefined
}

export interface BoardRecords {
  readonly units: ReadonlyMap<string, BoardUnit>
  readonly tasks: ReadonlyMap<string, BoardTask>
  readonly tracks: ReadonlyMap<string, BoardTrack>
}

/**
 * The Einsatz units and tasks among the Run's objects, and the labels of its
 * tracks. Track data and track indexes are passed over by type; any other
 * Einsatz object whose record does not parse is an error, never skipped.
 */
export const readBoardRecords = (objects: ReadonlyArray<OperationalObject>): BoardRecords => {
  const units = new Map<string, BoardUnit>()
  const tasks = new Map<string, BoardTask>()
  const tracks = new Map<string, BoardTrack>()
  for (const object of objects) {
    if (object.packId !== einsatzPackId) continue
    const passedOver = passedOverSchema.safeParse(object.packData)
    if (passedOver.success) {
      if (passedOver.data.type === 'track') tracks.set(object.id, { id: object.id, label: object.label, audience: object.audience })
      continue
    }
    const parsed = recordSchema.safeParse(object.packData)
    if (!parsed.success) throw new Error(`Einsatz object ${object.id} has a record the Board cannot read: ${parsed.error.message}`)
    const data = parsed.data
    if (data.type === 'task') tasks.set(object.id, { ...data, id: object.id, label: object.label })
    else {
      units.set(object.id, {
        ...data,
        id: object.id,
        label: object.label,
        point: object.spatial.position?.point,
        etaSeconds: object.spatial.route?.etaSeconds,
      })
    }
  }
  return { units, tasks, tracks }
}

/** Compile-time agreement: every engine record is a record the Board can read, so the Board reads no field the engine does not write. */
type Readable<Engine, Board> = [Engine] extends [Board] ? true : false
type Holds<T extends true> = T
export type BoardRecordsAgree = Holds<Readable<UnitData, BoardUnitData>> & Holds<Readable<TaskData, BoardTaskData>>

/** Every record type the engine writes as an object: the records of its transitions, a dropped track being deleted instead. */
type EngineRecordType = Exclude<Transition, { readonly kind: 'track-dropped' }>['record']['type']
type BoardKnownType = BoardUnitData['type'] | BoardTaskData['type'] | typeof passedOverTypes[number]
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Compile-time agreement: the Board reads or passes over exactly the record types the engine writes, no more and no fewer. */
export type BoardRecordTypesAgree = Holds<Same<EngineRecordType, BoardKnownType>>
