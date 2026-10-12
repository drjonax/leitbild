import { describe, expect, test } from 'bun:test'
import { openBridgeDevice } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'
import type { MimicRow } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { insertedFraction, vesselGeometry } from '../src/ui/embed/composed-display/mimic/vessel-symbol.ts'
import { fillTracePath, programMark, stripReading } from '../src/ui/embed/composed-display/mimic/vessel-trends.ts'

// The reactor vessel's geometry and the vessels' traces, as the embed draws
// them: pure functions of the drawn box, the sample and the kept history.

const origin = { x: 1512, y: 720 }
// The Full-HD overview's vessel: two cells wide, its eight nozzles on its left face.
const nozzles = [48, 60, 72, 84, 96, 108, 120, 144].map(y => ({ x: origin.x, y: origin.y + y, face: 'left' as const }))
const overview = (level: number | null, groups: ReadonlyArray<ReadonlyArray<number | null>>) =>
  vesselGeometry({ height: 168, origin, drawing: { core: 'overlap', span: { x: 0, width: 48 }, nozzles }, level, groups })

describe('the reactor vessel symbol', () => {
  test('a part is in by its reading over its range, from the end it is out at', () => {
    const range = { min: 0, max: 228 }
    expect(insertedFraction(228, range, 'min')).toBe(0)
    expect(insertedFraction(0, range, 'min')).toBe(1)
    expect(insertedFraction(114, range, 'min')).toBe(0.5)
    expect(insertedFraction(57, range, 'max')).toBe(0.25)
    expect(insertedFraction(300, range, 'min')).toBe(0)
    expect(insertedFraction(null, range, 'min')).toBeNull()
    expect(insertedFraction(Number.NaN, range, 'min')).toBeNull()
  })

  test('collars where its pipes reach it, a head above them, and its core region over the bottom of its body', () => {
    const shape = overview(100, [[0, 0, 0, 0], [0, 0, 0, 8 / 228]])
    expect(shape.collars).toHaveLength(8)
    expect(shape.collars.every(collar => collar.x === 0 && collar.width === shape.body.x)).toBe(true)
    expect(shape.collars.map(collar => collar.y + collar.height / 2)).toEqual([48, 60, 72, 84, 96, 108, 120, 144])
    // The head's flange sits above the first nozzle; the body ends where the bottom dome starts.
    expect(shape.flange.y + shape.flange.height).toBeLessThan(48 - 5)
    expect(shape.body.y + shape.body.height).toBe(168 - openBridgeDevice.reactorVessel.bottomDome)
    const core = shape.core!
    expect(core.y + core.height).toBe(shape.body.y + shape.body.height)
    expect(core.height).toBe(openBridgeDevice.reactorVessel.coreBand)
    // Eight bars in two groups, all inside the core region and apart from one another.
    expect(core.bars).toHaveLength(8)
    const edges = core.bars.map(bar => [bar.x, bar.x + bar.width] as const)
    expect(edges[0]![0]).toBeGreaterThanOrEqual(core.x)
    expect(edges.at(-1)![1]).toBeLessThanOrEqual(core.x + core.width + 1e-9)
    edges.slice(1).forEach(([left], index) => expect(left).toBeGreaterThan(edges[index]![1]))
    expect(edges[4]![0] - edges[3]![1]).toBeGreaterThan(edges[1]![0] - edges[0]![1])
    // At power: seven banks out, the last control bank 8 steps in.
    expect(core.bars.map(bar => bar.length)).toEqual([0, 0, 0, 0, 0, 0, 0, expect.closeTo((8 / 228) * core.height, 6)])
  })

  test('its fill spans the interior by the level it reads; a level it does not know is no fill, never an empty vessel', () => {
    expect(overview(100, []).fill).toEqual({ top: 4 })
    expect(overview(0, []).fill).toEqual({ top: 164 })
    expect(overview(50, []).fill).toEqual({ top: 84 })
    expect(overview(null, []).fill).toBeNull()
    // Tripped, every bank is in; one whose reading is missing is drawn as not known.
    const tripped = overview(100, [[1, 1, 1, 1], [1, 1, 1, null]])
    expect(tripped.core!.bars.map(bar => bar.length)).toEqual([...Array.from({ length: 7 }, () => tripped.core!.height), null])
  })

  test('equipment that heats nothing has no core region', () => {
    expect(vesselGeometry({ height: 168, origin, drawing: { core: null, span: { x: 0, width: 96 }, nozzles: [] }, level: 80, groups: [] }).core).toBeNull()
  })
})

describe('vessel traces', () => {
  const now = Date.parse('2026-10-12T10:13:30Z')
  const cell = openBridgeDevice.tankFill
  test('a tank\'s fill trace lies on its fill\'s scale across the window, ending at now', () => {
    // Steady at 55 %, recorded once a minute: one unbroken line across the whole cell, at 55 % of the fill's height.
    const points = (path: string) => [...path.matchAll(/([ML])(\d+\.\d) (\d+\.\d)/g)].map(match => ({ move: match[1] === 'M', x: Number(match[2]), y: Number(match[3]) }))
    const steady = points(fillTracePath(Array.from({ length: 12 }, (_, index) => ({ t: now - 660_000 + index * 60_000, v: 55 })), now, 600_000, cell, 100))
    expect(steady.filter(point => point.move)).toHaveLength(1)
    expect(new Set(steady.map(point => point.y))).toEqual(new Set([Number((cell.y + 0.45 * cell.height).toFixed(1))]))
    expect([steady[0]!.x, steady.at(-1)!.x]).toEqual([cell.x, cell.x + cell.width])
    // Two minutes of history start where they start; none at all draws nothing.
    const young = [{ t: now - 120_000, v: 55 }]
    expect(fillTracePath(young, now, 600_000, cell, 100).startsWith(`M${(cell.x + 0.8 * cell.width).toFixed(1)} `)).toBe(true)
    expect(fillTracePath([], now, 600_000, cell, 100)).toBe('')
  })

  test('a tank marks its level program only while its level stands off it by more than a tenth of its span', () => {
    expect(programMark(55, 55)).toBeNull()
    expect(programMark(24.9, 25)).toBeNull()
    expect(programMark(30, 45)).toBe(45)
    expect(programMark(null, 45)).toBeNull()
    expect(programMark(30, null)).toBeNull()
  })

  test('a heat exchanger\'s strip traces the instrument its level row reads now', () => {
    const row: MimicRow = { kind: 'value', path: 'sgA.levelPercent', unit: 'percent', required: true, span: { min: 0, max: 100 }, wider: { path: 'sgA.wideRangeLevelPercent', span: { min: 0, max: 100 } } }
    expect(stripReading(row, false)).toBe('sgA.levelPercent')
    expect(stripReading(row, true)).toBe('sgA.wideRangeLevelPercent')
    expect(stripReading({ kind: 'position', required: true }, false)).toBeNull()
    expect(stripReading(undefined, false)).toBeNull()
  })
})
