import { describe, expect, test } from 'bun:test'
import {
  backoffDelay, classifyPeopleFailure, createPeopleSession, OUTBOX_KEY_PREFIX, peopleRequestError, PREFERRED_NAME_KEY, REQUEST_TIMEOUT_MS,
  SEND_TIMEOUT_MS, SYNC_HOLD_MS, SYNC_HOLD_TIMEOUT_MS, TOKEN_KEY_PREFIX, type PeopleEnvironmentEvent, type PeopleLock, type PeoplePorts, type PeopleState,
} from './people-session.ts'
import { NAME_TEXT, SEND_NOTE, SEND_REASON } from './people-format.ts'
import { PEOPLE_CAPABILITY, type ConversationSummaryWire, type MessageWire, type PersonWire, type SyncResultWire } from './people-wire.ts'

const WS = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'
const TOKEN_KEY = `${TOKEN_KEY_PREFIX}${WS}`
const OUTBOX_KEY = `${OUTBOX_KEY_PREFIX}${WS}`
const RUN_A = { workspaceId: WS, moduleId: 'world', type: 'world.simulation-run', id: 'run-a' }
const RUN_B = { ...RUN_A, id: 'run-b' }
const ME: PersonWire = { id: 'person-me', name: 'User1' }
const BEN: PersonWire = { id: 'person-ben', name: 'Ben' }
const CARA: PersonWire = { id: 'person-cara', name: 'Cara' }
const ANA: PersonWire = { id: 'person-ana', name: 'Ana' }
const T0 = Date.parse('2026-10-13T12:00:00.000Z')

// --- fakes -------------------------------------------------------------------

/** Lets every pending promise chain run (real macrotask turns; the session's own timers are fake). */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}
type MemoryStorage = ReturnType<typeof memoryStorage>

const fakeClock = () => {
  let now = T0
  let next = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    timers: {
      set: (callback: () => void, ms: number) => { pending.set(++next, { at: now + ms, callback }); return next },
      clear: (handle: unknown) => { pending.delete(handle as number) },
    },
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0]
        if (due === undefined) break
        pending.delete(due[0])
        now = due[1].at
        due[1].callback()
        await settle()
      }
      now = target
      await settle()
    },
  }
}

interface Call {
  readonly capability: string
  readonly path: string
  readonly input: any
  readonly actor: unknown
  readonly idempotencyKey: string | undefined
  readonly signal: AbortSignal | undefined
  readonly keepalive: boolean
  readonly at: number
  settled: boolean
}
/** 'hold': answer only when aborted. `late`: answer even after an abort (a response already on the wire). */
type Reply = Response | 'hold' | { readonly late: Promise<Response> }
type Handler = (call: Call) => Reply

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ok = (result: unknown): Response => json({ result })
const refuse = (status: number, code: string, details?: Record<string, unknown>): Response =>
  json({ error: { code, message: `refused: ${code}`, ...(details === undefined ? {} : { details }) } }, status)
const htmlBadGateway = (): Response => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } })

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError')

