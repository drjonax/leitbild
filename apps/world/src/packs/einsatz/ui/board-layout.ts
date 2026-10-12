import type { MapCover } from '../../../ui/surface-panel-interaction.ts'
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
