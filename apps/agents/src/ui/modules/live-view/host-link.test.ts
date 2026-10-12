import { describe, expect, test } from 'bun:test'
import { embeddedViewOpenMessageSchema, embeddedViewsMessageSchema, newWorkspaceId, type EmbeddedViewListing, type EmbeddedViewsMessage } from '@leitbild/contracts'
import {
  createViewListPublisher,
  createViewListSync,
  inlineHostAnnouncement,
  inlineOpenRequest,
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
  test('an inline display\'s open request is relayed only from a frame this page made, on this origin, about this Workspace', () => {
    const frame = { name: 'inline display' }
    const page = { origin: 'https://leitbild.app', workspaceId, inlineFrames: [frame] }
    const request = { origin: 'https://leitbild.app', source: frame, data: viewOpenMessage(listing('opened:1')) }
    expect(inlineOpenRequest(request, page)).toEqual(viewOpenMessage(listing('opened:1')))
    expect(inlineOpenRequest({ ...request, source: { name: 'another frame' } }, page)).toBeNull()
    expect(inlineOpenRequest({ ...request, origin: 'https://evil.example' }, page)).toBeNull()
    expect(inlineOpenRequest(request, { ...page, workspaceId: newWorkspaceId() })).toBeNull()
    expect(inlineOpenRequest({ ...request, data: { type: 'leitbild:view-open' } }, page)).toBeNull()
    expect(inlineHostAnnouncement()).toEqual({ type: 'leitbild:view-host' })
  })

  test('an open request carries the whole listing and passes the contract', () => {
    expect(embeddedViewOpenMessageSchema.parse(viewOpenMessage(listing('room-1/tr_1/call_1_0/a')))).toEqual({ type: 'leitbild:view-open', view: listing('room-1/tr_1/call_1_0/a') })
  })

  test('outside the Host a display links to the Workspace page with this room, never a Run', () => {
    expect(workspaceRoomHref(workspaceId, 'room/1 & 2')).toBe(`/workspaces/${workspaceId}?agents=room%2F1+%26+2`)
    expect(new URL(workspaceRoomHref(workspaceId, 'room-1'), 'https://leitbild.app').searchParams.has('world')).toBe(false)
  })
})

const fakeClock = () => {
  let now = 0
  let next = 1
  const timers = new Map<number, { readonly due: number; readonly run: () => void }>()
  return {
    setTimer: (run: () => void, delayMs: number) => { const id = next++; timers.set(id, { due: now + delayMs, run }); return id },
    clearTimer: (timer: unknown) => { timers.delete(timer as number) },
    pending: () => timers.size,
    advance: (ms: number) => {
      now += ms
      for (const [id, timer] of [...timers].sort(([, left], [, right]) => left.due - right.due)) {
        if (timer.due > now) continue
        timers.delete(id)
        timer.run()
      }
    },
  }
}

