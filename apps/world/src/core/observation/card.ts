/**
 * The card World returns with a vignette, P0 draft (plan v3.1 Appendix A,
 * §2.4). The wire schema the Agents lane lands in packages/contracts is
 * authoritative; this is World's producer-side shape with reservations for
 * entity rows, events and map features.
 */
import { z } from 'zod'
import { stampSchema } from './model.ts'

/** What an item stands for; only `ref` (an observable) is used before P2. */
const itemSubjectSchema = z.union([
  z.object({ ref: z.string().min(1).max(256) }).strict(),
  z.object({ objectId: z.string().min(1).max(128) }).strict(),
  z.object({ eventId: z.string().min(1).max(128), at: stampSchema }).strict(),
  z.object({ featureId: z.string().min(1).max(128), attribution: z.string().min(1).max(200) }).strict(),
])

export const cardItemSchema = z.object({
  /** Cited in answers as ⟦k3⟧. */
  key: z.string().regex(/^k\d+$/),
  label: z.string().min(1).max(80),
  reading: z.string().min(1).max(120),
  unit: z.string().max(16).optional(),
  /** Every number a reading shows, at its typed precision. */
  numbers: z.array(z.object({ value: z.number().finite(), decimals: z.number().int().min(0).max(6) }).strict()).max(8),
  subject: itemSubjectSchema.optional(),
}).strict()

export const cardAdjustmentSchema = z.object({
  kind: z.enum(['layout', 'scope', 'access']),
  text: z.string().min(1).max(200),
  /** The item a fit could not keep, with at most three verified alternatives. */
  lost: z.string().min(1).max(160).optional(),
  alternatives: z.array(z.string().min(1).max(160)).min(1).max(3).optional(),
}).strict().refine(adjustment => adjustment.alternatives === undefined || adjustment.lost !== undefined, 'alternatives belong to a lost item')

export const displayCardSchema = z.object({
  at: stampSchema,
  items: z.array(cardItemSchema).max(48),
  more: z.number().int().nonnegative(),
  adjusted: z.array(cardAdjustmentSchema).max(8),
}).strict().refine(card => new Set(card.items.map(item => item.key)).size === card.items.length, 'item keys are unique')
