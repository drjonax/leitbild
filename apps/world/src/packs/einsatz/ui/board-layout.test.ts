import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRailWidth } from '../../../ui/rail-state.ts'
import { cameraPaddingFor, noMapCover } from '../../../ui/surface-panel-interaction.ts'
import type { Arrangement } from '../board/types.ts'
import { boardChromePx, boardEdgeGapPx, boardHeightFor, boardLayoutFor, boardMapCover, boardSections, listHeadingPx, listHeightsFor, listRowsTemplate, minBoardWidthPx, minMapWidthPx, rowBoxPx, rowBoxStyle, rowBoxVars, rowPx, tapPx, visibleRows } from './board-layout.ts'

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

  test('at 960 × 720 Calls and Assets keep fixed shares that each show at least two whole rows, Calls the larger, with the alerts strip shown or not', () => {
    // The Host's header takes 44 px of a 720 px window; the World surface is the rest.
    const board = boardHeightFor(720 - 44)
    for (const alerts of [true, false]) {
      const heights = listHeightsFor(board, ['work', 'units'], alerts)
      expect(visibleRows(heights.work!, 'work')).toBeGreaterThanOrEqual(2)
      expect(visibleRows(heights.units!, 'units')).toBeGreaterThanOrEqual(2)
      expect(heights.work!).toBeGreaterThan(heights.units!)
      // With Contacts as well, every list still shows a row.
      const three = listHeightsFor(board, ['work', 'units', 'contacts'], alerts)
      for (const section of ['work', 'units', 'contacts'] as const) expect(visibleRows(three[section]!, section)).toBeGreaterThanOrEqual(1)
      // The parts add up to the Board.
      const { padding, gap, actionBar, statusLine, log } = boardChromePx
      const strip = alerts ? boardChromePx.alerts + gap : 0
      expect(heights.work! + heights.units! + gap + 2 * padding + strip + actionBar + statusLine + log + 3 * gap).toBeCloseTo(board, 6)
    }
    // Two rows: their lines, padding and borders, and one gap between them, below the heading.
    expect(visibleRows(listHeadingPx + 2 * rowPx.work - rowBoxPx.gap, 'work')).toBe(2)
    expect([rowPx.work, rowPx.units, listHeadingPx]).toEqual([70, 52, 20])
  })

  test('the rows on screen are the rows this layout counts: the panel binds the row box on the Board, and every list sizes its rows and heading with it', () => {
    expect(rowBoxStyle).toBe('--board-line: 16px; --line-gap: 2px; --row-pad: 6px; --row-gap: 4px; --heading-gap: 4px')
    const source = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8')
    const panel = source('BoardPanel.svelte')
    expect(panel).toContain('style={rowBoxStyle}')
    expect(panel).toContain('line-height: var(--board-line);')
    expect(panel).toContain('style:max-height={`${boardChromePx.alerts}px`}')
    for (const file of ['BoardWorkList.svelte', 'BoardUnits.svelte', 'BoardContacts.svelte']) {
      const sheet = source(file)
      for (const name of Object.keys(rowBoxVars).filter(entry => entry !== '--board-line')) expect(sheet).toContain(`var(${name})`)
      expect(sheet).toMatch(/\n {2}\.row \{[^}]*border: 1px solid/)
      // No row, list or line sets its own height, line height, padding or gap past the box.
      expect(sheet).not.toMatch(/line-height:/)
    }
  })

  test('each list scrolls within its own share, and every row and line holding a tap target is at least 44 px', () => {
    expect(listRowsTemplate(['work', 'units'])).toBe('minmax(0, 4fr) minmax(0, 3fr)')
    expect(listRowsTemplate(['contacts', 'units'])).toBe('minmax(0, 3fr) minmax(0, 3fr)')
    expect(Math.min(...Object.values(rowPx), boardChromePx.statusLine)).toBeGreaterThanOrEqual(tapPx)
    expect(tapPx).toBe(44)
    const panel = readFileSync(join(import.meta.dir, 'BoardPanel.svelte'), 'utf8')
    expect(panel).toContain('style:grid-template-rows={listRowsTemplate(sections)}')
  })

  test('the lists follow the arrangement: the work list leads for queues, Contacts for map-led roles, and a list left out is not shown', () => {
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })).toEqual(['work', 'units'])
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })).toEqual(['work', 'units', 'contacts'])
    expect(boardSections({ lead: 'map', workList: false, unitBoard: true, contacts: true })).toEqual(['contacts', 'units'])
    expect(boardSections({ lead: 'map', workList: true, unitBoard: false, contacts: true })).toEqual(['contacts', 'work'])
  })
})
