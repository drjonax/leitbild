import type { Action } from 'svelte/action'

/**
 * Keeps a list row in view when it becomes the selected one, within the
 * list's own scrolling share, so a selection made on the map or by the
 * Board itself never lies hidden below the fold.
 */
export const revealWhen: Action<HTMLElement, boolean> = (node, shown) => {
  const reveal = (value: boolean): void => {
    if (value) node.scrollIntoView({ block: 'nearest' })
  }
  reveal(shown)
  return { update: reveal }
}