const fakeAgents = (clock: { now: () => number }) => {
  const calls: Call[] = []
  const handlers = new Map<string, Handler>()
  /** Sync answers in order; when empty, a held sync waits and an immediate one gets `syncResult`. */
  const syncReplies: Reply[] = []
  let syncResult: SyncResultWire = result()
  let maxSyncsInFlight = 0
  handlers.set(PEOPLE_CAPABILITY.sync, call => syncReplies.shift() ?? (call.input.waitMs > 0 ? 'hold' : ok(syncResult)))
  handlers.set(PEOPLE_CAPABILITY.leave, () => ok({ left: true }))
  handlers.set(PEOPLE_CAPABILITY.markRead, () => ok({ unread: 0 }))
  const fetch = async (path: string, init: RequestInit): Promise<Response> => {
    const capability = decodeURIComponent(path.replace(/^.*\/capabilities\//, '').replace(/\/invoke$/, ''))
    const body = JSON.parse(String(init.body))
    const call: Call = {
      capability, path, input: body.input, actor: body.actor, idempotencyKey: body.idempotencyKey, signal: init.signal ?? undefined,
      keepalive: init.keepalive === true, at: clock.now(), settled: false,
    }
    if (capability === PEOPLE_CAPABILITY.sync) {
      const live = calls.filter(other => other.capability === PEOPLE_CAPABILITY.sync && !other.settled && !other.signal?.aborted).length
      maxSyncsInFlight = Math.max(maxSyncsInFlight, live + 1)
    }
    calls.push(call)
    const handler = handlers.get(capability)
    if (handler === undefined) throw new Error(`Unexpected request: ${capability}`)
    const reply = handler(call)
    try {
      if (typeof reply === 'object' && 'late' in reply) return await reply.late
      return await new Promise<Response>((resolve, reject) => {
        if (call.signal?.aborted) return reject(abortError())
        call.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
        if (reply !== 'hold') resolve(reply)
      })
    } finally {
      call.settled = true
    }
  }
  return {
    fetch,
    calls,
    syncReplies,
    on(capability: string, handler: Handler) { handlers.set(capability, handler); return this },
    to: (capability: string) => calls.filter(call => call.capability === capability),
    setSyncResult(next: SyncResultWire) { syncResult = next },
    get maxSyncsInFlight() { return maxSyncsInFlight },
  }
}
type FakeAgents = ReturnType<typeof fakeAgents>

function result(overrides: Partial<SyncResultWire> = {}): SyncResultWire {
  return {
    storeId: 'store-1', serverNow: new Date(T0).toISOString(), presenceWarming: false, me: ME, present: [], conversations: [],
    messages: [], cursor: 0, more: false, view: 'view-0', ...overrides,
  }
}
const message = (seq: number, from: PersonWire, to: PersonWire, text = `message ${seq}`): MessageWire =>
  ({ seq, id: `msg-${seq}`, from: from.id, to: to.id, text, sentAt: new Date(T0 + seq * 1_000).toISOString() })
const conversation = (person: PersonWire, unread: number, lastSeq: number, here = true): ConversationSummaryWire =>
  ({ with: person, here, lastSeq, lastSentAt: new Date(T0 + lastSeq * 1_000).toISOString(), unread })

const setup = (options: {
  readonly local?: MemoryStorage | 'blocked'
  readonly session?: MemoryStorage
  readonly lock?: PeopleLock | null
  readonly visible?: boolean
  readonly agents?: FakeAgents
  readonly clock?: ReturnType<typeof fakeClock>
} = {}) => {
  const clock = options.clock ?? fakeClock()
  const agents = options.agents ?? fakeAgents(clock)
  const local = options.local ?? memoryStorage({ [TOKEN_KEY]: 'token-1' })
  const sessionStore = options.session ?? memoryStorage()
  let visible = options.visible ?? true
  const handlers = new Set<(event: PeopleEnvironmentEvent) => void>()
  let ids = 0
  const warnings: string[] = []
  const ports: PeoplePorts = {
    fetch: agents.fetch,
    localStorage: () => {
      if (local === 'blocked') throw new DOMException('The operation is insecure.', 'SecurityError')
      return local
    },
    sessionStorage: () => sessionStore,
    timers: clock.timers,
    lock: options.lock ?? null,
    visible: () => visible,
    listen: handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
    randomId: () => `id-${++ids}`,
    random: () => 0.5, // no jitter: the backoff steps are exact
    now: clock.now,
    warn: text => { warnings.push(text) },
  }
  const session = createPeopleSession({ workspaceId: WS, ports })
  const states: PeopleState[] = []
  session.subscribe(state => { states.push(state) })
  const emit = (event: PeopleEnvironmentEvent): void => { for (const handler of handlers) handler(event) }
  return {
    session, agents, clock, local, sessionStore, states, warnings, emit,
    state: () => session.state(),
    syncs: () => agents.to(PEOPLE_CAPABILITY.sync),
    setVisible: (next: boolean) => { visible = next; emit({ type: 'visibility' }) },
    /** Ends the held sync with this answer (the client asks again at once after `online`). */
    answer: async (reply: Reply) => { agents.syncReplies.push(reply); emit({ type: 'online' }); await settle() },
  }
}

const names = (people: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> => people.map(person => person.name)

// --- tests -----------------------------------------------------------------------

const chatReady = (agents: FakeAgents, messages: ReadonlyArray<MessageWire> = [], readThrough = { me: 0, them: 0 }) =>
  agents.on(PEOPLE_CAPABILITY.conversationRead, call => ok({ with: { id: call.input.with, name: call.input.with === BEN.id ? 'Ben' : 'Cara' }, messages, readThrough }))

describe('failure classification', () => {
  const http = (status: number, code: string | null, extra: { retryable?: boolean; details?: Record<string, unknown> } = {}) =>
    classifyPeopleFailure(peopleRequestError('http', { status, code, ...extra }))

  test('network loss, an HTML gateway page, 502/503/504 and restarting Modules are transient', () => {
    expect(classifyPeopleFailure(peopleRequestError('network')).kind).toBe('transient')
    expect(classifyPeopleFailure(peopleRequestError('non-json', { status: 502 })).kind).toBe('transient')
    for (const status of [502, 503, 504]) expect(http(status, null).kind).toBe('transient')
    for (const code of ['module_unavailable', 'module_outcome_unknown', 'module_not_ready', 'workspace_closing']) expect(http(500, code).kind).toBe('transient')
    expect(http(500, 'something_new', { retryable: true }).kind).toBe('transient')
    expect(http(500, 'people_unavailable').kind).toBe('transient')
    expect(http(507, 'storage_budget_exceeded', { retryable: true }).kind).toBe('transient')
    expect(http(409, 'workspace_closing', { retryable: true }).kind).toBe('transient')
  })

  test('a rate limit is transient and carries its wait', () => {
    expect(http(429, 'people_rate_limited', { details: { retryAfterMs: 4_000 } })).toEqual({ kind: 'transient', code: 'people_rate_limited', retryAfterMs: 4_000 })
  })

  test('a refused token asks for a rejoin; refusals and contract errors are permanent; aborts are neither', () => {
    expect(http(401, 'person_token_invalid').kind).toBe('token-invalid')
    for (const [status, code] of [[400, 'person_name_invalid'], [400, 'conversation_with_self'], [403, 'people_human_required'], [404, 'workspace_not_found'], [409, 'people_limit_reached'], [500, 'internal_error']] as const) {
      expect(http(status, code).kind).toBe('permanent')
    }
    expect(classifyPeopleFailure(peopleRequestError('contract', { status: 200 }))).toMatchObject({ kind: 'permanent', code: 'people_contract_invalid' })
    expect(classifyPeopleFailure(peopleRequestError('aborted')).kind).toBe('aborted')
    expect(classifyPeopleFailure(new Error('programming error')).kind).toBe('permanent')
  })

  test('backoff steps 1, 2, 4, 8, 15 s, capped, ±30 % jitter, never under a retry-after', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(attempt => backoffDelay(attempt, 0.5, null))).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000])
    expect(backoffDelay(0, 0, null)).toBe(700)
    expect(backoffDelay(0, 0.999_999, null)).toBe(1_300)
    expect(backoffDelay(0, 0.5, 6_000)).toBe(6_000)
  })
})

