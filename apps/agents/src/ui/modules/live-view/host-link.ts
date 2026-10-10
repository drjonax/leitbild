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
  readonly delayMs: number
  readonly setTimer: (run: () => void, delayMs: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}

export interface ViewListPublisher {
  /** The current list; posted after `delayMs` without a newer offer, and only when its key sequence differs from the last one posted. */
  readonly offer: (views: ReadonlyArray<EmbeddedViewListing>) => void
}

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index])

export const createViewListPublisher = (deps: ViewListPublisherDeps): ViewListPublisher => {
  // The Host starts every frame document with nothing listed.
  let publishedKeys: ReadonlyArray<string> = []
  let pending: unknown = null
  return {
    offer: views => {
      if (pending !== null) deps.clearTimer(pending)
      pending = deps.setTimer(() => {
        pending = null
        const keys = views.map(view => view.key)
        if (sameKeys(keys, publishedKeys)) return
        publishedKeys = keys
        deps.post({ type: 'leitbild:views', views: [...views] })
      }, deps.delayMs)
    },
  }
}

export interface ViewListSyncDeps {
  /** The valid fences of the shown room's posted answers, in store order, each key once. */
  readonly fences: () => ReadonlyArray<ViewFence>
  readonly resolve: (fence: ViewFence) => Promise<ViewResolution>
  readonly offer: (views: ReadonlyArray<EmbeddedViewListing>) => void
}

/** Derives the list from the store once every resolution settled; a newer store state supersedes an older derivation. */
export const createViewListSync = (deps: ViewListSyncDeps): (() => Promise<void>) => {
  let generation = 0
  return async () => {
    const current = ++generation
    const fences = deps.fences()
    const resolutions = await Promise.all(fences.map(fence => deps.resolve(fence)))
    // A newer derivation started while these settled; it offers the newer list.
    if (current !== generation) return
    const resolved: ResolvedViewFence[] = fences.map((fence, index) => ({ fence, resolution: resolutions[index]! }))
    deps.offer(viewListings(resolved))
  }
}
