import type { Snippet } from 'svelte'
import type { PopoverMode } from '../../vignette/popover.ts'
import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
import type { ComposedDisplaySample } from '../composed-display-client.ts'

// The popover an interactive drawing opens from an item's detail dot (a
// magnifying glass), and the overlays a person pins from it. Hovering a dot
// a moment opens the item's quick look; pressing it opens the item's popover
// with its controls as well. Either closes when the pointer leaves it and its
// dot, on Esc, or on a press outside it: there is no Close button and no
// "Open detail" (a press on the item opens its detail). The pin in its
// corner keeps it on the surface as an overlay, which a person drags by its
// handle and resizes, and which stays until its pin is pressed again; several
// may stand at once. Its body is a stack of sections; World's quick look is
// one (QUICK LOOK), and the display that hosts the drawing adds its own (a
// CONTROL and a PROPOSAL section) through MimicPanel's `sections`.

// --- Pinned overlays --------------------------------------------------------

/** A quick-look row's height, in a popover's own px (vessel-design §C). */
export const QUICK_LOOK_ROW = 28
/** The widths an overlay is resized between: only its trends take the difference; text never shrinks. */
export const OVERLAY_WIDTH = { min: 280, max: 520 } as const

/**
 * An item's popover pinned on the surface. `x`, `y`: where it stands in the
 * page's px, fixed to the window, so the drawing's zoom and scrolling never
 * move it off its place. `width`: its own px, drawn at 1/scale as the popover
 * is. `rows`: how many quick-look rows it shows once resized, the rest
 * dropped from the bottom behind a "+n" line; null for all of them.
 */
export interface PinnedOverlay {
  readonly item: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rows: number | null
}

/**
 * Pins an item's popover where it stands, or, pinned already, closes its
 * overlay. The overlay pinned last stands on top.
 */
export const togglePinned = (overlays: ReadonlyArray<PinnedOverlay>, pinned: PinnedOverlay): ReadonlyArray<PinnedOverlay> =>
  overlays.some(overlay => overlay.item === pinned.item) ? overlays.filter(overlay => overlay.item !== pinned.item) : [...overlays, pinned]

/** The overlay a person touched last stands on top of the others. */
export const raisedOverlay = (overlays: ReadonlyArray<PinnedOverlay>, item: string): ReadonlyArray<PinnedOverlay> => {
  const touched = overlays.find(overlay => overlay.item === item)
  return touched === undefined || overlays.at(-1) === touched ? overlays : [...overlays.filter(overlay => overlay !== touched), touched]
}

/**
 * An overlay kept within the window: moved back inside it where a resize of
 * the window or a change of zoom left it partly outside. `drawnHeight` is
 * its whole height as drawn, in its own px.
 */
export const keptInWindow = (overlay: PinnedOverlay, drawnHeight: number, page: { readonly width: number; readonly height: number }, scale: number): PinnedOverlay => {
  const x = Math.min(Math.max(0, overlay.x), Math.max(0, page.width - overlay.width / scale))
  const y = Math.min(Math.max(0, overlay.y), Math.max(0, page.height - drawnHeight / scale))
  return x === overlay.x && y === overlay.y ? overlay : { ...overlay, x, y }
}

/** An overlay dragged by its header from where it stood by the pointer's travel (page px), within the window. */
export const movedOverlay = (from: PinnedOverlay, travel: { readonly dx: number; readonly dy: number }, drawnHeight: number, page: { readonly width: number; readonly height: number }, scale: number): PinnedOverlay =>
  keptInWindow({ ...from, x: from.x + travel.dx, y: from.y + travel.dy }, drawnHeight, page, scale)

/**
 * An overlay resized by its corner from the width and rows it had by the
 * pointer's travel (page px; its own px grow by the travel times the scale
 * it is drawn at): its width between OVERLAY_WIDTH and the window's right
 * edge, its rows whole, from one to all `available`, never past the
 * window's bottom edge (`drawnHeight`: its whole height as it began).
 */
export const resizedOverlay = (
  from: PinnedOverlay,
  start: { readonly width: number; readonly rows: number },
  travel: { readonly dx: number; readonly dy: number },
  available: number,
  drawnHeight: number,
  page: { readonly width: number; readonly height: number },
  scale: number,
): PinnedOverlay => {
  const widest = Math.max(OVERLAY_WIDTH.min, Math.min(OVERLAY_WIDTH.max, (page.width - from.x) * scale))
  const width = Math.round(Math.min(widest, Math.max(OVERLAY_WIDTH.min, start.width + travel.dx * scale)))
  const room = (page.height - from.y) * scale - (drawnHeight - start.rows * QUICK_LOOK_ROW)
  const tallest = Math.max(1, Math.min(available, Math.floor(room / QUICK_LOOK_ROW)))
  const rows = Math.min(tallest, Math.max(1, Math.round(start.rows + (travel.dy * scale) / QUICK_LOOK_ROW)))
  return { ...from, width, rows: rows >= available ? null : rows }
}

// --- Sections ---------------------------------------------------------------

/** What a popover section is given to draw for the item it is open on. */
export interface MimicPopoverContext {
  readonly item: MimicDrawnItem
  readonly latest: ComposedDisplaySample | undefined
  /** Its quick look (hovered), or everything the item offers (pressed, or pinned): only then does it offer commands. */
  readonly mode: PopoverMode
  /** Pinned as an overlay on the surface. */
  readonly pinned: boolean
  /** The width its sections have, in its own px, and how many quick-look rows it shows (null: all). */
  readonly room: { readonly width: number; readonly rows: number | null }
  /** The page's samples are stale: its values are old and its controls disabled. */
  readonly stale: boolean
}

/**
 * A section of an item's popover, which the display hosting the drawing
 * adds (MimicPanel `sections`). Sections stand in `order`, lowest first
 * (PROPOSAL 10, CONTROL 15, QUICK LOOK 20: a press's controls stand above the rows a hover shows), each under its title, in the
 * popovers whose `modes` they name; one that does not apply to an item takes
 * no room in its popover.
 */
export interface MimicPopoverSection {
  readonly id: string
  readonly title: string
  readonly order: number
  readonly modes: ReadonlyArray<PopoverMode>
  readonly applies: (item: MimicDrawnItem) => boolean
  readonly body: Snippet<[MimicPopoverContext]>
}

/** The QUICK LOOK section's place among a popover's sections. */
export const QUICK_LOOK_ORDER = 20
