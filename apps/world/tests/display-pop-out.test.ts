import { describe, expect, test } from 'bun:test'
import { embeddedViewListingSchema, embeddedViewWindowName, type EmbeddedViewEnvelope, type EmbeddedViewListing } from '@leitbild/contracts'
import {
  answerDisplayRelay,
  createDisplayRelay,
  parseDisplayRelayRequest,
  parseDisplayRelayTaken,
  popOutListing,
  RELAY_ANSWER_MS,
  type DisplayRelayRequest,
  type DisplayRelayTaken,
  type RelayChannel,
  type ScheduleTimer,
} from '../src/ui/embed/display-relay.ts'
import { createViewerLease, FROZEN_BEFORE_CLOSED_MS, type RunPresenceAnswer, type ViewerLeasePhase } from '../src/ui/embed/pop-out.ts'
import { createViewHost } from '../src/ui/embed/view-host.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const otherWorkspace = '2f939c54-48fd-4548-bb81-413e8f553dfc'

const envelope = (config: { readonly run?: string; readonly workspace?: string; readonly state?: string } = {}): EmbeddedViewEnvelope => ({
  moduleId: 'world',
  viewType: 'display.vignette',
  subject: { workspaceId: config.workspace ?? workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.run ?? 'run-1' },
  title: 'Fleet · halden',
  height: 600,
  state: config.state ?? '{"views":[{"kind":"fleet","of":{"category":"process-plant","group":"halden"}}]}',
}) as EmbeddedViewEnvelope

/** A manual clock: timers run only when the test advances it. */
const manualClock = () => {
  let now = 0
  let timers: Array<{ readonly at: number; readonly run: () => void }> = []
  const schedule: ScheduleTimer = (run, delayMs) => {
    const timer = { at: now + delayMs, run }
    timers.push(timer)
    return () => { timers = timers.filter(entry => entry !== timer) }
  }
  const advance = (ms: number): void => {
    now += ms
    const due = timers.filter(timer => timer.at <= now)
    timers = timers.filter(timer => timer.at > now)
    for (const timer of due) timer.run()
  }
  return { schedule, advance, pending: () => timers.length }
}

const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve() }

/** A lease over fake ports: presence answers what the test sets; each connect is one socket the test drives. */
const fakeLease = (presence: RunPresenceAnswer = 'loaded') => {
  const clock = manualClock()
  const state = { presence, presenceAsked: 0 }
  const sockets: Array<{ ready: () => void; closed: () => void; open: boolean }> = []
  const lease = createViewerLease({
    presence: async () => { state.presenceAsked += 1; return state.presence },
    connect: events => {
      const socket = { ready: events.ready, closed: events.closed, open: true }
      sockets.push(socket)
      return { close: () => { socket.open = false } }
    },
    schedule: clock.schedule,
  })
  const phases: ViewerLeasePhase['kind'][] = []
  lease.subscribe(phase => { phases.push(phase.kind) })
  const last = () => sockets.at(-1)!
  return { lease, clock, state, sockets, phases, last }
}

