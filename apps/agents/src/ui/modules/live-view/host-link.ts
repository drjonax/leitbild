// Agents' side of the Workspace's one process display window. Agents only
// builds plain contract messages for its parent page; the Host validates each
// one with the contract schemas, relays it to the window and reports a
// rejection itself. Agents frames no World page. Pure apart from injected
// timers and posting, so it is tested without a DOM.
import type { EmbeddedViewListing, EmbeddedViewOpenMessage, EmbeddedViewsMessage } from '@leitbild/contracts'
import { viewListings, type ResolvedViewFence, type ViewFence } from './listing.ts'
import type { ViewResolution } from './resolve.ts'

export type ViewHostMessage = EmbeddedViewsMessage | EmbeddedViewOpenMessage

export interface ViewHostEvent {
  readonly origin: string
  readonly source: unknown
  readonly data: unknown
}

export interface ViewHostPage {
  readonly origin: string
  /** `window.parent`; equal to `self` when the page is not framed. */
  readonly parent: unknown
  readonly self: unknown
}

/**
 * The Host announces on frame load that displays listed or opened from this
 * frame reach a window: exactly `{type: 'leitbild:view-host'}`, from the
 * parent page, on this origin.
 */
export const isViewHostAnnouncement = (event: ViewHostEvent, page: ViewHostPage): boolean => {
  if (page.parent === page.self || event.source !== page.parent || event.origin !== page.origin) return false
  const data = event.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    && Object.keys(data).length === 1 && (data as { readonly type?: unknown }).type === 'leitbild:view-host'
}

export const viewOpenMessage = (view: EmbeddedViewListing): EmbeddedViewOpenMessage => ({ type: 'leitbild:view-open', view })

/** Where a display opens when this page is not inside the Host: the Workspace page with this room, never a Run. */
export const workspaceRoomHref = (workspaceId: string, roomId: string): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}?${new URLSearchParams({ agents: roomId })}`

export interface ViewListPublisherDeps {
  readonly post: (message: EmbeddedViewsMessage) => void
  /** How long a list that adds or reorders displays must hold before it is posted. */
  readonly settleMs: number
  /** How long a list that only removes displays must hold before it is posted. */
  readonly removalGraceMs: number
  readonly setTimer: (run: () => void, delayMs: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}

export interface ViewListPublisher {
  /**
   * The current list of the shown room (null: none). Nothing is posted while
   * its key sequence equals the last one posted. A list of another room is
   * posted at once; within one room, a list that only removes displays is
   * posted after `removalGraceMs` and any other after `settleMs`, each only
   * if no newer list was offered meanwhile.
   */
  readonly offer: (roomId: string | null, views: ReadonlyArray<EmbeddedViewListing>) => void
}

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index])

// `next` keeps some of `published`, in the same order, and adds nothing.
const removesOnly = (next: ReadonlyArray<string>, published: ReadonlyArray<string>): boolean => {
  if (next.length >= published.length) return false
  let kept = 0
  for (const key of published) if (kept < next.length && next[kept] === key) kept += 1
  return kept === next.length
}

// A realtime snapshot empties the shown room's messages and refetches them, so
// the store passes through a shorter list and back. Removals therefore wait
// longer than additions; if the room returns to what was posted meanwhile, the
// window never hears of the gap and keeps its frames.
export const createViewListPublisher = (deps: ViewListPublisherDeps): ViewListPublisher => {
  // The Host starts every frame document with nothing listed.
  let publishedKeys: ReadonlyArray<string> = []
  // Undefined until the first offer, which therefore counts as a room switch.
  let offeredRoom: string | null | undefined = undefined
  let pending: unknown = null
  const publish = (keys: ReadonlyArray<string>, views: ReadonlyArray<EmbeddedViewListing>): void => {
    publishedKeys = keys
    deps.post({ type: 'leitbild:views', views: [...views] })
  }
  return {
    offer: (roomId, views) => {
      const roomSwitched = roomId !== offeredRoom
      offeredRoom = roomId
      if (pending !== null) deps.clearTimer(pending)
      pending = null
      const keys = views.map(view => view.key)
      if (sameKeys(keys, publishedKeys)) return
      if (roomSwitched) {
        publish(keys, views)
        return
      }
      pending = deps.setTimer(() => {
        pending = null
        publish(keys, views)
      }, removesOnly(keys, publishedKeys) ? deps.removalGraceMs : deps.settleMs)
    },
  }
}

export interface ViewListSyncDeps {
  /** The room whose displays are listed, null when none is shown. */
  readonly room: () => string | null
  /** The valid fences of a room's posted answers, in store order, each key once. */
  readonly fences: (roomId: string) => ReadonlyArray<ViewFence>
  readonly resolve: (fence: ViewFence) => Promise<ViewResolution>
  readonly offer: (roomId: string | null, views: ReadonlyArray<EmbeddedViewListing>) => void
}

/** Derives the list from the store once every resolution settled; a newer store state supersedes an older derivation. */
export const createViewListSync = (deps: ViewListSyncDeps): (() => Promise<void>) => {
  let generation = 0
  return async () => {
    const current = ++generation
    const roomId = deps.room()
    const fences = roomId === null ? [] : deps.fences(roomId)
    const resolutions = await Promise.all(fences.map(fence => deps.resolve(fence)))
    // A newer derivation started while these settled; it offers the newer list.
    if (current !== generation) return
    const resolved: ResolvedViewFence[] = fences.map((fence, index) => ({ fence, resolution: resolutions[index]! }))
    deps.offer(roomId, viewListings(resolved))
  }
}