describe('publishing the list', () => {
  const publisher = () => {
    const clock = fakeClock()
    const posted: EmbeddedViewsMessage[] = []
    const { offer } = createViewListPublisher({ post: message => posted.push(message), settleMs: 250, removalGraceMs: 2_000, ...clock })
    const keysPosted = () => posted.map(message => message.views.map(view => view.key))
    return { offer, posted, keysPosted, clock }
  }
  const listed = (...keys: string[]) => keys.map(listing)

  test('posts the first room\'s list at once, and nothing while it is still empty', () => {
    const empty = publisher()
    empty.offer('room-1', [])
    empty.clock.advance(5_000)
    expect(empty.posted).toEqual([])
    const shown = publisher()
    shown.offer('room-1', listed('a'))
    expect(shown.posted).toEqual([{ type: 'leitbild:views', views: listed('a') }])
  })

  test('posts additions and reorders after the list settled, and only when its key sequence changed', () => {
    const { offer, posted, keysPosted, clock } = publisher()
    offer('room-1', [])
    offer('room-1', listed('a'))
    clock.advance(249)
    expect(posted).toEqual([])
    clock.advance(1)
    offer('room-1', listed('a'))
    clock.advance(5_000)
    offer('room-1', listed('b', 'a'))
    clock.advance(250)
    offer('room-1', listed('a', 'b'))
    clock.advance(250)
    expect(keysPosted()).toEqual([['a'], ['b', 'a'], ['a', 'b']])
    for (const message of posted) embeddedViewsMessageSchema.parse(message)
  })

  test('a newer list replaces one still settling', () => {
    const { offer, posted, clock } = publisher()
    offer('room-1', [])
    offer('room-1', listed('a'))
    offer('room-1', listed('a', 'b'))
    expect(clock.pending()).toBe(1)
    clock.advance(250)
    expect(posted).toEqual([{ type: 'leitbild:views', views: listed('a', 'b') }])
  })

  test('a realtime snapshot that empties the room and refetches it posts nothing', () => {
    const { offer, keysPosted, clock } = publisher()
    offer('room-1', listed('a', 'b'))
    offer('room-1', [])
    clock.advance(1_200)
    offer('room-1', listed('a'))
    clock.advance(700)
    offer('room-1', listed('a', 'b'))
    clock.advance(10_000)
    expect(keysPosted()).toEqual([['a', 'b']])
  })

  test('a removal that still holds after the grace is posted, an empty list included', () => {
    const { offer, keysPosted, clock } = publisher()
    offer('room-1', listed('a', 'b', 'c'))
    offer('room-1', listed('a', 'c'))
    clock.advance(1_999)
    expect(keysPosted()).toEqual([['a', 'b', 'c']])
    clock.advance(1)
    expect(keysPosted()).toEqual([['a', 'b', 'c'], ['a', 'c']])
    offer('room-1', [])
    clock.advance(2_000)
    expect(keysPosted().at(-1)).toEqual([])
  })

  test('a list that removes some displays and adds another settles like an addition', () => {
    const { offer, keysPosted, clock } = publisher()
    offer('room-1', listed('a', 'b'))
    offer('room-1', listed('b', 'c'))
    clock.advance(250)
    expect(keysPosted().at(-1)).toEqual(['b', 'c'])
  })

  test('another room\'s list is posted at once, an empty one included, and cancels a pending one', () => {
    const { offer, keysPosted, clock } = publisher()
    offer('room-1', listed('a'))
    offer('room-1', listed('a', 'b'))
    offer('room-2', listed('x'))
    expect(keysPosted()).toEqual([['a'], ['x']])
    offer(null, [])
    expect(keysPosted()).toEqual([['a'], ['x'], []])
    clock.advance(10_000)
    expect(keysPosted()).toHaveLength(3)
  })
})

describe('deriving the list from the store', () => {
  const fenceFor = (key: string): ViewFence => ({ key, answer: { roomId: 'room-1', turnId: 'tr_1', caption: 'Answer 14:02:31' }, ref: { callId: 'call_1_0', key } })

  test('offers the shown room\'s resolved displays once every resolution settled', async () => {
    const offered: Array<{ readonly roomId: string | null; readonly keys: ReadonlyArray<string> }> = []
    let room: string | null = 'room-1'
    const sync = createViewListSync({
      room: () => room,
      fences: () => [fenceFor('a'), fenceFor('refused'), fenceFor('b')],
      resolve: async fence => (fence.key === 'refused'
        ? { kind: 'refused', code: 'view_evidence_unavailable', message: 'gone' }
        : { kind: 'view', envelope: envelope(fence.key) }) as ViewResolution,
      offer: (roomId, views) => offered.push({ roomId, keys: views.map(view => view.key) }),
    })
    await sync()
    room = null
    await sync()
    expect(offered).toEqual([{ roomId: 'room-1', keys: ['a', 'b'] }, { roomId: null, keys: [] }])
  })

  test('a newer store state supersedes a derivation still waiting for evidence', async () => {
    let fences = [fenceFor('a')]
    let releaseSlow: (resolution: ViewResolution) => void = () => {}
    const offered: ReadonlyArray<EmbeddedViewListing>[] = []
    const sync = createViewListSync({
      room: () => 'room-1',
      fences: () => fences,
      resolve: fence => fence.key === 'a'
        ? new Promise<ViewResolution>(resolve => { releaseSlow = resolve })
        : Promise.resolve({ kind: 'view', envelope: envelope(fence.key) } as ViewResolution),
      offer: (_roomId, views) => offered.push(views),
    })
    const older = sync()
    fences = [fenceFor('b')]
    await sync()
    releaseSlow({ kind: 'view', envelope: envelope('a') } as ViewResolution)
    await older
    expect(offered.map(views => views.map(view => view.key))).toEqual([['b']])
  })
})
