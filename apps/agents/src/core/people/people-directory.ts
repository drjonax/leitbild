// ============================================================================
// PeopleDirectory — the People of one Workspace: identity, presence per Run,
// direct messages and long-polling syncs.
//
// Independent of the Agents Workspace runtime: it never loads Rooms or Agents
// and holds no operation lease while a sync waits. Every mutation validates
// and commits synchronously, then wakes waiting syncs through the directory's
// own waiter set. Presence is in memory only (see presence.ts); People,
// messages and read markers are in the Workspace's people.sqlite.
//
// Errors carry a structured PeopleFailure (status, code, retryable, details)
// so the capability layer maps every refusal to one distinct error code.
// ============================================================================

import type { WorkspaceId } from '@leitbild/contracts'
import {
  DEFAULT_PERSON_NAME_PREFIX,
  allocateDefaultPersonName,
  normalisePersonName,
  personNameKey,
} from './people-names.ts'
import { createPeopleStore, type StoredMessage, type StoredPerson } from './people-store.ts'
import { PRESENCE_TIMEOUT_MS, createPresence, createWaiterSet, type ScreenEntry, type WaiterBudget } from './presence.ts'
import type { PeopleMetrics } from './people-metrics.ts'

// --- Named limits (each sized for one Workspace of people watching a Run) ---

/** Presence expiry is checked this often; an expiry wakes waiting syncs. */
export const PRESENCE_SWEEP_MS = 5_000
/** A sync never holds longer than this; the Host gateway gives a Module 30 s. */
export const MAX_SYNC_WAIT_MS = 20_000
/** Messages one sync returns at most; `more` tells the client to continue at once. */
export const SYNC_MESSAGE_PAGE = 100
/** Owner decision: the last 200 messages of a conversation are kept. */
export const CONVERSATION_KEEP = 200
/** One message is at most this long; a chat line, not a document. */
export const MESSAGE_MAX_CODE_POINTS = 2_000
/**
 * All tabs of one browser are one Person, and each tab holds at most one
 * waiting sync, so this is the number of open tabs that wait side by side;
 * a further one supersedes the oldest.
 */
export const MAX_WAITERS_PER_PERSON = 16
/** Identities per Workspace; anonymous joins must not grow without bound. */
export const PEOPLE_PER_WORKSPACE = 500
/**
 * At the cap, People who never chatted, have no screen open and were away
 * this long are forgotten. One day, not weeks: anonymous joins can fill the
 * cap within minutes, and that must not lock a Workspace's joins for longer.
 */
export const INACTIVE_PERSON_PRUNE_MS = 24 * 60 * 60_000
/** last_active_at is written at most this often per Person, never per heartbeat. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60 * 60_000
/** Storage admission estimate for one Person row and its indexes. */
const PERSON_GROWTH_BYTES = 4 * 1024
/** Storage admission estimate for a new conversation at its retention bound. */
const CONVERSATION_GROWTH_BYTES = CONVERSATION_KEEP * (MESSAGE_MAX_CODE_POINTS * 4 + 512)
/** 256-bit identity token: unguessable, and only its hash is stored. */
const TOKEN_BYTES = 32

interface RateWindow { readonly max: number; readonly windowMs: number }
const SEND_LIMITS: ReadonlyArray<RateWindow> = [{ max: 10, windowMs: 10_000 }, { max: 60, windowMs: 60_000 }]
const JOIN_LIMITS: ReadonlyArray<RateWindow> = [{ max: 60, windowMs: 60_000 }]
const RENAME_LIMITS: ReadonlyArray<RateWindow> = [{ max: 10, windowMs: 60_000 }]
const SYNC_LIMITS: ReadonlyArray<RateWindow> = [{ max: 30, windowMs: 10_000 }]

// --- Wire shapes (validated again by the capability layer's output schemas) ---

