import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRailWidth } from '../../../ui/rail-state.ts'
import { cameraPaddingFor, noMapCover } from '../../../ui/surface-panel-interaction.ts'
import type { Arrangement } from '../board/types.ts'
import { waitingAbove } from './reveal.ts'
import { boardChromePx, boardEdgeGapPx, boardHeightFor, boardLayoutFor, boardMapCover, boardSections, listContentPx, listHeadingPx, listHeightsFor, listRowsTemplate, listsHeightFor, minBoardWidthPx, minMapWidthPx, rowBoxPx, rowBoxStyle, rowBoxVars, rowPx, tapPx, visibleRows } from './board-layout.ts'

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

  test('at 960 × 720 and 1024 × 768, with both lists full, Calls and Assets each show at least two whole rows, Calls the larger, with the alerts strip shown or not', () => {
    // The Host's header takes 44 px of the window; the World surface is the rest.
    for (const window of [720, 768]) {
      const board = boardHeightFor(window - 44)
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

  test('a short Calls list takes only what its rows need and leaves no gap: Assets takes the rest, at 960 × 720 and 1024 × 768', () => {
    for (const window of [720, 768]) {
      const board = boardHeightFor(window - 44)
      for (const alerts of [true, false]) {
        const lists = listsHeightFor(board, alerts)
        for (const calls of [0, 1, 2]) {
          const heights = listHeightsFor(board, ['work', 'units'], alerts, { work: listContentPx('work', calls) })
          expect(heights.work).toBe(listContentPx('work', calls))
          expect(heights.work! + boardChromePx.gap + heights.units!).toBeCloseTo(lists, 6)
          // Assets gets more than its share when Calls is short.
          expect(heights.units!).toBeGreaterThan(lists * 3 / 7)
        }
      }
    }
    // At 1024 × 768 with two calls, four whole asset rows, where fixed shares gave two.
    expect(visibleRows(listHeightsFor(boardHeightFor(768 - 44), ['work', 'units'], false, { work: listContentPx('work', 2) }).units!, 'units')).toBeGreaterThanOrEqual(4)
  })

  test('each list scrolls within its own share, and every row and line holding a tap target is at least 44 px', () => {
    expect(listRowsTemplate(['work', 'units'])).toBe('fit-content(57.143%) minmax(0, 1fr)')
    expect(listRowsTemplate(['contacts', 'units'])).toBe('fit-content(50%) minmax(0, 1fr)')
    expect(listRowsTemplate(['work', 'units', 'contacts'])).toBe('fit-content(40%) fit-content(30%) minmax(0, 1fr)')
    expect(Math.min(...Object.values(rowPx), boardChromePx.statusLine)).toBeGreaterThanOrEqual(tapPx)
    expect(tapPx).toBe(44)
    const panel = readFileSync(join(import.meta.dir, 'BoardPanel.svelte'), 'utf8')
    expect(panel).toContain('style:grid-template-rows={listRowsTemplate(sections)}')
  })

  test('Close call is in view without scrolling the capped action bar: pinned to the right of the first row of buttons, under at most three lines of text, apart from the commit button', () => {
    const bar = readFileSync(join(import.meta.dir, 'BoardActionBar.svelte'), 'utf8')
    const markup = bar.slice(bar.indexOf('<div class="bar"'), bar.indexOf('<style>'))
    const rowStart = markup.indexOf('<div class="buttons">')
    // Above the row stand only the text line and a confirmation's detail, which never shows beside Close.
    expect([...markup.slice(0, rowStart).matchAll(/class="([\w-]+)"/g)].map(match => match[1])).toEqual(['bar', 'text', 'detail'])
    // In the row, the buttons that act wrap among themselves; Close follows them, outside their wrapping group.
    const row = markup.slice(rowStart, markup.indexOf('{#if task !== null}'))
    const main = row.slice(row.indexOf('<div class="main">'), row.indexOf('</div>'))
    expect(main).toContain('class="primary"')
    expect(main).not.toContain('class="close"')
    expect(row.indexOf('class="close"')).toBeGreaterThan(row.indexOf('</div>'))
    expect(markup.match(/class="close"/g)).toHaveLength(1)
    // The row itself never wraps, and Close neither shrinks nor wraps; a wide gap keeps it apart.
    const rule = (selector: string): string => new RegExp(`\\n {2}${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(bar)?.[1] ?? ''
    expect(rule('.buttons')).toContain('display: flex;')
    expect(rule('.buttons')).not.toContain('wrap')
    expect(Number(/gap: (\d+)px/.exec(rule('.buttons'))?.[1])).toBeGreaterThanOrEqual(3 * Number(/gap: (\d+)px/.exec(rule('.main'))?.[1]))
    expect(rule('.close')).toContain('flex: none;')
    // The cap holds three lines of text, the bar's gap and the row of buttons.
    const barGap = Number(/gap: (\d+)px/.exec(rule('.bar'))?.[1])
    expect(3 * rowBoxPx.line + barGap + tapPx).toBeLessThanOrEqual(boardChromePx.actionBar)
  })

  test('a call that arrives while Calls is scrolled lands above what it shows, and the marker over its top counts it until the list is back at the top', () => {
    const row = (index: number, waiting: boolean) => ({ waiting, top: index * rowPx.work, height: rowPx.work - rowBoxPx.gap })
    // Two served calls, scrolled a little to keep the selected one in view: nothing waits above.
    const served = [row(0, false), row(1, false)]
    expect(waitingAbove(served, 30)).toBe(0)
    // A waiting call arrives and takes the top; the list keeps its scroll, so the new row is out of view above.
    const arrived = [row(0, true), row(1, false), row(2, false)]
    expect(waitingAbove(arrived, rowPx.work)).toBe(1)
    // Half of it showing is enough to see it; back at the top, the marker goes.
    expect(waitingAbove(arrived, rowPx.work / 3)).toBe(0)
    expect(waitingAbove(arrived, 0)).toBe(0)
    // Waiting rows below the fold are no news: Calls lists them first, so the top is where a new one lands.
    expect(waitingAbove([row(0, false), row(1, true)], 0)).toBe(0)
    const list = readFileSync(join(import.meta.dir, 'BoardWorkList.svelte'), 'utf8')
    for (const binding of ['data-waiting={!row.served}', 'onscroll={measure}', 'onclick={toTop}']) expect(list).toContain(binding)
    // The marker lies over the list, never in its flow: no row moves when it shows.
    expect(/\n {2}\.above \{([^}]*)\}/.exec(list)?.[1]).toContain('position: absolute;')
  })

  test('nothing moves under the finger: the action bar and the status line keep their heights, the guard\'s hint takes the text line, the alternatives keep to one row, and alerts stand below the lists', () => {
    const source = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8')
    const panel = source('BoardPanel.svelte')
    expect(panel).toContain('<div class="action" style:height={`${boardChromePx.actionBar}px`}>')
    expect(panel).toContain('<div class="status" style:height={`${boardChromePx.statusLine}px`}>')
    // The alerts strip comes and goes below the lists and above the log, never above a button or a row.
    const markup = panel.slice(panel.indexOf('<section'), panel.indexOf('<style>'))
    expect(markup.indexOf('class="alerts"')).toBeGreaterThan(markup.indexOf('class="body"'))
    expect(markup.indexOf('class="alerts"')).toBeLessThan(markup.indexOf('class="log"'))
    const rule = (sheet: string, selector: string): string => new RegExp(`\\n {2}${selector.replaceAll('.', '\\.')} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? ''
    expect(rule(panel, '.feedback')).toContain('-webkit-line-clamp: 2;')
    const bar = source('BoardActionBar.svelte')
    // The text line is always there, and holds the hint while the guard runs: the hint has no line of its own.
    expect(bar).toContain('<p class="text" class:hint={commit.hint !== null}>{commit.hint ?? (commit.button === commit.text ? \'\' : commit.text)}</p>')
    expect(bar).not.toContain('{#if commit.hint')
    expect(rule(bar, '.text')).toContain('white-space: nowrap;')
    expect(rule(bar, '.alternatives')).toContain('flex-wrap: nowrap;')
    expect(rule(bar, '.alternatives')).toContain('overflow-x: auto;')
    // The text line, the row of buttons and one row of alternatives fit the bar.
    const barGap = Number(/gap: (\d+)px/.exec(rule(bar, '.bar'))?.[1])
    expect(rowBoxPx.line + 2 * barGap + 2 * tapPx).toBeLessThanOrEqual(boardChromePx.actionBar)
  })

  test('the lists follow the arrangement: the work list leads for queues, Contacts for map-led roles, and a list left out is not shown', () => {
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })).toEqual(['work', 'units'])
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })).toEqual(['work', 'units', 'contacts'])
    expect(boardSections({ lead: 'map', workList: false, unitBoard: true, contacts: true })).toEqual(['contacts', 'units'])
    expect(boardSections({ lead: 'map', workList: true, unitBoard: false, contacts: true })).toEqual(['contacts', 'work'])
  })
})
