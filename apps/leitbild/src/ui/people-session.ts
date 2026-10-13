// The people client (CONTRACT "Host UI client"): who else is in this Run, my
// name, and direct messages, all through the Agents people Capabilities via
// the Host's invoke path. Framework-free: every browser facility is a port, so
// the tests drive the network, storage, timers, locks and page lifecycle.
//
// - Identity: a token per Workspace in localStorage, joined under a Web Lock so
//   two tabs opened together become one person; a sibling tab's token is
//   adopted from the `storage` event. Blocked storage gives a page-only
//   identity and says so.
// - Sync: exactly one request in flight, each answer chaining the next (a held
//   request while nothing changes). A Run switch aborts it and asks again at
//   once; answers for an older generation are dropped.
// - Trouble: transient failures back off 1, 2, 4, 8, 15 s (±30 %), keep the
//   last known state, and show nothing for 3 s, "Reconnecting…" until 30 s,
//   then "Can't reach Leitbild". They never reach the page's error banner.
// - Messages: an outbox with one idempotency key per message, kept in
//   sessionStorage so a reload re-sends the same message rather than a copy,
//   delivered one at a time in order.

import { z } from 'zod'
import {
  conversationReadResultSchema, errorEnvelopeSchema, invocationEnvelopeSchema, invokeBody, invokePath, joinResultSchema,
  markReadResultSchema, PEOPLE_CAPABILITY, PEOPLE_ERROR, renameResultSchema, sendResultSchema, SYNC_WAIT_MAX_MS, syncResultSchema,
  type ConversationSummaryWire, type MessageWire, type NameInvalidReason, type PersonWire, type SyncInput, type SyncResultWire,
  type ViewingReference,
} from './people-wire.ts'
import {
  HISTORY_CAP, messageSendable, messageText, NAME_TEXT, nameProblem, normaliseName, PEOPLE_FAILED_TEXT, SEND_REASON,
  type ChatItem,
} from './people-format.ts'

/** Backoff steps after transient failures; the last one repeats. */
export const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const
/** ±30 % so screens that lost the server together do not return together. */
export const BACKOFF_JITTER = 0.3
/** A deploy restart is shorter than this, so it shows nothing. */
export const RECONNECT_NOTICE_DELAY_MS = 3_000
/** After this the notice says Leitbild cannot be reached and offers "Try now". */
export const RECONNECT_ESCALATE_MS = 30_000
/** An unacknowledged message shows "Sending…" only after this. */
export const SENDING_LABEL_DELAY_MS = 1_000
/** An unacknowledged message is "Not sent" after this, unless the whole connection is down. */
export const SEND_TIMEOUT_MS = 15_000
/** A held sync waits as long as Agents allows, well inside the Host gateway's 30 s. */
export const SYNC_HOLD_MS = SYNC_WAIT_MAX_MS
/** Two token refusals in a row without a success is a server fault, not a lost token: stop rather than create people in a loop. */
export const TOKEN_REFUSALS_BEFORE_FAILING = 2

export const TOKEN_KEY_PREFIX = 'leitbild:people:'
export const PREFERRED_NAME_KEY = 'leitbild:people-name'
export const OUTBOX_KEY_PREFIX = 'leitbild:people-outbox:'
export const JOIN_LOCK_PREFIX = 'leitbild:people-join:'

// ---------------------------------------------------------------------------
// Ports

export interface PeopleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export type PeopleTimerHandle = unknown
export interface PeopleTimers {
  set(callback: () => void, ms: number): PeopleTimerHandle
  clear(handle: PeopleTimerHandle): void
}
/** Web Locks' `navigator.locks.request`, or null where the browser has none. */
export type PeopleLock = <T>(name: string, task: () => Promise<T>) => Promise<T>
export type PeopleEnvironmentEvent =
  | { readonly type: 'visibility' }
  | { readonly type: 'online' }
  | { readonly type: 'pagehide' }
  | { readonly type: 'pageshow'; readonly persisted: boolean }
  | { readonly type: 'resume' }
  | { readonly type: 'storage'; readonly key: string | null; readonly newValue: string | null }

export interface PeoplePorts {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>
  /** May throw (blocked site data); the session then keeps a page-only identity. */
  readonly localStorage: () => PeopleStorage
  readonly sessionStorage: () => PeopleStorage
  readonly timers: PeopleTimers
  readonly lock: PeopleLock | null
  readonly visible: () => boolean
  readonly listen: (handler: (event: PeopleEnvironmentEvent) => void) => () => void
  readonly randomId: () => string
  /** [0, 1), for backoff jitter. */
  readonly random: () => number
  readonly now: () => number
  /** The console: diagnostics only, never the user's text. */
  readonly warn: (message: string, cause?: unknown) => void
}

// ---------------------------------------------------------------------------
// Failures

export type PeopleTransport = 'network' | 'non-json' | 'http' | 'contract' | 'aborted'

export interface PeopleRequestError extends Error {
  readonly transport: PeopleTransport
  readonly status: number | null
  readonly code: string | null
  readonly retryable: boolean
  readonly details: Readonly<Record<string, unknown>> | null
}

export const peopleRequestError = (
  transport: PeopleTransport,
  fields: { readonly status?: number | null; readonly code?: string | null; readonly message?: string; readonly retryable?: boolean; readonly details?: Readonly<Record<string, unknown>> | null } = {},
): PeopleRequestError => Object.assign(new Error(fields.message ?? `People request failed (${transport})`), {
  transport,
  status: fields.status ?? null,
  code: fields.code ?? null,
  retryable: fields.retryable ?? false,
  details: fields.details ?? null,
})

const isPeopleRequestError = (error: unknown): error is PeopleRequestError =>
  error instanceof Error && typeof (error as Partial<PeopleRequestError>).transport === 'string'

export type PeopleFailure =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'transient'; readonly code: string | null; readonly retryAfterMs: number | null }
  | { readonly kind: 'token-invalid' }
  | { readonly kind: 'permanent'; readonly code: string | null; readonly status: number | null; readonly details: Readonly<Record<string, unknown>> | null }

