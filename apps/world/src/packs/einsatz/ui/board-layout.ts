import type { MapCover } from '../../../ui/surface-panel-contract.ts'
import type { Arrangement } from '../board/types.ts'

/**
 * Where the Board lies over the map. It is docked to the right edge of the
 * World surface, over the map, and never hides it: it takes its preferred
 * width only while at least `minMapWidthPx` of map stays clear beside it,
 * and narrows down to `minBoardWidthPx` before that. A map-led arrangement
 * (sensing and firing roles) prefers a narrower Board than one led by the
 * work list. The camera is padded by the width the Board is observed to
 * take, so the map centres and fits in the part left clear.
 */

export const minMapWidthPx = 400
export const minBoardWidthPx = 300
/** The gap between the Board and the surface's right edge. */
export const boardEdgeGapPx = 12
/**
 * The Board's clearance from the surface's top and bottom edges: room for the
 * role bar above it and the World status line below it, both drawn over the
 * map. The role bar wraps on narrow screens (a switch in progress, the
 * opposing-sides warning) and may then reach over the Board's top.
 */
export const boardTopClearancePx = 52
export const boardBottomClearancePx = 52
const preferredWidthPx: Readonly<Record<Arrangement['lead'], number>> = { 'work-list': 480, map: 380 }

export interface BoardLayout {
  readonly widthPx: number
  /** The map left clear beside the Board. */
  readonly mapWidthPx: number
}

/** The Board's width on a surface this wide, and the map it leaves clear. */
export const boardLayoutFor = (surfaceWidthPx: number, lead: Arrangement['lead']): BoardLayout => {
  if (!Number.isFinite(surfaceWidthPx) || surfaceWidthPx < 0) throw new Error(`The World surface is no width: ${surfaceWidthPx}`)
  const room = surfaceWidthPx - boardEdgeGapPx - minMapWidthPx
  const widthPx = Math.max(minBoardWidthPx, Math.min(preferredWidthPx[lead], room))
  return { widthPx, mapWidthPx: surfaceWidthPx - boardEdgeGapPx - widthPx }
}

export type BoardSection = 'work' | 'units' | 'contacts'

/**
 * The Board's height, top to bottom: its padding, the alerts strip while any
 * alert stands (capped, scrolling inside), the action bar (capped, scrolling
 * inside past its cap), the status line (feedback, Undo, sound), the lists
 * and the event log, with a gap between each. The lists share what is left,
 * each scrolling on its own: a list takes what its rows need up to its fair
 * share, and the last list takes the rest, so a short Calls list leaves no
 * gap above Assets and both stay in view however long either grows. Every
 * height a tap target takes is at least `tapPx`.
 */
export const tapPx = 44
export const boardChromePx = {
  padding: 8,
  gap: 6,
  /** The alerts strip's cap: two alerts. */
  alerts: 48,
  /** The action bar's cap: the big button, one line of alternatives or verbs, and one line of what is still needed. */
  actionBar: 112,
  statusLine: tapPx,
  /** Two lines of the event log. */
  log: 30,
} as const

/**
 * The lists' box model. The panel binds these on the Board as CSS custom
 * properties (`rowBoxStyle`) and the lists' style sheets size their rows and
 * headings with them, so a row's height here is its height on screen: its
 * lines and the gaps between them, its padding and 1 px border, and the gap
 * to the next row. A line that wraps makes its row taller.
 */
export const rowBoxPx = { line: 16, lineGap: 2, padding: 6, border: 1, gap: 4, headingGap: 4 } as const
/** The custom properties the panel binds on the Board, by name. */
export const rowBoxVars: Readonly<Record<string, string>> = {
  '--board-line': `${rowBoxPx.line}px`,
  '--line-gap': `${rowBoxPx.lineGap}px`,
  '--row-pad': `${rowBoxPx.padding}px`,
  '--row-gap': `${rowBoxPx.gap}px`,
  '--heading-gap': `${rowBoxPx.headingGap}px`,
}
/** The same, as the Board's style attribute. */
export const rowBoxStyle = Object.entries(rowBoxVars).map(([name, value]) => `${name}: ${value}`).join('; ')
/** A list's heading above its rows: one line and the gap below it. */
export const listHeadingPx = rowBoxPx.line + rowBoxPx.headingGap
/** The lines a row shows: a call's three, an asset's or a contact's two. */
const rowLines: Readonly<Record<BoardSection, number>> = { work: 3, units: 2, contacts: 2 }
const rowHeightPx = (lines: number): number =>
  lines * rowBoxPx.line + (lines - 1) * rowBoxPx.lineGap + 2 * rowBoxPx.padding + 2 * rowBoxPx.border + rowBoxPx.gap
