// ```leitbild-view fences become display chips, and the displays of the shown
// room's answers are listed for the Workspace's one process display window.
// A fence becomes a chip only inside a posted AI answer whose own turn
// produced the display; everywhere else (human messages, comparison reruns)
// it is an explicit notice. The Host relays the list and every open request
// to World's window; a display the reader asks to see inline is also framed
// in its answer (inline.ts).
import { addPostRenderProcessor } from '../extensions/post-render-registry.ts'
import { apiFetch, currentWorkspaceId } from '../api-client.ts'
import { $roomMessages, $selectedRoomId } from '../stores.ts'
import { VIEW_FENCE_LANGUAGE } from '../../../core/render-validators/view-fence.ts'
import { findPostedAnswer, roomViewFences, viewFenceOf, viewListingOf, type ViewFence } from './listing.ts'
import { createViewResolutionCache, resolveViewReference } from './resolve.ts'
import { openView } from './open.ts'
import {
  createViewListPublisher,
  createViewListSync,
  inlineHostAnnouncement,
  inlineOpenRequest,
  isViewHostAnnouncement,
  workspaceRoomHref,
  type ViewHostMessage,
} from './host-link.ts'
import { inlineFrameWindows, relayInlineOpens } from './inline.ts'
import { createChipHost, fenceNotice, promoteUnhostedChips, showAvailable, showPreparing, showRefused, showUnhosted, type ChipActions } from './chip.ts'

// Long enough for a burst of re-renders and resolutions to settle into one
// list, short enough that a new answer's display reaches the window at once.
const LIST_SETTLE_MS = 250
// Long enough for a realtime snapshot's refetch of the shown room to restore
// its messages, so the window does not drop displays that are still there.
const LIST_REMOVAL_GRACE_MS = 2_000

const fetchJson = async (path: string): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await apiFetch(path)
  return { status: response.status, body: response.status === 200 ? await response.json() : null }
}

const resolutions = createViewResolutionCache<ViewFence>(fence =>
  resolveViewReference(fence.ref, { roomId: fence.answer.roomId, turnId: fence.answer.turnId, workspaceId: currentWorkspaceId() }, fetchJson))

// Set once the Host announces itself on this frame document; a reload starts unhosted again.
let hosted = false

// Displays the reader shows inline, by key, for this page's life: an answer
// rendered again (room switch, realtime snapshot) shows them inline again.
const inlineKeys = new Set<string>()

const chipActions: ChipActions = {
  open: listing => openView(listing),
  inlineShown: key => inlineKeys.has(key),
  setInlineShown: (key, shown) => { if (shown) inlineKeys.add(key); else inlineKeys.delete(key) },
}

const postToHost = (message: ViewHostMessage): void => {
  window.parent.postMessage(message, location.origin)
}

const publisher = createViewListPublisher({
  post: postToHost,
  settleMs: LIST_SETTLE_MS,
  removalGraceMs: LIST_REMOVAL_GRACE_MS,
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
})

const syncViewList = createViewListSync({
  room: () => $selectedRoomId.get(),
  fences: roomId => roomViewFences($roomMessages.get()[roomId] ?? []),
  resolve: fence => resolutions.resolve(fence),
  offer: (roomId, views) => publisher.offer(roomId, views),
})

const refreshViewList = (): void => {
  // Unhosted, no window receives the list; the Host's announcement refreshes it.
  if (!hosted) return
  void syncViewList()
}

const settleChip = async (host: HTMLElement, roomId: string, turnId: string, body: string): Promise<void> => {
  // renderMessage renders only messages of the room store, so the answer is there.
  const answer = findPostedAnswer($roomMessages.get()[roomId] ?? [], turnId)
  if (answer === null) {
    showRefused(host, 'view_answer_missing', 'the answer that composed this display is not loaded')
    return
  }
  const parsed = viewFenceOf(answer, body)
  if (parsed.kind === 'invalid') {
    showRefused(host, 'view_reference_invalid', parsed.error)
    return
  }
  const resolution = await resolutions.resolve(parsed.fence)
  if (resolution.kind === 'refused') {
    showRefused(host, resolution.code, resolution.message)
    return
  }
  const listing = viewListingOf(parsed.fence, resolution.envelope)
  if (hosted) showAvailable(host, listing, chipActions)
  else showUnhosted(host, listing, workspaceRoomHref(currentWorkspaceId(), roomId), chipActions)
}

const renderViewBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll<HTMLElement>(`code.language-${VIEW_FENCE_LANGUAGE}`)
  if (blocks.length === 0) return
  const roomId = container.dataset.viewRoom
  const turnId = container.dataset.viewTurn
  const settling: Promise<void>[] = []
  for (const code of blocks) {
    const pre = code.closest('pre') ?? code
    if (roomId === undefined || turnId === undefined) {
      pre.replaceWith(fenceNotice('Live displays appear only in the posted answer that composed them.'))
      continue
    }
    const host = createChipHost()
    showPreparing(host)
    pre.replaceWith(host)
    settling.push(settleChip(host, roomId, turnId, code.textContent ?? '').catch((error: unknown) => {
      showRefused(host, 'view_chip_failed', error instanceof Error ? error.message : String(error))
    }))
  }
  await Promise.all(settling)
}

addPostRenderProcessor('leitbild-view', renderViewBlocks)

window.addEventListener('message', event => {
  // An inline display asks for another in the window (C1 E5: a chip or banner label on it): relayed while hosted.
  const open = hosted ? inlineOpenRequest(event, { origin: location.origin, workspaceId: currentWorkspaceId(), inlineFrames: inlineFrameWindows() }) : null
  if (open !== null) {
    postToHost(open)
    return
  }
  if (!isViewHostAnnouncement(event, { origin: location.origin, parent: window.parent, self: window })) return
  // The Host announces once per frame load; a repeated announcement changes nothing.
  if (hosted) return
  hosted = true
  promoteUnhostedChips(document, chipActions)
  relayInlineOpens(frame => frame.contentWindow?.postMessage(inlineHostAnnouncement(), location.origin))
  refreshViewList()
})

$selectedRoomId.listen(() => refreshViewList())
$roomMessages.listen((_messages, _previous, changedRoomId) => {
  // A whole-store replacement (room deleted) names no room; it may have been the shown one.
  if (changedRoomId === undefined || changedRoomId === $selectedRoomId.get()) refreshViewList()
})
