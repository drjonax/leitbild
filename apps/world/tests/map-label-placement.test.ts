import { describe, expect, test } from 'bun:test'
import { labelSize, mercatorPixels, placeLabels, slotAnchor, type LabelCandidate, type LabelObstacle } from '../src/ui/map-runtime/label-placement.ts'

const candidate = (id: string, x: number, y: number, text: string, extra: Partial<LabelCandidate> = {}): LabelCandidate =>
  ({ id, x, y, text, iconSizePx: 24, selected: false, highlighted: false, priority: 40, ...extra })
const icon = (entry: LabelCandidate): LabelObstacle => ({ id: entry.id, x: entry.x, y: entry.y, iconSizePx: entry.iconSizePx })
const place = (entries: ReadonlyArray<LabelCandidate>, extra: ReadonlyArray<LabelObstacle> = []) => placeLabels(entries, [...entries.map(icon), ...extra])

describe('map label placement', () => {
  test('labels far apart all sit below their icons', () => {
    const slots = place([candidate('a', 0, 0, 'Patrol 1 · AV'), candidate('b', 400, 0, 'Patrol 2 · AV')])
    expect([...slots]).toEqual([['a', 'below'], ['b', 'below']])
  })

  test('a label that would overlap one placed before moves to another side of its icon, and one with no free side is left out', () => {
    // A depot and a unit standing on it: "Brekke depot" and "Truck 1 · AV" no longer merge into one string.
    const depot = candidate('depot', 0, 0, 'Brekke depot', { priority: 40 })
    const truck = candidate('truck', 6, 4, 'Truck 1 · AV', { priority: 60 })
    const slots = place([depot, truck])
    expect(slots.get('truck')).toBe('below')
    expect(slots.get('depot')).toBe('above')
    // A tight stack of five: whatever cannot be placed is not drawn rather than drawn over another.
    const stack = ['A1', 'A2', 'A3', 'A4', 'A5'].map((id, index) => candidate(id, index * 2, index * 2, `${id} · Ambulance · AV`))
    const stacked = place(stack)
    expect(stacked.size).toBeLessThan(stack.length)
    expect(stacked.size).toBeGreaterThan(1)
  })

  test('the selected object places first and always shows its label; then the highlighted, then higher priority', () => {
    const plain = candidate('plain', 0, 0, 'Plain label', { priority: 90 })
    const selected = candidate('selected', 1, 1, 'Selected label', { selected: true })
    const crowd = [-30, 30].flatMap(dx => [-20, 20].map(dy => candidate(`c${dx}${dy}`, dx, dy, 'Crowd label', { priority: 90 })))
    const slots = place([plain, selected, ...crowd])
    expect(slots.get('selected')).toBe('below')
    expect(place([candidate('low', 0, 0, 'Same place'), candidate('high', 0, 0, 'Same place', { priority: 70 })]).get('high')).toBe('below')
    expect(place([candidate('lit', 0, 0, 'Same place', { highlighted: true }), candidate('high', 0, 0, 'Same place', { priority: 90 })]).get('lit')).toBe('below')
  })

  test('a label keeps clear of other icons, labelled or not', () => {
    const unit = candidate('u', 0, 0, 'Unit 1')
    const below = slotAnchor('below', 24).offset[1]
    const blocker: LabelObstacle = { id: 'other', x: 0, y: below + labelSize('Unit 1').height / 2, iconSizePx: 24 }
    expect(place([unit], [blocker]).get('u')).toBe('above')
  })

  test('positions are Web Mercator pixels on a 512 px world, so a placement holds while the map pans and scales with zoom', () => {
    expect(mercatorPixels(0, 0, 0)).toEqual({ x: 256, y: 256 })
    const at11 = mercatorPixels(11.38, 59.12, 11)
    const at12 = mercatorPixels(11.38, 59.12, 12)
    expect(at12.x / at11.x).toBeCloseTo(2, 10)
    expect(at12.y / at11.y).toBeCloseTo(2, 10)
    expect(mercatorPixels(11.39, 59.12, 12).x - at12.x).toBeCloseTo(0.01 / 360 * 512 * 4096, 6)
  })
})
