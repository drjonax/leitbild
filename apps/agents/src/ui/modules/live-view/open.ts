// Opening a display in the Workspace's one process display window: Agents
// posts a self-contained open request to the Host page that frames it. Free
// of module side effects, so other chat modules can import it.
import type { EmbeddedViewListing, WorkspaceResourceReference } from '@leitbild/contracts'
import { firstAvailableListing } from './chip.ts'
import { viewOpenMessage, viewSubjectOpenMessage } from './host-link.ts'

export const openView = (listing: EmbeddedViewListing): void => {
  window.parent.postMessage(viewOpenMessage(listing), location.origin)
}

/**
 * Opens one subject's default display on its Run in the window (a proposal's
 * element). False outside the Host, which no window answers.
 */
export const openSubjectDefault = (resource: WorkspaceResourceReference, subject: string, title: string): boolean => {
  if (window.parent === window) return false
  window.parent.postMessage(viewSubjectOpenMessage(resource, subject, title), location.origin)
  return true
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
