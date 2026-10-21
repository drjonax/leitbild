// ============================================================================
// Answer cards — the cards World returns with the vignettes a turn composes,
// as the model reads them and as its answer cites them.
//
// A card is wire data (contracts display-card.ts): items of key, label and
// reading, with the numbers each reading shows. The model reads a card as
// lines; each further card of a turn is re-keyed from the turn's last key + 1,
// so a key names one line in the whole turn. The citation check reads the
// answer against those lines (citations.ts), and the answer's chips show the
// same keys: the turn's stored calls are re-keyed in the order the turn read
// them, which is the order it dispatched them (call_<round>_<index>, one at a
// time, results in request order).
// ============================================================================

import { displayCardSchema, type DisplayCard, type DisplayCardItem } from '@leitbild/contracts'
import { viewRefFor } from '../core/render-validators/view-fence.ts'
import type { ExecutionCall } from '../core/executions/store.ts'

type Entry = { readonly key?: unknown; readonly success?: unknown; readonly data?: unknown }

/** The card a workspace_call result entry carries, if any: a successful entry whose data has `card`. */
export const entryCard = (entry: Entry): { readonly card: unknown } | undefined =>
  entry.success === true && typeof entry.data === 'object' && entry.data !== null && Object.hasOwn(entry.data, 'card')
    ? { card: (entry.data as { readonly card: unknown }).card }
    : undefined

/** A card as the model reads it: one line per item, as T10's citation replay showed it. */
export const cardLines = (card: DisplayCard): ReadonlyArray<string> => [
  `card at ${card.at.at} (${card.at.clock})`,
  ...card.items.map(item => `${item.key} · ${item.label} · ${item.reading}`),
  ...(card.more > 0 ? [`+${card.more} more`] : []),
  ...card.adjusted.map(adjustment => `adjusted (${adjustment.kind}): ${adjustment.text}`),
]

/** One turn's cards: each re-keyed from the turn's last key + 1, and every item by its turn key. */
export const createTurnCards = () => {
  const items = new Map<string, DisplayCardItem>()
  return {
    /** A card a result carries, validated (a broken contract fails the turn) and re-keyed. Call once per card. */
    add: (raw: unknown): DisplayCard => {
      const card = displayCardSchema.parse(raw)
      const rekeyed: DisplayCard = { ...card, items: card.items.map((item, index) => ({ ...item, key: `k${items.size + index + 1}` })) }
      for (const item of rekeyed.items) items.set(item.key, item)
      return rekeyed
    },
    items: (): ReadonlyArray<DisplayCardItem> => [...items.values()],
  }
}
export type TurnCards = ReturnType<typeof createTurnCards>

const dispatchOrder = (call: ExecutionCall): readonly [number, number] => {
  const match = /^call_(\d+)_(\d+)$/.exec(call.id)
  if (match === null) throw new Error(`Execution call ${call.id} has no turn position`)
  return [Number(match[1]), Number(match[2])]
}

/** A turn's cards as its answer cites them, from the stored calls: each with the viewRef of the vignette it came with. */
export const storedTurnCards = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<{ readonly viewRef: string; readonly card: DisplayCard }> => {
  const cards = createTurnCards()
  const ordered = calls.map(call => ({ call, at: dispatchOrder(call) })).sort((left, right) => left.at[0] - right.at[0] || left.at[1] - right.at[1])
  return ordered.flatMap(({ call }) => {
    if (call.tool !== 'workspace_call' || call.result?.success !== true) return []
    const entries = (call.result.data as { readonly results: ReadonlyArray<Entry> }).results
    return entries.flatMap(entry => {
      const carried = entryCard(entry)
      return carried === undefined ? [] : [{ viewRef: viewRefFor(call.id, String(entry.key)), card: cards.add(carried.card) }]
    })
  })
}
