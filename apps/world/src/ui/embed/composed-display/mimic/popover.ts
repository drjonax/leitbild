import type { Snippet } from 'svelte'
import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
import type { ComposedDisplaySample } from '../composed-display-client.ts'

// The popover an interactive drawing opens from an item's detail dot: one at
// a time, opened by hovering the dot a moment or by clicking (tapping) it,
// which pins it. Its body is a stack of sections; World's quick look is one
// (QUICK LOOK), and the display that hosts the drawing adds its own (a
// CONTROL and a PROPOSAL section) through MimicPanel's `sections`.

/** How long the pointer rests on a dot before its popover opens, and how long it may be away before a hovered popover closes. */
export const POPOVER_INTENT_MS = 300

export type PopoverState =
  | { readonly kind: 'closed' }
  /** `pinned`: opened or kept by a click, a tap or the keyboard; only Esc, its close button, a click outside or its dot again close it. */
  | { readonly kind: 'open'; readonly item: string; readonly pinned: boolean }

export type PopoverEvent =
  /** The pointer rested on a dot for POPOVER_INTENT_MS. */
  | { readonly kind: 'hovered'; readonly item: string }
  /** The pointer left the dot and the popover for POPOVER_INTENT_MS. */
  | { readonly kind: 'left' }
  /** A click, a tap, Enter or Space on a dot. */
  | { readonly kind: 'pressed'; readonly item: string }
  /** Esc, the close button, or a press outside the dot and the popover. */
  | { readonly kind: 'dismissed' }

export const POPOVER_CLOSED: PopoverState = { kind: 'closed' }

/**
 * The next popover state. A press always pins: on a popover hovering opened
 * it keeps it open, pinned, never closing it; only a press on the dot of a
 * pinned popover closes it again. Hovering never takes over a pinned
 * popover, and leaving closes only a hovered one.
 */
export const nextPopover = (state: PopoverState, event: PopoverEvent): PopoverState => {
  if (event.kind === 'dismissed') return POPOVER_CLOSED
  if (event.kind === 'left') return state.kind === 'open' && !state.pinned ? POPOVER_CLOSED : state
  if (event.kind === 'hovered') return state.kind === 'open' && state.pinned ? state : { kind: 'open', item: event.item, pinned: false }
  if (state.kind === 'open' && state.item === event.item && state.pinned) return POPOVER_CLOSED
  return { kind: 'open', item: event.item, pinned: true }
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where a popover goes, in the page's px: beside its item where it fits
 * (right, then left), else under or over it, so it never covers the item it
 * is about; clamped inside the page where nothing fits. `scale` is how much
 * the page is magnified on screen: the popover is drawn at 1/scale, so it
 * reads at 100 % whatever the display's zoom, and takes that much more room.
 */
export const popoverPlacement = (item: Box, popover: { readonly width: number; readonly height: number }, page: { readonly width: number; readonly height: number }, scale: number): { readonly x: number; readonly y: number } => {
  const width = popover.width / scale
  const height = popover.height / scale
  const gap = 8 / scale
  const clampX = (x: number): number => Math.min(Math.max(0, x), Math.max(0, page.width - width))
  const clampY = (y: number): number => Math.min(Math.max(0, y), Math.max(0, page.height - height))
  const candidates = [
    { x: item.x + item.width + gap, y: clampY(item.y), fits: item.x + item.width + gap + width <= page.width },
    { x: item.x - gap - width, y: clampY(item.y), fits: item.x - gap - width >= 0 },
    { x: clampX(item.x), y: item.y + item.height + gap, fits: item.y + item.height + gap + height <= page.height },
    { x: clampX(item.x), y: item.y - gap - height, fits: item.y - gap - height >= 0 },
  ]
  const chosen = candidates.find(candidate => candidate.fits)
  return chosen === undefined ? { x: clampX(item.x + item.width + gap), y: clampY(item.y) } : { x: chosen.x, y: chosen.y }
}

/** What a popover section is given to draw for the item it is open on. */
export interface MimicPopoverContext {
  readonly item: MimicDrawnItem
  readonly latest: ComposedDisplaySample | undefined
  /** Whether the reader pinned it, or it is open while the pointer rests on its dot. */
  readonly pinned: boolean
  /** Closes the popover and returns focus to the item's dot. */
  readonly close: () => void
}

/**
 * A section of an item's popover, which the display hosting the drawing
 * adds (MimicPanel `sections`). Sections stand in `order`, lowest first
 * (PROPOSAL 10, QUICK LOOK 20, CONTROL 30), each under its title; one that
 * does not apply to an item takes no room in its popover.
 */
export interface MimicPopoverSection {
  readonly id: string
  readonly title: string
  readonly order: number
  readonly applies: (item: MimicDrawnItem) => boolean
  readonly body: Snippet<[MimicPopoverContext]>
}

/** The QUICK LOOK section's place among a popover's sections. */
export const QUICK_LOOK_ORDER = 20
