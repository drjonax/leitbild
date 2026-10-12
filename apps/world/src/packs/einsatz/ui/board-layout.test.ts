import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRailWidth } from '../../../ui/rail-state.ts'
import { cameraPaddingFor, noMapCover } from '../../../ui/surface-panel-interaction.ts'
import type { Arrangement } from '../board/types.ts'
import { waitingAbove } from './reveal.ts'
import { boardChromePx, boardEdgeGapPx, boardHeightFor, foldedContactsPx, boardLayoutFor, boardMapCover, boardSections, listContentPx, listFloorPx, listHeadingPx, listHeightsFor, listRowsTemplate, listsHeightFor, minBoardWidthPx, minMapWidthPx, rowBoxPx, rowBoxStyle, rowBoxVars, rowPx, tapPx, visibleRows } from './board-layout.ts'

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

  test('at 960 × 720 and 1024 × 768, with both lists full, Calls and Assets each show at least two whole rows, Calls the larger, whether an alert stands or not', () => {
    // The Host's header takes 44 px of the window; the World surface is the rest.
    for (const window of [720, 768]) {
      const board = boardHeightFor(window - 44)
      const heights = listHeightsFor(board, ['work', 'units'])
      expect(visibleRows(heights.work!, 'work')).toBeGreaterThanOrEqual(2)
      expect(visibleRows(heights.units!, 'units')).toBeGreaterThanOrEqual(2)
      expect(heights.work!).toBeGreaterThan(heights.units!)
      // With Contacts open as well, Calls and Assets still show two rows each, and Contacts its heading and first group's count.
      const three = listHeightsFor(board, ['work', 'units', 'contacts'])
      for (const section of ['work', 'units'] as const) expect(visibleRows(three[section]!, section)).toBeGreaterThanOrEqual(2)
      expect(three.contacts!).toBeGreaterThanOrEqual(listFloorPx.contacts - 1e-6)
      // The parts add up to the Board; an alert takes the foot's first line and changes none of them.
      const { padding, gap, actionBar, statusLine, foot } = boardChromePx
      expect(heights.work! + heights.units! + gap + 2 * padding + actionBar + statusLine + foot + 3 * gap).toBeCloseTo(board, 6)
    }
    // At 1024 × 768, two and a half rows of each with Contacts open.
    const open = listHeightsFor(boardHeightFor(768 - 44), ['work', 'units', 'contacts'])
    expect(visibleRows(open.work!, 'work')).toBeGreaterThanOrEqual(2.5)
    expect(visibleRows(open.units!, 'units')).toBeGreaterThanOrEqual(2.5)
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
    expect(panel).toContain('<div class="foot" style:height={`${boardChromePx.foot}px`}>')
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
      const lists = listsHeightFor(board)
      for (const calls of [0, 1, 2]) {
        const heights = listHeightsFor(board, ['work', 'units'], { work: listContentPx('work', calls) })
        expect(heights.work).toBe(listContentPx('work', calls))
        expect(heights.work! + boardChromePx.gap + heights.units!).toBeCloseTo(lists, 6)
        // Assets gets more than its share when Calls is short.
        expect(heights.units!).toBeGreaterThan(lists * 3 / 7)
      }
    }
    // At 1024 × 768 with two calls, four whole asset rows, where fixed shares gave two.
    expect(visibleRows(listHeightsFor(boardHeightFor(768 - 44), ['work', 'units'], { work: listContentPx('work', 2) }).units!, 'units')).toBeGreaterThanOrEqual(4)
  })

  test('each list scrolls within its own share, and every row and line holding a tap target is at least 44 px', () => {
    // Every list but the last fits its rows up to a limit in pixels, so a list's place depends only on the Board's height.
    const board = boardHeightFor(768 - 44)
    expect(listRowsTemplate(['work', 'units'], board)).toBe(`fit-content(${+(listsHeightFor(board) * 4 / 7).toFixed(1)}px) minmax(0, 1fr)`)
    expect(listRowsTemplate(['work', 'units', 'contacts'], board)).toBe(`fit-content(${listFloorPx.work}px) fit-content(${listFloorPx.units}px) minmax(0, 1fr)`)
    expect(listRowsTemplate(['contacts', 'units'], board)).toMatch(/^fit-content\([\d.]+px\) minmax\(0, 1fr\)$/)
    expect(Math.min(...Object.values(rowPx), boardChromePx.statusLine)).toBeGreaterThanOrEqual(tapPx)
    expect(tapPx).toBe(44)
    const panel = readFileSync(join(import.meta.dir, 'BoardPanel.svelte'), 'utf8')
    expect(panel).toContain('style:grid-template-rows={rowsTemplate}')
    expect(panel).toContain('listRowsTemplate(sections, boardHeightFor(surfaceHeight), folded)')
  })

  test('Close call is in view without scrolling the capped action bar: pinned to the right of the first row of buttons, under at most three lines of text, apart from the commit button', () => {
    const bar = readFileSync(join(import.meta.dir, 'BoardActionBar.svelte'), 'utf8')
    const markup = bar.slice(bar.indexOf('<div class="bar"'), bar.indexOf('<style>'))
    const rowStart = markup.indexOf('<div class="buttons">')
    // Above the row stands only the text line: a confirmation's detail stands below it, so the row never moves.
    expect([...markup.slice(0, rowStart).matchAll(/class="([\w-]+)"/g)].map(match => match[1])).toEqual(['bar', 'text'])
    expect(markup.indexOf('class="detail"')).toBeGreaterThan(markup.indexOf('</div>', markup.indexOf('class="close"')))
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

  test('a call that arrives while Calls is scrolled lands above what it shows, and the marker in the heading counts it while its title is out of view', () => {
    const row = (index: number, waiting: boolean) => ({ waiting, top: index * rowPx.work })
    // Two served calls, scrolled a little to keep the selected one in view: nothing waits above.
    const served = [row(0, false), row(1, false)]
    expect(waitingAbove(served, 30)).toBe(0)
    // A waiting call arrives and takes the top; the list keeps its scroll, so the new row is out of view above.
    const arrived = [row(0, true), row(1, false), row(2, false)]
    expect(waitingAbove(arrived, rowPx.work)).toBe(1)
    // Its title hidden, though most of the row shows, is enough to count it: the walkthrough's list rested 30 px down.
    expect(waitingAbove(arrived, 30)).toBe(1)
    expect(waitingAbove(arrived, rowBoxPx.border + rowBoxPx.padding + rowBoxPx.line / 2 + 1)).toBe(1)
    // Its title readable, or back at the top, the marker goes.
    expect(waitingAbove(arrived, rowBoxPx.border + rowBoxPx.padding)).toBe(0)
    expect(waitingAbove(arrived, 0)).toBe(0)
    // Waiting rows below the fold are no news: Calls lists them first, so the top is where a new one lands.
    expect(waitingAbove([row(0, false), row(1, true)], 0)).toBe(0)
    const list = readFileSync(join(import.meta.dir, 'BoardWorkList.svelte'), 'utf8')
    for (const binding of ['data-waiting={!row.served}', 'onscroll={measure}', 'onclick={toTop}']) expect(list).toContain(binding)
    // The marker stands in the heading line, one line high, never over a row; its tap area is 44 px high.
    const markup = list.slice(list.indexOf('<section'), list.indexOf('<style>'))
    expect(markup.indexOf('class="above"')).toBeLessThan(markup.indexOf('<div class="list">'))
    expect(markup.indexOf('class="above"')).toBeGreaterThan(markup.indexOf('<div class="head">'))
    const above = /\n {2}\.above \{([^}]*)\}/.exec(list)?.[1] ?? ''
    expect(above).toContain('height: var(--board-line);')
    const inset = /\.above::before \{[^}]*inset: -(\d+)px -\d+px -(\d+)px;/.exec(list)
    expect(rowBoxPx.line + Number(inset?.[1]) + Number(inset?.[2])).toBeGreaterThanOrEqual(tapPx)
  })

  test('nothing moves under the finger: the action bar, the status line and the foot keep their heights, the guard\'s hint takes the text line, the alternatives keep to one row, and the newest alert takes the foot\'s first line', () => {
    const source = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8')
    const panel = source('BoardPanel.svelte')
    expect(panel).toContain('<div class="action" style:height={`${boardChromePx.actionBar}px`}>')
    expect(panel).toContain('<div class="status" style:height={`${boardChromePx.statusLine}px`}>')
    const rule = (sheet: string, selector: string): string => new RegExp(`\\n {2}${selector.replaceAll('.', '\\.')} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? ''
    // The alert line comes and goes inside the foot, above the log, which gives way to it: the foot's height never changes.
    const markup = panel.slice(panel.indexOf('<section'), panel.indexOf('<style>'))
    expect(markup.indexOf('class="foot"')).toBeGreaterThan(markup.indexOf('class="body"'))
    expect(markup.indexOf('class="alert"')).toBeGreaterThan(markup.indexOf('class="foot"'))
    expect(markup.indexOf('class="alert"')).toBeLessThan(markup.indexOf('class="log"'))
    expect(markup).not.toContain('{#each view.alerts')
    expect(rule(panel, '.alert')).toContain('white-space: nowrap;')
    // The foot holds the alert line and one line of the log.
    expect(rowBoxPx.line + 15).toBeLessThanOrEqual(boardChromePx.foot)
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

  test('folded Contacts give Calls and Assets the height: at 960 × 720 and 1024 × 768 each shows at least as many rows as beside an open Contacts list', () => {
    for (const window of [720, 768]) {
      const board = boardHeightFor(window - 44)
      const three = listHeightsFor(board, ['work', 'units', 'contacts'])
      const folded = listHeightsFor(board, ['work', 'units'], {}, true)
      expect(folded.work!).toBeGreaterThanOrEqual(three.work! - 1e-6)
      expect(folded.units!).toBeGreaterThan(three.units!)
      expect(folded.work! + folded.units! + boardChromePx.gap + foldedContactsPx + boardChromePx.gap).toBeCloseTo(listsHeightFor(board), 6)
    }
    // At 1024 × 768, two and a half calls and two and a half assets.
    const folded = listHeightsFor(boardHeightFor(768 - 44), ['work', 'units'], {}, true)
    expect(visibleRows(folded.work!, 'work')).toBeGreaterThanOrEqual(2.5)
    expect(visibleRows(folded.units!, 'units')).toBeGreaterThanOrEqual(2.5)
    const panel = readFileSync(join(import.meta.dir, 'BoardPanel.svelte'), 'utf8')
    expect(panel).toContain("boardSections(view.arrangement).filter(section => section !== 'contacts' || !folded)")
    expect(panel).toContain('style:height={`${foldedContactsPx}px`}')
    // Nothing on the folded line or the heading hides behind a pointer's hover.
    expect(panel).not.toContain('title={view.contacts')
    expect(readFileSync(join(import.meta.dir, 'BoardContacts.svelte'), 'utf8')).not.toContain('title=')
  })

  test('the lists follow the arrangement: the work list leads for queues, Contacts for map-led roles, and a list left out is not shown', () => {
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: false })).toEqual(['work', 'units'])
    expect(boardSections({ lead: 'work-list', workList: true, unitBoard: true, contacts: true })).toEqual(['work', 'units', 'contacts'])
    expect(boardSections({ lead: 'map', workList: false, unitBoard: true, contacts: true })).toEqual(['contacts', 'units'])
    expect(boardSections({ lead: 'map', workList: true, unitBoard: false, contacts: true })).toEqual(['contacts', 'work'])
  })
})
