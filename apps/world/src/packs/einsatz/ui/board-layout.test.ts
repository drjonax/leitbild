import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRailWidth } from '../../../ui/rail-state.ts'
import { cameraPaddingFor, noMapCover } from '../../../ui/surface-panel-interaction.ts'
import type { Arrangement } from '../board/types.ts'
import { boardEdgeGapPx, boardLayoutFor, boardMapCover, boardSections, minBoardWidthPx, minMapWidthPx } from './board-layout.ts'

const leads: ReadonlyArray<Arrangement['lead']> = ['work-list', 'map']

/** The map a screen keeps clear beside the Board: the surface less what the Board's observed width pads the camera by. */
const clearMap = (surfaceWidthPx: number, lead: Arrangement['lead']): number => {
  const padding = cameraPaddingFor([boardMapCover(boardLayoutFor(surfaceWidthPx, lead).widthPx)])
  return surfaceWidthPx - padding.left - padding.right
}

describe('Board layout', () => {
  test('at 960 px with the Board open and the rail collapsed, at least 400 px of map stays clear, and the camera is padded by exactly the Board', () => {
    // The Einsatz Pack starts the surface with its rail collapsed, so the map spans the window.
    for (const lead of leads) {
      const layout = boardLayoutFor(960, lead)
      expect(layout.mapWidthPx).toBeGreaterThanOrEqual(minMapWidthPx)
      expect(clearMap(960, lead)).toBe(layout.mapWidthPx)
      expect(clearMap(960, lead)).toBeGreaterThanOrEqual(400)
    }
    expect(boardLayoutFor(960, 'work-list')).toEqual({ widthPx: 480, mapWidthPx: 468 })
    expect(boardLayoutFor(960, 'map')).toEqual({ widthPx: 380, mapWidthPx: 568 })
  })

  test('the Board narrows before it hides the map, down to its least width, and keeps its preferred width on wide screens', () => {
    for (const lead of leads) {
      for (let surface = minBoardWidthPx + boardEdgeGapPx + minMapWidthPx; surface <= 2_560; surface += 8) {
        expect(clearMap(surface, lead)).toBeGreaterThanOrEqual(minMapWidthPx)
      }
      expect(boardLayoutFor(480, lead).widthPx).toBe(minBoardWidthPx)
    }
    expect(boardLayoutFor(1_920, 'work-list').widthPx).toBe(480)
    expect(boardLayoutFor(1_920, 'map').widthPx).toBe(380)
    expect(boardLayoutFor(800, 'work-list')).toEqual({ widthPx: 388, mapWidthPx: 400 })
  })

  test('with the rail open at 960 px the map would fall short, which is why the Pack starts with the rail collapsed', () => {
    expect(clearMap(960 - defaultRailWidth, 'work-list')).toBeLessThan(minMapWidthPx)
  })

  test('the camera is padded by the observed Board and its gap on the right only; an unmeasured Board pads nothing', () => {
    expect(boardMapCover(480)).toEqual({ top: 0, right: 480 + boardEdgeGapPx, bottom: 0, left: 0 })
    expect(boardMapCover(379.4)).toEqual({ top: 0, right: 380 + boardEdgeGapPx, bottom: 0, left: 0 })
    expect(boardMapCover(0)).toEqual(noMapCover)
    expect(() => boardLayoutFor(Number.NaN, 'map')).toThrow('The World surface is no width: NaN')
  })

  test('the panel lies where this layout says: it binds its width, edge gap and clearances from here and sets none of them in its style sheet', () => {
    const panel = readFileSync(join(import.meta.dir, 'BoardPanel.svelte'), 'utf8')
    for (const binding of ['style:width={`${layout.widthPx}px`}', 'style:right={`${boardEdgeGapPx}px`}', 'style:top={`${boardTopClearancePx}px`}', 'style:bottom={`${boardBottomClearancePx}px`}']) {
      expect(panel).toContain(binding)
    }
    const boardRule = /\n {2}\.board \{[^}]*\}/.exec(panel)?.[0]
    expect(boardRule).toBeDefined()
    expect(boardRule).not.toMatch(/\b(top|right|bottom|left|width):/)
  })

  test('the lists follow the arrangement: the work list leads for queues, Contacts for map-led roles, and a list left out is not shown', () => {
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })).toEqual(['work', 'units'])
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })).toEqual(['work', 'units', 'contacts'])
    expect(boardSections({ lead: 'map', workList: false, unitBoard: true, contacts: true })).toEqual(['contacts', 'units'])
    expect(boardSections({ lead: 'map', workList: true, unitBoard: false, contacts: true })).toEqual(['contacts', 'work'])
  })
})