describe('the pop-out viewer lease', () => {
  test('holds the Run once its WebSocket is ready, while the window is visible', async () => {
    const { lease, sockets, last } = fakeLease()
    expect(lease.current()).toEqual({ kind: 'released' })
    lease.setVisible(true)
    expect(lease.current()).toEqual({ kind: 'attaching' })
    await settle()
    expect(sockets).toHaveLength(1)
    last().ready()
    expect(lease.current()).toEqual({ kind: 'held' })
  })

  test('a hidden window releases its lease, and holds a new one when shown again', async () => {
    const { lease, sockets, last } = fakeLease()
    lease.setVisible(true)
    await settle()
    last().ready()
    lease.setVisible(false)
    expect(lease.current()).toEqual({ kind: 'released' })
    expect(sockets[0]!.open).toBe(false)
    // Its own close is no loss.
    sockets[0]!.closed()
    expect(lease.current()).toEqual({ kind: 'released' })
    lease.setVisible(true)
    await settle()
    expect(sockets).toHaveLength(2)
    last().ready()
    expect(lease.current()).toEqual({ kind: 'held' })
  })

  test('never connects to a Run that is not loaded: it says it is closed', async () => {
    const { lease, sockets, state } = fakeLease('not-loaded')
    lease.setVisible(true)
    await settle()
    expect(state.presenceAsked).toBe(1)
    expect(sockets).toHaveLength(0)
    expect(lease.current()).toEqual({ kind: 'closed', reason: 'the Run is not loaded, and a pop-out never opens one' })
    // Shown again, it stays closed: only a reload attaches again.
    lease.setVisible(false)
    lease.setVisible(true)
    await settle()
    expect(sockets).toHaveLength(0)
  })

  test('a deleted Run closes it at once', async () => {
    const { lease } = fakeLease('missing')
    lease.setVisible(true)
    await settle()
    expect(lease.current()).toEqual({ kind: 'closed', reason: 'the Run no longer exists' })
  })

  test('a dropped connection reads FROZEN, then closed, and never reconnects', async () => {
    const { lease, clock, sockets, phases, last } = fakeLease()
    lease.setVisible(true)
    await settle()
    last().ready()
    last().closed()
    expect(lease.current()).toEqual({ kind: 'lost', reason: 'the connection to the Run was lost' })
    clock.advance(FROZEN_BEFORE_CLOSED_MS - 1)
    expect(lease.current().kind).toBe('lost')
    clock.advance(1)
    expect(lease.current()).toEqual({ kind: 'closed', reason: 'the connection to the Run was lost' })
    expect(phases).toEqual(['released', 'attaching', 'held', 'lost', 'closed'])
    lease.setVisible(false)
    lease.setVisible(true)
    await settle()
    expect(sockets).toHaveLength(1)
  })

  test('a second ready on the same connection is a reset or restart: FROZEN, then closed', async () => {
    const { lease, clock, last } = fakeLease()
    lease.setVisible(true)
    await settle()
    last().ready()
    last().ready()
    expect(lease.current()).toEqual({ kind: 'lost', reason: 'the Run was reset or restarted' })
    expect(last().open).toBe(false)
    clock.advance(FROZEN_BEFORE_CLOSED_MS)
    expect(lease.current().kind).toBe('closed')
  })

  test('a Run closed by someone else, found by the display, reads FROZEN, then closed', async () => {
    const { lease, clock, last } = fakeLease()
    lease.setVisible(true)
    await settle()
    last().ready()
    lease.runGone(false)
    expect(lease.current()).toEqual({ kind: 'lost', reason: 'the Run was closed' })
    expect(last().open).toBe(false)
    clock.advance(FROZEN_BEFORE_CLOSED_MS)
    expect(lease.current()).toEqual({ kind: 'closed', reason: 'the Run was closed' })
  })

  test('refused before it held the Run, it says why from the Run\'s presence', async () => {
    const closedMeanwhile = fakeLease()
    closedMeanwhile.lease.setVisible(true)
    await settle()
    closedMeanwhile.state.presence = 'not-loaded'
    closedMeanwhile.last().closed()
    await settle()
    expect(closedMeanwhile.lease.current()).toEqual({ kind: 'closed', reason: 'the Run is not loaded, and a pop-out never opens one' })

    const roles = fakeLease()
    roles.lease.setVisible(true)
    await settle()
    roles.last().closed()
    await settle()
    expect(roles.lease.current()).toEqual({ kind: 'closed', reason: 'this Run admits only screens holding a role, and a pop-out holds none' })
  })

  test('hidden while it asked about the Run, it does not connect', async () => {
    const { lease, sockets } = fakeLease()
    lease.setVisible(true)
    lease.setVisible(false)
    await settle()
    expect(sockets).toHaveLength(0)
    expect(lease.current()).toEqual({ kind: 'released' })
  })

  test('stopping it closes the socket and cancels the pending close', async () => {
    const { lease, clock, last } = fakeLease()
    lease.setVisible(true)
    await settle()
    last().ready()
    last().closed()
    lease.stop()
    expect(clock.pending()).toBe(0)
  })
})

