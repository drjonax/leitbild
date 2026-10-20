import { describe, expect, test } from 'bun:test'
import { weatherQuantities } from '../../apps/world/src/packs/weather/quantities.ts'
import { fixturePath } from './scenarios.ts'
import { hits, loadPairs, PACKS, scoreRecall, signalCatalog, stalePairs, type RetrievalPair, type SearchMatch } from './retrieval.ts'

const match = (fields: Partial<SearchMatch> & Pick<SearchMatch, 'kind' | 'objectId'>): SearchMatch => ({ label: 'x', pack: 'p', score: 1, ...fields })

describe('T11 hit rules (architecture A4 matches)', () => {
  test('an observable by its objectId#signalId ref or its tag; never the same signal on another unit', () => {
    const expected = { kind: 'signal', objectId: 'plant:halden-2', signal: 'SG-B-LVL-NR' } as const
    expect(hits(expected, match({ kind: 'observable', objectId: 'plant:halden-2', ref: 'plant:halden-2#SG-B-LVL-NR' }))).toBe(true)
    expect(hits(expected, match({ kind: 'observable', objectId: 'plant:halden-2', ref: 'plant:halden-2#sgB.levelPercent', tag: 'SG-B-LVL-NR' }))).toBe(true)
    expect(hits(expected, match({ kind: 'observable', objectId: 'plant:halden-3', ref: 'plant:halden-3#SG-B-LVL-NR', tag: 'SG-B-LVL-NR' }))).toBe(false)
    expect(hits(expected, match({ kind: 'object', objectId: 'plant:halden-2' }))).toBe(false)
  })

  test('a grid element, or an observable measured on it; with a quantity only that observable', () => {
    const element = { kind: 'element', objectId: 'grid:g', element: 'branch:b' } as const
    expect(hits(element, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:b', class: 'switch' } }))).toBe(true)
    expect(hits(element, match({ kind: 'observable', objectId: 'grid:g', element: { id: 'branch:b', class: 'switch' }, quantity: 'loading' }))).toBe(true)
    expect(hits(element, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:c', class: 'switch' } }))).toBe(false)
    const loading = { ...element, quantity: 'loading' }
    expect(hits(loading, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:b', class: 'switch' } }))).toBe(false)
    expect(hits({ kind: 'element', objectId: 'grid:g', quantity: 'frequency' }, match({ kind: 'observable', objectId: 'grid:g', quantity: 'frequency' }))).toBe(true)
    expect(hits({ kind: 'object', objectId: 'unit:1' }, match({ kind: 'object', objectId: 'unit:1' }))).toBe(true)
  })

  test('recall counts a hit within the top 8 only, per pack and overall, and lists every miss', () => {
    const pair = (pack: string, objectId: string): RetrievalPair => ({ pack, query: { text: objectId }, expect: [{ kind: 'object', objectId }], form: 'id', source: 's', review: 'AI-drafted, pending review' })
    const filler = Array.from({ length: 8 }, (_, index) => match({ kind: 'object', objectId: `other:${index}` }))
    const scored = scoreRecall([pair('drone', 'drone:a'), pair('drone', 'drone:b')], [
      { matches: [match({ kind: 'object', objectId: 'drone:a' })] },
      { matches: [...filler, match({ kind: 'object', objectId: 'drone:b' })] },
    ])
    expect(scored.byPack.drone).toEqual({ pairs: 2, hits: 1, recall: 0.5 })
    expect(scored.misses).toHaveLength(1)
    expect(scored.pass).toBe(false)
  })
})

describe('the T11 corpus', () => {
  test('at least 150 pairs, at least 20 for every pack of the integrated fixture, each with an expectation', async () => {
    const pairs = await loadPairs()
    expect(pairs.length).toBeGreaterThanOrEqual(150)
    for (const pack of PACKS) expect({ pack, enough: pairs.filter(pair => pair.pack === pack).length >= 20 }).toEqual({ pack, enough: true })
    for (const pair of pairs) expect(pair.expect.length).toBeGreaterThan(0)
    // Norwegian names and qualified objectId# forms are in it (V14).
    expect(pairs.filter(pair => /[æøåÆØÅ]/.test(pair.query.text)).length).toBeGreaterThanOrEqual(10)
    expect(pairs.filter(pair => pair.form === 'qualified').length).toBeGreaterThanOrEqual(8)
  })

  test('every plant and weather signal exists, and every object is one of the fixture\'s or one its cues create by 240 s', async () => {
    const fixture = await Bun.file(fixturePath('fixture:integrated-all-packs')!).json() as { packs: ReadonlyArray<{ items?: ReadonlyArray<{ id: string }> }> }
    // The Einsatz cues create Truck 2 (120 s), R-2 Shelter (150 s) and U-2 Pumping station fuel (180 s) with these ids;
    // retrieval.ts checks them, and the grid elements, in the Run it asks.
    const objects = new Set([...fixture.packs.flatMap(pack => (pack.items ?? []).map(item => item.id)), 'unit:1', 'task:1', 'task:2'])
    const stale = stalePairs(await loadPairs(), { objects, signalExists: signalCatalog(weatherQuantities.map(quantity => quantity.id)), elementExists: () => true })
    expect(stale).toEqual([])
  })
})
