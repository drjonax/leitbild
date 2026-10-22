import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { openedListing } from '../opened-display.ts'
import type { DisplayOpening, ViewHost } from '../view-host.ts'

// The pop-over an interactive drawing opens on one of its items, and where it
// stands: a press (a click, a tap, Enter or Space) opens the item's pop-over
// (its actions only in the display window), and a second press on it closes it; hovering a moment
// opens a quick look, which never takes over a pop-over a press opened;
// leaving, Esc or a press outside close either. It never covers the item it
// is about, and reads at 100 % whatever the display's zoom.

/** How long the pointer rests on a dot before its quick look opens, and how long it may be away before the popover closes. */
export const POPOVER_INTENT_MS = 300

/** What a popover shows: its quick look (hovered), or everything an item offers, its controls too (pressed, or pinned). */
export type PopoverMode = 'look' | 'operate'

export type PopoverState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly item: string; readonly mode: PopoverMode }

export type PopoverEvent =
  /** The pointer rested on a dot for POPOVER_INTENT_MS. */
  | { readonly kind: 'hovered'; readonly item: string }
  /** The pointer left the dot and the popover for POPOVER_INTENT_MS, while nothing in the popover has focus. */
  | { readonly kind: 'left' }
  /** A click, a tap, Enter or Space on a dot. */
  | { readonly kind: 'pressed'; readonly item: string }
  /** Esc, or a press outside the dot and the popover. */
  | { readonly kind: 'dismissed' }

export const POPOVER_CLOSED: PopoverState = { kind: 'closed' }

/**
 * The next popover state. A press opens an item's popover with its controls,
 * and a second press on its dot closes it; hovering opens a quick look and
 * never takes over a popover a press opened; leaving closes either.
 */
export const nextPopover = (state: PopoverState, event: PopoverEvent): PopoverState => {
  if (event.kind === 'dismissed' || event.kind === 'left') return POPOVER_CLOSED
  if (event.kind === 'hovered') return state.kind === 'open' && state.mode === 'operate' ? state : { kind: 'open', item: event.item, mode: 'look' }
  if (state.kind === 'open' && state.item === event.item && state.mode === 'operate') return POPOVER_CLOSED
  return { kind: 'open', item: event.item, mode: 'operate' }
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The room a popover keeps from the page's edges, in its own px (on screen whatever the zoom). */
export const POPOVER_MARGIN = 8

/**
 * Where a popover goes, in the page's px: beside its item where it fits
 * (right, then left), else under or over it, so it never covers the item it
 * is about; shifted inside the page's margins where nothing fits. `scale` is
 * how much the page is magnified on screen: the popover is drawn at 1/scale,
 * so it reads at 100 % whatever the display's zoom, and takes that much more
 * room. Its height is never more than popoverRoom gives it.
 */
export const popoverPlacement = (item: Box, popover: { readonly width: number; readonly height: number }, page: { readonly width: number; readonly height: number }, scale: number): { readonly x: number; readonly y: number } => {
  const width = popover.width / scale
  const height = popover.height / scale
  const gap = 8 / scale
  const margin = POPOVER_MARGIN / scale
  const clampX = (x: number): number => Math.min(Math.max(margin, x), Math.max(margin, page.width - margin - width))
  const clampY = (y: number): number => Math.min(Math.max(margin, y), Math.max(margin, page.height - margin - height))
  const candidates = [
    { x: item.x + item.width + gap, y: clampY(item.y), fits: item.x + item.width + gap + width <= page.width - margin },
    { x: item.x - gap - width, y: clampY(item.y), fits: item.x - gap - width >= margin },
    { x: clampX(item.x), y: item.y + item.height + gap, fits: item.y + item.height + gap + height <= page.height - margin },
    { x: clampX(item.x), y: item.y - gap - height, fits: item.y - gap - height >= margin },
  ]
  const chosen = candidates.find(candidate => candidate.fits)
  return chosen === undefined ? { x: clampX(item.x + item.width + gap), y: clampY(item.y) } : { x: chosen.x, y: chosen.y }
}

/**
 * The tallest a popover may be, in its own px: the page's height on screen
 * less its margins, so all of it stands on screen at any size and zoom; what
 * it holds beyond that scrolls inside it.
 */
export const popoverRoom = (page: { readonly height: number }, scale: number): number => Math.max(0, page.height * scale - 2 * POPOVER_MARGIN)

/** A popover's width, in its own px. */
export const POPOVER_WIDTH = 340

/**
 * What an element's pop-over offers under the element's default, by where its
 * display is shown (view-host.ts): its Pack's actions only in the display
 * window; framed by a page that opens displays for it (a chat answer's, which
 * relays to the Workspace's window, or a procedure tag dialog's), the way
 * there; in a frame no page hosts, nothing to act on.
 */
export type ElementOffer = 'actions' | 'open-in-window' | 'nothing'
export const elementOffer = (opening: DisplayOpening | null): ElementOffer =>
  opening === 'window' ? 'actions' : opening === 'relay' ? 'open-in-window' : 'nothing'

/** What an element's pop-over holds, besides its title. */
export type ElementPart = 'actions' | 'default' | 'open-in-window' | 'nothing'

/**
 * Its parts in order: in the display window the Pack's actions first (a
 * pending proposal and its Approve with them), the element's default under
 * them; elsewhere the default first, then the way to the display window or
 * the line saying where the element is operated, pinned at the foot of its
 * scrolling body.
 */
export const elementParts = (offer: ElementOffer): ReadonlyArray<ElementPart> =>
  offer === 'actions' ? ['actions', 'default'] : ['default', offer]

/** The display an element's pop-over opened from, as the listing of the element's default names it (opened-display.ts). */
export interface OpenedFrom {
  /** Stable for that display: the element's default opened from it keeps one key. */
  readonly key: string
  readonly title: string
}

/**
 * Opens the element's default (`envelope`, World's default display of the
 * element) in the Workspace's display window, through the page that frames
 * the display (view-host.ts openDisplay), captioned with the display it was
 * opened from. False where nothing opens it.
 */
export const openElementDefault = (host: Pick<ViewHost, 'openDisplay'>, from: OpenedFrom, envelope: EmbeddedViewEnvelope): boolean =>
  host.openDisplay({ state: envelope.state, title: envelope.title, listing: () => openedListing({ ...from, envelope }, { state: envelope.state, title: envelope.title }) })