/** The height one row takes in its list, the gap to the next included; at least a tap target. */
export const rowPx: Readonly<Record<BoardSection, number>> = { work: rowHeightPx(rowLines.work), units: rowHeightPx(rowLines.units), contacts: rowHeightPx(rowLines.contacts) }
const listShares: Readonly<Record<BoardSection, number>> = { work: 4, units: 3, contacts: 3 }

/** The Board's height on a surface this tall: what its top and bottom clearances leave. */
export const boardHeightFor = (surfaceHeightPx: number): number => surfaceHeightPx - boardTopClearancePx - boardBottomClearancePx

/** Each list's fair share of the lists' height, as a fraction: its part of all the shown lists' parts. */
const shareOf = (sections: ReadonlyArray<BoardSection>, section: BoardSection): number =>
  listShares[section] / sections.reduce((sum, entry) => sum + listShares[entry], 0)

/**
 * The CSS grid rows of the lists: every list but the last fits its content
 * up to its fair share of the lists' height; the last takes all that is left.
 */
export const listRowsTemplate = (sections: ReadonlyArray<BoardSection>): string =>
  sections.map((section, index) => index === sections.length - 1 ? 'minmax(0, 1fr)' : `fit-content(${+(shareOf(sections, section) * 100).toFixed(3)}%)`).join(' ')

/** The lists' height on a Board this tall, gaps between the lists included, with the alerts strip shown or not. */
export const listsHeightFor = (boardHeightPx: number, alerts: boolean): number => {
  const { padding, gap, actionBar, statusLine, log } = boardChromePx
  return boardHeightPx - 2 * padding - (alerts ? boardChromePx.alerts + gap : 0) - actionBar - statusLine - log - 3 * gap
}

/**
 * The height each list takes on a Board this tall, as `listRowsTemplate`
 * lays them out, given the height each list's heading and rows would fill
 * (unbounded when absent): every list but the last takes that up to its
 * fair share, the last takes the rest.
 */
export const listHeightsFor = (boardHeightPx: number, sections: ReadonlyArray<BoardSection>, alerts: boolean, content: Readonly<Partial<Record<BoardSection, number>>> = {}): Readonly<Partial<Record<BoardSection, number>>> => {
  const lists = listsHeightFor(boardHeightPx, alerts)
  const tracks = lists - boardChromePx.gap * Math.max(0, sections.length - 1)
  const heights: Partial<Record<BoardSection, number>> = {}
  let used = 0
  sections.forEach((section, index) => {
    const height = index === sections.length - 1 ? tracks - used : Math.min(content[section] ?? Number.POSITIVE_INFINITY, shareOf(sections, section) * lists)
    heights[section] = height
    used += height
  })
  return heights
}

/** The height a list's heading and this many rows fill. */
export const listContentPx = (section: BoardSection, rows: number): number => listHeadingPx + rows * rowPx[section] - (rows > 0 ? rowBoxPx.gap : 0)

/** How many rows of a list show at once in its share, below its heading; the last row needs no gap after it. */
export const visibleRows = (listHeightPx: number, section: BoardSection): number => (listHeightPx - listHeadingPx + rowBoxPx.gap) / rowPx[section]

/**
 * The Board's lists in the order the arrangement leads with: the work list
 * first for roles with a queue, the Contacts list first for map-led roles;
 * a list the arrangement leaves out is not shown.
 */
export const boardSections = (arrangement: Arrangement): ReadonlyArray<BoardSection> => {
  const order: ReadonlyArray<BoardSection> = arrangement.lead === 'work-list' ? ['work', 'units', 'contacts'] : ['contacts', 'units', 'work']
  const shown: Readonly<Record<BoardSection, boolean>> = { work: arrangement.workList, units: arrangement.unitBoard, contacts: arrangement.contacts }
  return order.filter(section => shown[section])
}

/** How far a Board observed at this width reaches over the map: its width and its gap from the right edge. */
export const boardMapCover = (observedWidthPx: number): MapCover => ({
  top: 0,
  right: observedWidthPx > 0 ? Math.ceil(observedWidthPx) + boardEdgeGapPx : 0,
  bottom: 0,
  left: 0,
})
