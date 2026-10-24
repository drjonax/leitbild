/**
 * A vignette spec (architecture A1): what a display is about and which views
 * it shows, by name only. No view carries a number, limit, colour or
 * coordinate; World resolves the names and draws everything from declarations.
 */
import { z } from 'zod'

const nameSchema = z.string().min(1).max(160)
const namesSchema = z.array(nameSchema).min(1).max(8).optional()
export const distanceBandSchema = z.enum(['1km', '5km', '20km', '50km', '150km'])

/**
 * A live collection of one presentation category; resolved and removed objects only when `closed`. `group` keeps the
 * members of one Pack-declared group (a category's group key, such as a plant cluster).
 */
export const selectorSchema = z.object({
  category: z.string().min(1).max(128),
  group: z.string().min(1).max(128).optional(),
  status: z.array(z.string().min(1)).max(6).optional(),
  near: nameSchema.optional(),
  within: distanceBandSchema.optional(),
  closed: z.boolean().default(false),
}).strict()

/** The most units a spec names one by one; more are a set by selector, re-resolved each sample. */
export const MAX_NAMED_UNITS = 12
/** The most quantities one comparison holds across its units. */
export const MAX_COMPARED_SIGNALS = 8

/** Units compared or trended together: a live selector, or at most twelve named units. */
export const unitSetSchema = z.union([
  selectorSchema,
  z.array(nameSchema).min(1).max(MAX_NAMED_UNITS, { message: `name at most ${MAX_NAMED_UNITS} units; for more use a set, {category, group}` }),
])

export const viewSchema = z.discriminatedUnion('kind', [
  /** With `of`, each signal is a quantity matched on every unit of the set (a comparable role, a tag or a label). */
  z.object({ kind: z.literal('trend'), signals: z.array(nameSchema).min(1).max(12), horizon: z.enum(['2m', '10m', '30m']).optional(), of: unitSetSchema.optional() }).strict(),
  z.object({ kind: z.literal('values'), signals: z.array(nameSchema).min(1).max(16).optional(), of: selectorSchema.optional() }).strict(),
  /** With `of`, the alerts of a set's members, ranked across them. */
  z.object({ kind: z.literal('alerts'), scope: z.enum(['related', 'run']).default('related'), of: selectorSchema.optional() }).strict(),
  /** One row per member, from the Pack's declared member columns: worst first. */
  z.object({ kind: z.literal('fleet'), of: selectorSchema }).strict(),
  /** Rows are units, columns these quantities, each matched per unit. */
  z.object({
    kind: z.literal('compare'), of: unitSetSchema,
    signals: z.array(nameSchema).min(1).max(MAX_COMPARED_SIGNALS, { message: `compare at most ${MAX_COMPARED_SIGNALS} quantities across units` }),
  }).strict(),
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
}).strict().refine(spec => spec.subjects.length > 0 || spec.views.some(view => (view.kind === 'alerts' && view.scope === 'run') || setOf(view) !== undefined), {
  path: ['subjects'], message: 'name 1 to 6 subjects; only a run-wide alerts view (scope run) or a view of a set (of) needs none',
}).refine(spec => spec.views.every(view => view.kind !== 'alerts' || view.of === undefined || view.scope !== 'run'), {
  path: ['views'], message: 'an alerts view is of the run (scope run) or of a set (of), not both',
})

/** The set a view is about, where it names one. */
export const setOf = (view: z.output<typeof viewSchema>): z.output<typeof unitSetSchema> | undefined =>
  view.kind === 'fleet' || view.kind === 'compare' || view.kind === 'trend' || view.kind === 'alerts' ? view.of : undefined

export type Selector = z.output<typeof selectorSchema>
export type View = z.output<typeof viewSchema>
export type Subject = z.output<typeof subjectSchema>
export type DisplaySpec = z.output<typeof displaySpecSchema>
