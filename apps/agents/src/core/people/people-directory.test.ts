import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import {
  ACTIVITY_WRITE_INTERVAL_MS,
  INACTIVE_PERSON_PRUNE_MS,
  SYNC_ABORTED,
  createPeopleDirectory,
  peopleFailureOf,
  type PeopleDirectory,
  type SyncInput,
  type SyncResult,
} from './people-directory.ts'
import { createPeopleMetrics } from './people-metrics.ts'
import { PRESENCE_TIMEOUT_MS, createWaiterBudget, type WaiterBudget } from './presence.ts'

let dir = ''
let path = ''
const opened: PeopleDirectory[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leitbild-people-directory-'))
  path = join(dir, 'people.sqlite')
})
afterEach(async () => {
  for (const directory of opened.splice(0)) directory.close()
  await rm(dir, { recursive: true, force: true })
})

const RUN_1 = 'world|world.simulation-run|run-1'
const RUN_2 = 'world|world.simulation-run|run-2'

const clock = () => {
  let at = Date.UTC(2026, 9, 13, 12)
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

const make = (options: { readonly budget?: WaiterBudget; readonly processStartedAt?: number; readonly peopleLimit?: number } = {}) => {
  const time = clock()
  const metrics = createPeopleMetrics()
  const lines: string[] = []
  const admissions: number[] = []
  const directory = createPeopleDirectory({
    workspaceId: newWorkspaceId(),
    path,
    metrics,
    waiterBudget: options.budget ?? createWaiterBudget(),
    admitGrowth: async (bytes, work) => { admissions.push(bytes); return await work() },
    now: time.now,
    processStartedAt: options.processStartedAt ?? 0,
    sweepMs: 10,
    log: line => lines.push(line),
    ...(options.peopleLimit === undefined ? {} : { peopleLimit: options.peopleLimit }),
  })
  opened.push(directory)
  return { directory, time, metrics, lines, admissions }
}

const live = () => new AbortController().signal
const answered = (value: SyncResult | typeof SYNC_ABORTED): SyncResult => {
  if (value === SYNC_ABORTED) throw new Error('sync was aborted')
  return value
}
const screen = () => crypto.randomUUID()

/** First sync of a screen, then a long-poll continuing from it. */
const syncer = (directory: PeopleDirectory, token: string, screenId = screen(), viewingKey = RUN_1) => {
  let last: SyncResult | undefined
  const input = (waitMs: number): SyncInput => ({
    token, screen: screenId, viewingKey, waitMs,
    ...(last === undefined ? {} : { after: last.cursor, storeId: last.storeId, view: last.view }),
  })
  return {
    now: async (): Promise<SyncResult> => { last = answered(await directory.sync(input(0), live())); return last },
    wait: (waitMs = 5_000, signal = live()): Promise<SyncResult> =>
      directory.sync(input(waitMs), signal).then(value => { last = answered(value); return last }),
    raw: (waitMs: number, signal: AbortSignal) => directory.sync(input(waitMs), signal),
  }
}

const failureCode = async (work: () => unknown): Promise<string | undefined> => {
  try { await work() } catch (error) {
    return peopleFailureOf(error)?.code ?? (error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.message : String(error))
  }
  throw new Error('expected a failure')
}

describe('People directory', () => {
  test('joins with the lowest free default name or a free preferred name, and stores only the token hash', async () => {
    const { directory, admissions } = make()
    const first = await directory.join({})
    expect(first.me.name).toBe('User1')
    expect(first.preferredNameAccepted).toBe(false)
    expect(first.me.id).toMatch(/^person-[0-9a-f-]{36}$/)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const ben = await directory.join({ preferredName: '  Ben ' })
    expect(ben).toMatchObject({ me: { name: 'Ben' }, preferredNameAccepted: true })
    expect(await directory.join({ preferredName: 'BEN' })).toMatchObject({ me: { name: 'User2' }, preferredNameAccepted: false })
    expect(await directory.join({ preferredName: 'Ben‮' })).toMatchObject({ me: { name: 'User3' }, preferredNameAccepted: false })
    expect(admissions).toHaveLength(4)
    const file = Buffer.from(await Bun.file(path).bytes())
    expect(file.includes(first.token)).toBe(false)
    expect(file.includes(new Bun.CryptoHasher('sha256').update(first.token).digest('hex'))).toBe(true)
    expect(await failureCode(() => directory.sync({ token: 'unknown', screen: screen(), viewingKey: RUN_1, waitMs: 0 }, live()))).toBe('person_token_invalid')
  })

  test('renames: a case change of one\'s own name is allowed, a taken or invalid name is refused with a reason', async () => {
    const { directory } = make()
    const ann = await directory.join({ preferredName: 'Ann' })
    await directory.join({ preferredName: 'Ben' })
    expect(directory.rename({ token: ann.token, name: 'ANN' }).me).toEqual({ id: ann.me.id, name: 'ANN' })
    expect(await failureCode(() => directory.rename({ token: ann.token, name: 'ben' }))).toBe('person_name_taken')
    try { directory.rename({ token: ann.token, name: 'a'.repeat(33) }) } catch (error) {
      expect(peopleFailureOf(error)).toMatchObject({ status: 400, code: 'person_name_invalid', details: { reason: 'too_long' } })
    }
    expect(await failureCode(() => directory.rename({ token: ann.token, name: 'Ann​' }))).toBe('person_name_invalid')
    expect(directory.rename({ token: ann.token, name: 'User1' }).me.name).toBe('User1')
    // The default allocation skips a name someone chose.
    expect((await directory.join({})).me.name).toBe('User2')
  })

  test('a waiting sync wakes within 100 ms of a message and returns it with the conversation', async () => {
    const { directory, metrics } = make()
    const ann = await directory.join({ preferredName: 'Ann' })
    const ben = await directory.join({ preferredName: 'Ben' })
    const annSync = syncer(directory, ann.token)
    const first = await annSync.now()
    expect(first).toMatchObject({ me: ann.me, present: [], conversations: [], messages: [], cursor: 0, more: false, presenceWarming: false })
    const waiting = annSync.wait()
    await Bun.sleep(20)
    expect(directory.stats().waiters).toBe(1)
    const started = performance.now()
    const sent = await directory.send({ token: ben.token, to: ann.me.id, text: 'hello' }, 'key-1')
    const woken = await waiting
    expect(performance.now() - started).toBeLessThan(100)
    expect(woken.messages).toEqual([sent.message])
    expect(woken.cursor).toBe(sent.message.seq)
    expect(woken.conversations).toEqual([{ with: ben.me, here: false, lastSeq: sent.message.seq, lastSentAt: sent.message.sentAt, unread: 1 }])
    expect(metrics.snapshot()).toMatchObject({ syncsWoken: 1, messagesSent: 1 })
  })

  test('a rename wakes waiting syncs; an unchanged state waits until the hold expires and answers the current view', async () => {
    const { directory, metrics } = make()
    const ann = await directory.join({})
    const ben = await directory.join({})
    const annSync = syncer(directory, ann.token)
    const benSync = syncer(directory, ben.token)
    await benSync.now()
    const first = await annSync.now()
    expect(first.present).toEqual([ben.me])
    const held = performance.now()
    const expired = await annSync.wait(60)
    expect(performance.now() - held).toBeGreaterThanOrEqual(50)
    expect(expired.view).toBe(first.view)
    expect(metrics.snapshot().syncsHeldToExpiry).toBe(1)
    const waiting = annSync.wait()
    directory.rename({ token: ben.token, name: 'Benjamin' })
    expect((await waiting).present).toEqual([{ id: ben.me.id, name: 'Benjamin' }])
  })

  test('an aborted sync drops its waiter and is never answered', async () => {
    const budget = createWaiterBudget()
    const { directory, metrics } = make({ budget })
    const ann = await directory.join({})
    const annSync = syncer(directory, ann.token)
    await annSync.now()
    const controller = new AbortController()
    const pending = annSync.raw(10_000, controller.signal)
    await Bun.sleep(10)
    expect(directory.stats().waiters).toBe(1)
    expect(budget.held()).toBe(1)
    controller.abort()
    expect(await pending).toBe(SYNC_ABORTED)
    expect(directory.stats().waiters).toBe(0)
    expect(budget.held()).toBe(0)
    expect(metrics.snapshot().syncsAborted).toBe(1)
    const already = new AbortController()
    already.abort()
    expect(answered(await annSync.raw(10_000, already.signal)).view).toBeString()
    expect(directory.stats().waiters).toBe(0)
  })

  test('close() answers every waiting sync with the current state at once and refuses later calls', async () => {
    const budget = createWaiterBudget()
    const { directory, metrics } = make({ budget })
    const ann = await directory.join({})
    const ben = await directory.join({})
    const annSync = syncer(directory, ann.token)
    const benSync = syncer(directory, ben.token, screen(), RUN_2)
    await annSync.now()
    await benSync.now()
    const waiting = [annSync.wait(15_000), benSync.wait(15_000)]
    await Bun.sleep(10)
    const started = performance.now()
    directory.close()
    const results = await Promise.all(waiting)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(results.map(result => result.me.id)).toEqual([ann.me.id, ben.me.id])
    expect(budget.held()).toBe(0)
    expect(metrics.snapshot().syncsClosed).toBe(2)
    expect(await failureCode(() => annSync.now())).toBe('workspace_closing')
    expect(await failureCode(() => directory.join({}))).toBe('workspace_closing')
    directory.close()
  })

  test('presence is per Run: arrival, Run switch, a second screen elsewhere, leave and expiry after the timeout', async () => {
    const { directory, time } = make()
    const ann = await directory.join({ preferredName: 'Ann' })
    const ben = await directory.join({ preferredName: 'Ben' })
    const annSync = syncer(directory, ann.token)
    await annSync.now()
    const arrival = annSync.wait()
    const benScreen = screen()
    const benSync = syncer(directory, ben.token, benScreen)
    expect((await benSync.now()).present).toEqual([ann.me])
    expect((await arrival).present).toEqual([ben.me])

    // Ben's screen switches to another Run.
    const departure = annSync.wait()
    const benElsewhere = syncer(directory, ben.token, benScreen, RUN_2)
    expect((await benElsewhere.now()).present).toEqual([])
    expect((await departure).present).toEqual([])

    // A second tab of Ben in Run 1 shows him in both Runs.
    const secondTab = screen()
    const back = annSync.wait()
    await syncer(directory, ben.token, secondTab).now()
    expect((await back).present).toEqual([ben.me])
    const left = annSync.wait()
    expect(directory.leave({ token: ben.token, screen: secondTab })).toEqual({ left: true })
    expect((await left).present).toEqual([])

    // Ben returns, then stops syncing: he expires after the timeout, while
    // Ann's own pending sync keeps her present.
    await syncer(directory, ben.token, secondTab).now()
    const present = await annSync.now()
    expect(present.present).toEqual([ben.me])
    const expiry = annSync.wait()
    await Bun.sleep(20)
    time.advance(PRESENCE_TIMEOUT_MS)
    const expired = await expiry
    expect(expired.present).toEqual([])
    const benView = await syncer(directory, ben.token, screen()).now()
    expect(benView.present).toEqual([ann.me])
  })

  test('a fifth waiting sync of one Person supersedes the oldest; the process budget answers excess syncs at once', async () => {
    const budget = createWaiterBudget(5)
    const { directory, metrics } = make({ budget })
    const ann = await directory.join({})
    const ben = await directory.join({})
    const cid = await directory.join({})
    const annTabs = await Promise.all([1, 2, 3, 4, 5].map(async () => {
      const tab = syncer(directory, ann.token)
      await tab.now()
      return tab
    }))
    const first = annTabs[0]!.wait(15_000)
    await Bun.sleep(2)
    const rest = annTabs.slice(1, 4).map(tab => tab.wait(15_000))
    await Bun.sleep(5)
    expect(directory.stats().waiters).toBe(4)
    const fifth = annTabs[4]!.wait(15_000)
    const superseded = await first
    expect(superseded.me).toEqual(ann.me)
    expect(directory.stats().waiters).toBe(4)
    expect(metrics.snapshot().syncsSuperseded).toBe(1)
    // Ben and Cid view other Runs, so their arrival changes nothing Ann sees.
    const benSync = syncer(directory, ben.token, screen(), RUN_2)
    await benSync.now()
    const benWaiting = benSync.wait(15_000)
    await Bun.sleep(5)
    expect(budget.held()).toBe(5)
    const cidSync = syncer(directory, cid.token, screen(), 'world|world.simulation-run|run-3')
    await cidSync.now()
    const overflow = await cidSync.wait(15_000)
    expect(overflow.me).toEqual(cid.me)
    expect(metrics.snapshot().syncWaiterOverflow).toBe(1)
    directory.close()
    await Promise.all([...rest, fifth, benWaiting])
    expect(budget.held()).toBe(0)
  })

  test('heartbeat-only syncs, presence changes and leaves never write the database file', async () => {
    const { directory, time } = make()
    const ann = await directory.join({})
    const ben = await directory.join({})
    await directory.send({ token: ben.token, to: ann.me.id, text: 'hi' }, 'k')
    const before = statSync(path, { bigint: true })
    const annScreen = screen()
    const annSync = syncer(directory, ann.token, annScreen)
    for (let i = 0; i < 20; i++) {
      time.advance(1_000)
      await annSync.now()
      await syncer(directory, ben.token, screen(), i % 2 ? RUN_1 : RUN_2).now()
    }
    await annSync.wait(30)
    directory.leave({ token: ann.token, screen: annScreen })
    time.advance(PRESENCE_TIMEOUT_MS)
    await Bun.sleep(30)
    const after = statSync(path, { bigint: true })
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.size).toBe(before.size)
    // Activity is recorded at most hourly; that write is visible to this check.
    await Bun.sleep(10)
    time.advance(ACTIVITY_WRITE_INTERVAL_MS)
    await annSync.now()
    expect(statSync(path, { bigint: true }).mtimeNs).not.toBe(before.mtimeNs)
  })

  test('send validates text and recipient, replays a repeated key, refuses a reused key for another message, and rate-limits new messages only', async () => {
    const { directory, time, lines, admissions, metrics } = make()
    const ann = await directory.join({ preferredName: 'Ann' })
    const ben = await directory.join({ preferredName: 'Ben' })
    expect(await failureCode(() => directory.send({ token: ann.token, to: ben.me.id, text: ' \n\t ' }, 'k0'))).toBe('message_empty')
    expect(await failureCode(() => directory.send({ token: ann.token, to: ben.me.id, text: '🙂'.repeat(2_001) }, 'k0'))).toBe('message_too_long')
    for (const text of ['\u0000hello', 'bell\u0007', 'carriage\rreturn', 'del\u007f', 'c1\u0085']) {
      expect(await failureCode(() => directory.send({ token: ann.token, to: ben.me.id, text }, 'k0'))).toBe('message_invalid_characters')
    }
    const tabbed = await directory.send({ token: ann.token, to: ben.me.id, text: 'col\tcol\nnext line' }, 'k-tab')
    expect(tabbed.message.text).toBe('col\tcol\nnext line')
    expect(await failureCode(() => directory.send({ token: ann.token, to: ann.me.id, text: 'me' }, 'k0'))).toBe('message_to_self')
    expect(await failureCode(() => directory.send({ token: ann.token, to: `person-${crypto.randomUUID()}`, text: 'x' }, 'k0'))).toBe('person_not_found')
    const first = await directory.send({ token: ann.token, to: ben.me.id, text: '  Café \n\nline two  \n ' }, 'k1')
    expect(first.replayed).toBe(false)
    expect(first.message.text).toBe('  Café \n\nline two')
    expect(first.message).toMatchObject({ from: ann.me.id, to: ben.me.id, sentAt: new Date(time.now()).toISOString() })
    expect(await directory.send({ token: ann.token, to: ben.me.id, text: '  Café \n\nline two' }, 'k1')).toEqual({ message: first.message, replayed: true })
    expect(await failureCode(() => directory.send({ token: ann.token, to: ben.me.id, text: 'other' }, 'k1'))).toBe('idempotency_conflict')
    expect((await directory.send({ token: ann.token, to: ben.me.id, text: 'x'.repeat(2_000) }, 'k-long')).message.text).toHaveLength(2_000)
    for (let i = 2; i <= 8; i++) await directory.send({ token: ann.token, to: ben.me.id, text: `m${i}` }, `k${i}`)
    let limited: unknown
    try { await directory.send({ token: ann.token, to: ben.me.id, text: 'eleventh' }, 'k11') } catch (error) { limited = error }
    expect(peopleFailureOf(limited)).toMatchObject({ status: 429, code: 'people_rate_limited', retryable: true })
    expect(peopleFailureOf(limited)!.details!.retryAfterMs as number).toBeGreaterThan(0)
    // A retry of an accepted message is answered even while new messages are limited.
    expect((await directory.send({ token: ann.token, to: ben.me.id, text: 'm5' }, 'k5')).replayed).toBe(true)
    time.advance(10_000)
    expect((await directory.send({ token: ann.token, to: ben.me.id, text: 'later' }, 'k12')).replayed).toBe(false)
    // Two joins and one new conversation pass storage admission, not every message.
    expect(admissions).toHaveLength(3)
    expect(metrics.snapshot()).toMatchObject({ messagesSent: 11, messagesReplayed: 2 })
    const sentLines = lines.filter(line => line.includes('"outcome":"sent"'))
    expect(sentLines).toHaveLength(11)
    expect(JSON.parse(sentLines[1]!.slice('[people] send '.length))).toEqual({
      workspaceId: directory.workspaceId, sender: ann.me.id, recipient: ben.me.id, messageId: first.message.id, seq: first.message.seq, outcome: 'sent',
    })
    expect(lines.some(line => line.includes('"outcome":"people_rate_limited"'))).toBe(true)
    expect(lines.some(line => line.includes('"outcome":"idempotency_conflict"'))).toBe(true)
    for (const line of lines) {
      for (const secret of ['Café', 'line two', 'Ann', 'Ben', ann.token, ben.token, 'eleventh']) expect(line).not.toContain(secret)
    }
  })

  test('conversations read oldest first, read markers move forward only, and unread counts follow them', async () => {
    const { directory } = make()
    const ann = await directory.join({})
    const ben = await directory.join({})
    const one = (await directory.send({ token: ben.token, to: ann.me.id, text: 'one' }, 'a')).message
    const two = (await directory.send({ token: ben.token, to: ann.me.id, text: 'two' }, 'b')).message
    const read = directory.readConversation({ token: ann.token, with: ben.me.id })
    expect(read).toEqual({ with: ben.me, messages: [one, two], readThrough: { me: 0, them: two.seq } })
    expect(directory.markRead({ token: ann.token, with: ben.me.id, through: one.seq })).toEqual({ unread: 1 })
    expect(directory.markRead({ token: ann.token, with: ben.me.id, through: 0 })).toEqual({ unread: 1 })
    const annSync = syncer(directory, ann.token)
    await annSync.now()
    const waiting = annSync.wait()
    expect(directory.markRead({ token: ann.token, with: ben.me.id, through: two.seq + 50 })).toEqual({ unread: 0 })
    expect((await waiting).conversations[0]!.unread).toBe(0)
    expect(directory.readConversation({ token: ann.token, with: ben.me.id }).readThrough).toEqual({ me: two.seq, them: two.seq })
    expect(await failureCode(() => directory.readConversation({ token: ann.token, with: ann.me.id }))).toBe('conversation_with_self')
    expect(await failureCode(() => directory.markRead({ token: ann.token, with: `person-${crypto.randomUUID()}`, through: 1 }))).toBe('person_not_found')
  })

  test('a sync returns at most 100 messages and says when more follow; a replaced store resets the cursor', async () => {
    const { directory, time } = make()
    const ann = await directory.join({})
    const ben = await directory.join({})
    const annSync = syncer(directory, ann.token)
    const start = await annSync.now()
    for (let i = 0; i < 101; i++) {
      time.advance(1_100)
      await directory.send({ token: ben.token, to: ann.me.id, text: `m${i}` }, `k${i}`)
    }
    const page = await annSync.now()
    expect(page.messages).toHaveLength(100)
    expect(page.more).toBe(true)
    expect(page.messages[0]!.text).toBe('m0')
    const rest = await annSync.now()
    expect(rest.messages.map(message => message.text)).toEqual(['m100'])
    expect(rest.more).toBe(false)
    const replaced = answered(await directory.sync({ token: ann.token, screen: screen(), viewingKey: RUN_1, waitMs: 5_000, after: 3, storeId: 'another-store', view: rest.view }, live()))
    expect(replaced).toMatchObject({ storeId: start.storeId, messages: [], cursor: rest.cursor })
  })

  test('at the People limit, People who never chatted and were away for 30 days are forgotten; otherwise joining is refused', async () => {
    const { directory, time, metrics } = make({ peopleLimit: 2 })
    const idle = await directory.join({})
    await directory.join({})
    expect(await failureCode(() => directory.join({}))).toBe('people_limit_reached')
    time.advance(INACTIVE_PERSON_PRUNE_MS + 1)
    const fresh = await directory.join({})
    expect(fresh.me.name).toBe('User1')
    expect(metrics.snapshot().peoplePruned).toBe(2)
    expect(await failureCode(() => directory.sync({ token: idle.token, screen: screen(), viewingKey: RUN_1, waitMs: 0 }, live()))).toBe('person_token_invalid')
  })

  test('reports presence as warming for one presence timeout after the process started, and its end wakes waiting syncs', async () => {
    const { directory, time } = make({ processStartedAt: clock().now() })
    const ann = await directory.join({})
    const annSync = syncer(directory, ann.token)
    expect((await annSync.now()).presenceWarming).toBe(true)
    const waiting = annSync.wait()
    await Bun.sleep(20)
    time.advance(PRESENCE_TIMEOUT_MS)
    expect((await waiting).presenceWarming).toBe(false)
  })

  test('can be evicted only without waiting syncs, live screens or recent requests', async () => {
    const { directory, time } = make()
    const ann = await directory.join({})
    expect(directory.canEvict(time.now() + 1_001, 1_000)).toBe(true)
    expect(directory.canEvict(time.now() + 999, 1_000)).toBe(false)
    const annSync = syncer(directory, ann.token)
    await annSync.now()
    expect(directory.canEvict(time.now() + 1_001, 1_000)).toBe(false)
    const later = time.now() + PRESENCE_TIMEOUT_MS + 1_001
    expect(directory.canEvict(later, 1_000)).toBe(true)
    const waiting = annSync.wait(60)
    await Bun.sleep(5)
    expect(directory.canEvict(later, 1_000)).toBe(false)
    await waiting
  })
})
