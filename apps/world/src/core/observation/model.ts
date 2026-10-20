/**
 * World-internal observation contract, P0 draft with reservations (plan v3.1
 * Appendix A). Nothing registers or imports it until the P1 core lane adopts
 * it; the apps/world/AGENTS.md rule says why it is not a universal Pack runtime.
 */
import { z } from 'zod'
import { alertSeveritySchema, alertStateSchema } from '../model/alerts.ts'
import { roleSeesSchema } from '../model/roles.ts'

/** Every timestamp names its clock; the two never share an axis. */
export const clockSchema = z.enum(['simulation', 'wall'])
export const stampSchema = z.object({ at: z.string().datetime({ offset: true }), clock: clockSchema }).strict()

/**
 * The one name for the six-level scale, lowest first. Observations, thresholds
 * and alert facets all call it `priority`; the alert record's coarse
 * `severity` (info, warning, critical) keeps its own name and meaning.
 */
export const priorityLevels = ['none', 'notice', 'caution', 'warning', 'alarm', 'emergency'] as const
export const prioritySchema = z.enum(priorityLevels)
export type Priority = z.infer<typeof prioritySchema>

/** Fixed core quantity kinds; plant `power` and grid `active-power` both map to `electric-power` in this layer. */
export const quantitySchema = z.enum([
  'level', 'loading', 'electric-power', 'reactive-power', 'thermal-power', 'thermal-fraction',
  'pressure', 'pressure-difference', 'temperature', 'temperature-rate', 'frequency', 'flow',
  'voltage', 'current', 'speed', 'rotational-speed', 'direction-from', 'angle', 'length',
  'mass', 'volume', 'energy', 'concentration', 'reactivity', 'count-rate', 'dose-rate',
  'precipitation-rate', 'fraction', 'count', 'duration', 'state',
])

export const thresholdSchema = z.object({
  id: z.string().min(1).max(128),
  direction: z.enum(['low', 'high']),
  value: z.number().finite(),
  order: z.number().int().min(1).max(4),
  effect: z.enum(['alarm', 'trip', 'control', 'rating', 'target']),
  /** Styles the limit tick only; a value's colour comes from its observation. */
  priority: prioritySchema.exclude(['none']),
  consequence: z.string().max(80).optional(),
  when: z.string().max(80).optional(),
}).strict()

export const observableSchema = z.object({
  /** `objectId#signalId`, or a record id (SHOULD). */
  ref: z.string().min(1).max(256),
  label: z.string().min(1).max(80),
  shortLabel: z.string().min(1).max(24).optional(),
  quantity: quantitySchema,
  unit: z.string().max(16),
  valueType: z.enum(['number', 'boolean', 'enum', 'text', 'duration', 'instant']),
  states: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict()).optional(),
  thresholds: z.array(thresholdSchema).max(12).default([]),
  basis: z.enum(['instrument', 'model', 'command', 'planned']).optional(),
  meaningfulWhile: z.string().max(80).optional(),
  /** Null: observable but not recorded, so no trend is promised. */
  series: z.object({ seriesId: z.string().min(1), intervalMs: z.number().int().positive() }).strict().nullable(),
}).strict()

export const observationSchema = stampSchema.extend({
  ref: z.string().min(1).max(256),
  value: z.union([z.number().finite(), z.boolean(), z.string(), z.null()]),
  quality: z.enum(['good', 'uncertain', 'bad', 'stale', 'not-applicable']),
  /** Pack-evaluated, mode- and demand-aware: the value's colour. */
  priority: prioritySchema,
  /** Mode-aware lead order. */
  rank: z.number().int().optional(),
  expected: z.object({ after: z.string().min(1) }).strict().optional(),
  since: stampSchema.optional(),
  /** Read only, never journalled. */
  timeToAct: z.object({ threshold: z.string().min(1), seconds: z.number().nonnegative() }).strict().optional(),
  why: z.string().max(300).optional(),
}).strict()

/** Optional facets beside today's alert record, which stays unchanged so saved Runs restore. */
export const alertFacetsSchema = z.object({
  returned: z.boolean().optional(),
  latched: z.boolean().optional(),
  standing: z.boolean().optional(),
  firstOut: z.object({ group: z.string().min(1), rank: z.number().int().min(1) }).strict().optional(),
  advisory: z.boolean().optional(),
  subject: z.union([z.object({ element: z.string().min(1) }).strict(), z.object({ group: z.string().min(1) }).strict()]).optional(),
  observable: z.string().min(1).max(256).optional(),
  threshold: z.string().min(1).max(128).optional(),
  priority: prioritySchema.optional(),
  clock: clockSchema.optional(),
})

const severityForPriority: Readonly<Record<Priority, z.infer<typeof alertSeveritySchema>>> = {
  none: 'info', notice: 'info', caution: 'warning', warning: 'warning', alarm: 'critical', emergency: 'critical',
}

/** A present `priority` must agree with the record's `severity`; nothing derives one from the other. */
export const alertWithFacetsSchema = alertStateSchema.extend(alertFacetsSchema.shape).superRefine((alert, context) => {
  if (alert.priority !== undefined && severityForPriority[alert.priority] !== alert.severity) {
    context.addIssue({ code: 'custom', path: ['priority'], message: `priority ${alert.priority} disagrees with severity ${alert.severity}` })
  }
})

/** Whose picture a read is made in: the original caller, never the model's choice. */
export const viewerSchema = z.object({ actor: z.enum(['person', 'agent']), sees: roleSeesSchema }).strict()