/** Gateway answers while a Module restarts (Caddy or the Host). Any error marked `retryable` is transient too (e.g. 507 storage_budget_exceeded). */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  PEOPLE_ERROR.moduleUnavailable, PEOPLE_ERROR.moduleOutcomeUnknown, PEOPLE_ERROR.moduleNotReady, PEOPLE_ERROR.workspaceClosing, PEOPLE_ERROR.rateLimited,
  PEOPLE_ERROR.peopleUnavailable,
])
const HTTP_TOO_MANY_REQUESTS = 429

export const classifyPeopleFailure = (error: unknown): PeopleFailure => {
  if (!isPeopleRequestError(error)) return { kind: 'permanent', code: null, status: null, details: null }
  if (error.transport === 'aborted') return { kind: 'aborted' }
  if (error.transport === 'network' || error.transport === 'non-json') return { kind: 'transient', code: null, retryAfterMs: null }
  if (error.transport === 'contract') return { kind: 'permanent', code: 'people_contract_invalid', status: error.status, details: null }
  if (error.code === PEOPLE_ERROR.tokenInvalid) return { kind: 'token-invalid' }
  const retryAfter = error.details?.retryAfterMs
  const retryAfterMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
  if (error.status === HTTP_TOO_MANY_REQUESTS || (error.status !== null && TRANSIENT_STATUSES.has(error.status))
    || (error.code !== null && TRANSIENT_CODES.has(error.code)) || error.retryable) {
    return { kind: 'transient', code: error.code, retryAfterMs }
  }
  return { kind: 'permanent', code: error.code, status: error.status, details: error.details }
}

/** The wait before attempt `attempt + 1`; `random` is in [0, 1). A server's retry-after is a floor. */
export const backoffDelay = (attempt: number, random: number, retryAfterMs: number | null): number => {
  const base = BACKOFF_STEPS_MS[Math.min(Math.max(0, attempt), BACKOFF_STEPS_MS.length - 1)]!
  const jittered = Math.round(base * (1 + (random * 2 - 1) * BACKOFF_JITTER))
  return Math.max(jittered, retryAfterMs ?? 0)
}

// ---------------------------------------------------------------------------
// State

export type ConnectionNotice = 'none' | 'reconnecting' | 'unreachable'

export interface PersonView {
  readonly id: string
  readonly name: string
  /** In this Run now. */
  readonly here: boolean
  readonly unread: number
}

export interface ChatView {
  readonly with: PersonView
  /** false while the first snapshot of a newly opened Run is on its way. */
  readonly hereKnown: boolean
  readonly loading: boolean
  readonly loadFailed: boolean
  readonly items: ReadonlyArray<ChatItem>
  /** The first message that was unread when the chat opened ("New" divider). */
  readonly firstUnreadKey: string | null
  /** The conversation is at Agents' 200-message cap, so older ones were dropped. */
  readonly capped: boolean
}

export type ToastView =
  | { readonly kind: 'message'; readonly id: number; readonly from: PersonWire; readonly text: string; readonly count: number }
  | { readonly kind: 'notice'; readonly id: number; readonly text: string }

export interface Announcement { readonly id: number; readonly text: string }

export interface PeopleState {
  /** A Run is being viewed, so presence is live. */
  readonly active: boolean
  readonly status: 'starting' | 'ready' | 'failed'
  readonly failure: string | null
  readonly notice: ConnectionNotice
  /** 'page': site storage is blocked, so this identity ends with the page. */
  readonly storage: 'browser' | 'page'
  readonly me: PersonWire | null
  /** The remembered name that was taken here when this browser joined. */
  readonly preferredNameTaken: string | null
  /** false until the first snapshot of the current Run arrives (no "Just you" flash). */
  readonly presentKnown: boolean
  /** Others in this Run, in arrival order. */
  readonly present: ReadonlyArray<PersonView>
  /** Conversations with people not in this Run, newest first. */
  readonly earlier: ReadonlyArray<PersonView>
  readonly unreadTotal: number
  readonly chat: ChatView | null
  readonly toast: ToastView | null
  readonly announcement: Announcement | null
}

export type RenameOutcome = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly error: string }

export interface PeopleSession {
  state(): PeopleState
  subscribe(listener: (state: PeopleState) => void): () => void
  /** The Run on screen, or null when the page leaves the Run view. */
  setViewing(viewing: ViewingReference | null): void
  openChat(person: PersonWire): void
  closeChat(): void
  retryChatLoad(): void
  /** Queues a message to the open chat; false when there is nothing sendable. */
  send(raw: string): boolean
  retrySend(key: string): void
  removeSend(key: string): void
  rename(raw: string): Promise<RenameOutcome>
  setPopoverOpen(open: boolean): void
  dismissToast(): void
  /** A system toast, e.g. a name that was not saved after the popover closed. */
  showNotice(text: string): void
  /** "Try now" / "Try again": ask at once, from the first backoff step. */
  tryNow(): void
  dispose(): void
}

interface OutboxEntry {
  readonly key: string
  readonly to: string
  readonly text: string
  readonly createdAt: number
  readonly deadline: number
  readonly stage: 'quiet' | 'sending' | 'failed'
  readonly reason: string | null
  /** Sent to Agents at least once, so it may be stored there although no answer came back. */
  readonly attempted: boolean
}

/** What survives a reload in sessionStorage: the message, its key, and whether it already failed. */
const storedOutboxSchema = z.array(z.object({
  key: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number(),
  failed: z.boolean(),
  reason: z.string().nullable(),
}))

type InternalToast =
  | { readonly kind: 'message'; readonly id: number; readonly fromId: string; readonly text: string; readonly count: number }
  | { readonly kind: 'notice'; readonly id: number; readonly text: string }

interface ChatNote { readonly key: string; readonly text: string; readonly at: number; readonly afterSeq: number }

