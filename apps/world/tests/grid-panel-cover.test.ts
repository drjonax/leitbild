import { describe, expect, test } from 'bun:test'
import { gridPanelMapCover } from '../src/ui/grid/panel-cover.ts'

// The grid overview panel declares the map it covers, so the camera and the read-only alarm strip keep clear of it.
describe('grid overview panel map cover', () => {
  test('a panel on the right covers the right side from its left edge; on the left, the left side to its right edge', () => {
    expect(gridPanelMapCover({ left: 1402, width: 500 }, 1920)).toEqual({ top: 0, right: 518, bottom: 0, left: 0 })
    expect(gridPanelMapCover({ left: 12.4, width: 400 }, 1920)).toEqual({ top: 0, right: 0, bottom: 0, left: 413 })
  })

  test('no frame, no cover', () => {
    expect(gridPanelMapCover(null, 1920)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})
