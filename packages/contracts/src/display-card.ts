import { z } from 'zod'

// The card World returns beside a composed display: one keyed item per line
// a reader is shown, so an answer cites what the display shows (⟦k3⟧). Every
// number an item shows is explicit, so no reader parses prose; `limits` are
// the declared thresholds of what the item reads, which the display marks but
// the reading does not state.

/** The six-level priority scale, lowest first; World's alerts and observations use this list. */
export const priorityLevels = ['none', 'notice', 'caution', 'warning', 'alarm', 'emergency'] as const

export const DISPLAY_CARD_MAX_ITEMS = 48
/** About 600 tokens at the 3.2 characters per token card lines run (T34, E1), as `displayCardTextLength` measures them. */
export const DISPLAY_CARD_MAX_TEXT = 1_900

const shownNumberSchema = z.object({ value: z.number().finite(), decimals: z.number().int().min(0).max(6) }).strict()
const idSchema = z.string().min(1).max(128)

export const displayCardItemSchema = z.object({
  key: z.string().regex(/^k\d+$/),
  /** "<object> · <observable>", or an object's or alert's own words. */
  label: z.string().min(1).max(80),
  reading: z.string().min(1).max(120),
  unit: z.string().max(16).optional(),
  /** Every number the reading shows, at the precision it shows it. */
  numbers: z.array(shownNumberSchema).max(8),
  limits: z.array(shownNumberSchema).max(4).optional(),
  /** The priority World read for it; absent where none is declared. */
  priority: z.enum(priorityLevels).optional(),
  /** An observable by its ref, an object, or one alert of an object. */
  subject: z.union([
    z.object({ ref: z.string().min(1).max(256) }).strict(),
    z.object({ objectId: idSchema }).strict(),
    z.object({ objectId: idSchema, alertId: idSchema }).strict(),
  ]).optional(),
}).strict()
export type DisplayCardItem = z.infer<typeof displayCardItemSchema>

export const displayCardAdjustmentSchema = z.object({
  kind: z.enum(['layout', 'scope', 'access']),
  text: z.string().min(1).max(200),
  /** The item a fit could not keep, with at most three verified alternatives. */
  lost: z.string().min(1).max(160).optional(),
  alternatives: z.array(z.string().min(1).max(160)).min(1).max(3).optional(),
}).strict().refine(adjustment => adjustment.alternatives === undefined || adjustment.lost !== undefined, 'alternatives belong to a lost item')
export type DisplayCardAdjustment = z.infer<typeof displayCardAdjustmentSchema>

/**
 * The characters of the lines a reader is shown, as the Assistant reads a card: `card at <at> (<clock>)`, then
 * `key · label · reading` per item, `+N more`, and `adjusted (kind): text` per adjustment, each line with the 3
 * characters that list it.
 */
export const displayCardTextLength = (card: {
  readonly at: { readonly at: string; readonly clock: string }
  readonly items: ReadonlyArray<Pick<DisplayCardItem, 'key' | 'label' | 'reading'>>
  readonly more: number
  readonly adjusted: ReadonlyArray<Pick<DisplayCardAdjustment, 'kind' | 'text'>>
}): number => [
  `card at ${card.at.at} (${card.at.clock})`,
  ...card.items.map(item => `${item.key} · ${item.label} · ${item.reading}`),
  ...(card.more > 0 ? [`+${card.more} more`] : []),
  ...card.adjusted.map(adjustment => `adjusted (${adjustment.kind}): ${adjustment.text}`),
].reduce((sum, line) => sum + line.length + 3, 0)

export const displayCardSchema = z.object({
  /** When it was read, on the clock it names. */
  at: z.object({ at: z.string().datetime({ offset: true }), clock: z.enum(['simulation', 'wall']) }).strict(),
  items: z.array(displayCardItemSchema).max(DISPLAY_CARD_MAX_ITEMS),
  /** Items that exist but the card does not show (a cap or a fit left them out, which `adjusted` says): never silent. */
  more: z.number().int().nonnegative(),
  adjusted: z.array(displayCardAdjustmentSchema).max(8),
}).strict().superRefine((card, ctx) => {
  if (new Set(card.items.map(item => item.key)).size !== card.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'item keys are unique' })
  if (displayCardTextLength(card) > DISPLAY_CARD_MAX_TEXT) ctx.addIssue({ code: 'custom', path: ['items'], message: `a card shows at most ${DISPLAY_CARD_MAX_TEXT} characters` })
})
export type DisplayCard = z.infer<typeof displayCardSchema>
