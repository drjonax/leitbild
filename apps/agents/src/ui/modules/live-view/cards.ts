// The cards a posted answer's turn returned, keyed as the answer cites them
// (the Agents cards route re-keys the turn's stored calls): the frozen card on
// a display chip and the chips that stand for each ⟦k⟧ in the answer. Pure:
// no DOM, no stores.
import { z } from 'zod'
import { displayCardSchema, type DisplayCard, type DisplayCardItem } from '@leitbild/contracts'

const turnCardsSchema = z.object({ cards: z.array(z.object({ viewRef: z.string().min(1), card: displayCardSchema }).strict()) }).strict()

export type TurnCardList = ReadonlyArray<{ readonly viewRef: string; readonly card: DisplayCard }>
export type TurnCardsRead = { readonly kind: 'cards'; readonly cards: TurnCardList } | { readonly kind: 'refused'; readonly message: string }
type FetchJson = (path: string) => Promise<{ readonly status: number; readonly body: unknown }>

/** One read per answer turn for the life of the page; a failure is kept and shown like a result, so chips agree. */
export const createTurnCardsReader = (fetchJson: FetchJson): ((roomId: string, turnId: string) => Promise<TurnCardsRead>) => {
  const reads = new Map<string, Promise<TurnCardsRead>>()
  return (roomId, turnId) => {
    const key = `${roomId}/${turnId}`
    const cached = reads.get(key)
    if (cached !== undefined) return cached
    const read = (async (): Promise<TurnCardsRead> => {
      const response = await fetchJson(`/rooms/${encodeURIComponent(roomId)}/executions/${encodeURIComponent(turnId)}/cards`)
      if (response.status !== 200) return { kind: 'refused', message: `reading this answer's cards failed with HTTP ${response.status}` }
      return { kind: 'cards', cards: turnCardsSchema.parse(response.body).cards }
    })().catch((error: unknown): TurnCardsRead => ({ kind: 'refused', message: `this answer's cards are unreadable (${error instanceof Error ? error.message : String(error)})` }))
    reads.set(key, read)
    return read
  }
}

export const FROZEN_LINES = 6

/** What a chip shows of its card: when it was read, its first lines, and how many more the card and display hold. */
export const frozenCard = (card: DisplayCard) => ({
  caption: `FROZEN · ${card.at.clock === 'simulation' ? 'sim ' : ''}${card.at.at.slice(11, 19)}`,
  lines: card.items.slice(0, FROZEN_LINES).map(item => ({ key: item.key, text: `${item.key} · ${item.label} · ${item.reading}` })),
  more: Math.max(0, card.items.length - FROZEN_LINES) + card.more,
})

/** A frozen card as assistive technology reads it, apart from the chip's action: title, time, lines, how many more. */
export const frozenCardText = (title: string, frozen: ReturnType<typeof frozenCard>): string =>
  [title, frozen.caption, ...frozen.lines.map(line => line.text), ...(frozen.more > 0 ? [`+${frozen.more} more`] : [])].join('. ')

/** The line a key names on the turn's cards, if any. */
export const itemOf = (cards: TurnCardList, key: string): DisplayCardItem | undefined => {
  for (const { card } of cards) {
    const item = card.items.find(candidate => candidate.key === key)
    if (item !== undefined) return item
  }
  return undefined
}
