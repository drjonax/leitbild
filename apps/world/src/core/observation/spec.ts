/**
 * Vignette and dashboard specs, P0 draft with reservations (plan v3.1
 * Appendix A, §2.3, §2.6). No view carries coordinates, numbers, limits or
 * colours; dashboard sections are stored by value, never as templates.
 */
import { z } from 'zod'
import { stampSchema } from './model.ts'

const nameSchema = z.string().min(1).max(160)
const namesSchema = z.array(nameSchema).min(1).max(8).optional()
export const distanceBandSchema = z.enum(['1km', '5km', '20km', '50km', '150km'])

/** A live collection: presentation categories or element classes; resolved and removed objects only when `closed`. */
export const selectorSchema = z.object({
  category: z.string().min(1).max(128).optional(),
  class: z.string().min(1).max(128).optional(),
  status: z.array(z.string().min(1)).max(6).optional(),
  near: nameSchema.optional(),
  within: distanceBandSchema.optional(),
  closed: z.boolean().default(false),
}).strict().refine(selector => selector.category !== undefined || selector.class !== undefined, 'a collection names a category or a class')

export const viewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trend'), signals: z.array(nameSchema).min(1).max(12), horizon: z.enum(['2m', '10m', '30m']).optional() }).strict(),
  z.object({
    kind: z.literal('values'), signals: z.array(nameSchema).min(1).max(16).optional(), of: selectorSchema.optional(),
    columns: z.array(z.string().min(1)).max(6).optional(), sort: z.string().min(1).optional(),
    count: z.object({ by: z.string().min(1) }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal('alerts'), scope: z.enum(['related', 'run']).default('related') }).strict(),
  z.object({ kind: z.literal('events'), of: selectorSchema.optional(), since: z.enum(['10m', '30m', 'run']).default('30m') }).strict(),
  z.object({
    kind: z.literal('topology'), from: namesSchema, to: namesSchema, around: namesSchema, media: namesSchema, groups: namesSchema,
    reach: z.number().int().min(1).max(4).optional(),
  }).strict(),
  z.object({ kind: z.literal('map'), around: namesSchema, within: distanceBandSchema.optional(), of: selectorSchema.optional() }).strict(),
])

/** An object, element or connection by name, or a live collection. */
export const subjectSchema = z.union([nameSchema, z.object({ of: selectorSchema }).strict()])

export const displaySpecSchema = z.object({
  title: z.string().min(1).max(80),
  question: z.string().min(1).max(300),
  need: z.string().min(1).max(300).optional(),
  subjects: z.array(subjectSchema).min(1).max(6),
  views: z.array(viewSchema).max(4),
}).strict()

export const dashboardScopeSchema = z.union([z.literal('run'), z.object({ subject: nameSchema }).strict(), z.object({ of: selectorSchema }).strict()])

/** `default` names a subject whose World default is generated from declarations; `spec` is a composed vignette by value. */
export const sectionSchema = z.object({
  id: z.string().min(1).max(64),
  by: z.enum(['world', 'agent', 'person']),
  source: z.union([z.object({ default: nameSchema }).strict(), z.object({ spec: displaySpecSchema }).strict()]),
  /** Drives "composed at <mode> · now <mode>". */
  composedAt: stampSchema.extend({ mode: z.string().min(1).max(64) }).strict().optional(),
}).strict()

export const dashboardSchema = z.object({
  scope: dashboardScopeSchema,
  revision: z.number().int().nonnegative(),
  sections: z.array(sectionSchema).max(8),
}).strict().refine(dashboard => new Set(dashboard.sections.map(section => section.id)).size === dashboard.sections.length, 'section ids are unique')

const revisionSchema = z.object({
  revision: z.number().int().positive(),
  by: z.object({ actor: z.enum(['person', 'agent']), id: z.string().min(1).max(128) }).strict(),
  at: stampSchema,
  added: z.array(z.string().min(1)).max(8),
  removed: z.array(z.string().min(1)).max(8),
}).strict()

/** One scope's entry in `runs/<id>/dashboards.json`: current spec, revision metadata (ids only), the last 20 removed sections by value. */
export const storedDashboardSchema = z.object({
  dashboard: dashboardSchema,
  revisions: z.array(revisionSchema).max(20),
  removed: z.array(z.object({ revision: z.number().int().positive(), section: sectionSchema }).strict()).max(20),
}).strict()

export const dashboardsFileSchema = z.object({ dashboards: z.array(storedDashboardSchema) }).strict()
