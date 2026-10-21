import { describe, expect, test } from 'bun:test'
import { DISPLAY_CARD_MAX_TEXT, displayCardTextLength } from '../../packages/contracts/src/index.ts'
import { buildCard } from './cards.ts'

// A Run that declares and reads `count` observables of one object, each with a long label.
const runOf = (count: number) => {
  const refs = Array.from({ length: count }, (_, index) => `plant:p#signal${index}`)
  const observables = refs.map((ref, index) => ({ ref, label: `A long declared observable label number ${index} for the card`, unit: 'MPa', thresholds: [] }))
  return {
    refs,
    run: {
      objects: [{ id: 'plant:p', label: 'Plant P' }],
      port: {
        declarations: async () => [{ objectId: 'plant:p', observables, elements: [] }],
        read: async () => ({ observations: refs.map((ref, index) => ({ ref, value: 15 + index / 100, at: '2026-01-01T10:00:00.000Z' })) }),
      },
    } as never,
  }
}

describe('buildCard holds the contracts card cap', () => {
  test('a card past 1,900 characters of lines is trimmed, and what it leaves out is counted and stated', async () => {
    const { run, refs } = runOf(30)
    const card = await buildCard(run, refs)
    expect(displayCardTextLength(card)).toBeLessThanOrEqual(DISPLAY_CARD_MAX_TEXT)
    expect(card.items.length).toBeLessThan(30)
    expect(card.more).toBe(30 - card.items.length)
    expect(card.adjusted).toEqual([{ kind: 'layout', text: `${30 - card.items.length} of 30 items not shown (card limit)` }])
  })

  test('a card within the cap keeps every item and states nothing', async () => {
    const { run, refs } = runOf(3)
    const card = await buildCard(run, refs)
    expect([card.items.length, card.more, card.adjusted]).toEqual([3, 0, []])
  })
})