/** Pages on one channel: a message one posts reaches every other, as a BroadcastChannel does. */
const channelBus = () => {
  const listeners = new Set<{ readonly page: number; readonly receive: (data: unknown) => void }>()
  const posted: Array<DisplayRelayRequest | DisplayRelayTaken> = []
  const page = (id: number): RelayChannel => ({
    post: message => {
      posted.push(message)
      for (const listener of [...listeners]) if (listener.page !== id) listener.receive(structuredClone(message))
    },
    listen: receive => {
      const listener = { page: id, receive }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return { page, posted, listening: () => listeners.size }
}

describe('the pop-out relay to the Run page', () => {
  const listing = (config: Parameters<typeof envelope>[0] = {}): EmbeddedViewListing => popOutListing(envelope(config))

  test('reads only well-formed requests about its Workspace', () => {
    const request = { type: 'world:display-relay', request: 'a1b2c3d4-0000', purpose: 'return', listing: listing() }
    expect(parseDisplayRelayRequest(request, workspaceId)).toEqual(request as DisplayRelayRequest)
    expect(parseDisplayRelayRequest(request, otherWorkspace)).toBeNull()
    expect(parseDisplayRelayRequest({ ...request, purpose: 'navigate' }, workspaceId)).toBeNull()
    expect(parseDisplayRelayRequest({ ...request, request: 'x' }, workspaceId)).toBeNull()
    expect(parseDisplayRelayRequest({ ...request, extra: true }, workspaceId)).toBeNull()
    expect(parseDisplayRelayRequest({ ...request, listing: { ...listing(), key: '' } }, workspaceId)).toBeNull()
    expect(parseDisplayRelayTaken({ type: 'world:display-relay-taken', request: 'a1b2c3d4-0000' })).toEqual({ type: 'world:display-relay-taken', request: 'a1b2c3d4-0000' })
    expect(parseDisplayRelayTaken({ type: 'world:display-relay-taken', request: 'a1b2c3d4-0000', more: 1 })).toBeNull()
  })

  test('the Run page of the display\'s Run shows it and says so; the pop-out learns it was taken', async () => {
    const bus = channelBus()
    const clock = manualClock()
    const opened: EmbeddedViewListing[] = []
    const stop = answerDisplayRelay({ channel: bus.page(1), workspaceId, runId: () => 'run-1', open: listing => { opened.push(listing) } })
    const relay = createDisplayRelay({ channel: bus.page(2), newRequestId: () => 'req-00000001', schedule: clock.schedule })
    const taken = await relay('return', listing())
    expect(taken).toBe(true)
    expect(opened).toEqual([listing()])
    expect(bus.posted.map(message => message.type)).toEqual(['world:display-relay', 'world:display-relay-taken'])
    expect(clock.pending()).toBe(0)
    stop()
    expect(bus.listening()).toBe(0)
  })

  test('a page on another Run, or in another Workspace, leaves it; the pop-out hears no answer and says so', async () => {
    const bus = channelBus()
    const clock = manualClock()
    const opened: EmbeddedViewListing[] = []
    answerDisplayRelay({ channel: bus.page(1), workspaceId, runId: () => 'run-2', open: listing => { opened.push(listing) } })
    answerDisplayRelay({ channel: bus.page(3), workspaceId: otherWorkspace, runId: () => 'run-1', open: listing => { opened.push(listing) } })
    const relay = createDisplayRelay({ channel: bus.page(2), newRequestId: () => 'req-00000002', schedule: clock.schedule })
    const answer = relay('open', listing())
    clock.advance(RELAY_ANSWER_MS)
    expect(await answer).toBe(false)
    expect(opened).toEqual([])
  })

  test('an answer to another request is not this one\'s', async () => {
    const bus = channelBus()
    const clock = manualClock()
    const relay = createDisplayRelay({ channel: bus.page(2), newRequestId: () => 'req-00000003', schedule: clock.schedule })
    const answer = relay('open', listing())
    bus.page(1).post({ type: 'world:display-relay-taken', request: 'req-99999999' })
    clock.advance(RELAY_ANSWER_MS)
    expect(await answer).toBe(false)
  })

  test('a popped-out display returns as a listing of its own, stable for the same display', () => {
    const first = popOutListing(envelope())
    expect(embeddedViewListingSchema.parse(first)).toEqual(first)
    expect(popOutListing(envelope()).key).toBe(first.key)
    expect(popOutListing(envelope({ run: 'run-2' })).key).not.toBe(first.key)
  })

  test('one window per display, whoever pops it out', () => {
    expect(embeddedViewWindowName(envelope())).toBe(embeddedViewWindowName(envelope()))
    expect(embeddedViewWindowName(envelope())).toMatch(/^leitbild-view-[0-9a-f]{8}$/)
    expect(embeddedViewWindowName(envelope({ run: 'run-2' }))).not.toBe(embeddedViewWindowName(envelope()))
    expect(embeddedViewWindowName(envelope({ state: '{"views":[]}' }))).not.toBe(embeddedViewWindowName(envelope()))
  })
})

describe('a view on a page of its own', () => {
  test('opens a display it names through the relay, never by posting to a parent', () => {
    const relayed: EmbeddedViewListing[] = []
    const host = createViewHost({ parent: null, origin: 'https://leitbild.test', listen: () => () => {}, refused: () => {}, detached: listing => { relayed.push(listing) } })
    const openings: Array<string | null> = []
    host.subscribeOpening(where => { openings.push(where) })
    expect(openings).toEqual(['relay'])
    const shown = popOutListing(envelope())
    expect(host.openDisplay({ state: shown.envelope.state, title: shown.envelope.title, listing: () => shown })).toBe(true)
    expect(relayed).toEqual([shown])
  })

  test('without a relay it opens nothing', () => {
    const host = createViewHost({ parent: null, origin: 'https://leitbild.test', listen: () => () => {}, refused: () => {} })
    const shown = popOutListing(envelope())
    expect(host.openDisplay({ state: shown.envelope.state, title: shown.envelope.title, listing: () => shown })).toBe(false)
  })
})
