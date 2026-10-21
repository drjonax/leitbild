import { describe, expect, test } from 'bun:test'
import { DISPLAY_CARD_MAX_TEXT, displayCardItemSchema, displayCardSchema, displayCardTextLength, priorityLevels } from './display-card.ts'

const at = { at: '2026-10-21T08:00:00.000Z', clock: 'simulation' } as const
const item = {
  key: 'k3', label: 'Unit 2 · SG A narrow-range level', reading: '31.5 % · caution', unit: '%', numbers: [{ value: 31.5, decimals: 1 }],
  limits: [{ value: 20, decimals: 1 }], priority: 'caution', subject: { ref: 'unit-2#SG-A-NR-LVL' },
} as const

describe('display card', () => {
  test('an item is keyed for citation and carries its numbers, its declared limits and its priority', () => {
    expect(displayCardItemSchema.parse(item).key).toBe('k3')
    expect(displayCardItemSchema.safeParse({ ...item, key: 'x3' }).success).toBe(false)
    expect(displayCardItemSchema.safeParse({ ...item, numbers: Array.from({ length: 9 }, () => ({ value: 1, decimals: 0 })) }).success).toBe(false)
    expect(displayCardItemSchema.safeParse({ ...item, limits: Array.from({ length: 5 }, () => ({ value: 1, decimals: 0 })) }).success).toBe(false)
    expect(displayCardItemSchema.safeParse({ ...item, priority: 'red' }).success).toBe(false)
    expect(priorityLevels).toEqual(['none', 'notice', 'caution', 'warning', 'alarm', 'emergency'])
  })

  test('an item stands for an observable, an object or one alert of an object, and nothing else', () => {
    for (const subject of [{ objectId: 'incident-7' }, { objectId: 'grid:halden', alertId: 'alert-3' }]) expect(displayCardItemSchema.safeParse({ ...item, subject }).success).toBe(true)
    for (const subject of [{ eventId: 'e-9', at }, { featureId: 'line-420', attribution: '© OpenStreetMap contributors' }, { lon: 11.3 }, { ref: 'unit-2#A', objectId: 'unit-2' }]) {
      expect(displayCardItemSchema.safeParse({ ...item, subject }).success).toBe(false)
    }
  })

  test('a card holds at most 48 unique items, eight adjustments and 2,400 characters', () => {
    const card = { at, items: [item], more: 0, adjusted: [{ kind: 'scope', text: 'Reach narrowed to 2 links', lost: 'aux feed', alternatives: ['feed-to-sg'] }] }
    expect(displayCardSchema.parse(card).items).toHaveLength(1)
    expect(displayCardSchema.safeParse({ ...card, items: [item, item] }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, at: { at: at.at } }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, adjusted: [{ kind: 'layout', text: 'x', alternatives: ['y'] }] }).success).toBe(false)
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, label: 'l', reading: 'r', numbers: [] }))
    expect(displayCardSchema.safeParse({ ...card, items: many(48), adjusted: [] }).success).toBe(true)
    expect(displayCardSchema.safeParse({ ...card, items: many(49), adjusted: [] }).success).toBe(false)
    const long = { ...item, label: 'L'.repeat(80), reading: 'R'.repeat(120) }
    const fits = Math.floor(DISPLAY_CARD_MAX_TEXT / displayCardTextLength({ items: [{ ...long, key: 'k10' }], adjusted: [] }))
    expect(displayCardSchema.safeParse({ at, items: Array.from({ length: fits }, (_, index) => ({ ...long, key: `k${10 + index}` })), more: 0, adjusted: [] }).success).toBe(true)
    expect(displayCardSchema.safeParse({ at, items: Array.from({ length: fits + 1 }, (_, index) => ({ ...long, key: `k${10 + index}` })), more: 0, adjusted: [] }).error?.issues[0]?.message)
      .toBe('a card shows at most 2400 characters')
  })

  test('the text a reader is shown counts each item line and each adjustment', () => {
    expect(displayCardTextLength({ items: [displayCardItemSchema.parse(item)], adjusted: [{ text: '2 alerts not shown' }] }))
      .toBe('k3 · Unit 2 · SG A narrow-range level · 31.5 % · caution'.length + '2 alerts not shown'.length)
  })
})
