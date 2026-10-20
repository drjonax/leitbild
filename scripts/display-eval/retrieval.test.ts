import { describe, expect, test } from 'bun:test'
import { weatherQuantities } from '../../apps/world/src/packs/weather/quantities.ts'
import { fixturePath } from './scenarios.ts'
import { hits, loadPairs, PACKS, scoreRecall, signalCatalog, stalePairs, type RetrievalPair, type SearchMatch } from './retrieval.ts'

const match = (fields: Partial<SearchMatch> & Pick<SearchMatch, 'kind' | 'objectId'>): SearchMatch => ({ label: 'x', pack: 'p', score: 1, ...fields })

describe('T11 hit rules (architecture A4 matches)', () => {
  test('an observable by its ref or by objectId + tag, as the pair declares (R23); never the same signal on another unit', () => {
    const ref = { kind: 'ref', ref: 'plant:halden-2#sgB.levelPercent' } as const
    const tag = { kind: 'tag', objectId: 'plant:halden-2', tag: 'SG-B-LVL-NR' } as const
    const unit2 = match({ kind: 'observable', objectId: 'plant:halden-2', ref: 'plant:halden-2#sgB.levelPercent', tag: 'SG-B-LVL-NR' })
    expect([hits(ref, unit2), hits(tag, unit2)]).toEqual([true, true])
    const unit3 = match({ kind: 'observable', objectId: 'plant:halden-3', ref: 'plant:halden-3#sgB.levelPercent', tag: 'SG-B-LVL-NR' })
    expect([hits(ref, unit3), hits(tag, unit3)]).toEqual([false, false])
    // A tag is never a ref.
    expect(hits({ kind: 'ref', ref: 'plant:halden-2#SG-B-LVL-NR' }, unit2)).toBe(false)
    expect(hits(tag, match({ kind: 'object', objectId: 'plant:halden-2' }))).toBe(false)
  })

  test('a grid element by its asset id, or an observable measured on it; a grid quantity by its ref', () => {
    const element = { kind: 'element', objectId: 'grid:g', element: 'branch:b' } as const
    expect(hits(element, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:b', class: 'switch' } }))).toBe(true)
    expect(hits(element, match({ kind: 'observable', objectId: 'grid:g', ref: 'grid:g#branch:b.loading', element: { id: 'branch:b', class: 'switch' } }))).toBe(true)
    expect(hits(element, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:c', class: 'switch' } }))).toBe(false)
    const loading = { kind: 'ref', ref: 'grid:g#branch:b.loading' } as const
    expect(hits(loading, match({ kind: 'element', objectId: 'grid:g', element: { id: 'branch:b', class: 'switch' } }))).toBe(false)
    expect(hits(loading, match({ kind: 'observable', objectId: 'grid:g', ref: 'grid:g#branch:b.loading' }))).toBe(true)
    expect(hits({ kind: 'object', objectId: 'unit:1' }, match({ kind: 'object', objectId: 'unit:1' }))).toBe(true)
  })

  test('reviewed recall leaves removed pairs out and scores re-keyed ones by their new expectations; raw scores every pair as mined', () => {
    const base = { pack: 'drone', form: 'id', source: 's', review: 'AI-drafted, pending review' } as const
    const pairs: ReadonlyArray<RetrievalPair> = [
      { ...base, query: { text: 'a' }, expect: [{ kind: 'object', objectId: 'drone:a' }], removed: 'names a condition' },
      { ...base, query: { text: 'b' }, expect: [{ kind: 'object', objectId: 'drone:b' }], rekeyed: { reason: 'names b', was: [{ kind: 'object', objectId: 'drone:x' }] } },
    ]
    const scored = scoreRecall(pairs, [{ matches: [match({ kind: 'object', objectId: 'drone:a' })] }, { matches: [match({ kind: 'object', objectId: 'drone:b' })] }])
    expect([scored.all, scored.raw.all]).toEqual([{ pairs: 1, hits: 1, recall: 1 }, { pairs: 2, hits: 1, recall: 0.5 }])
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
  test('the reviewed set (R34) keeps at least 150 pairs and at least 20 for every pack, each with an expectation', async () => {
    const all = await loadPairs()
    // Removed pairs give their reason; re-keyed ones keep the mined expectations that raw recall scores.
    for (const pair of all) if (pair.removed !== undefined) expect(pair.removed.length).toBeGreaterThan(10)
    for (const pair of all) if (pair.rekeyed !== undefined) expect([pair.rekeyed.reason.length > 10, pair.rekeyed.was.length > 0]).toEqual([true, true])
    const pairs = all.filter(pair => pair.removed === undefined)
    expect(pairs.length).toBeGreaterThanOrEqual(150)
    for (const pack of PACKS) expect({ pack, enough: pairs.filter(pair => pair.pack === pack).length >= 20 }).toEqual({ pack, enough: true })
    for (const pair of pairs) expect(pair.expect.length).toBeGreaterThan(0)
    // Norwegian names and qualified objectId# forms are in it (V14).
    expect(pairs.filter(pair => /[æøåÆØÅ]/.test(pair.query.text)).length).toBeGreaterThanOrEqual(10)
    expect(pairs.filter(pair => pair.form === 'qualified').length).toBeGreaterThanOrEqual(8)
  })

  test('every plant ref names a variable path and every tag an I&C tag, every weather ref a quantity id, and every object is one of the fixture\'s or one its cues create by 240 s', async () => {
    const fixture = await Bun.file(fixturePath('fixture:integrated-all-packs')!).json() as { packs: ReadonlyArray<{ items?: ReadonlyArray<{ id: string }> }> }
    // The Einsatz cues create Truck 2 (120 s), R-2 Shelter (150 s) and U-2 Pumping station fuel (180 s) with these ids;
    // retrieval.ts checks them, and the grid elements, in the Run it asks.
    const objects = new Set([...fixture.packs.flatMap(pack => (pack.items ?? []).map(item => item.id)), 'unit:1', 'task:1', 'task:2'])
    const catalog = signalCatalog(weatherQuantities.map(quantity => quantity.id))
    expect(stalePairs(await loadPairs(), { objects, ...catalog, elementExists: () => true })).toEqual([])
    // A plant ref names a variable path, never a tag (R23).
    expect([catalog.signalExists('plant:halden-2', 'pressurizer.pressureMPa'), catalog.signalExists('plant:halden-2', 'PT-455'), catalog.tagExists('plant:halden-2', 'PT-455')]).toEqual([true, false, true])
  })
})
