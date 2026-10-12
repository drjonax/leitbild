import { z } from 'zod'
import { geoJsonLineStringSchema, geoJsonPointSchema, idSchema, type GeoJsonPoint, type RouteImpact } from '../../../core/model/index.ts'
import { configIdSchema, type EinsatzConfig, type LoadClass, type TaskTemplate, type UnitType } from '../config-schema.ts'
import { validateEinsatzConfig } from '../config-validation.ts'
import { unitPhases } from '../lexicon.ts'

const simulationMs = z.number().finite().nonnegative()
/** A validated point typed as the core's read-only GeoJSON point. */
export const pointSchema: z.ZodType<GeoJsonPoint> = geoJsonPointSchema
const countsSchema = z.record(configIdSchema, z.number().int().positive())

export const propertyValueSchema = z.union([z.number().finite(), z.boolean(), configIdSchema])
export type PropertyValue = z.output<typeof propertyValueSchema>

/**
 * The longest `lastAction.by`. In a Run with roles it names the roles a
 * caller holds by label, so compile refuses a Scenario whose declared roles,
 * all held at once, would name more (`role_labels_too_long`). An actor id or
 * a standing order is far shorter.
 */
export const lastActionByMaxLength = 1_000

/** A prepared route: geometry, travel time at this unit's own full speed, distance and the router that produced it. */
export const legSchema = z.object({
  geometry: geoJsonLineStringSchema,
  durationMs: z.number().finite().nonnegative(),
  distanceM: z.number().finite().nonnegative(),
  provider: z.string().min(1).max(120),
}).strict()
export type Leg = z.output<typeof legSchema>

export const actionVerbs = ['create', 'send', 'divert', 'move', 'deliver', 'recall', 'hold', 'release', 'adjust', 'set', 'close'] as const
/** The last order a record received: what, towards which object, by whom and why, at which Run time. */
export const lastActionSchema = z.object({
  verb: z.enum(actionVerbs),
  target: idSchema.optional(),
  /** The core actor, `scenario` or `standing-order:<id>`; in a Run with roles, the labels of the roles the caller holds. */
  by: z.string().trim().min(1).max(lastActionByMaxLength),
  cause: z.string().trim().min(1).max(500).optional(),
  atMs: simulationMs,
}).strict()
export type LastAction = z.output<typeof lastActionSchema>

/** A standing alert on a record. It stays until what raised it is resolved. */
export const recordAlertSchema = z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(500), sinceMs: simulationMs }).strict()
export type RecordAlert = z.output<typeof recordAlertSchema>
/**
 * A record's standing alerts, at most one per code and ordered by code. Each
 * producer raises and clears only its own codes, so one alert never hides
 * another.
 */
const alertsSchema = z.array(recordAlertSchema).max(16)
  .refine(alerts => alerts.every((alert, index) => index === 0 || alerts[index - 1]!.code < alert.code), 'At most one alert per code, ordered by code')

/** Raises an alert, replacing the one of its code; one standing with the same message keeps its start. */
export const raiseAlert = (alerts: ReadonlyArray<RecordAlert>, alert: RecordAlert): RecordAlert[] => {
  const standing = alerts.find(entry => entry.code === alert.code)
  const raised = standing?.message === alert.message ? standing : alert
  return [...alerts.filter(entry => entry.code !== alert.code), raised].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
}

/** Clears the alerts of the given codes and no other. */
export const clearAlerts = (alerts: ReadonlyArray<RecordAlert>, codes: ReadonlyArray<string>): RecordAlert[] =>
  alerts.filter(alert => !codes.includes(alert.code))

/** The task alert raised when a unit is released with the task's work still waiting. */
export const workReturnedCode = 'work_returned'

/** Presentation copied from the configuration when the object is created. */
const presentationSchema = z.object({ icon: z.string().min(1).max(100), typeLabel: z.string().min(1).max(120) }).strict()

export const integrities = ['healthy', 'damaged', 'destroyed'] as const

/**
 * A unit's `packData`. It changes only on transitions (phase, task, load,
 * leg, integrity, properties, alerts, last order); its position and leg
 * progress are per-cycle runtime state. A site is a unit whose type has
 * `receiving` and no `mobility`; it alone carries `accepting` and `received`.
 */
export const unitDataSchema = z.object({
  type: z.literal('unit'),
  unitType: configIdSchema,
  side: configIdSchema.optional(),
  presentation: presentationSchema,
  base: pointSchema,
  atBase: z.boolean(),
  properties: z.record(configIdSchema, propertyValueSchema),
  phase: z.enum(unitPhases),
  phaseSinceMs: simulationMs,
  phaseDueMs: simulationMs.optional(),
  integrity: z.enum(integrities),
  taskId: idSchema.optional(),
  siteId: idSchema.optional(),
  load: countsSchema,
  leg: legSchema.optional(),
  accepting: z.boolean().optional(),
  received: countsSchema.optional(),
  lastAction: lastActionSchema.optional(),
  alerts: alertsSchema,
}).strict()

const tally = z.number().int().nonnegative()
/** Per requirement: units on their way (mobilizing or en route), on task, and finished. */
export const requirementCoverageSchema = z.object({ provides: configIdSchema, count: z.number().int().positive(), enRoute: tally, onTask: tally, completed: tally }).strict()
/** Per load class: load not yet picked up, and how much of it assigned units' free capacity covers. */
export const loadCoverageSchema = z.object({ classId: configIdSchema, waiting: tally, covered: tally }).strict()
export const coverageSchema = z.object({ requirements: z.array(requirementCoverageSchema), loads: z.array(loadCoverageSchema) }).strict()
export type TaskCoverage = z.output<typeof coverageSchema>