describe('sync', () => {
  test('asks at once, then holds; every call is a human invoke with the token only in the body', async () => {
    const { session, syncs, agents, state } = setup()
    agents.setSyncResult(result({ present: [BEN], cursor: 3, view: 'v1' }))
    session.setViewing(RUN_A)
    expect(state().presentKnown).toBe(false)
    await settle()
    const [first, second] = syncs()
    expect(first!.input).toEqual({ token: 'token-1', screen: 'id-1', viewing: RUN_A, waitMs: 0 })
    expect(second!.input).toEqual({ token: 'token-1', screen: 'id-1', viewing: RUN_A, after: 3, view: 'v1', storeId: 'store-1', waitMs: SYNC_HOLD_MS })
    expect(state()).toMatchObject({ status: 'ready', presentKnown: true, me: ME })
    expect(names(state().present)).toEqual(['Ben'])
    for (const call of agents.calls) {
      expect(call.actor).toEqual({ kind: 'human' })
      expect(call.path).toBe(`/api/workspaces/${WS}/capabilities/${call.capability}/invoke`)
      expect(call.path).not.toContain('token-1')
    }
  })

  test('the Run is passed as exactly its four reference fields', async () => {
    const { session, syncs } = setup()
    session.setViewing({ ...RUN_A, title: 'PWR 4-loop' } as typeof RUN_A)
    await settle()
    expect(syncs()[0]!.input.viewing).toEqual(RUN_A)
  })

  test('a replaced people store drops cached messages, re-reads the open chat and raises no toast', async () => {
    const { session, agents, state, answer } = setup()
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 2)], cursor: 2, view: '1' })))
    let reads = 0
    agents.on(PEOPLE_CAPABILITY.conversationRead, () => ++reads === 1
      ? ok({ with: BEN, messages: [message(1, BEN, ME), message(2, ME, BEN)], readThrough: { me: 2, them: 2 } })
      : ok({ with: BEN, messages: [], readThrough: { me: 0, them: 0 } }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    expect(state().chat?.items).toHaveLength(2)
    await answer(ok(result({ storeId: 'store-2', present: [BEN], conversations: [], cursor: 0, view: 'fresh' })))
    expect(reads).toBe(2)
    expect(state().chat?.items).toEqual([])
    expect(state().toast).toBeNull()
    expect(agents.to(PEOPLE_CAPABILITY.sync).at(-1)!.input).toMatchObject({ storeId: 'store-2', after: 0, view: 'fresh', waitMs: SYNC_HOLD_MS })
  })

  test('answers are parsed strictly: an unknown field is a contract error that stops the loop', async () => {
    const { session, agents, state } = setup()
    agents.syncReplies.push(ok({ ...result(), extra: true }))
    session.setViewing(RUN_A)
    await settle()
    expect(state()).toMatchObject({ status: 'failed', present: [] })
    expect(agents.to(PEOPLE_CAPABILITY.sync)).toHaveLength(1)
  })

  test('a 502 HTML page backs off 1, 2, 4, 8, 15 s and keeps the last list; "Reconnecting…" at 3 s, "can\'t reach" at 30 s', async () => {
    const { session, syncs, agents, clock, state } = setup()
    agents.syncReplies.push(ok(result({ present: [BEN], cursor: 1, view: 'v1' })))
    agents.on(PEOPLE_CAPABILITY.sync, call => agents.syncReplies.shift() ?? htmlBadGateway())
    session.setViewing(RUN_A)
    await settle()
    const start = clock.now()
    expect(names(state().present)).toEqual(['Ben'])
    expect(state().notice).toBe('none')

    await clock.advance(2_999)
    expect(state().notice).toBe('none')
    expect(names(state().present)).toEqual(['Ben'])
    await clock.advance(1)
    expect(state().notice).toBe('reconnecting')
    expect(state().announcement?.text).toBe('Reconnecting…')
    await clock.advance(26_999)
    expect(state().notice).toBe('reconnecting')
    await clock.advance(1)
    expect(state().notice).toBe('unreachable')
    await clock.advance(15_000)

    const times = syncs().slice(1).map(call => call.at - start)
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000])
    expect(names(state().present)).toEqual(['Ben'])
    expect(state().status).toBe('ready')

    // Try now asks at once; the next success clears the notice and says so.
    agents.on(PEOPLE_CAPABILITY.sync, call => agents.syncReplies.shift() ?? (call.input.waitMs > 0 ? 'hold' : ok(result({ present: [BEN, CARA], cursor: 2, view: 'v2' }))))
    session.tryNow()
    await settle()
    expect(state().notice).toBe('none')
    expect(state().announcement?.text).toBe('Connected again.')
    expect(names(state().present)).toEqual(['Ben', 'Cara'])
  })

  test('a success, `online` and the tab becoming visible reset the backoff', async () => {
    const { session, syncs, agents, clock, emit, setVisible } = setup()
    agents.on(PEOPLE_CAPABILITY.sync, () => htmlBadGateway())
    session.setViewing(RUN_A)
    await settle()
    await clock.advance(1_000 + 2_000 + 4_000) // now waiting 8 s
    const before = syncs().length
    emit({ type: 'online' })
    await settle()
    expect(syncs().length).toBe(before + 1)
    await clock.advance(999)
    expect(syncs().length).toBe(before + 1)
    await clock.advance(1)
    expect(syncs().length).toBe(before + 2) // back to 1 s
    await clock.advance(500)
    setVisible(true)
    await settle()
    expect(syncs().length).toBe(before + 3)
  })

  test('a held sync that never answers is given up after its hold plus 10 s and asked again after the first backoff step', async () => {
    const { session, syncs, clock, state } = setup()
    session.setViewing(RUN_A)
    await settle()
    const held = syncs()[1]!
    expect(held.input.waitMs).toBe(SYNC_HOLD_MS)
    await clock.advance(SYNC_HOLD_TIMEOUT_MS - 1)
    expect(held.signal?.aborted).toBe(false)
    await clock.advance(1)
    expect(held.signal?.aborted).toBe(true)
    expect(syncs()).toHaveLength(2)
    await clock.advance(999)
    expect(syncs()).toHaveLength(2)
    await clock.advance(1)
    // The retry answers at once, and a new hold follows.
    expect(syncs().slice(2).map(call => call.input.waitMs)).toEqual([0, SYNC_HOLD_MS])
    expect(state()).toMatchObject({ status: 'ready', notice: 'none' })
  })

  test('a rename with no answer gives up after the request timeout', async () => {
    const { session, agents, clock } = setup()
    agents.on(PEOPLE_CAPABILITY.rename, () => 'hold')
    session.setViewing(RUN_A)
    await settle()
    const outcome = session.rename('Ben')
    await clock.advance(REQUEST_TIMEOUT_MS)
    expect(await outcome).toEqual({ ok: false, error: NAME_TEXT.failed })
    expect(agents.to(PEOPLE_CAPABILITY.rename)[0]!.signal?.aborted).toBe(true)
  })

  test('a Run switch aborts the held sync, asks again at once and ignores the old answer', async () => {
    const { session, syncs, agents, state } = setup()
    const late = deferred<Response>()
    agents.syncReplies.push(ok(result({ present: [BEN], cursor: 1, view: 'a' })), { late: late.promise })
    session.setViewing(RUN_A)
    await settle()
    const held = syncs()[1]!
    expect(held.input).toMatchObject({ viewing: RUN_A, waitMs: SYNC_HOLD_MS })

    agents.syncReplies.push(ok(result({ present: [CARA], cursor: 1, view: 'b' })))
    session.setViewing(RUN_B)
    expect(held.signal?.aborted).toBe(true)
    expect(state().presentKnown).toBe(false)
    expect(state().present).toEqual([])
    await settle()
    expect(syncs()[2]!.input).toMatchObject({ viewing: RUN_B, waitMs: 0 })
    expect(names(state().present)).toEqual(['Cara'])

    late.resolve(ok(result({ present: [BEN, ANA], cursor: 9, view: 'stale' })))
    await settle()
    expect(names(state().present)).toEqual(['Cara'])
    expect(syncs().at(-1)!.input).toMatchObject({ viewing: RUN_B, after: 1, view: 'b' })
  })

  test('never has two syncs in flight across switches, wake-ups, adoption and retries', async () => {
    const { session, agents, emit, clock, setVisible } = setup()
    session.setViewing(RUN_A)
    await settle()
    session.setViewing(RUN_B)
    emit({ type: 'online' })
    setVisible(true)
    emit({ type: 'storage', key: TOKEN_KEY, newValue: 'token-2' })
    emit({ type: 'resume' })
    session.tryNow()
    session.setViewing(RUN_A)
    await settle()
    agents.syncReplies.push(htmlBadGateway())
    emit({ type: 'online' })
    await settle()
    await clock.advance(1_000)
    emit({ type: 'pagehide' })
    emit({ type: 'pageshow', persisted: true })
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.sync).length).toBeGreaterThan(8)
    expect(agents.maxSyncsInFlight).toBe(1)
  })

  test('while presence is warming up after a restart, people are merged with the last list, not dropped', async () => {
    const { session, agents, states, state } = setup()
    agents.syncReplies.push(
      ok(result({ present: [BEN, CARA], cursor: 1, view: '1' })),
      ok(result({ presenceWarming: true, present: [CARA], cursor: 1, view: '2' })),
      ok(result({ presenceWarming: false, present: [ANA, CARA], cursor: 1, view: '3' })),
    )
    session.setViewing(RUN_A)
    await settle()
    const seen = states.filter(entry => entry.presentKnown).map(entry => names(entry.present).join(','))
    expect([...new Set(seen)]).toEqual(['Ben,Cara', 'Cara,Ana'])
    // Arrival order: Ana came last, so she is listed last although the server sorts by name.
    expect(names(state().present)).toEqual(['Cara', 'Ana'])
  })

  test('a refused token rejoins with the remembered name, stores the new token and syncs with it', async () => {
    const local = memoryStorage({ [TOKEN_KEY]: 'old-token', [PREFERRED_NAME_KEY]: 'Anna' })
    const { session, agents, syncs, state } = setup({ local })
    agents.syncReplies.push(refuse(401, 'person_token_invalid'))
    agents.on(PEOPLE_CAPABILITY.join, () => ok({ token: 'new-token', me: { id: 'person-u3', name: 'User3' }, preferredNameAccepted: false }))
    agents.setSyncResult(result({ me: { id: 'person-u3', name: 'User3' } }))
    session.setViewing(RUN_A)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.join).map(call => call.input)).toEqual([{ preferredName: 'Anna' }])
    expect(local.map.get(TOKEN_KEY)).toBe('new-token')
    expect(syncs()[1]!.input.token).toBe('new-token')
    expect(state()).toMatchObject({ status: 'ready', preferredNameTaken: 'Anna', me: { name: 'User3' } })
  })

  test('a token refused again straight after joining stops instead of creating people in a loop', async () => {
    const { session, agents, state } = setup()
    agents.on(PEOPLE_CAPABILITY.sync, () => refuse(401, 'person_token_invalid'))
    agents.on(PEOPLE_CAPABILITY.join, () => ok({ token: 'new-token', me: ME, preferredNameAccepted: true }))
    session.setViewing(RUN_A)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.join)).toHaveLength(1)
    expect(state().status).toBe('failed')
    expect(state().failure).not.toBeNull()
  })

  test('a permanent refusal stops the loop and shows a failure, not the page error', async () => {
    const { session, agents, clock, syncs, state } = setup()
    agents.on(PEOPLE_CAPABILITY.sync, () => refuse(403, 'people_human_required'))
    session.setViewing(RUN_A)
    await settle()
    await clock.advance(60_000)
    expect(syncs()).toHaveLength(1)
    expect(state()).toMatchObject({ status: 'failed', notice: 'none' })
  })

  test('pagehide aborts the sync and says goodbye with a keepalive leave; a restored page syncs at once', async () => {
    const { session, agents, syncs, emit } = setup()
    session.setViewing(RUN_A)
    await settle()
    const held = syncs().at(-1)!
    emit({ type: 'pagehide' })
    expect(held.signal?.aborted).toBe(true)
    const [leave] = agents.to(PEOPLE_CAPABILITY.leave)
    expect(leave).toMatchObject({ keepalive: true, input: { token: 'token-1', screen: 'id-1' } })
    await settle()
    const count = syncs().length
    emit({ type: 'pageshow', persisted: true })
    await settle()
    expect(syncs()[count]!.input.waitMs).toBe(0)
  })

  test('leaving the Run view stops syncing and leaves the Run', async () => {
    const { session, agents, syncs, state } = setup()
    session.setViewing(RUN_A)
    await settle()
    session.setViewing(null)
    await settle()
    expect(syncs().at(-1)!.signal?.aborted).toBe(true)
    expect(agents.to(PEOPLE_CAPABILITY.leave)).toHaveLength(1)
    expect(state().active).toBe(false)
  })
})

