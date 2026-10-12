import { describe, expect, test } from 'bun:test'
import { startingZoomFor } from '../src/ui/map/map-camera.ts'

describe('starting camera', () => {
  test('a panel over the map lowers the Starting View\'s zoom so its whole extent fits the clear part', () => {
    // The Board at 960 × 720: 480 px wide plus its 12 px gap leaves 468 px of map.
    const zoom = startingZoomFor(12, { width: 960, height: 720 }, { top: 0, right: 492, bottom: 0, left: 0 })
    expect(2 ** (12 - zoom) * 468).toBeCloseTo(960, 6)
    // The narrower or shorter side decides.
    expect(startingZoomFor(12, { width: 1000, height: 500 }, { top: 250, right: 100, bottom: 0, left: 0 })).toBeCloseTo(11, 6)
  })

  test('nothing over the map, a map with no size yet, or no clear part keeps the authored zoom', () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 }
    expect(startingZoomFor(12, { width: 960, height: 720 }, none)).toBe(12)
    expect(startingZoomFor(12, { width: 0, height: 0 }, { ...none, right: 492 })).toBe(12)
    expect(startingZoomFor(12, { width: 400, height: 720 }, { ...none, right: 492 })).toBe(12)
  })
})
