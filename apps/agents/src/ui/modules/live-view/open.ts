// Opening a display in the Workspace's one process display window: Agents
// posts a self-contained open request to the Host page that frames it. Free
// of module side effects, so other chat modules can import it.
import type { EmbeddedViewListing } from '@leitbild/contracts'
import { firstAvailableListing } from './chip.ts'
import { viewOpenMessage } from './host-link.ts'

export const openView = (listing: EmbeddedViewListing): void => {
  window.parent.postMessage(viewOpenMessage(listing), location.origin)
}

/**
 * Opens the first display a rendered message card offers in the window, as
 * clicking its chip does. False when the card offers none that opens here
 * (still preparing, refused, or outside the Host).
 */
export const openDisplayIn = (card: HTMLElement): boolean => {
  const listing = firstAvailableListing(card)
  if (listing === null) return false
  openView(listing)
  return true
}