describe('identity', () => {
  test('two tabs opened together join once under the Web Lock', async () => {
    const clock = fakeClock()
    const agents = fakeAgents(clock)
    const shared = memoryStorage()
    let tail: Promise<unknown> = Promise.resolve()
    const lock: PeopleLock = async (_name, task) => {
      const run = tail.then(task)
      tail = run.catch(() => undefined)
      return await run
    }
    let joins = 0
    agents.on(PEOPLE_CAPABILITY.join, () => ok({ token: `token-${++joins}`, me: ME, preferredNameAccepted: true }))
    const first = setup({ clock, agents, local: shared, lock })
    const second = setup({ clock, agents, local: shared, lock })
    first.session.setViewing(RUN_A)
    second.session.setViewing(RUN_A)
    await settle()
    expect(joins).toBe(1)
    expect(new Set(agents.to(PEOPLE_CAPABILITY.sync).map(call => call.input.token))).toEqual(new Set(['token-1']))
  })

  test('a sibling tab\'s newer token is adopted from the storage event', async () => {
    const { session, emit, syncs } = setup()
    session.setViewing(RUN_A)
    await settle()
    emit({ type: 'storage', key: 'leitbild:other', newValue: 'x' })
    emit({ type: 'storage', key: TOKEN_KEY, newValue: null })
    await settle()
    const count = syncs().length
    emit({ type: 'storage', key: TOKEN_KEY, newValue: 'token-sibling' })
    await settle()
    expect(syncs().length).toBe(count + 2)
    expect(syncs()[count]!.input).toMatchObject({ token: 'token-sibling', waitMs: 0 })
    expect(syncs()[count]!.input.after).toBeUndefined()
  })

  test('a refusal of the old token after adopting a sibling\'s keeps the sibling\'s token and joins no one (review P3)', async () => {
    const { session, agents, local, emit, state } = setup()
    agents.on(PEOPLE_CAPABILITY.conversationRead, () => ok({ with: BEN, messages: [], readThrough: { me: 0, them: 0 } }))
    const refusal = deferred<Response>()
    agents.on(PEOPLE_CAPABILITY.send, call => call.input.token === 'token-1' ? { late: refusal.promise } : ok({ message: message(5, ME, BEN, 'x'), replayed: false }))
    let joins = 0
    agents.on(PEOPLE_CAPABILITY.join, () => { joins += 1; return ok({ token: `joined-${joins}`, me: { id: 'person-new', name: 'User9' }, preferredNameAccepted: true }) })
    agents.setSyncResult(result({ present: [BEN], cursor: 0, view: 'v0' }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('x')
    await settle()
    if (local === 'blocked') throw new Error('storage expected')
    local.map.set(TOKEN_KEY, 'token-2')
    emit({ type: 'storage', key: TOKEN_KEY, newValue: 'token-2' })
    await settle()
    refusal.resolve(refuse(401, 'person_token_invalid'))
    await settle()
    expect(local.map.get(TOKEN_KEY)).toBe('token-2')
    expect(joins).toBe(0)
    expect(new Set(agents.to(PEOPLE_CAPABILITY.sync).slice(-2).map(call => call.input.token))).toEqual(new Set(['token-2']))
    // The message is sent again with the adopted token.
    expect(agents.to(PEOPLE_CAPABILITY.send).map(call => call.input.token)).toEqual(['token-1', 'token-2'])
    expect(state().chat?.items).toEqual([expect.objectContaining({ kind: 'message', seq: 5 })])
  })

  test('blocked site storage gives a page-only identity and says so', async () => {
    let locked = 0
    const lock: PeopleLock = async (_name, task) => { locked += 1; return await task() }
    const { session, agents, syncs, state } = setup({ local: 'blocked', lock })
    agents.on(PEOPLE_CAPABILITY.join, () => ok({ token: 'page-token', me: ME, preferredNameAccepted: true }))
    expect(state().storage).toBe('page')
    session.setViewing(RUN_A)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.join).map(call => call.input)).toEqual([{}])
    expect(locked).toBe(0)
    expect(syncs()[0]!.input.token).toBe('page-token')
    expect(state()).toMatchObject({ status: 'ready', storage: 'page' })
  })

  test('a full sessionStorage says unsent messages are not kept, and never claims the identity is page-only', async () => {
    const sessionStore = memoryStorage()
    sessionStore.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError') }
    const { session, agents, state, warnings } = setup({ session: sessionStore })
    chatReady(agents)
    agents.on(PEOPLE_CAPABILITY.send, () => 'hold')
    session.setViewing(RUN_A)
    await settle()
    expect(state()).toMatchObject({ storage: 'browser', outboxSaved: true })
    session.openChat(BEN)
    await settle()
    session.send('kept in this page only')
    await settle()
    expect(state()).toMatchObject({ storage: 'browser', outboxSaved: false })
    expect(warnings.filter(text => text.includes('unsent messages'))).toHaveLength(1)
  })

  test('rename maps every server refusal to a sentence and remembers a saved name', async () => {
    const { session, agents, local, state } = setup()
    const replies = [
      refuse(409, 'person_name_taken'),
      refuse(400, 'person_name_invalid', { reason: 'invalid_characters' }),
      refuse(400, 'person_name_invalid', { reason: 'too_long' }),
      refuse(429, 'people_rate_limited', { retryAfterMs: 30_000 }),
      htmlBadGateway(),
      ok({ me: { id: ME.id, name: 'Ben 2' } }),
    ]
    agents.on(PEOPLE_CAPABILITY.rename, () => replies.shift()!)
    session.setViewing(RUN_A)
    await settle()
    expect(await session.rename('   ')).toEqual({ ok: false, error: NAME_TEXT.empty })
    expect(await session.rename('x'.repeat(33))).toEqual({ ok: false, error: NAME_TEXT.tooLong })
    expect(await session.rename('User1')).toEqual({ ok: true, name: 'User1' })
    expect(agents.to(PEOPLE_CAPABILITY.rename)).toHaveLength(0)

    expect(await session.rename('  ben\n ')).toEqual({ ok: false, error: NAME_TEXT.taken('ben') })
    expect(agents.to(PEOPLE_CAPABILITY.rename)[0]!.input).toEqual({ token: 'token-1', name: 'ben' })
    expect(await session.rename('b‍n')).toEqual({ ok: false, error: NAME_TEXT.invalidCharacters })
    expect(await session.rename('Ben')).toEqual({ ok: false, error: NAME_TEXT.tooLong })
    expect(await session.rename('Ben')).toEqual({ ok: false, error: NAME_TEXT.rateLimited })
    expect(await session.rename('Ben')).toEqual({ ok: false, error: NAME_TEXT.failed })
    expect(await session.rename('Ben  2')).toEqual({ ok: true, name: 'Ben 2' })
    expect(local !== 'blocked' && local.map.get(PREFERRED_NAME_KEY)).toBe('Ben 2')
    expect(state().me?.name).toBe('Ben 2')
    expect(state().announcement?.text).toBe('Saved.')
  })
})

