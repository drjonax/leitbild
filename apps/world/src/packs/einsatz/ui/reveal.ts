import type { Action } from 'svelte/action'
import { rowBoxPx } from './board-layout.ts'

/**
 * Keeps the row the operator acts on in view, within its list's own
 * scrolling share. The row passes a key while it is the selected one, null
 * otherwise: its place in the list and what makes it taller. Each new key
 * brings it into view, so a selection made on the map or by the Board
 * itself, a row that moved when the list re-sorted, or a highlighted row
 * that grew its job chain never lies hidden below the fold.
 */
export const revealWhen: Action<HTMLElement, string | null> = (node, key) => {
  let shown: string | null = null
  const reveal = (next: string | null): void => {
    if (next !== null && next !== shown) node.scrollIntoView({ block: 'nearest' })
    shown = next
  }
  reveal(key)
  return { update: reveal }
}

/** A selected row's reveal key: its place in its list and its height's parts; null for a row not selected. */
export const revealKey = (selected: boolean, place: number, ...parts: ReadonlyArray<number>): string | null =>
  selected ? [place, ...parts].join(':') : null

/** A row of a scrolling list as laid out: whether it waits for the operator, and where its top lies in the list's scrolled content. */
export interface ListedRow {
  readonly waiting: boolean
  readonly top: number
}

/** Where a row's title line, its label and priority, is half hidden: below its border and padding, half a line down. */
const titleMiddlePx = rowBoxPx.border + rowBoxPx.padding + rowBoxPx.line / 2

/**
 * How many waiting rows lie above what a list scrolled this far shows: rows
 * whose title line is more than half scrolled out of view, so the operator
 * no longer reads which call it is. Calls lists its waiting rows first, so a
 * call that arrives while the operator has scrolled the list lands there,
 * and the list says so in its heading.
 */
export const waitingAbove = (rows: ReadonlyArray<ListedRow>, scrollTop: number): number =>
  rows.filter(row => row.waiting && row.top + titleMiddlePx < scrollTop).length
