import { describe, expect, test } from 'bun:test'
import { mapWithConcurrency } from './bounded-fan-out.ts'

describe('mapWithConcurrency', () => {
  test('keeps at most the limit running and returns results in item order', async () => {
    let running = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, index) => index)
    const results = await mapWithConcurrency(items, 16, async item => {
      running += 1
      peak = Math.max(peak, running)
      // Later items finish first, so order comes from the index, not completion.
      await Bun.sleep((50 - item) % 5)
      running -= 1
      return item * 2
    })
    expect(results).toEqual(items.map(item => item * 2))
    expect(peak).toBe(16)
  })

  test('rejects with the first failure and starts no further item', async () => {
    const started: number[] = []
    const failing = mapWithConcurrency(Array.from({ length: 40 }, (_, index) => index), 4, async item => {
      started.push(item)
      await Bun.sleep(1)
      if (item === 2) throw new Error('unreadable item 2')
      return item
    })
    await expect(failing).rejects.toThrow('unreadable item 2')
    expect(started.length).toBeLessThan(40)
  })

  test('refuses a limit that is not a positive integer', async () => {
    await expect(mapWithConcurrency([1], 0, async item => item)).rejects.toThrow('positive integer')
  })
})