describe('messages', () => {

  test('a transient send failure retries with the same key, and a reload re-sends it with that key', async () => {
    const sessionStore = memoryStorage()
    const first = setup({ session: sessionStore })
    chatReady(first.agents)
    first.agents.on(PEOPLE_CAPABILITY.send, () => htmlBadGateway())
    first.session.setViewing(RUN_A)
    await settle()
    first.session.openChat(BEN)
    await settle()
    expect(first.session.send('Hello Ben  \n')).toBe(true)
    await settle()
    const sends = first.agents.to(PEOPLE_CAPABILITY.send)
    const key = sends[0]!.idempotencyKey!
    expect(key).toBeTruthy()
    expect(sends[0]!.input).toEqual({ token: 'token-1', to: BEN.id, text: 'Hello Ben' })
    await first.clock.advance(1_000)
    expect(first.agents.to(PEOPLE_CAPABILITY.send).map(call => call.idempotencyKey)).toEqual([key, key])
    expect(first.state().chat?.items.at(-1)).toMatchObject({ kind: 'outgoing', key, stage: 'sending' })
    expect(JSON.parse(sessionStore.map.get(OUTBOX_KEY)!)).toEqual([{ key, to: BEN.id, text: 'Hello Ben', createdAt: T0, failed: false, reason: null }])

    // The page reloads: a new session on the same sessionStorage sends the same message with the same key.
    first.session.dispose()
    const second = setup({ session: sessionStore })
    chatReady(second.agents)
    second.agents.on(PEOPLE_CAPABILITY.send, call => ok({ message: { ...message(7, ME, BEN, call.input.text), id: 'msg-7' }, replayed: true }))
    second.session.setViewing(RUN_A)
    await settle()
    expect(second.agents.to(PEOPLE_CAPABILITY.send).map(call => [call.idempotencyKey, call.input.text])).toEqual([[key, 'Hello Ben']])
    expect(sessionStore.map.has(OUTBOX_KEY)).toBe(false)
    second.session.openChat(BEN)
    await settle()
  })

  test('an unacknowledged message shows "Sending…" after 1 s and "Not sent" after 15 s; Retry keeps its key', async () => {
    const { session, agents, clock, state } = setup()
    chatReady(agents)
    agents.on(PEOPLE_CAPABILITY.send, () => refuse(503, 'module_unavailable'))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('Seal injection is normal')
    await settle()
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'outgoing', stage: 'quiet' })
    await clock.advance(1_000)
    expect(state().chat?.items.at(-1)).toMatchObject({ stage: 'sending' })
    await clock.advance(SEND_TIMEOUT_MS - 1_000)
    const failed = state().chat?.items.at(-1)
    expect(failed).toMatchObject({ kind: 'outgoing', stage: 'failed', reason: SEND_REASON.unreachable })
    const attempts = agents.to(PEOPLE_CAPABILITY.send).length
    await clock.advance(60_000)
    expect(agents.to(PEOPLE_CAPABILITY.send).length).toBe(attempts) // no retries once it has failed

    agents.on(PEOPLE_CAPABILITY.send, call => ok({ message: message(9, ME, BEN, call.input.text), replayed: false }))
    session.retrySend(failed!.key)
    await settle()
    const keys = new Set(agents.to(PEOPLE_CAPABILITY.send).map(call => call.idempotencyKey))
    expect(keys).toEqual(new Set([failed!.key]))
    // The delivered bubble keeps the key it was sent with, so its node is kept.
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'message', key: failed!.key, seq: 9, mine: true })
  })

  test('my own message arriving through sync before its send is acknowledged shows once, as delivered (review P1)', async () => {
    const { session, agents, state, answer } = setup()
    chatReady(agents)
    const ack = deferred<Response>()
    agents.on(PEOPLE_CAPABILITY.send, () => ({ late: ack.promise }))
    agents.setSyncResult(result({ present: [BEN], cursor: 0, view: 'v0' }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('hello')
    await settle()
    const key = agents.to(PEOPLE_CAPABILITY.send)[0]!.idempotencyKey!
    const sent = message(1, ME, BEN, 'hello')
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 1)], messages: [sent], cursor: 1, view: 'v1' })))
    expect(state().chat?.items).toEqual([expect.objectContaining({ kind: 'message', key, seq: 1, mine: true, text: 'hello' })])
    ack.resolve(ok({ message: sent, replayed: false }))
    await settle()
    expect(state().chat?.items).toEqual([expect.objectContaining({ kind: 'message', key, seq: 1 })])
  })

  test('a send that gave up waiting but was stored shows as delivered when sync brings it, not "Not sent" beside it (review P2)', async () => {
    const { session, agents, state, answer, clock } = setup()
    chatReady(agents)
    agents.on(PEOPLE_CAPABILITY.send, () => 'hold')
    agents.setSyncResult(result({ present: [BEN], cursor: 0, view: 'v0' }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('slow one')
    await settle()
    await clock.advance(SEND_TIMEOUT_MS + 1)
    expect(state().chat?.items).toEqual([expect.objectContaining({ kind: 'outgoing', stage: 'failed' })])
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 1)], messages: [message(1, ME, BEN, 'slow one')], cursor: 1, view: 'v1' })))
    expect(state().chat?.items).toEqual([expect.objectContaining({ kind: 'message', seq: 1, text: 'slow one' })])
  })

  test('an identical message from a sibling tab never swallows one that was not sent yet', async () => {
    const { session, agents, state, answer } = setup()
    chatReady(agents)
    agents.on(PEOPLE_CAPABILITY.send, () => refuse(503, 'module_unavailable'))
    agents.setSyncResult(result({ present: [BEN], cursor: 0, view: 'v0' }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('ok')
    session.send('ok')
    await settle()
    // The first was tried once (and is waiting to retry); the second was never sent.
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 1)], messages: [message(1, ME, BEN, 'ok')], cursor: 1, view: 'v1' })))
    expect(state().chat?.items.map(item => item.kind)).toEqual(['message', 'outgoing'])
  })

  test('a rate-limited message says it is sending too fast and waits for the limit, not "couldn\'t reach Leitbild"', async () => {
    const { session, agents, clock, state } = setup()
    chatReady(agents)
    const replies = [refuse(429, 'people_rate_limited', { retryAfterMs: 20_000 })]
    agents.on(PEOPLE_CAPABILITY.send, call => replies.shift() ?? ok({ message: message(3, ME, BEN, call.input.text), replayed: false }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('one more')
    await settle()
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'outgoing', note: SEND_NOTE.rateLimited })
    await clock.advance(19_999)
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'outgoing', stage: 'sending', note: SEND_NOTE.rateLimited })
    expect(agents.to(PEOPLE_CAPABILITY.send)).toHaveLength(1)
    await clock.advance(1)
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'message', seq: 3 })
  })

  test('a rejected message fails at once with its reason, without retries; Remove drops it locally', async () => {
    const { session, agents, clock, state } = setup()
    chatReady(agents)
    const refusals = [refuse(400, 'message_invalid_characters'), refuse(400, 'message_too_long')]
    agents.on(PEOPLE_CAPABILITY.send, () => refusals.shift()!)
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.send('a NUL the server refuses')
    session.send('too long for the server')
    await settle()
    await clock.advance(60_000)
    expect(agents.to(PEOPLE_CAPABILITY.send)).toHaveLength(2)
    const [first, second] = state().chat!.items
    expect(first).toMatchObject({ stage: 'failed', reason: SEND_REASON.invalidCharacters })
    expect(second).toMatchObject({ stage: 'failed', reason: SEND_REASON.tooLong })
    session.removeSend(first!.key)
    session.removeSend(second!.key)
    expect(state().chat?.items).toEqual([])
  })

  test('while the connection is down, queued messages wait rather than fail, then flush in order', async () => {
    const { session, agents, clock, state } = setup()
    chatReady(agents)
    let down = true
    agents.on(PEOPLE_CAPABILITY.sync, call => agents.syncReplies.shift() ?? (down ? htmlBadGateway() : call.input.waitMs > 0 ? 'hold' : ok(result({ cursor: 0 }))))
    agents.syncReplies.push(ok(result()))
    agents.on(PEOPLE_CAPABILITY.send, call => down ? htmlBadGateway() : ok({ message: message(call.input.text === 'one' ? 1 : 2, ME, BEN, call.input.text), replayed: false }))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    // The held sync fails: the connection is in trouble from here.
    await (async () => { agents.syncReplies.push(htmlBadGateway()); session.tryNow(); await settle() })()
    session.send('one')
    session.send('two')
    await clock.advance(40_000)
    expect(state().notice).toBe('unreachable')
    expect(state().chat?.items.map(item => item.kind === 'outgoing' ? item.stage : item.kind)).toEqual(['sending', 'sending'])
    down = false
    session.tryNow()
    await settle()
    expect(state().chat?.items.map(item => item.kind === 'message' ? item.text : `pending ${item.kind}`)).toEqual(['one', 'two'])
    const delivered = agents.to(PEOPLE_CAPABILITY.send).filter(call => call.settled).map(call => call.input.text)
    expect(delivered.at(-2)).toBe('one')
    expect(delivered.at(-1)).toBe('two')
  })

  test('marks read only while the chat is open and the tab visible', async () => {
    const { session, agents, state, setVisible, answer } = setup({ visible: false })
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 5)], cursor: 5, view: '1' })))
    chatReady(agents, [message(4, ME, BEN), message(5, BEN, ME)], { me: 4, them: 5 })
    session.setViewing(RUN_A)
    await settle()
    expect(state().unreadTotal).toBe(1)
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(0)

    session.openChat(BEN)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(0) // hidden tab
    expect(state().chat?.firstUnreadKey).toBe('msg-5')
    expect(state().unreadTotal).toBe(1)

    setVisible(true)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.markRead).map(call => call.input)).toEqual([{ token: 'token-1', with: BEN.id, through: 5 }])
    expect(state().unreadTotal).toBe(0)

    // A message for the open, visible chat is read at once.
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 6)], messages: [message(6, BEN, ME)], cursor: 6, view: '2' })))
    expect(agents.to(PEOPLE_CAPABILITY.markRead).at(-1)!.input.through).toBe(6)
    expect(state().toast).toBeNull()

    // A closed chat is never marked read.
    session.closeChat()
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 7)], messages: [message(7, BEN, ME)], cursor: 7, view: '3' })))
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(2)
    expect(state().unreadTotal).toBe(1)
  })

  test('a mark-read answer never overwrites a newer unread count from sync (review P4)', async () => {
    const { session, agents, state, answer } = setup()
    agents.on(PEOPLE_CAPABILITY.conversationRead, () => ok({ with: BEN, messages: [message(1, BEN, ME)], readThrough: { me: 0, them: 0 } }))
    const mark = deferred<Response>()
    agents.on(PEOPLE_CAPABILITY.markRead, () => ({ late: mark.promise }))
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 1)], cursor: 1, view: 'v1' })))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(1)
    session.closeChat()
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 2)], messages: [message(2, BEN, ME)], cursor: 2, view: 'v2' })))
    expect(state().unreadTotal).toBe(1)
    mark.resolve(ok({ unread: 0 })) // computed before message 2 was stored
    await settle()
    expect(state().unreadTotal).toBe(1)
  })

  test('marks read only while the newest message is on screen; scrolled up, the real count shows', async () => {
    const { session, agents, state, answer } = setup()
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 1)], cursor: 1, view: '1' })))
    chatReady(agents, [message(1, BEN, ME)], { me: 1, them: 1 })
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    session.setChatAtBottom(false)
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 1, 2)], messages: [message(2, BEN, ME)], cursor: 2, view: '2' })))
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(0)
    expect(state().unreadTotal).toBe(1)
    session.setChatAtBottom(true)
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.markRead).map(call => call.input.through)).toEqual([2])
    expect(state().unreadTotal).toBe(0)
  })

  test('the open chat\'s count shows while it loads and after a failed mark-read', async () => {
    const { session, agents, state } = setup()
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 2, 2)], cursor: 2, view: '1' })))
    const read = deferred<Response>()
    agents.on(PEOPLE_CAPABILITY.conversationRead, () => ({ late: read.promise }))
    agents.on(PEOPLE_CAPABILITY.markRead, () => refuse(500, 'internal_error'))
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    expect(state().unreadTotal).toBe(2) // loading
    read.resolve(ok({ with: BEN, messages: [message(1, BEN, ME), message(2, BEN, ME)], readThrough: { me: 0, them: 0 } }))
    await settle()
    expect(agents.to(PEOPLE_CAPABILITY.markRead)).toHaveLength(1)
    expect(state().unreadTotal).toBe(2) // the read was refused
  })

  test('unread totals add up; new messages raise one toast per sender, never for history, a hidden tab or an open popover', async () => {
    const { session, agents, state, setVisible, answer } = setup()
    agents.syncReplies.push(ok(result({
      present: [BEN], conversations: [conversation(BEN, 2, 3), conversation(CARA, 1, 2, false)],
      messages: [message(1, BEN, ME), message(2, CARA, ME), message(3, BEN, ME)], cursor: 3, view: '1',
    })))
    session.setViewing(RUN_A)
    await settle()
    expect(state().unreadTotal).toBe(3)
    expect(state().toast).toBeNull() // history is not news
    expect(names(state().earlier)).toEqual(['Cara'])
    expect(state().earlier[0]).toMatchObject({ here: false, unread: 1 })
    expect(state().present[0]).toMatchObject({ name: 'Ben', here: true, unread: 2 })

    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 3, 4), conversation(CARA, 1, 2, false)], messages: [message(4, BEN, ME, 'Pressuriser level?')], cursor: 4, view: '2' })))
    expect(state().unreadTotal).toBe(4)
    expect(state().toast).toMatchObject({ kind: 'message', from: BEN, text: 'Pressuriser level?', count: 1 })
    expect(state().announcement?.text).toBe('New message from Ben')

    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 4, 5), conversation(CARA, 1, 2, false)], messages: [message(5, BEN, ME)], cursor: 5, view: '3' })))
    expect(state().toast).toMatchObject({ from: BEN, count: 2 })

    await answer(ok(result({ present: [BEN], conversations: [conversation(CARA, 2, 6, false), conversation(BEN, 4, 5)], messages: [message(6, CARA, ME, 'Hi')], cursor: 6, view: '4' })))
    expect(state().toast).toMatchObject({ from: CARA, count: 1, text: 'Hi' })

    session.setPopoverOpen(true)
    expect(state().toast).toBeNull()
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 5, 7), conversation(CARA, 2, 6, false)], messages: [message(7, BEN, ME)], cursor: 7, view: '5' })))
    expect(state().toast).toBeNull()
    expect(state().unreadTotal).toBe(7)

    session.setPopoverOpen(false)
    setVisible(false)
    await answer(ok(result({ present: [BEN], conversations: [conversation(BEN, 6, 8), conversation(CARA, 2, 6, false)], messages: [message(8, BEN, ME)], cursor: 8, view: '6' })))
    expect(state().toast).toBeNull()
    expect(state().unreadTotal).toBe(8)
  })

  test('a sender whose name never arrived shows as "Unknown person", warned once, never as a raw id', async () => {
    const { session, state, answer, warnings } = setup()
    session.setViewing(RUN_A)
    await settle()
    const stranger = { id: 'person-stranger', name: 'Stranger' }
    await answer(ok(result({ messages: [message(1, stranger, ME, 'hi')], cursor: 1, view: '1' })))
    await answer(ok(result({ messages: [message(2, stranger, ME, 'again')], cursor: 2, view: '2' })))
    expect(state().toast).toMatchObject({ kind: 'message', from: { id: 'person-stranger', name: 'Unknown person' }, count: 2 })
    expect(warnings.filter(text => text.includes('person-stranger'))).toHaveLength(1)
  })

  test('a rename while the chat is open adds a line to it', async () => {
    const { session, agents, state, answer } = setup()
    agents.syncReplies.push(ok(result({ present: [BEN], conversations: [conversation(BEN, 0, 1)], cursor: 1, view: '1' })))
    chatReady(agents, [message(1, BEN, ME)], { me: 1, them: 1 })
    session.setViewing(RUN_A)
    await settle()
    session.openChat(BEN)
    await settle()
    const renamed = { ...BEN, name: 'Ben (turbine)' }
    await answer(ok(result({ present: [renamed], conversations: [conversation(renamed, 0, 1)], cursor: 1, view: '2' })))
    expect(state().chat?.with.name).toBe('Ben (turbine)')
    expect(state().chat?.items.at(-1)).toMatchObject({ kind: 'note', text: 'Ben is now called Ben (turbine)' })
    expect(names(state().present)).toEqual(['Ben (turbine)'])
  })
})