/** A task's `packData`: located, counted demand on a side, with the coverage and rank the engine derives on each transition. */
export const taskDataSchema = z.object({
  type: z.literal('task'),
  template: configIdSchema,
  side: configIdSchema.optional(),
  presentation: presentationSchema,
  point: pointSchema,
  createdAtMs: simulationMs,
  loads: countsSchema,
  pickedUp: countsSchema,
  served: countsSchema,
  rank: configIdSchema,
  coverage: coverageSchema,
  closedAtMs: simulationMs.optional(),
  lastAction: lastActionSchema.optional(),
  alerts: alertsSchema,
}).strict()

export const einsatzDataSchema = z.discriminatedUnion('type', [unitDataSchema, taskDataSchema])
export type UnitData = z.output<typeof unitDataSchema>
export type TaskData = z.output<typeof taskDataSchema>
export type UnitRecord = UnitData & { readonly id: string; readonly label: string }
export type TaskRecord = TaskData & { readonly id: string; readonly label: string }

/** Per-cycle state of a unit, never journaled: its position, leg progress, the route impacts slowing it and its last failed reflex attempt. */
export interface UnitMotion {
  readonly point: GeoJsonPoint
  readonly progressMs: number
  readonly impacts: ReadonlyArray<RouteImpact>
  readonly reflexAttemptMs?: number
}

/** The configuration indexed for lookups. Load classes keep their declared priority order, highest first. */
export interface Catalog {
  readonly config: EinsatzConfig
  readonly types: ReadonlyMap<string, UnitType>
  readonly templates: ReadonlyMap<string, TaskTemplate>
  readonly classes: ReadonlyArray<LoadClass>
  readonly classIds: ReadonlyArray<string>
  readonly classRank: ReadonlyMap<string, number>
}

/** Indexes a configuration; one that cannot run as written is an error, never partly used. */
export const createCatalog = (config: EinsatzConfig): Catalog => {
  const issues = validateEinsatzConfig(config)
  if (issues.length > 0) throw new Error(`Einsatz configuration cannot run: ${issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  return {
    config,
    types: new Map(config.unitTypes.map(type => [type.id, type])),
    templates: new Map(config.taskTemplates.map(template => [template.id, template])),
    classes: config.loadClasses,
    classIds: config.loadClasses.map(loadClass => loadClass.id),
    classRank: new Map(config.loadClasses.map((loadClass, index) => [loadClass.id, index])),
  }
}

/** Everything the engine decides from: canonical records, per-cycle motion and the Run time they hold at. */
export interface EngineState {
  readonly catalog: Catalog
  /** The Run's declared sides; empty in open mode. Sides are opaque ids to the engine. */
  readonly sides: ReadonlyArray<string>
  readonly timeMs: number
  readonly units: ReadonlyMap<string, UnitRecord>
  readonly tasks: ReadonlyMap<string, TaskRecord>
  readonly motion: ReadonlyMap<string, UnitMotion>
}

/** A record's `packData` changed at `atMs`. A unit transition also carries where the unit was then. */
export type Transition =
  | { readonly kind: 'unit'; readonly atMs: number; readonly record: UnitRecord; readonly point: GeoJsonPoint; readonly progressMs: number }
  | { readonly kind: 'task'; readonly atMs: number; readonly record: TaskRecord }

export const emptyEngineState = (input: { readonly config: EinsatzConfig; readonly sides: ReadonlyArray<string>; readonly timeMs: number }): EngineState => {
  if (!Number.isFinite(input.timeMs) || input.timeMs < 0) throw new Error('Invalid Einsatz engine time')
  return { catalog: createCatalog(input.config), sides: input.sides, timeMs: input.timeMs, units: new Map(), tasks: new Map(), motion: new Map() }
}

export const unitTypeOf = (catalog: Catalog, unit: UnitRecord): UnitType => {
  const type = catalog.types.get(unit.unitType)
  if (type === undefined) throw new Error(`${unit.id}: unit type ${unit.unitType} is not declared`)
  return type
}

export const templateOf = (catalog: Catalog, task: Pick<TaskRecord, 'id' | 'template'>): TaskTemplate => {
  const template = catalog.templates.get(task.template)
  if (template === undefined) throw new Error(`${task.id}: task template ${task.template} is not declared`)
  return template
}

/** Lower is more urgent: the index of a load class in declared priority order. */
export const classRankOf = (catalog: Catalog, classId: string): number => {
  const rank = catalog.classRank.get(classId)
  if (rank === undefined) throw new Error(`Load class ${classId} is not declared`)
  return rank
}

/** Whether class `a` is strictly lower in priority than class `b`. */
export const isLowerClass = (catalog: Catalog, a: string, b: string): boolean => classRankOf(catalog, a) > classRankOf(catalog, b)

export const motionOf = (state: Pick<EngineState, 'motion'>, unitId: string): UnitMotion => {
  const motion = state.motion.get(unitId)
  if (motion === undefined) throw new Error(`${unitId}: no motion state`)
  return motion
}
