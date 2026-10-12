import { z } from 'zod'
import { idSchema, type GeoJsonPoint } from '../../../core/model/index.ts'
import { configIdSchema } from '../config-schema.ts'
import type { Draft } from './draft.ts'
import { pointSchema, propertyValueSchema, type Leg, type UnitRecord } from './model.ts'

/**
 * Intents: what an actor asks the engine to do. Commands, scenario cues and
 * standing orders all arrive as intents and pass the same validation.
 */

const distinct = (ids: ReadonlyArray<string>): boolean => new Set(ids).size === ids.length

export const sendTargetSchema = z.union([
  z.object({ taskId: idSchema }).strict(),
  z.object({ siteId: idSchema }).strict(),
  z.object({ point: pointSchema }).strict(),
])

/**
 * Send units to a task, a site or a point, all or nothing. Units not named
 * in `divert` must be free; a divert names the task the unit is released
 * from. A divert to a site or point is a release and a move in one.
 */
export const sendIntentSchema = z.object({
  kind: z.literal('send'),
  units: z.array(idSchema).min(1).max(20).refine(distinct, 'Each unit is named once'),
  to: sendTargetSchema,
  divert: z.array(z.object({ unitId: idSchema, fromTaskId: idSchema }).strict()).min(1).max(20).optional(),
}).strict().refine(intent => intent.divert === undefined || (distinct(intent.divert.map(entry => entry.unitId)) && intent.divert.every(entry => intent.units.includes(entry.unitId))), {
  message: 'Every divert names a unit of the send, once', path: ['divert'],
})

/** Release a unit from its task, if any, and bring it back to base. */
export const recallIntentSchema = z.object({ kind: z.literal('recall'), unitId: idSchema, fromTaskId: idSchema.optional() }).strict()
/** Halt a free unit in place. */
export const holdIntentSchema = z.object({ kind: z.literal('hold'), unitId: idSchema }).strict()

const loadsSchema = z.record(configIdSchema, z.number().int().min(1).max(1_000))
export const taskCreateIntentSchema = z.object({
  kind: z.literal('task.create'),
  id: idSchema,
  template: configIdSchema,
  side: configIdSchema.optional(),
  at: pointSchema,
  loads: loadsSchema.optional(),
  label: z.string().trim().min(1).max(120),
}).strict()
export const taskCloseIntentSchema = z.object({ kind: z.literal('task.close'), taskId: idSchema, reason: z.string().trim().min(1).max(500).optional() }).strict()
export const siteSetIntentSchema = z.object({ kind: z.literal('site.set'), siteId: idSchema, accepting: z.boolean() }).strict()

const propertiesSchema = z.record(configIdSchema, propertyValueSchema)
/** A new unit of a declared type. Its base is where it is created unless one is named. */
export const unitCreateIntentSchema = z.object({
  kind: z.literal('unit.create'),
  id: idSchema,
  type: configIdSchema,
  side: configIdSchema.optional(),
  at: pointSchema,
  base: pointSchema.optional(),
  label: z.string().trim().min(1).max(120),
  properties: propertiesSchema.optional(),
}).strict()
export const unitAdjustIntentSchema = z.object({
  kind: z.literal('unit.adjust'),
  unitId: idSchema,
  properties: propertiesSchema.refine(properties => Object.keys(properties).length > 0, 'Name at least one property'),
  reason: z.string().trim().min(1).max(500),
}).strict()

export const intentSchema = z.discriminatedUnion('kind', [
  sendIntentSchema,
  recallIntentSchema,
  holdIntentSchema,
  taskCreateIntentSchema,
  taskCloseIntentSchema,
  siteSetIntentSchema,
  unitCreateIntentSchema,
  unitAdjustIntentSchema,
])

export type Intent = z.output<typeof intentSchema>
export type SendIntent = z.output<typeof sendIntentSchema>
export type IntentOf<K extends Intent['kind']> = Extract<Intent, { kind: K }>

/** Who acts. Roles, scenario cues and standing orders all act through this. */
export interface EngineActor {
  /** Wording for `lastAction.by`: a role's label, or `standing-order:<id>`. */
  readonly by: string
  /** The units the actor commands; need and divert comparisons are taken over them. */
  readonly commandable: (unit: UnitRecord) => boolean
}

/** An actor that commands every unit: the Controller, open mode, scenario cues and standing orders. */
export const commandsEveryUnit = (): boolean => true

export interface RouteNeed {
  readonly unitId: string
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
}

/**
 * A validated intent: the routes it needs, notes for what it leaves
 * unchanged ("already en route"), and how it applies once routes exist.
 */
export type Plan =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true
    readonly routes: ReadonlyArray<RouteNeed>
    readonly notes: ReadonlyArray<string>
    readonly apply: (draft: Draft, legs: ReadonlyMap<string, Leg>) => void
  }
