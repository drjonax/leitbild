import { describe, expect, test } from 'bun:test'
import { createTurnCardsReader, frozenCard, itemOf } from './cards.ts'

const at = { at: '2026-01-01T10:16:00.000Z', clock: 'simulation' as const }
const card = (count: number, more = 0) => ({
  at, more, adjusted: [],
  items: Array.from({ length: count }, (_, index) => ({ key: `k${index + 1}`, label: `Line ${index + 1} · loading`, reading: `${90 + index}.0 %`, numbers: [{ value: 90 + index, decimals: 1 }] })),
})

describe('answer cards in the chat', () => {
  test('a frozen card says when it was read, shows six lines and counts the rest the card and display hold', () => {
    const shown = frozenCard(card(8, 3))
    expect(shown.caption).toBe('FROZEN · sim 10:16:00')
    expect(shown.lines.map(line => line.text)).toEqual(Array.from({ length: 6 }, (_, index) => `k${index + 1} · Line ${index + 1} · loading · ${90 + index}.0 %`))
    expect(shown.more).toBe(5)
    expect(frozenCard({ ...card(1), at: { at: at.at, clock: 'wall' } }).caption).toBe('FROZEN · 10:16:00')
  })

  test('one read per answer turn, validated; a failed or broken read is kept as a refusal that says why', async () => {
    const paths: string[] = []
    const bodies: Record<string, { status: number; body: unknown }> = {
      '/rooms/r/executions/t1/cards': { status: 200, body: { cards: [{ viewRef: 'call_0_0/a', card: card(2) }, { viewRef: 'call_1_0/b', card: { ...card(1), items: [{ ...card(1).items[0]!, key: 'k3', label: 'Reserve' }] } }] } },
      '/rooms/r/executions/t2/cards': { status: 404, body: null },
      '/rooms/r/executions/t3/cards': { status: 200, body: { cards: [{ viewRef: 'call_0_0/a', card: { items: 'none' } }] } },
    }
    const read = createTurnCardsReader(async path => { paths.push(path); return bodies[path]! })
    const first = await read('r', 't1')
    expect(await read('r', 't1')).toBe(first)
    expect(paths).toEqual(['/rooms/r/executions/t1/cards'])
    if (first.kind !== 'cards') throw new Error('expected cards')
    expect(itemOf(first.cards, 'k3')?.label).toBe('Reserve')
    expect(itemOf(first.cards, 'k9')).toBeUndefined()
    expect(await read('r', 't2')).toEqual({ kind: 'refused', message: "reading this answer's cards failed with HTTP 404" })
    expect(await read('r', 't3')).toMatchObject({ kind: 'refused', message: expect.stringContaining("this answer's cards are unreadable") })
  })
})