export const viewingKey = (viewing: ViewingReference): string =>
  `${viewing.workspaceId}/${viewing.moduleId}/${viewing.type}/${viewing.id}`

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

// ---------------------------------------------------------------------------

export const createPeopleSession = (options: { readonly workspaceId: string; readonly ports: PeoplePorts }): PeopleSession => {
  const { workspaceId, ports } = options
  const tokenKey = `${TOKEN_KEY_PREFIX}${workspaceId}`
  const outboxKey = `${OUTBOX_KEY_PREFIX}${workspaceId}`
  /** One per page instance: a tab is a screen; never stored. */
  const screenId = ports.randomId()

  // --- storage --------------------------------------------------------------
  let storageBlocked = false
  const blockStorage = (cause: unknown): void => {
    if (storageBlocked) return
    storageBlocked = true
    ports.warn('People: site storage is blocked, so this page keeps its own identity', cause)
  }
  const open = (factory: () => PeopleStorage): PeopleStorage | null => {
    try { return factory() } catch (cause) { blockStorage(cause); return null }
  }
  let local = open(ports.localStorage)
  let session = open(ports.sessionStorage)
  const read = (store: 'local' | 'session', key: string): string | null => {
    const target = store === 'local' ? local : session
    if (target === null) return null
    try { return target.getItem(key) } catch (cause) {
      blockStorage(cause)
      if (store === 'local') local = null
      else session = null
      return null
    }
  }
  const write = (store: 'local' | 'session', key: string, value: string | null): void => {
    const target = store === 'local' ? local : session
    if (target === null) return
    try {
      if (value === null) target.removeItem(key)
      else target.setItem(key, value)
    } catch (cause) {
      blockStorage(cause)
      if (store === 'local') local = null
      else session = null
    }
  }

  // --- model ----------------------------------------------------------------
  let disposed = false
  let suspended = false
  let viewing: ViewingReference | null = null
  let currentViewingKey: string | null = null
  let token: string | null = read('local', tokenKey) || null
  let joining: Promise<string> | null = null
  let me: PersonWire | null = null
  let preferredNameTaken: string | null = null
  let status: PeopleState['status'] = 'starting'
  let failure: string | null = null
  let storeId: string | null = null
  let cursor: number | null = null
  let view: string | null = null
  /** Messages before the first complete answer are history, never toasts. */
  let catchingUp = true
  let presentKnown = false
  let presentOrder: ReadonlyArray<PersonWire> = []
  let conversations: ReadonlyArray<ConversationSummaryWire> = []
  const names = new Map<string, PersonWire>()
  const messagesByPeer = new Map<string, ReadonlyArray<MessageWire>>()
  /** My read marker per peer, as last confirmed. */
  const readThrough = new Map<string, number>()
  /** Server message id → the client key it was sent with, so a delivered bubble keeps its node. */
  const deliveredKeys = new Map<string, string>()
  let popoverOpen = false
  let toast: InternalToast | null = null
  let toastSerial = 0
  let announcement: Announcement | null = null
  let announcementSerial = 0

  // chat
  let chatPeer: string | null = null
  let chatController: AbortController | null = null
  let chatLoading = false
  let chatLoadFailed = false
  let chatFirstUnread: string | null = null
  let chatCapped = false
  let chatNotes: ReadonlyArray<ChatNote> = []
  let markingRead = false
  let markAgain = false

  // sync loop
  let generation = 0
  let syncController: AbortController | null = null
  let retryTimer: PeopleTimerHandle | null = null
  let backoffAttempt = 0
  let tokenRefusals = 0
  let troubleSince: number | null = null
  let notice: ConnectionNotice = 'none'
  let noticeTimers: ReadonlyArray<PeopleTimerHandle> = []

  // outbox
  let outbox: ReadonlyArray<OutboxEntry> = []
  let sendingKey: string | null = null
  let sendController: AbortController | null = null
  let sendRetryTimer: PeopleTimerHandle | null = null
  let sendAttempt = 0
  let outboxTimer: PeopleTimerHandle | null = null

  const listeners = new Set<(state: PeopleState) => void>()

  // --- derived state --------------------------------------------------------
  const nameOf = (id: string): PersonWire => names.get(id) ?? { id, name: id }
  const summaryFor = (id: string): ConversationSummaryWire | undefined => conversations.find(summary => summary.with.id === id)
  const peerOf = (message: MessageWire): string => message.from === me?.id ? message.to : message.from
  const messageKey = (message: MessageWire): string => deliveredKeys.get(message.id) ?? message.id

  const chatItems = (peer: string): ReadonlyArray<ChatItem> => {
    const items: ChatItem[] = []
    const notes = [...chatNotes].sort((left, right) => left.afterSeq - right.afterSeq)
    let next = 0
    for (const message of messagesByPeer.get(peer) ?? []) {
      while (next < notes.length && notes[next]!.afterSeq < message.seq) {
        const note = notes[next++]!
        items.push({ kind: 'note', key: note.key, text: note.text, at: note.at })
      }
      items.push({ kind: 'message', key: messageKey(message), seq: message.seq, mine: message.from === me?.id, text: message.text, at: Date.parse(message.sentAt) })
    }
    for (const note of notes.slice(next)) items.push({ kind: 'note', key: note.key, text: note.text, at: note.at })
    for (const entry of outbox) {
      if (entry.to === peer) items.push({ kind: 'outgoing', key: entry.key, text: entry.text, at: entry.createdAt, stage: entry.stage, reason: entry.reason })
    }
    return items
  }

  const snapshot = (): PeopleState => {
    const visible = ports.visible()
    // The open, visible chat is being read: its count is about to be cleared.
    const unreadFor = (id: string): number => chatPeer === id && visible ? 0 : summaryFor(id)?.unread ?? 0
    const presentIds = new Set(presentOrder.map(person => person.id))
    const person = (id: string, here: boolean): PersonView => ({ ...nameOf(id), here, unread: unreadFor(id) })
    const chat: ChatView | null = chatPeer === null ? null : {
      with: person(chatPeer, presentIds.has(chatPeer)),
      hereKnown: presentKnown,
      loading: chatLoading,
      loadFailed: chatLoadFailed,
      items: chatItems(chatPeer),
      firstUnreadKey: chatFirstUnread,
      capped: chatCapped,
    }
    return {
      active: viewing !== null,
      status,
      failure,
      notice,
      storage: storageBlocked ? 'page' : 'browser',
      me,
      preferredNameTaken,
      presentKnown,
      present: presentOrder.map(entry => person(entry.id, true)),
      earlier: conversations.filter(summary => !presentIds.has(summary.with.id)).map(summary => person(summary.with.id, false)),
      unreadTotal: conversations.reduce((total, summary) => total + unreadFor(summary.with.id), 0),
      chat,
      toast: toast === null ? null : toast.kind === 'notice' ? toast : { kind: 'message', id: toast.id, from: nameOf(toast.fromId), text: toast.text, count: toast.count },
      announcement,
    }
  }
  let current = snapshot()
  const emit = (): void => {
    if (disposed) return
    current = snapshot()
    for (const listener of listeners) listener(current)
  }
  const announce = (text: string): void => { announcement = { id: ++announcementSerial, text } }

  // --- requests -------------------------------------------------------------
  const invoke = async <T>(
    capabilityId: string, input: unknown, schema: z.ZodType<T>,
    options: { readonly signal?: AbortSignal; readonly idempotencyKey?: string } = {},
  ): Promise<T> => {
    let response: Response
    try {
      response = await ports.fetch(invokePath(workspaceId, capabilityId), {
        method: 'POST', headers: JSON_HEADERS, body: invokeBody(input, options.idempotencyKey),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      if (options.signal?.aborted) throw peopleRequestError('aborted')
      throw peopleRequestError('network', { message: cause instanceof Error ? cause.message : String(cause) })
    }
    let body: unknown
    try { body = await response.json() } catch {
      if (options.signal?.aborted) throw peopleRequestError('aborted')
      // An HTML error page from the proxy while a service restarts.
      throw peopleRequestError('non-json', { status: response.status })
    }
    if (!response.ok) {
      const parsed = errorEnvelopeSchema.safeParse(body)
      const error = parsed.success ? parsed.data.error : {}
      throw peopleRequestError('http', {
        status: response.status,
        code: error.code ?? null,
        message: error.message ?? `HTTP ${response.status}`,
        retryable: error.retryable === true,
        details: error.details ?? null,
      })
    }
    const envelope = invocationEnvelopeSchema.safeParse(body)
    const result = envelope.success ? schema.safeParse(envelope.data.result) : null
    if (result === null || !result.success) {
      throw peopleRequestError('contract', { status: response.status, message: `${capabilityId} answered outside its contract` })
    }
    return result.data
  }

  const leave = (keepalive: boolean): void => {
    if (token === null) return
    // Best effort by design: a screen that never says goodbye expires after 30 s on the server.
    void ports.fetch(invokePath(workspaceId, PEOPLE_CAPABILITY.leave), {
      method: 'POST', headers: JSON_HEADERS, body: invokeBody({ token, screen: screenId }), ...(keepalive ? { keepalive: true } : {}),
    }).then(response => { if (!response.ok) ports.warn(`People: leave answered HTTP ${response.status}`) },
      cause => ports.warn('People: leave did not reach Leitbild; the screen expires on its own', cause))
  }

  // --- identity -------------------------------------------------------------
  const forgetIdentityData = (): void => {
    cursor = null
    view = null
    catchingUp = true
    conversations = []
    messagesByPeer.clear()
    readThrough.clear()
    deliveredKeys.clear()
    chatFirstUnread = null
  }

  const ensureToken = (): Promise<string> => {
    if (token !== null) return Promise.resolve(token)
    if (joining !== null) return joining
    const task = async (): Promise<string> => {
      // A sibling tab may have joined while this one waited for the lock.
      const stored = read('local', tokenKey)
      if (stored) return stored
      const remembered = read('local', PREFERRED_NAME_KEY)
      const preferredName = remembered !== null && nameProblem(normaliseName(remembered)) === null ? normaliseName(remembered) : null
      const result = await invoke(PEOPLE_CAPABILITY.join, preferredName === null ? {} : { preferredName }, joinResultSchema)
      write('local', tokenKey, result.token)
      me = result.me
      preferredNameTaken = preferredName !== null && !result.preferredNameAccepted ? preferredName : null
      return result.token
    }
    // Without Web Locks (an insecure context) two tabs opened together may each
    // join; the `storage` event then moves both to the token written last.
    const joined = ports.lock !== null && local !== null ? ports.lock(`${JOIN_LOCK_PREFIX}${workspaceId}`, task) : task()
    joining = joined.then(fresh => {
      if (token === null) token = fresh
      return token
    }).finally(() => { joining = null })
    return joining
  }

  /**
   * Agents refused `refused`, the token a request was sent with. When this page
   * has moved on since (to a sibling tab's token, adopted from the storage
   * event) nothing changes. Otherwise a newer stored token is adopted, or the
   * token is forgotten so the next call joins again. Returns whether the
   * identity changed, so the caller restarts.
   */
  const dropToken = (refused: string): boolean => {
    if (token !== null && token !== refused) return false
    const stored = read('local', tokenKey)
    if (stored && stored !== refused) token = stored
    else {
      token = null
      if (stored) write('local', tokenKey, null)
    }
    forgetIdentityData()
    return true
  }

  // --- presence and messages ------------------------------------------------
  const remember = (person: PersonWire): void => {
    const previous = names.get(person.id)
    if (previous !== undefined && previous.name !== person.name && person.id === chatPeer) {
      const afterSeq = (messagesByPeer.get(person.id) ?? []).at(-1)?.seq ?? 0
      chatNotes = [...chatNotes, { key: `note:${ports.randomId()}`, text: `${previous.name} is now called ${person.name}`, at: ports.now(), afterSeq }]
    }
    names.set(person.id, person)
  }

  /**
   * My own message can arrive (through sync or a conversation read) before its
   * send is acknowledged, or after the send gave up waiting although Agents
   * stored it. It is then the oldest outbox entry already sent to the same
   * person with the same text: that entry is delivered, never shown twice.
   * Only an entry that was sent can match, so a sibling tab's identical message
   * never swallows one that was not sent yet.
   */
  const claimOutbox = (message: MessageWire): void => {
    if (me === null || message.from !== me.id || deliveredKeys.has(message.id)) return
    const entry = outbox.find(candidate => candidate.attempted && candidate.to === message.to && candidate.text === message.text)
    if (entry === undefined) return
    deliveredKeys.set(message.id, entry.key)
    outbox = outbox.filter(candidate => candidate.key !== entry.key)
    persistOutbox()
    if (sendingKey === entry.key) {
      sendController?.abort()
      finishSend()
    }
  }

  /** Adds messages by seq, ignoring ones already known; returns the new ones. */
  const addMessages = (incoming: ReadonlyArray<MessageWire>, knownPeer?: string): ReadonlyArray<MessageWire> => {
    const fresh: MessageWire[] = []
    for (const message of incoming) {
      const peer = knownPeer ?? peerOf(message)
      const list = messagesByPeer.get(peer) ?? []
      if (list.some(known => known.id === message.id)) continue
      claimOutbox(message)
      fresh.push(message)
      messagesByPeer.set(peer, [...list, message].sort((left, right) => left.seq - right.seq).slice(-HISTORY_CAP))
    }
    return fresh
  }

  const mergePresent = (incoming: ReadonlyArray<PersonWire>, warming: boolean): void => {
    const byId = new Map(incoming.map(person => [person.id, person]))
    // While the server is warming up after a restart it has not heard from
    // every screen yet: keep the last known list rather than show people leaving.
    const kept = presentOrder.flatMap(person => {
      const next = byId.get(person.id)
      return next !== undefined ? [next] : warming ? [nameOf(person.id)] : []
    })
    const keptIds = new Set(kept.map(person => person.id))
    // Arrivals go to the end; a rename never reorders the list.
    presentOrder = [...kept, ...incoming.filter(person => !keptIds.has(person.id))]
  }

  const toastFor = (fresh: ReadonlyArray<MessageWire>): void => {
    const visible = ports.visible()
    const incoming = fresh.filter(message => message.from !== me?.id && !(message.from === chatPeer && visible))
    // Hidden tabs get only the title count; an open popover updates its rows instead.
    if (incoming.length === 0 || !visible || popoverOpen) return
    const last = incoming[incoming.length - 1]!
    const count = incoming.filter(message => message.from === last.from).length
    const previous = toast?.kind === 'message' && toast.fromId === last.from ? toast.count : 0
    toast = { kind: 'message', id: ++toastSerial, fromId: last.from, text: last.text, count: previous + count }
    announce(`New message from ${nameOf(last.from).name}`)
  }

  /**
   * Applies one answer; true when the next sync should ask at once rather than
   * hold. A first answer (no `after`) carries no messages, only the newest
   * cursor: history is read per conversation when a chat opens.
   */
  const applySync = (result: SyncResultWire, sentStoreId: string | null): boolean => {
    if (sentStoreId !== null && result.storeId !== sentStoreId) {
      // Agents' people store was replaced: what this page knew no longer
      // applies. The answer itself is a fresh start (no messages, the newest
      // cursor), so it is applied as the first answer would be.
      forgetIdentityData()
      if (chatPeer !== null) loadChat()
    }
    storeId = result.storeId
    me = result.me
    for (const person of result.present) remember(person)
    for (const summary of result.conversations) remember(summary.with)
    mergePresent(result.present, result.presenceWarming)
    presentKnown = true
    conversations = result.conversations
    const fresh = addMessages(result.messages)
    if (!catchingUp) toastFor(fresh)
    if (!result.more) catchingUp = false
    cursor = result.cursor
    view = result.view
    status = 'ready'
    failure = null
    return result.more
  }

  const maybeMarkRead = (): void => {
    const peer = chatPeer
    if (peer === null || token === null || chatLoading || !ports.visible()) return
    const summary = summaryFor(peer)
    const messages = messagesByPeer.get(peer) ?? []
    const marked = readThrough.get(peer) ?? 0
    const lastIncoming = messages.filter(message => message.from === peer).at(-1)?.seq ?? 0
    const through = Math.max(summary?.lastSeq ?? 0, messages.at(-1)?.seq ?? 0)
    if (!((summary?.unread ?? 0) > 0 || lastIncoming > marked) || through === 0) return
    if (markingRead) { markAgain = true; return }
    markingRead = true
    const usedToken = token
    void invoke(PEOPLE_CAPABILITY.markRead, { token: usedToken, with: peer, through }, markReadResultSchema).then(result => {
      readThrough.set(peer, Math.max(readThrough.get(peer) ?? 0, through))
      conversations = conversations.map(entry => entry.with.id === peer ? { ...entry, unread: result.unread } : entry)
      emit()
    }, error => {
      const failed = classifyPeopleFailure(error)
      if (failed.kind === 'token-invalid') { if (dropToken(usedToken)) restart(); return }
      // The next sync answer tries again; the count stays visible meanwhile.
      if (failed.kind !== 'aborted') ports.warn('People: marking the chat read failed', error)
    }).finally(() => {
      markingRead = false
      if (markAgain) { markAgain = false; maybeMarkRead() }
    })
  }

  // --- sync loop ------------------------------------------------------------
  const clearNoticeTimers = (): void => {
    for (const handle of noticeTimers) ports.timers.clear(handle)
    noticeTimers = []
  }

  const troubled = (): void => {
    if (troubleSince !== null) return
    troubleSince = ports.now()
    noticeTimers = [
      ports.timers.set(() => { notice = 'reconnecting'; announce('Reconnecting…'); emit() }, RECONNECT_NOTICE_DELAY_MS),
      ports.timers.set(() => { notice = 'unreachable'; emit() }, RECONNECT_ESCALATE_MS),
    ]
    scheduleOutboxTimer()
  }

  const recovered = (): void => {
    backoffAttempt = 0
    tokenRefusals = 0
    if (troubleSince === null) return
    clearNoticeTimers()
    if (notice !== 'none') announce('Connected again.')
    troubleSince = null
    notice = 'none'
    // Queued messages get a full send window now that the connection is back.
    const now = ports.now()
    outbox = outbox.map(entry => entry.stage === 'failed' ? entry : { ...entry, deadline: now + SEND_TIMEOUT_MS })
    if (sendRetryTimer !== null) { ports.timers.clear(sendRetryTimer); sendRetryTimer = null }
    sendAttempt = 0
  }

  const stopLoop = (): void => {
    generation += 1
    syncController?.abort()
    syncController = null
    if (retryTimer !== null) { ports.timers.clear(retryTimer); retryTimer = null }
  }

  const restart = (): void => {
    stopLoop()
    if (viewing === null || suspended || disposed || status === 'failed') return
    void cycle(generation, false)
  }

  const fail = (code: string | null, cause: unknown): void => {
    status = 'failed'
    failure = PEOPLE_FAILED_TEXT
    clearNoticeTimers()
    troubleSince = null
    notice = 'none'
    ports.warn(`People stopped: ${code ?? 'unknown error'}`, cause)
  }

  const cycle = async (cycleGeneration: number, hold: boolean): Promise<void> => {
    const controller = new AbortController()
    syncController = controller
    let usedToken: string | null = null
    try {
      const currentToken = await ensureToken()
      usedToken = currentToken
      if (cycleGeneration !== generation || viewing === null) return
      const sentStoreId = storeId
      const input: SyncInput = {
        token: currentToken,
        screen: screenId,
        viewing,
        ...(cursor === null ? {} : { after: cursor }),
        ...(view === null ? {} : { view }),
        ...(storeId === null ? {} : { storeId }),
        waitMs: hold ? SYNC_HOLD_MS : 0,
      }
      const result = await invoke(PEOPLE_CAPABILITY.sync, input, syncResultSchema, { signal: controller.signal })
      if (cycleGeneration !== generation) return // A newer sync owns the state.
      syncController = null
      const again = applySync(result, sentStoreId)
      recovered()
      if (chatPeer !== null && chatLoadFailed) loadChat()
      maybeMarkRead()
      pump()
      scheduleOutboxTimer()
      emit()
      if (cycleGeneration === generation) void cycle(cycleGeneration, !again)
    } catch (error) {
      if (cycleGeneration !== generation) return
      syncController = null
      const failed = classifyPeopleFailure(error)
      if (failed.kind === 'aborted') return
      if (failed.kind === 'token-invalid') {
        // Already on a newer token: just ask again with it.
        if (usedToken === null || (token !== null && token !== usedToken)) { void cycle(cycleGeneration, false); return }
        tokenRefusals += 1
        if (tokenRefusals >= TOKEN_REFUSALS_BEFORE_FAILING) fail(PEOPLE_ERROR.tokenInvalid, error)
        else { dropToken(usedToken); void cycle(cycleGeneration, false) }
        emit()
        return
      }
      if (failed.kind === 'permanent') { fail(failed.code, error); emit(); return }
      troubled()
      retryTimer = ports.timers.set(() => {
        retryTimer = null
        if (cycleGeneration === generation) void cycle(cycleGeneration, false)
      }, backoffDelay(backoffAttempt++, ports.random(), failed.retryAfterMs))
      emit()
    }
  }

  // --- chat -----------------------------------------------------------------
  const loadChat = (): void => {
    const peer = chatPeer
    if (peer === null) return
    chatController?.abort()
    const controller = new AbortController()
    chatController = controller
    chatLoading = true
    chatLoadFailed = false
    let usedToken: string | null = null
    void ensureToken()
      .then(currentToken => {
        usedToken = currentToken
        return invoke(PEOPLE_CAPABILITY.conversationRead, { token: currentToken, with: peer }, conversationReadResultSchema, { signal: controller.signal })
      })
      .then(result => {
        if (chatController !== controller) return
        chatController = null
        chatLoading = false
        remember(result.with)
        for (const message of result.messages) claimOutbox(message)
        const newer = (messagesByPeer.get(peer) ?? []).filter(message => message.seq > (result.messages.at(-1)?.seq ?? 0))
        messagesByPeer.set(peer, [...result.messages, ...newer].slice(-HISTORY_CAP))
        readThrough.set(peer, Math.max(readThrough.get(peer) ?? 0, result.readThrough.me))
        const firstUnread = result.messages.find(message => message.from === peer && message.seq > result.readThrough.me)
        chatFirstUnread = firstUnread === undefined ? null : messageKey(firstUnread)
        chatCapped = result.messages.length >= HISTORY_CAP
        maybeMarkRead()
        pump()
        emit()
      }, error => {
        if (chatController !== controller) return
        chatController = null
        chatLoading = false
        const failed = classifyPeopleFailure(error)
        if (failed.kind === 'aborted') return
        if (failed.kind === 'token-invalid') {
          // Already on a newer token: read again with it.
          if (usedToken !== null && !dropToken(usedToken)) { loadChat(); return }
          restart()
        }
        chatLoadFailed = true
        ports.warn('People: the conversation did not load', error)
        emit()
      })
    emit()
  }

  // --- outbox ---------------------------------------------------------------
  const persistOutbox = (): void => {
    write('session', outboxKey, outbox.length === 0 ? null : JSON.stringify(outbox.map(entry => ({
      key: entry.key, to: entry.to, text: entry.text, createdAt: entry.createdAt, failed: entry.stage === 'failed', reason: entry.reason,
    }))))
  }

  const restoreOutbox = (): void => {
    const raw = read('session', outboxKey)
    if (raw === null) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    const entries = storedOutboxSchema.safeParse(parsed)
    if (!entries.success) {
      ports.warn('People: discarded an unreadable outbox')
      write('session', outboxKey, null)
      return
    }
    const now = ports.now()
    outbox = entries.data.map(entry => ({
      key: entry.key, to: entry.to, text: entry.text, createdAt: entry.createdAt, deadline: now + SEND_TIMEOUT_MS,
      stage: entry.failed ? 'failed' : 'sending', reason: entry.failed ? entry.reason ?? SEND_REASON.failed : null,
      // It may have been sent before the reload.
      attempted: true,
    }))
  }

  const finishSend = (): void => {
    sendingKey = null
    sendController = null
  }

  const markFailed = (key: string, reason: string): void => {
    outbox = outbox.map(entry => entry.key === key ? { ...entry, stage: 'failed', reason } : entry)
    if (sendingKey === key) { sendController?.abort(); finishSend() }
  }

  const sendReason = (failed: PeopleFailure): string => {
    if (failed.kind !== 'permanent') return SEND_REASON.unreachable
    if (failed.code === PEOPLE_ERROR.messageTooLong) return SEND_REASON.tooLong
    if (failed.code === PEOPLE_ERROR.messageInvalidCharacters) return SEND_REASON.invalidCharacters
    if (failed.code === PEOPLE_ERROR.messageEmpty) return SEND_REASON.empty
    if (failed.code === PEOPLE_ERROR.personNotFound) return SEND_REASON.personGone
    return SEND_REASON.failed
  }

  /** Delivers the oldest unsent message; one at a time keeps them in order. */
  const pump = (): void => {
    if (sendingKey !== null || sendRetryTimer !== null || suspended || disposed || token === null) return
    const next = outbox.find(entry => entry.stage !== 'failed')
    if (next === undefined) return
    const controller = new AbortController()
    sendingKey = next.key
    sendController = controller
    if (!next.attempted) outbox = outbox.map(entry => entry.key === next.key ? { ...entry, attempted: true } : entry)
    const usedToken = token
    void invoke(PEOPLE_CAPABILITY.send, { token: usedToken, to: next.to, text: next.text }, sendResultSchema, { signal: controller.signal, idempotencyKey: next.key })
      .then(result => {
        if (sendController !== controller) return
        finishSend()
        sendAttempt = 0
        outbox = outbox.filter(entry => entry.key !== next.key)
        persistOutbox()
        deliveredKeys.set(result.message.id, next.key)
        addMessages([result.message], next.to)
        // Sending counts as reading the conversation up to the message.
        readThrough.set(next.to, Math.max(readThrough.get(next.to) ?? 0, result.message.seq))
        scheduleOutboxTimer()
        emit()
        pump()
      }, error => {
        if (sendController !== controller) return
        finishSend()
        const failed = classifyPeopleFailure(error)
        if (failed.kind === 'aborted') return
        if (failed.kind === 'token-invalid') {
          // Already on a newer token, the message is sent again with it; else join first.
          if (dropToken(usedToken)) restart()
          else pump()
          emit()
          return
        }
        if (failed.kind === 'transient') {
          sendRetryTimer = ports.timers.set(() => { sendRetryTimer = null; pump() }, backoffDelay(sendAttempt++, ports.random(), failed.retryAfterMs))
          emit()
          return
        }
        ports.warn('People: a message was refused', error)
        markFailed(next.key, sendReason(failed))
        persistOutbox()
        emit()
        pump()
      })
  }

  const scheduleOutboxTimer = (): void => {
    if (outboxTimer !== null) { ports.timers.clear(outboxTimer); outboxTimer = null }
    const due = outbox.flatMap(entry => [
      ...(entry.stage === 'quiet' ? [entry.createdAt + SENDING_LABEL_DELAY_MS] : []),
      // While the whole connection is down, messages wait for it rather than fail.
      ...(entry.stage !== 'failed' && troubleSince === null ? [entry.deadline] : []),
    ])
    if (due.length === 0 || disposed) return
    outboxTimer = ports.timers.set(onOutboxTimer, Math.max(0, Math.min(...due) - ports.now()))
  }

  const onOutboxTimer = (): void => {
    outboxTimer = null
    const now = ports.now()
    let failedAny = false
    for (const entry of outbox) {
      if (entry.stage === 'quiet' && now >= entry.createdAt + SENDING_LABEL_DELAY_MS) {
        outbox = outbox.map(item => item.key === entry.key ? { ...item, stage: 'sending' } : item)
      }
      if (entry.stage !== 'failed' && troubleSince === null && now >= entry.deadline) {
        markFailed(entry.key, SEND_REASON.unreachable)
        failedAny = true
      }
    }
    if (failedAny) {
      persistOutbox()
      if (sendRetryTimer !== null) { ports.timers.clear(sendRetryTimer); sendRetryTimer = null }
    }
    scheduleOutboxTimer()
    emit()
    pump()
  }

  // --- environment ----------------------------------------------------------
  const onEnvironment = (event: PeopleEnvironmentEvent): void => {
    if (disposed) return
    switch (event.type) {
      case 'visibility':
        if (ports.visible()) {
          maybeMarkRead()
          if (retryTimer !== null) { backoffAttempt = 0; restart() }
        }
        emit()
        return
      case 'online':
        backoffAttempt = 0
        sendAttempt = 0
        restart()
        if (sendRetryTimer !== null) { ports.timers.clear(sendRetryTimer); sendRetryTimer = null }
        pump()
        return
      case 'pagehide':
        suspended = true
        stopLoop()
        sendController?.abort()
        finishSend()
        if (viewing !== null) leave(true)
        return
      case 'pageshow':
        if (!event.persisted) return
        suspended = false
        restart()
        pump()
        return
      case 'resume':
        suspended = false
        restart()
        pump()
        return
      case 'storage':
        // Only a sibling tab's newer token matters; a removal is that tab
        // rejoining, and its new token follows.
        if (event.key !== tokenKey || !event.newValue || event.newValue === token) return
        token = event.newValue
        forgetIdentityData()
        tokenRefusals = 0
        restart()
        if (chatPeer !== null) loadChat()
        emit()
        return
    }
  }
  const unlisten = ports.listen(onEnvironment)
  restoreOutbox()
  scheduleOutboxTimer()
  current = snapshot()

  // --- API ------------------------------------------------------------------
  return {
    state: () => current,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setViewing: next => {
      const key = next === null ? null : viewingKey(next)
      if (key === currentViewingKey) return
      const hadViewing = viewing !== null
      // Exactly the four reference fields: Agents validates `viewing` strictly.
      viewing = next === null ? null : { workspaceId: next.workspaceId, moduleId: next.moduleId, type: next.type, id: next.id }
      currentViewingKey = key
      presentOrder = []
      presentKnown = false
      if (next === null) {
        stopLoop()
        clearNoticeTimers()
        troubleSince = null
        notice = 'none'
        if (hadViewing) leave(false)
        emit()
        return
      }
      restart()
      pump()
      emit()
    },
    openChat: person => {
      if (chatPeer === person.id) return
      if (!names.has(person.id)) names.set(person.id, person)
      chatController?.abort()
      chatController = null
      chatPeer = person.id
      chatNotes = []
      chatFirstUnread = null
      chatCapped = false
      if (toast?.kind === 'message' && toast.fromId === person.id) toast = null
      loadChat()
    },
    closeChat: () => {
      if (chatPeer === null) return
      chatController?.abort()
      chatController = null
      chatPeer = null
      chatLoading = false
      chatLoadFailed = false
      chatNotes = []
      chatFirstUnread = null
      emit()
    },
    retryChatLoad: () => loadChat(),
    send: raw => {
      if (chatPeer === null || !messageSendable(raw)) return false
      const now = ports.now()
      outbox = [...outbox, { key: ports.randomId(), to: chatPeer, text: messageText(raw), createdAt: now, deadline: now + SEND_TIMEOUT_MS, stage: 'quiet', reason: null, attempted: false }]
      chatFirstUnread = null
      persistOutbox()
      scheduleOutboxTimer()
      emit()
      pump()
      return true
    },
    retrySend: key => {
      const now = ports.now()
      outbox = outbox.map(entry => entry.key === key && entry.stage === 'failed' ? { ...entry, stage: 'sending', reason: null, deadline: now + SEND_TIMEOUT_MS } : entry)
      persistOutbox()
      scheduleOutboxTimer()
      emit()
      pump()
    },
    removeSend: key => {
      outbox = outbox.filter(entry => !(entry.key === key && entry.stage === 'failed'))
      persistOutbox()
      emit()
    },
    rename: async raw => {
      const name = normaliseName(raw)
      if (me !== null && name === me.name) return { ok: true, name }
      const problem = nameProblem(name)
      if (problem !== null) return { ok: false, error: problem }
      if (token === null || notice !== 'none') return { ok: false, error: NAME_TEXT.reconnecting }
      const usedToken = token
      try {
        const result = await invoke(PEOPLE_CAPABILITY.rename, { token: usedToken, name }, renameResultSchema)
        me = result.me
        preferredNameTaken = null
        // The browser proposes this name when it next joins another Workspace.
        write('local', PREFERRED_NAME_KEY, result.me.name)
        announce('Saved.')
        emit()
        return { ok: true, name: result.me.name }
      } catch (error) {
        const failed = classifyPeopleFailure(error)
        if (failed.kind === 'token-invalid') {
          if (dropToken(usedToken)) restart()
          return { ok: false, error: NAME_TEXT.failed }
        }
        if (failed.kind === 'transient') {
          if (failed.code === PEOPLE_ERROR.rateLimited) return { ok: false, error: NAME_TEXT.rateLimited }
          return { ok: false, error: troubleSince !== null ? NAME_TEXT.reconnecting : NAME_TEXT.failed }
        }
        if (failed.kind === 'permanent' && failed.code === PEOPLE_ERROR.nameTaken) return { ok: false, error: NAME_TEXT.taken(name) }
        if (failed.kind === 'permanent' && failed.code === PEOPLE_ERROR.nameInvalid) {
          const reason = failed.details?.reason as NameInvalidReason | undefined
          return { ok: false, error: reason === 'empty' ? NAME_TEXT.empty : reason === 'too_long' ? NAME_TEXT.tooLong : NAME_TEXT.invalidCharacters }
        }
        ports.warn('People: rename failed', error)
        return { ok: false, error: NAME_TEXT.failed }
      }
    },
    setPopoverOpen: next => {
      if (popoverOpen === next) return
      popoverOpen = next
      if (next && toast?.kind === 'message') toast = null
      emit()
    },
    dismissToast: () => {
      if (toast === null) return
      toast = null
      emit()
    },
    showNotice: text => {
      toast = { kind: 'notice', id: ++toastSerial, text }
      announce(text)
      emit()
    },
    tryNow: () => {
      if (status === 'failed') {
        status = me === null ? 'starting' : 'ready'
        failure = null
        tokenRefusals = 0
      }
      backoffAttempt = 0
      sendAttempt = 0
      restart()
      if (sendRetryTimer !== null) { ports.timers.clear(sendRetryTimer); sendRetryTimer = null }
      pump()
      emit()
    },
    dispose: () => {
      if (disposed) return
      if (viewing !== null) leave(true)
      disposed = true
      unlisten()
      stopLoop()
      clearNoticeTimers()
      chatController?.abort()
      sendController?.abort()
      for (const handle of [sendRetryTimer, outboxTimer]) if (handle !== null) ports.timers.clear(handle)
      listeners.clear()
    },
  }
}
