/**
 * A vignette spec (architecture A1): what a display is about and which views
 * it shows, by name only. No view carries a number, limit, colour or
 * coordinate; World resolves the names and draws everything from declarations.
 */
import { z } from 'zod'

const nameSchema = z.string().min(1).max(160)
const namesSchema = z.array(nameSchema).min(1).max(8).optional()
export const distanceBandSchema = z.enum(['1km', '5km', '20km', '50km', '150km'])

/** A live collection of one presentation category; resolved and removed objects only when `closed`. */
export const selectorSchema = z.object({
  category: z.string().min(1).max(128),
  status: z.array(z.string().min(1)).max(6).optional(),
  near: nameSchema.optional(),
  within: distanceBandSchema.optional(),
  closed: z.boolean().default(false),
}).strict()

export const viewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trend'), signals: z.array(nameSchema).min(1).max(12), horizon: z.enum(['2m', '10m', '30m']).optional() }).strict(),
  z.object({ kind: z.literal('values'), signals: z.array(nameSchema).min(1).max(16).optional(), of: selectorSchema.optional() }).strict(),
  z.object({ kind: z.literal('alerts'), scope: z.enum(['related', 'run']).default('related') }).strict(),
  z.object({
    kind: z.literal('topology'), from: namesSchema, to: namesSchema, around: namesSchema, media: namesSchema, groups: namesSchema,
    reach: z.number().int().min(1).max(4).optional(),
  }).strict(),
  z.object({ kind: z.literal('map'), around: namesSchema, within: distanceBandSchema.optional(), of: selectorSchema.optional() }).strict(),
])

/** An object, element, observable or connection by name, or a live collection. */
export const subjectSchema = z.union([nameSchema, z.object({ of: selectorSchema }).strict()])

/** No views asks for the World default of each subject. A run-wide alerts view is about the Run: it needs no subject. */
export const displaySpecSchema = z.object({
  title: z.string().min(1).max(80),
  question: z.string().min(1).max(300),
  need: z.string().min(1).max(300).optional(),
  subjects: z.array(subjectSchema).max(6),
  views: z.array(viewSchema).max(4),
}).strict().refine(spec => spec.subjects.length > 0 || spec.views.some(view => view.kind === 'alerts' && view.scope === 'run'), {
  path: ['subjects'], message: 'name 1 to 6 subjects; only a run-wide alerts view (scope run) needs none',
})

export type Selector = z.output<typeof selectorSchema>
export type View = z.output<typeof viewSchema>
export type Subject = z.output<typeof subjectSchema>
export type DisplaySpec = z.output<typeof displaySpecSchema>
