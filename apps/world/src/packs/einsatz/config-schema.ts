import { z } from 'zod'
import { lexiconSchema, unitLexiconSchema } from './lexicon.ts'

/**
 * The structure of an Einsatz Pack Selection config. It names no asset type:
 * unit types, task templates, load classes, properties and all wording are
 * data. This module holds structure only and imports no map catalogue, so UI
 * code may read the types; `einsatzConfigSchema` in `config-validation.ts` is
 * the authoritative parser, adding every semantic refusal.
 */

/** Ids the configuration declares and references: types, templates, load classes, properties, tags, services, roles and sides. */
export const configIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(64)
const labelSchema = z.string().trim().min(1).max(120)
const pluralSchema = z.object({ one: labelSchema, other: labelSchema }).strict()
const iconSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(100)
const idList = (max: number) => z.array(configIdSchema).max(max)
const finite = z.number().finite()
const seconds = finite.min(0).max(86_400)
const metres = finite.positive().max(100_000)

/** How a unit moves: `road` is routed on the road network, `direct` is a straight line. */
const mobilitySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('road'), speedFactor: finite.positive().max(4).default(1) }).strict(),
  z.object({ mode: z.literal('direct'), speedMps: finite.positive().max(400) }).strict(),
])

/**
 * The extension point. This closed component set and the mobility modes are
 * the only places a new mechanic enters: a documented change inside this Pack
 * (schema, validation and refusal, engine step, neutral wording, tests), never
 * a branch for one unit type.
 */
export const componentsSchema = z.object({
  mobility: mobilitySchema.optional(),
  service: z.object({ provides: idList(16).min(1), onSceneS: seconds }).strict().optional(),
  carry: z.object({ capacity: z.number().int().min(1).max(100), classes: idList(16).min(1) }).strict().optional(),
  receiving: z.object({ accepts: idList(16).min(1), slots: z.number().int().min(1).max(100), handoverS: seconds, accepting: z.boolean() }).strict().optional(),
  sensor: z.object({ detectM: metres, identifyM: finite.min(0).max(100_000) }).strict().optional(),
  signature: z.object({
    factor: finite.positive().max(10),
    haltedFactor: finite.positive().max(1).default(0.5),
    concealAfterS: seconds.default(30),
    firedFactor: finite.min(1).max(10).default(2),
  }).strict().optional(),
  effector: z.object({ rangeM: metres, fireRate: finite.positive().max(100).default(1), targets: idList(16).min(1) }).strict().optional(),
  durability: z.object({ stepFireS: finite.positive().max(86_400) }).strict().optional(),
}).strict()

const propertyBase = { id: configIdSchema, label: labelSchema, board: z.boolean().default(false) }
/** A typed property of a unit type; instances hold their own values. */
export const propertySchema = z.discriminatedUnion('kind', [
  z.object({ ...propertyBase, kind: z.literal('number'), unit: z.string().trim().min(1).max(16).optional(), min: finite.optional(), max: finite.optional(), default: finite }).strict(),
  z.object({ ...propertyBase, kind: z.literal('boolean'), default: z.boolean() }).strict(),
  z.object({ ...propertyBase, kind: z.literal('enum'), values: z.array(z.object({ id: configIdSchema, label: labelSchema }).strict()).min(1).max(32), default: configIdSchema }).strict(),
])

export const roeModes = ['hold', 'return-fire', 'free'] as const
/** The five closed, parameterised reflexes a unit type may carry. */
export const standingOrdersSchema = z.object({
  deliver: z.enum(['nearest-accepting', 'none']).optional(),
  return: z.object({ afterIdleS: seconds }).strict().optional(),
  roe: z.enum(roeModes).optional(),
  withdraw: z.object({ whenDamaged: z.boolean() }).strict().optional(),
  onStepLost: z.object({ createTask: configIdSchema, perStep: z.record(configIdSchema, z.number().int().min(1).max(20)) }).strict().optional(),
}).strict()

export const unitTypeSchema = z.object({
  id: configIdSchema,
  label: labelSchema,
  icon: iconSchema,
  tags: idList(16).default([]),
  public: z.boolean().default(false),
  components: componentsSchema,
  properties: z.array(propertySchema).max(24).default([]),
  lexicon: unitLexiconSchema.optional(),
  standingOrders: standingOrdersSchema.optional(),
}).strict()

/** A closed comparison on a declared property: `atLeast`/`atMost` for numbers, `equals` for booleans and enums. */
export const conditionSchema = z.union([
  z.object({ property: configIdSchema, atLeast: finite, atMost: finite.optional() }).strict(),
  z.object({ property: configIdSchema, atMost: finite }).strict(),
  z.object({ property: configIdSchema, equals: z.union([z.boolean(), configIdSchema]) }).strict(),
])

/** `count` units providing `provides`, each meeting every `where` comparison. */
export const requirementSchema = z.object({
  provides: configIdSchema,
  count: z.number().int().min(1).max(20),
  label: pluralSchema,
  where: z.array(conditionSchema).max(8).default([]),
}).strict()

/** `priorityClass` is an optional floor on the rank of tasks made from the template. */
export const taskTemplateSchema = z.object({
  id: configIdSchema,
  label: labelSchema,
  icon: iconSchema,
  priorityClass: configIdSchema.optional(),
  requires: z.array(requirementSchema).max(12).default([]),
}).strict()

/** Load classes are declared in priority order, highest first. */
export const loadClassSchema = z.object({ id: configIdSchema, label: labelSchema, code: z.string().trim().min(1).max(8), noun: pluralSchema }).strict()

export const unitSelectorSchema = z.union([
  z.object({ types: idList(100).min(1) }).strict(),
  z.object({ tags: idList(16).min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
])
/** The units an operator role commands and the task templates in its queue. */
export const authoritySchema = z.object({ roleId: configIdSchema, units: unitSelectorSchema, taskTemplates: idList(100) }).strict()

/** Every field defaults to empty, so `{}` is a valid configuration declaring nothing. */
export const einsatzConfigShapeSchema = z.object({
  hostility: z.record(configIdSchema, idList(16)).default({}),
  lexicon: lexiconSchema.default({}),
  loadClasses: z.array(loadClassSchema).max(12).default([]),
  unitTypes: z.array(unitTypeSchema).max(100).default([]),
  taskTemplates: z.array(taskTemplateSchema).max(100).default([]),
  authority: z.array(authoritySchema).max(50).default([]),
}).strict()

export type EinsatzConfig = z.output<typeof einsatzConfigShapeSchema>
export type UnitType = z.output<typeof unitTypeSchema>
export type UnitComponents = z.output<typeof componentsSchema>
export type UnitProperty = z.output<typeof propertySchema>
export type StandingOrders = z.output<typeof standingOrdersSchema>
export type TaskTemplate = z.output<typeof taskTemplateSchema>
export type Requirement = z.output<typeof requirementSchema>
export type Condition = z.output<typeof conditionSchema>
export type LoadClass = z.output<typeof loadClassSchema>
export type Authority = z.output<typeof authoritySchema>
