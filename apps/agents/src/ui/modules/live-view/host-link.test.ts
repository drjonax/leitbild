import { describe, expect, test } from 'bun:test'
import { embeddedViewOpenMessageSchema, embeddedViewsMessageSchema, newWorkspaceId, type EmbeddedViewListing, type EmbeddedViewsMessage } from '@leitbild/contracts'
import {
  createViewListPublisher,
  createViewListSync,
  isViewHostAnnouncement,
  viewOpenMessage,
  workspaceRoomHref,
} from './host-link.ts'
import type { ViewFence } from './listing.ts'
import type { ViewResolution } from './resolve.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const envelope = (title: string) => ({ viewType: 'process-plant.display', title, height: 340, state: '{"composition":{}}', moduleId: 'world', subject: run }) as never
const listing = (key: string): EmbeddedViewListing => ({ key, envelope: envelope(key), caption: 'Answer 14:02:31' })

describe('the Host announcement', () => {
  const parent = { name: 'host page' }
  const self = { name: 'agents frame' }
  const page = { origin: 'https://leitbild.app', parent, self }
  const announcement = { origin: 'https://leitbild.app', source: parent, data: { type: 'leitbild:view-host' } }

  test('is exactly the Host message from the parent page on this origin', () => {
    expect(isViewHostAnnouncement(announcement, page)).toBe(true)
  })

  test('is not trusted from another origin, another window or an unframed page', () => {
    expect(isViewHostAnnouncement({ ...announcement, origin: 'https://evil.example' }, page)).toBe(false)
    expect(isViewHostAnnouncement({ ...announcement, source: self }, page)).toBe(false)
    expect(isViewHostAnnouncement({ ...announcement, source: null }, page)).toBe(false)
    expect(isViewHostAnnouncement({ ...announcement, source: self }, { ...page, parent: self })).toBe(false)
  })

  test('is not any other or extended shape', () => {
    for (const data of [{ type: 'leitbild:view-host', extra: true }, { type: 'leitbild:views', views: [] }, { type: 'leitbild:subject-focus', subjects: [] }, 'leitbild:view-host', null, [{ type: 'leitbild:view-host' }]]) {
      expect(isViewHostAnnouncement({ ...announcement, data }, page)).toBe(false)
    }
  })
})

describe('messages Agents builds for the Host', () => {
  test('an open request carries the whole listing and passes the contract', () => {
    expect(embeddedViewOpenMessageSchema.parse(viewOpenMessage(listing('room-1/tr_1/call_1_0/a')))).toEqual({ type: 'leitbild:view-open', view: listing('room-1/tr_1/call_1_0/a') })
  })

  test('outside the Host a display links to the Workspace page with this room, never a Run', () => {
    expect(workspaceRoomHref(workspaceId, 'room/1 & 2')).toBe(`/workspaces/${workspaceId}?agents=room%2F1+%26+2`)
    expect(new URL(workspaceRoomHref(workspaceId, 'room-1'), 'https://leitbild.app').searchParams.has('world')).toBe(false)
  })
})

const fakeTimers = () => {
  let next = 1
  const timers = new Map<number, () => void>()
  return {
    setTimer: (run: () => void) => { const id = next++; timers.set(id, run); return id },
    clearTimer: (timer: unknown) => { timers.delete(timer as number) },
    pending: () => timers.size,
    elapse: () => { const due = [...timers.values()]; timers.clear(); for (const run of due) run() },
  }
}

describe('publishing the list', () => {
  const publisher = () => {
    const timers = fakeTimers()
    const posted: EmbeddedViewsMessage[] = []
    const { offer } = createViewListPublisher({ post: message => posted.push(message), delayMs: 250, ...timers })
    return { offer, posted, timers }
  }

  test('posts after the list settled, and only when its key sequence changed', () => {
    const { offer, posted, timers } = publisher()
    offer([])
    timers.elapse()
    expect(posted).toEqual([])
    offer([listing('a')])
    expect(posted).toEqual([])
    timers.elapse()
    expect(posted).toEqual([{ type: 'leitbild:views', views: [listing('a')] }])
    offer([listing('a')])
    timers.elapse()
    expect(posted).toHaveLength(1)
    offer([listing('b'), listing('a')])
    timers.elapse()
    offer([listing('a'), listing('b')])
    timers.elapse()
    expect(posted.map(message => message.views.map(view => view.key))).toEqual([['a'], ['b', 'a'], ['a', 'b']])
    for (const message of posted) embeddedViewsMessageSchema.parse(message)
  })

  test('a newer list replaces one still settling', () => {
    const { offer, posted, timers } = publisher()
    offer([listing('a')])
    offer([listing('a'), listing('b')])
    expect(timers.pending()).toBe(1)
    timers.elapse()
    expect(posted).toEqual([{ type: 'leitbild:views', views: [listing('a'), listing('b')] }])
  })

  test('posts an empty list when the room no longer has displays', () => {
    const { offer, posted, timers } = publisher()
    offer([listing('a')])
    timers.elapse()
    offer([])
    timers.elapse()
    expect(posted.at(-1)).toEqual({ type: 'leitbild:views', views: [] })
  })
})

describe('deriving the list from the store', () => {
  const fenceFor = (key: string): ViewFence => ({ key, answer: { roomId: 'room-1', turnId: 'tr_1', caption: 'Answer 14:02:31' }, ref: { callId: 'call_1_0', key } })

  test('offers the resolved displays once every resolution settled', async () => {
    const offered: ReadonlyArray<EmbeddedViewListing>[] = []
    const sync = createViewListSync({
      fences: () => [fenceFor('a'), fenceFor('refused'), fenceFor('b')],
      resolve: async fence => (fence.key === 'refused'
        ? { kind: 'refused', code: 'view_evidence_unavailable', message: 'gone' }
        : { kind: 'view', envelope: envelope(fence.key) }) as ViewResolution,
      offer: views => offered.push(views),
    })
    await sync()
    expect(offered.map(views => views.map(view => view.key))).toEqual([['a', 'b']])
  })

  test('a newer store state supersedes a derivation still waiting for evidence', async () => {
    let fences = [fenceFor('a')]
    let releaseSlow: (resolution: ViewResolution) => void = () => {}
    const offered: ReadonlyArray<EmbeddedViewListing>[] = []
    const sync = createViewListSync({
      fences: () => fences,
      resolve: fence => fence.key === 'a'
        ? new Promise<ViewResolution>(resolve => { releaseSlow = resolve })
        : Promise.resolve({ kind: 'view', envelope: envelope(fence.key) } as ViewResolution),
      offer: views => offered.push(views),
    })
    const older = sync()
    fences = [fenceFor('b')]
    await sync()
    releaseSlow({ kind: 'view', envelope: envelope('a') } as ViewResolution)
    await older
    expect(offered.map(views => views.map(view => view.key))).toEqual([['b']])
  })
})
