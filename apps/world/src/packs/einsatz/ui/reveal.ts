import type { Action } from 'svelte/action'

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