export interface Person { readonly id: string; readonly name: string }
export interface Message {
  readonly seq: number
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  readonly sentAt: string
}
export interface ConversationEntry {
  readonly with: Person
  readonly here: boolean
  readonly lastSeq: number
  readonly lastSentAt: string
  readonly unread: number
}
export interface SyncResult {
  readonly storeId: string
  readonly serverNow: string
  readonly presenceWarming: boolean
  readonly me: Person
  readonly present: ReadonlyArray<Person>
  readonly conversations: ReadonlyArray<ConversationEntry>
  readonly messages: ReadonlyArray<Message>
  readonly cursor: number
  readonly more: boolean
  readonly view: string
}

export interface SyncInput {
  readonly token: string
  readonly screen: string
  /** Opaque key of the Run being viewed; the directory never interprets it. */
  readonly viewingKey: string
  readonly after?: number
  readonly view?: string
  readonly storeId?: string
  readonly waitMs: number
}

// --- Structured failures ---

export interface PeopleFailure {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

const PEOPLE_FAILURE = Symbol('people-failure')

export const peopleError = (failure: PeopleFailure): Error =>
  Object.assign(new Error(failure.message), { [PEOPLE_FAILURE]: failure })

export const peopleFailureOf = (error: unknown): PeopleFailure | undefined =>
  error instanceof Error && PEOPLE_FAILURE in error ? (error as Error & { [PEOPLE_FAILURE]: PeopleFailure })[PEOPLE_FAILURE] : undefined

const closingError = (): Error => Object.assign(new Error('Agents Workspace is closing'), { code: 'workspace_closing' })

const EVICTED = Symbol('people-directory-evicted')
/**
 * A directory closed because it was idle. Nothing was done before this was
 * thrown, and the Workspace is still there: the caller may open the
 * directory again and repeat the call once.
 */
const evictedError = (): Error => Object.assign(new Error('People directory was closed while idle'), { code: 'workspace_closing', [EVICTED]: true })
export const isEvictedDirectoryError = (error: unknown): boolean => error instanceof Error && EVICTED in error

const rateLimited = (retryAfterMs: number): Error => peopleError({
  status: 429, code: 'people_rate_limited', message: 'Too many requests; retry shortly', retryable: true,
  details: { retryAfterMs },
})

// --- Ports ---

export interface PeopleTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
  readonly setInterval: (callback: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

const systemTimers: PeopleTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface PeopleDirectoryOptions {
  readonly workspaceId: WorkspaceId
  /** workspaces/{id}/agents/people.sqlite; its directory must already exist. */
  readonly path: string
  readonly metrics: PeopleMetrics
  readonly waiterBudget: WaiterBudget
  /** Storage admission for growth (the Agents storage budget in production). */
  readonly admitGrowth: <T>(estimatedBytes: number, work: () => Promise<T>) => Promise<T>
  /** Wall clock: stored timestamps and serverNow only. */
  readonly now?: () => number
  /**
   * Monotonic clock in ms since process start: rate-limit windows, presence
   * expiry, warming and idleness, so a wall-clock step never expires or
   * revives anyone.
   */
  readonly monotonicNow?: () => number
  readonly timers?: PeopleTimers
  readonly randomBytes?: (length: number) => Uint8Array
  readonly randomUUID?: () => string
  /** Process start on the monotonic clock; presence is incomplete for PRESENCE_TIMEOUT_MS after it. */
  readonly processStartedAt?: number
  readonly presenceTimeoutMs?: number
  readonly sweepMs?: number
  /** Defaults to PEOPLE_PER_WORKSPACE. */
  readonly peopleLimit?: number
  /** One line per send outcome; ids and outcome only. */
  readonly log?: (line: string) => void
}

// --- Helpers ---

const sha256Hex = (value: string): string => new Bun.CryptoHasher('sha256').update(value).digest('hex')

const createWindowLimiter = (now: () => number, windows: ReadonlyArray<RateWindow>) => {
  const longest = Math.max(...windows.map(window => window.windowMs))
  const stamps = new Map<string, number[]>()
  return {
    /** Records one use when every window has room; nothing is recorded on refusal. */
    take: (key: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } => {
      const at = now()
      const recent = (stamps.get(key) ?? []).filter(stamp => stamp > at - longest)
      for (const window of windows) {
        const inWindow = recent.filter(stamp => stamp > at - window.windowMs)
        if (inWindow.length >= window.max) {
          return { ok: false, retryAfterMs: Math.max(1, inWindow[inWindow.length - window.max]! + window.windowMs - at) }
        }
      }
      recent.push(at)
      stamps.set(key, recent)
      return { ok: true }
    },
    prune: (): void => {
      const at = now()
      for (const [key, list] of stamps) if (list.every(stamp => stamp <= at - longest)) stamps.delete(key)
    },
  }
}

// Control characters other than tab and line feed have no place in a chat
// line, and SQLite's length() stops at NUL, so the store could never accept one.
const FORBIDDEN_MESSAGE_CHARACTERS = /(?![\t\n])\p{Cc}/u

export type MessageTextRejection = 'message_empty' | 'message_invalid_characters' | 'message_too_long'

/** NFC, trailing whitespace trimmed; leading whitespace, tabs and inner newlines are content. */
export const normaliseMessageText = (raw: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: MessageTextRejection } => {
  const text = raw.toWellFormed().normalize('NFC').replace(/\s+$/u, '')
  if (text.length === 0) return { ok: false, code: 'message_empty' }
  if (FORBIDDEN_MESSAGE_CHARACTERS.test(text)) return { ok: false, code: 'message_invalid_characters' }
  if ([...text].length > MESSAGE_MAX_CODE_POINTS) return { ok: false, code: 'message_too_long' }
  return { ok: true, text }
}

const MESSAGE_TEXT_REJECTIONS: Readonly<Record<MessageTextRejection, string>> = {
  message_empty: 'A message needs text',
  message_invalid_characters: 'A message cannot contain control characters other than tabs and line breaks',
  message_too_long: `A message is at most ${MESSAGE_MAX_CODE_POINTS} characters`,
}

const iso = (ms: number): string => new Date(ms).toISOString()
const toPerson = (person: StoredPerson): Person => ({ id: person.id, name: person.name })
const toMessage = (message: StoredMessage): Message => ({
  seq: message.seq, id: message.id, from: message.from, to: message.to, text: message.text, sentAt: iso(message.sentAt),
})
const byName = (a: StoredPerson, b: StoredPerson): number =>
  a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

type SettleReason = 'woken' | 'expired' | 'aborted' | 'closed' | 'superseded'
type Settlement = { readonly result: SyncResult } | { readonly error: unknown } | { readonly aborted: true }

interface Waiter {
  readonly personId: string
  readonly viewingKey: string
  readonly after: number
  readonly view: string | undefined
  readonly entry: ScreenEntry
  readonly settle: (settlement: Settlement, reason: SettleReason) => void
}

/** Result of a sync whose caller went away; it is never delivered. */
export const SYNC_ABORTED = Symbol('sync-aborted')

export const createPeopleDirectory = (options: PeopleDirectoryOptions) => {
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const timers = options.timers ?? systemTimers
  const randomBytes = options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)))
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
  // performance.now() counts from the process's time origin.
  const processStartedAt = options.processStartedAt ?? 0
  const presenceTimeoutMs = options.presenceTimeoutMs ?? PRESENCE_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.log(line))
  const { metrics, waiterBudget } = options
  const peopleLimit = options.peopleLimit ?? PEOPLE_PER_WORKSPACE

  const store = createPeopleStore(options.path, { newStoreId: randomUUID })
  const presence = createPresence({ now: monotonicNow, timeoutMs: presenceTimeoutMs })
  const waiters = createWaiterSet<Waiter>()
  const limits = {
    send: createWindowLimiter(monotonicNow, SEND_LIMITS),
    join: createWindowLimiter(monotonicNow, JOIN_LIMITS),
    rename: createWindowLimiter(monotonicNow, RENAME_LIMITS),
    sync: createWindowLimiter(monotonicNow, SYNC_LIMITS),
  }
  let closed: 'open' | 'closing' | 'evicted' = 'open'
  let lastActivityAt = monotonicNow()
  const isWarming = (): boolean => monotonicNow() - processStartedAt < presenceTimeoutMs
  let lastWarming = isWarming()

  const ensureOpen = (): void => {
    if (closed === 'evicted') throw evictedError()
    if (closed === 'closing') throw closingError()
  }
  const take = (limiter: ReturnType<typeof createWindowLimiter>, key: string): void => {
    const outcome = limiter.take(key)
    if (!outcome.ok) throw rateLimited(outcome.retryAfterMs)
  }

  const authenticate = (token: string): StoredPerson => {
    const person = store.personByTokenHash(sha256Hex(token))
    if (!person) throw peopleError({ status: 401, code: 'person_token_invalid', message: 'This identity is not known in this Workspace' })
    lastActivityAt = monotonicNow()
    if (now() - person.lastActiveAt >= ACTIVITY_WRITE_INTERVAL_MS) store.recordActivity(person.id, now())
    return person
  }
  const requirePeer = (me: StoredPerson, peerId: string, selfCode: string): StoredPerson => {
    if (peerId === me.id) throw peopleError({ status: 400, code: selfCode, message: 'A conversation needs another Person' })
    const peer = store.personById(peerId)
    if (!peer) throw peopleError({ status: 404, code: 'person_not_found', message: 'Person not found in this Workspace' })
    return peer
  }
  const personOf = (id: string): StoredPerson => {
    const person = store.personById(id)
    // People with a conversation or a live screen are never pruned.
    if (!person) throw new Error(`People invariant broken: referenced Person is missing (${id})`)
    return person
  }

  const computeSync = (personId: string, viewingKey: string, cursor: { readonly after: number } | 'reset'): SyncResult => {
    const me = personOf(personId)
    const presentIds = presence.presentIn(viewingKey)
    presentIds.delete(me.id)
    const present = [...presentIds].map(personOf).sort(byName).map(toPerson)
    const conversations = store.conversations(me.id).map(summary => ({
      with: toPerson(personOf(summary.peer)),
      here: presentIds.has(summary.peer),
      lastSeq: summary.lastSeq,
      lastSentAt: iso(summary.lastSentAt),
      unread: summary.unread,
    }))
    const presenceWarming = isWarming()
    let messages: Message[] = []
    let more = false
    let next: number
    if (cursor === 'reset') {
      // A new or replaced cursor starts at the present; history is read per conversation.
      next = store.maxSeqFor(me.id)
    } else {
      const page = store.messagesAfter(me.id, cursor.after, SYNC_MESSAGE_PAGE + 1)
      more = page.length > SYNC_MESSAGE_PAGE
      messages = page.slice(0, SYNC_MESSAGE_PAGE).map(toMessage)
      next = messages.at(-1)?.seq ?? cursor.after
    }
    const view = new Bun.CryptoHasher('sha256')
      .update(JSON.stringify({ me: toPerson(me), present, conversations, presenceWarming }))
      .digest('base64url')
    return {
      storeId: store.storeId,
      serverNow: iso(now()),
      presenceWarming,
      me: toPerson(me),
      present,
      conversations,
      messages,
      cursor: next,
      more,
      view,
    }
  }
  const settlementFor = (waiter: Waiter): Settlement => {
    try {
      return { result: computeSync(waiter.personId, waiter.viewingKey, { after: waiter.after }) }
    } catch (error) {
      return { error }
    }
  }

  // Changes coalesce: many mutations in one tick recompute each waiter once.
  let flushScheduled = false
  const flush = (): void => {
    flushScheduled = false
    // close() has already answered every waiter with the final state.
    if (closed !== 'open') return
    const computed = new Map<string, Settlement>()
    for (const waiter of waiters.all()) {
      const key = `${waiter.personId}|${waiter.viewingKey}|${waiter.after}`
      const settlement = computed.get(key) ?? settlementFor(waiter)
      computed.set(key, settlement)
      if ('error' in settlement) { waiter.settle(settlement, 'woken'); continue }
      if ('result' in settlement && (settlement.result.messages.length > 0 || settlement.result.view !== waiter.view)) {
        waiter.settle(settlement, 'woken')
      }
    }
  }
  const notifyChange = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(flush)
  }

  const sweep = (): void => {
    // A tick that races close() has nothing left to sweep.
    if (closed !== 'open') return
    const expired = presence.sweep()
    const warming = isWarming()
    for (const limiter of Object.values(limits)) limiter.prune()
    if (expired > 0 || warming !== lastWarming) {
      lastWarming = warming
      notifyChange()
    }
  }
  const sweepHandle = timers.setInterval(sweep, options.sweepMs ?? PRESENCE_SWEEP_MS)

  const wait = (input: SyncInput, me: StoredPerson, entry: ScreenEntry, signal: AbortSignal): Promise<SyncResult | typeof SYNC_ABORTED> =>
    new Promise((resolve, reject) => {
      let holdTimer: unknown
      const onAbort = (): void => waiter.settle({ aborted: true }, 'aborted')
      const waiter: Waiter = {
        personId: me.id,
        viewingKey: input.viewingKey,
        after: input.after!,
        view: input.view,
        entry,
        settle: (settlement, reason) => {
          if (!waiters.delete(waiter)) return
          timers.clearTimeout(holdTimer)
          signal.removeEventListener('abort', onAbort)
          waiterBudget.release()
          presence.release(entry, !('aborted' in settlement))
          if ('aborted' in settlement) { metrics.inc('syncsAborted'); resolve(SYNC_ABORTED); return }
          if ('error' in settlement) { reject(settlement.error); return }
          metrics.inc(reason === 'woken' ? 'syncsWoken' : reason === 'expired' ? 'syncsHeldToExpiry' : reason === 'closed' ? 'syncsClosed' : 'syncsSuperseded')
          resolve(settlement.result)
        },
      }
      waiters.add(waiter)
      presence.hold(entry)
      holdTimer = timers.setTimeout(() => waiter.settle(settlementFor(waiter), 'expired'), input.waitMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })

  return {
    workspaceId: options.workspaceId,
    storeId: store.storeId,

    join: async (input: { readonly preferredName?: string }): Promise<{ readonly token: string; readonly me: Person; readonly preferredNameAccepted: boolean }> => {
      ensureOpen()
      lastActivityAt = monotonicNow()
      take(limits.join, 'workspace')
      const preferred = input.preferredName === undefined ? undefined : normalisePersonName(input.preferredName)
      const token = Buffer.from(randomBytes(TOKEN_BYTES)).toString('base64url')
      const id = `person-${randomUUID()}`
      const created = await options.admitGrowth(PERSON_GROWTH_BYTES, async () => {
        ensureOpen()
        // Everything from the capacity check to the insert is synchronous, so
        // two joins can never both take the last slot or the same name.
        if (store.countPeople() >= peopleLimit) {
          metrics.inc('peoplePruned', store.pruneInactivePeople(now() - INACTIVE_PERSON_PRUNE_MS, [...presence.livePeople()]))
          if (store.countPeople() >= peopleLimit) {
            throw peopleError({ status: 409, code: 'people_limit_reached', message: 'This Workspace has reached its number of People' })
          }
        }
        const accepted = preferred?.ok === true && store.personIdByNameKey(preferred.key) === undefined
        const name = accepted && preferred?.ok === true
          ? preferred.name
          : allocateDefaultPersonName(store.nameKeysStartingWith(personNameKey(DEFAULT_PERSON_NAME_PREFIX)))
        store.insertPerson({ id, name, nameKey: personNameKey(name), tokenHash: sha256Hex(token), now: now() })
        return { name, accepted }
      })
      metrics.inc('joins')
      return { token, me: { id, name: created.name }, preferredNameAccepted: created.accepted }
    },

    sync: async (input: SyncInput, signal: AbortSignal): Promise<SyncResult | typeof SYNC_ABORTED> => {
      ensureOpen()
      const me = authenticate(input.token)
      const { entry, changed } = presence.touch(me.id, input.screen, input.viewingKey)
      if (changed) notifyChange()
      const reset = input.after === undefined || input.storeId !== store.storeId
      const current = computeSync(me.id, input.viewingKey, reset ? 'reset' : { after: input.after! })
      const immediate = input.waitMs === 0 || reset || signal.aborted
        || current.messages.length > 0 || current.view !== input.view
      if (immediate) {
        take(limits.sync, me.id)
        metrics.inc('syncsImmediate')
        return current
      }
      const mine = waiters.forPerson(me.id)
      const supersedes = mine.length >= MAX_WAITERS_PER_PERSON
      const overflows = !supersedes && !waiterBudget.available()
      // A sync that displaces another or cannot wait answers without holding,
      // so it costs one sync token, taken before anything is answered: a 429
      // never follows an already superseded waiter, and runaway tabs settle
      // into a bounded rotation instead of a tight loop.
      if (supersedes || overflows) take(limits.sync, me.id)
      if (supersedes) {
        const oldest = mine[0]!
        oldest.settle(settlementFor(oldest), 'superseded')
      }
      if (!waiterBudget.tryTake()) {
        metrics.inc('syncWaiterOverflow')
        return current
      }
      return await wait(input, me, entry, signal)
    },

    rename: (input: { readonly token: string; readonly name: string }): { readonly me: Person } => {
      ensureOpen()
      const me = authenticate(input.token)
      take(limits.rename, me.id)
      const normalised = normalisePersonName(input.name)
      if (!normalised.ok) {
        throw peopleError({ status: 400, code: 'person_name_invalid', message: 'This name cannot be used', details: { reason: normalised.reason } })
      }
      const owner = store.personIdByNameKey(normalised.key)
      if (owner !== undefined && owner !== me.id) {
        throw peopleError({ status: 409, code: 'person_name_taken', message: 'Someone in this Workspace already uses this name' })
      }
      if (normalised.name !== me.name) {
        store.renamePerson(me.id, normalised.name, normalised.key)
        metrics.inc('renames')
        notifyChange()
      }
      return { me: { id: me.id, name: normalised.name } }
    },

    readConversation: (input: { readonly token: string; readonly with: string }) => {
      ensureOpen()
      const me = authenticate(input.token)
      const peer = requirePeer(me, input.with, 'conversation_with_self')
      return {
        with: toPerson(peer),
        messages: store.conversation(me.id, peer.id, CONVERSATION_KEEP).map(toMessage),
        readThrough: { me: store.readThrough(me.id, peer.id), them: store.readThrough(peer.id, me.id) },
      }
    },

    markRead: (input: { readonly token: string; readonly with: string; readonly through: number }): { readonly unread: number } => {
      ensureOpen()
      const me = authenticate(input.token)
      const peer = requirePeer(me, input.with, 'conversation_with_self')
      if (store.markRead(me.id, peer.id, input.through)) notifyChange()
      return { unread: store.unreadFrom(me.id, peer.id) }
    },

    send: async (input: { readonly token: string; readonly to: string; readonly text: string }, idempotencyKey: string): Promise<{ readonly message: Message; readonly replayed: boolean }> => {
      ensureOpen()
      const outcome: { sender?: string; recipient?: string; messageId?: string; seq?: number } = {}
      const record = (result: string): void => log(`[people] send ${JSON.stringify({ workspaceId: options.workspaceId, ...outcome, outcome: result })}`)
      try {
        const me = authenticate(input.token)
        outcome.sender = me.id
        const normalised = normaliseMessageText(input.text)
        if (!normalised.ok) {
          throw peopleError({ status: 400, code: normalised.code, message: MESSAGE_TEXT_REJECTIONS[normalised.code] })
        }
        const replay = (existing: StoredMessage): { readonly message: Message; readonly replayed: boolean } => {
          outcome.recipient = existing.to
          outcome.messageId = existing.id
          outcome.seq = existing.seq
          if (existing.to !== input.to || existing.text !== normalised.text) {
            throw peopleError({ status: 409, code: 'idempotency_conflict', message: 'This retry key was already used for a different message' })
          }
          metrics.inc('messagesReplayed')
          record('replayed')
          return { message: toMessage(existing), replayed: true }
        }
        // Replays reach back only as far as retention: a key whose message
        // was pruned out of the newest CONVERSATION_KEEP is free again (accepted).
        const existing = store.messageBySenderKey(me.id, idempotencyKey)
        if (existing) return replay(existing)
        const peer = requirePeer(me, input.to, 'message_to_self')
        outcome.recipient = peer.id
        take(limits.send, me.id)
        const message = { id: `msg-${randomUUID()}`, from: me.id, to: peer.id, text: normalised.text, sentAt: now(), idempotencyKey }
        const commit = () => { ensureOpen(); return store.appendMessage(message, CONVERSATION_KEEP) }
        // Admission rescans the data directory, so only a new conversation pays for it;
        // an existing one is bounded by its retention.
        const appended = store.pairHasMessages(me.id, peer.id)
          ? commit()
          : await options.admitGrowth(CONVERSATION_GROWTH_BYTES, async () => commit())
        if (appended.kind === 'existing') return replay(appended.message)
        outcome.messageId = appended.message.id
        outcome.seq = appended.message.seq
        metrics.inc('messagesSent')
        metrics.inc('messagesPruned', appended.pruned)
        notifyChange()
        record('sent')
        return { message: toMessage(appended.message), replayed: false }
      } catch (error) {
        const failure = peopleFailureOf(error)
        record(failure?.code ?? (error instanceof Error && 'code' in error ? String(error.code) : 'failed'))
        throw error
      }
    },

    leave: (input: { readonly token: string; readonly screen: string }): { readonly left: true } => {
      ensureOpen()
      const me = authenticate(input.token)
      if (presence.remove(me.id, input.screen)) notifyChange()
      metrics.inc('leaves')
      return { left: true }
    },

    /**
     * Idle at wall-clock time `at` (the registry's sweep time, possibly ahead
     * of now): no waiting sync, no live screen and no request for `idleMs`.
     */
    canEvict: (at: number, idleMs: number): boolean => {
      const atMonotonic = monotonicNow() + (at - now())
      return waiters.size() === 0 && presence.liveScreenCount(atMonotonic) === 0 && atMonotonic - lastActivityAt > idleMs
    },

    stats: (): { readonly waiters: number; readonly liveScreens: number } =>
      ({ waiters: waiters.size(), liveScreens: presence.liveScreenCount() }),

    /**
     * Answers every waiting sync with the current state, then closes the
     * store. Idempotent. `evicted` marks an idle close, after which callers
     * may reopen the directory; removal and shutdown close as `closing`.
     */
    close: (reason: 'closing' | 'evicted' = 'closing'): void => {
      if (closed !== 'open') return
      closed = reason
      timers.clearInterval(sweepHandle)
      for (const waiter of waiters.all()) waiter.settle(settlementFor(waiter), 'closed')
      presence.clear()
      store.close()
    },
  }
}

export type PeopleDirectory = ReturnType<typeof createPeopleDirectory>
