import { describe, expect, test } from 'bun:test'
import { ROD_SHOWN, VESSEL_SHAPE, vesselGeometry } from '../src/ui/embed/vignette/vessel-symbol.ts'

// The reactor vessel's geometry as the vignette draws it: a pure function of
// the drawn box, its level and its rod banks' insertion.

const origin = { x: 1512, y: 720 }
// The Full-HD overview's vessel: two cells wide, its eight nozzles on its left face.
const nozzles = [48, 60, 72, 84, 96, 108, 120, 144].map(y => ({ x: origin.x, y: origin.y + y, face: 'left' as const }))
const overview = (level: number | null, groups: ReadonlyArray<ReadonlyArray<number | null>>) =>
  vesselGeometry({ height: 168, origin, drawing: { core: 'overlap', span: { x: 0, width: 48 }, nozzles }, level, groups })

describe('the reactor vessel symbol', () => {
  test('collars where its pipes reach it, a head above them, and its core region over the bottom of its body', () => {
    const shape = overview(100, [[0, 0, 0, 0], [0, 0, 0, 8 / 228]])
    expect(shape.collars).toHaveLength(8)
    expect(shape.collars.every(collar => collar.x === 0 && collar.width === shape.body.x)).toBe(true)
    expect(shape.collars.map(collar => collar.y + collar.height / 2)).toEqual([48, 60, 72, 84, 96, 108, 120, 144])
    // The head's flange sits above the first nozzle; the body ends where the bottom dome starts.
    expect(shape.flange.y + shape.flange.height).toBeLessThan(48 - 5)
    expect(shape.body.y + shape.body.height).toBe(168 - VESSEL_SHAPE.bottomDome)
    const core = shape.core!
    expect(core.y + core.height).toBe(shape.body.y + shape.body.height)
    expect(core.height).toBe(VESSEL_SHAPE.coreBand)
    // Eight bars in two groups, all inside the core region and apart from one another.
    expect(core.bars).toHaveLength(8)
    const edges = core.bars.map(bar => [bar.x, bar.x + bar.width] as const)
    expect(edges[0]![0]).toBeGreaterThanOrEqual(core.x)
    expect(edges.at(-1)![1]).toBeLessThanOrEqual(core.x + core.width + 1e-9)
    edges.slice(1).forEach(([left], index) => expect(left).toBeGreaterThan(edges[index]![1]))
    expect(edges[4]![0] - edges[3]![1]).toBeGreaterThan(edges[1]![0] - edges[0]![1])
    // At power: seven banks out, the last control bank 8 steps in; every one shows itself withdrawn above the core
    // region, never as a 2 px tick (ISA-101 review of run 26c).
    expect(core.bars.map(bar => bar.inserted)).toEqual([0, 0, 0, 0, 0, 0, 0, expect.closeTo((8 / 228) * core.height, 6)])
    expect(core.bars.map(bar => bar.withdrawn)).toEqual(Array.from({ length: 8 }, () => ROD_SHOWN))
    expect(core.y - shape.body.y).toBeGreaterThanOrEqual(ROD_SHOWN)
  })

  test('its fill spans the interior by the level it reads; a level it does not know is no fill, never an empty vessel', () => {
    expect(overview(100, []).fill).toEqual({ top: 4 })
    expect(overview(0, []).fill).toEqual({ top: 164 })
    expect(overview(50, []).fill).toEqual({ top: 84 })
    expect(overview(null, []).fill).toBeNull()
    // Tripped, every bank is in; one whose reading is missing is drawn as not known.
    const tripped = overview(100, [[1, 1, 1, 1], [1, 1, 1, null]])
    expect(tripped.core!.bars.map(bar => bar.inserted)).toEqual([...Array.from({ length: 7 }, () => tripped.core!.height), null])
    expect(tripped.core!.bars.map(bar => bar.withdrawn)).toEqual([...Array.from({ length: 7 }, () => 0), null])
  })

  test('equipment that heats nothing has no core region', () => {
    expect(vesselGeometry({ height: 168, origin, drawing: { core: null, span: { x: 0, width: 96 }, nozzles: [] }, level: 80, groups: [] }).core).toBeNull()
  })
})
