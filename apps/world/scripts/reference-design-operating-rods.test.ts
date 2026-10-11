import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { compileOperatingRods, parseS2Holding, parseS2Rods, OPERATING_RODS_PAGES } from './reference-design-operating-rods'

const fence = (name: string, body: string) => '```' + name + '\n' + body + '\n```\n'

test('S2 rod and holding blocks are strict and single', () => {
  expect(parseS2Rods(fence('ld01-s2-rods', '{"spiderDrag":"pending","envelopeDiskDragCoefficient":1.28}')))
    .toEqual({ spiderDrag: 'pending', envelopeDiskDragCoefficient: 1.28 })
  expect(() => parseS2Rods(fence('ld01-s2-rods', '{"spiderDrag":"maybe","envelopeDiskDragCoefficient":1.28}'))).toThrow()
  expect(() => parseS2Rods(fence('ld01-s2-rods', '{"spiderDrag":"omitted","envelopeDiskDragCoefficient":1.28,"x":1}'))).toThrow()
  expect(() => parseS2Rods('no block')).toThrow('Expected one ld01-s2-rods block')
  expect(parseS2Holding(fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0.2}'))).toEqual({ turbineTripToOpening_s: 0.2 })
  expect(() => parseS2Holding(fence('ld01-s2-holding-circuit', '{"turbineTripToOpening_s":0}'))).toThrow()
})

const wiki = process.env.LD01_WIKI_ROOT
test.skipIf(!wiki)('the actual rods section is the footprint, its record and the declared boundaries', async () => {
  const s = await compileOperatingRods(wiki!)
  expect(s.clusters).toHaveLength(52)
  expect(s.clusters.map(c => c.id)).toEqual(Array.from({ length: 52 }, (_, i) => 'LD01.CR.' + String(i + 1).padStart(3, '0')))
  // Assembly order: increasing y, then x; the central assembly has none.
  const order = s.clusters.map(c => c.lattice[1]! * 100 + c.lattice[0]!)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(s.clusters.some(c => c.lattice[0] === 0 && c.lattice[1] === 0)).toBe(false)
  const sector = [0, 0, 0, 0]
  for (const c of s.clusters) {
    expect(c.sector_shares.reduce((a, b) => a + b, 0)).toBe(1)
    expect(c.sector_shares.every(w => [0, 0.25, 0.5, 1].includes(w) || Number.isInteger(w * 48))).toBe(true)
    c.sector_shares.forEach((w, k) => { sector[k]! += w })
    // An axis cluster is split, an off-axis one is not.
    const onAxis = c.lattice[0] === 0 || c.lattice[1] === 0
    expect(c.sector_shares.filter(w => w > 0)).toHaveLength(onAxis ? 2 : 1)
  }
  expect(sector).toEqual([13, 13, 13, 13])
  expect(s.bodies.mass_kg + s.spider.mass_kg).toBeCloseTo(35.004273597401564, 10)
  expect(s.cells.lower.top_m).toBe(s.cells.core[0]![0]!.bottom_m)
  expect(s.cells.core[0]![1]!.top_m).toBe(s.cells.upper.bottom_m)
  expect(s.cells.upper.top_m).toBe(s.cells.housing_main.bottom_m)
  expect(s.guide.upper_mouth_m - s.guide.lower_mouth_m).toBeCloseTo(s.bodies.length_m, 12)
  expect(s.holding.turbine_trip_to_opening_s).toBe(0.2)
  expect(s.reference_travel_m).toBe(2.8)
  const root = join(wiki!, 'world/packs/process-plant/reference-designs/ld-01')
  for (const [i, name] of OPERATING_RODS_PAGES.entries()) {
    const text = await Bun.file(join(root, name)).text()
    expect(s.provenance[i]).toEqual({ name, sha256: createHash('sha256').update(text).digest('hex') })
  }
})
