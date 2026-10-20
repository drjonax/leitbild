import { z } from 'zod'
import type { ObjectId } from './ids.ts'
import { isoTimestampSchema } from './time.ts'

export const alertSeveritySchema = z.enum(['info', 'warning', 'critical'])
export type AlertSeverity = z.infer<typeof alertSeveritySchema>

/**
 * The one name for the six-level scale, lowest first. Observations, thresholds
 * and alert facets all call it `priority`; the alert record's coarse
 * `severity` (info, warning, critical) keeps its own name and meaning.
 */
export const priorityLevels = ['none', 'notice', 'caution', 'warning', 'alarm', 'emergency'] as const
export const prioritySchema = z.enum(priorityLevels)
export type Priority = z.infer<typeof prioritySchema>

/** An observable's address, `objectId#signal`: the object part is what access checks inspect. */
export const observableRefSchema = z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}#\S+$/, 'an observable ref is objectId#signal')

/** The object an observable ref names. */
export const refObjectId = (ref: string): ObjectId => ref.slice(0, ref.indexOf('#')) as ObjectId

const severityForPriority: Readonly<Record<Priority, AlertSeverity>> = {
  none: 'info', notice: 'info', caution: 'warning', warning: 'warning', alarm: 'critical', emergency: 'critical',
}

/**
 * Today's record (id … acknowledged, unchanged) plus optional facets a Pack
 * sets; a boolean facet is `true` or absent. The object stays non-strict, as
 * every saved Run's records parse through it, so a facet only lives if it is
 * declared here. Nothing derives a priority from a severity.
 */
export const alertStateSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  severity: alertSeveritySchema,
  /** A stable title; live values belong to observations. */
  message: z.string().min(1),
  /** Fixed per occurrence; its clock is `clock`, absent → time unknown. */
  raisedAt: isoTimestampSchema,
  acknowledged: z.boolean(),
  acknowledgedBy: z.enum(['person', 'ai', 'system']).optional(),
  /** Returned to normal, still unacknowledged. */
  returned: z.literal(true).optional(),
  latched: z.literal(true).optional(),
  standing: z.literal(true).optional(),
  advisory: z.literal(true).optional(),
  firstOut: z.object({ group: z.string().min(1).max(64), rank: z.number().int().min(1) }).strict().optional(),
  subject: z.union([
    z.object({ element: z.string().min(1).max(200) }).strict(),
    z.object({ group: z.string().min(1).max(200) }).strict(),
  ]).optional(),
  observable: observableRefSchema.optional(),
  threshold: z.string().min(1).max(128).optional(),
  priority: prioritySchema.optional(),
  clock: z.enum(['simulation', 'wall']).optional(),
}).superRefine((alert, context) => {
  if (alert.priority !== undefined && severityForPriority[alert.priority] !== alert.severity) {
    context.addIssue({ code: 'custom', path: ['priority'], message: `priority ${alert.priority} disagrees with severity ${alert.severity}` })
  }
  if (alert.acknowledgedBy !== undefined && !alert.acknowledged) {
    context.addIssue({ code: 'custom', path: ['acknowledgedBy'], message: 'only an acknowledged alert names who acknowledged it' })
  }
})

export type AlertState = Readonly<z.output<typeof alertStateSchema>>
