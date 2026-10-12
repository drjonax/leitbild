import { z } from 'zod'
import { idSchema, type GeoJsonPoint } from '../../../core/model/index.ts'
import { configIdSchema, roeModes } from '../config-schema.ts'
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

const propertiesSchema = z.record(configIdSchema, propertyValueSchema)
const loadsSchema = z.record(configIdSchema, z.number().int().min(1).max(1_000))
const labelSchema = z.string().trim().min(1).max(120)
const reasonSchema = z.string().trim().min(1).max(500)

/**
 * The fields each intent carries besides its `kind`. Command Capabilities
 * accept the same fields on the wire; a create's id is the runtime's to give.
 */
export const intentFields = {
  send: {
    units: z.array(idSchema).min(1).max(20).refine(distinct, 'Each unit is named once'),
    to: sendTargetSchema,
    divert: z.array(z.object({ unitId: idSchema, fromTaskId: idSchema }).strict()).min(1).max(20).optional(),
  },
  recall: { unitId: idSchema, fromTaskId: idSchema.optional() },
  hold: { unitId: idSchema },
  taskCreate: { template: configIdSchema, side: configIdSchema.optional(), at: pointSchema, loads: loadsSchema.optional(), label: labelSchema },
  taskClose: { taskId: idSchema, reason: reasonSchema.optional() },
  siteSet: { siteId: idSchema, accepting: z.boolean() },
  unitCreate: { type: configIdSchema, side: configIdSchema.optional(), at: pointSchema, base: pointSchema.optional(), label: labelSchema, properties: propertiesSchema.optional() },
  unitAdjust: { unitId: idSchema, properties: propertiesSchema.refine(properties => Object.keys(properties).length > 0, 'Name at least one property'), reason: reasonSchema },
  setRoe: { unitId: idSchema, roe: z.enum(roeModes) },
  engage: { unitId: idSchema, trackId: idSchema },
} as const

/** Every divert names a unit of the send, once. */
export const divertsNameSendUnits = (send: { readonly units: ReadonlyArray<string>; readonly divert?: ReadonlyArray<{ readonly unitId: string }> | undefined }): boolean =>
  send.divert === undefined || (distinct(send.divert.map(entry => entry.unitId)) && send.divert.every(entry => send.units.includes(entry.unitId)))
export const divertsNameSendUnitsIssue = { message: 'Every divert names a unit of the send, once', path: ['divert'] }

/**
 * Send units to a task, a site or a point, all or nothing. Units not named
 * in `divert` must be free; a divert names the task the unit is released
 * from. A divert to a site or point is a release and a move in one.
 */
export const sendIntentSchema = z.object({ kind: z.literal('send'), ...intentFields.send }).strict().refine(divertsNameSendUnits, divertsNameSendUnitsIssue)

/** Release a unit from its task, if any, and bring it back to base. */
export const recallIntentSchema = z.object({ kind: z.literal('recall'), ...intentFields.recall }).strict()
/** Halt a free unit in place. */
export const holdIntentSchema = z.object({ kind: z.literal('hold'), ...intentFields.hold }).strict()

export const taskCreateIntentSchema = z.object({ kind: z.literal('task.create'), id: idSchema, ...intentFields.taskCreate }).strict()
export const taskCloseIntentSchema = z.object({ kind: z.literal('task.close'), ...intentFields.taskClose }).strict()
export const siteSetIntentSchema = z.object({ kind: z.literal('site.set'), ...intentFields.siteSet }).strict()

/** A new unit of a declared type. Its base is where it is created unless one is named. */
export const unitCreateIntentSchema = z.object({ kind: z.literal('unit.create'), id: idSchema, ...intentFields.unitCreate }).strict()
export const unitAdjustIntentSchema = z.object({ kind: z.literal('unit.adjust'), ...intentFields.unitAdjust }).strict()

/** Set a unit's rules of engagement: hold fire, return fire, or fire on any eligible track. */
export const setRoeIntentSchema = z.object({ kind: z.literal('set-roe'), ...intentFields.setRoe }).strict()
/** Name an own-side track as a unit's priority target. */
export const engageIntentSchema = z.object({ kind: z.literal('engage'), ...intentFields.engage }).strict()

export const intentSchema = z.discriminatedUnion('kind', [
  sendIntentSchema,
  recallIntentSchema,
  holdIntentSchema,
  taskCreateIntentSchema,
  taskCloseIntentSchema,
  siteSetIntentSchema,
  unitCreateIntentSchema,
  unitAdjustIntentSchema,
  setRoeIntentSchema,
  engageIntentSchema,
])

export type Intent = z.output<typeof intentSchema>
export type SendIntent = z.output<typeof sendIntentSchema>
export type IntentOf<K extends Intent['kind']> = Extract<Intent, { kind: K }>

/** Who acts. Roles, scenario cues and standing orders all act through this. */
export interface EngineActor {
  /**
   * Who acted, recorded in `lastAction.by`: the labels of the roles a caller
   * holds in a Run with roles; otherwise an id: the core actor, `scenario`
   * for authored items, or `standing-order:<id>`. Refusal wording never shows it.
   */
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
