import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationPair, createPeopleStore, type PeopleStore } from './people-store.ts'

let dir = ''
let path = ''
const open: PeopleStore[] = []
const openStore = (): PeopleStore => {
  const store = createPeopleStore(path, { newStoreId: () => crypto.randomUUID() })
  open.push(store)
  return store
}
const closeAll = () => { for (const store of open.splice(0)) store.close() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leitbild-people-store-'))
  path = join(dir, 'people.sqlite')
})
afterEach(async () => {
  closeAll()
  await rm(dir, { recursive: true, force: true })
})

const person = (store: PeopleStore, name: string, now = 1_000) => {
  const id = `person-${crypto.randomUUID()}`
  store.insertPerson({ id, name, nameKey: name.toLowerCase(), tokenHash: new Bun.CryptoHasher('sha256').update(id).digest('hex'), now })
  return id
}
const send = (store: PeopleStore, from: string, to: string, text: string, key: string = crypto.randomUUID(), sentAt = 2_000) =>
  store.appendMessage({ id: `msg-${crypto.randomUUID()}`, from, to, text, sentAt, idempotencyKey: key }, 200)

describe('People store', () => {
  test('keeps its identity, People and message order across reopen', () => {
    const first = openStore()
    const ann = person(first, 'Ann')
    const ben = person(first, 'Ben')
    const sent = ['one', 'two', 'three'].map(text => send(first, ann, ben, text))
    const storeId = first.storeId
    closeAll()
    const reopened = openStore()
    expect(reopened.storeId).toBe(storeId)
    expect(reopened.personById(ann)).toMatchObject({ name: 'Ann', nameKey: 'ann' })
    const seqs = reopened.conversation(ben, ann, 200).map(message => message.seq)
    expect(seqs).toEqual(sent.map(outcome => outcome.message.seq))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    // AUTOINCREMENT: a sequence number is never reused after reopen.
    const next = send(reopened, ben, ann, 'four')
    expect(next.message.seq).toBeGreaterThan(seqs.at(-1)!)
    expect(reopened.messagesAfter(ann, seqs[0]!, 100).map(message => message.text)).toEqual(['two', 'three', 'four'])
    expect(reopened.maxSeqFor(ann)).toBe(next.message.seq)
  })

  test('returns the original message for a repeated sender key, also after reopen', () => {
    const first = openStore()
    const ann = person(first, 'Ann')
    const ben = person(first, 'Ben')
    const original = send(first, ann, ben, 'hello', 'key-1')
    expect(original.kind).toBe('appended')
    closeAll()
    const reopened = openStore()
    expect(reopened.messageBySenderKey(ann, 'key-1')).toEqual(original.message)
    const repeated = send(reopened, ann, ben, 'hello', 'key-1')
    expect(repeated).toEqual({ kind: 'existing', message: original.message })
    expect(reopened.conversation(ann, ben, 200)).toHaveLength(1)
    // Keys belong to their sender: Ben may use the same key.
    expect(send(reopened, ben, ann, 'hi', 'key-1').kind).toBe('appended')
  })

  test('keeps only the newest 200 messages of a conversation and counts what it pruned', () => {
    const store = openStore()
    const ann = person(store, 'Ann')
    const ben = person(store, 'Ben')
    const cid = person(store, 'Cid')
    send(store, ann, cid, 'other conversation')
    let pruned = 0
    for (let i = 0; i < 205; i++) {
      const outcome = send(store, i % 2 ? ann : ben, i % 2 ? ben : ann, `m${i}`)
      if (outcome.kind === 'appended') pruned += outcome.pruned
    }
    expect(pruned).toBe(5)
    const kept = store.conversation(ann, ben, 500)
    expect(kept).toHaveLength(200)
    expect(kept[0]!.text).toBe('m5')
    expect(kept.at(-1)!.text).toBe('m204')
    expect(store.conversation(ann, cid, 500)).toHaveLength(1)
  })

  test('read markers move forward only, never past the last message, and drive unread counts', () => {
    const store = openStore()
    const ann = person(store, 'Ann')
    const ben = person(store, 'Ben')
    const a = send(store, ben, ann, 'one').message.seq
    const b = send(store, ben, ann, 'two').message.seq
    expect(store.unreadFrom(ann, ben)).toBe(2)
    expect(store.markRead(ann, ben, a)).toBe(true)
    expect(store.unreadFrom(ann, ben)).toBe(1)
    expect(store.markRead(ann, ben, 0)).toBe(false)
    expect(store.readThrough(ann, ben)).toBe(a)
    expect(store.markRead(ann, ben, b + 1_000)).toBe(true)
    expect(store.readThrough(ann, ben)).toBe(b)
    expect(store.unreadFrom(ann, ben)).toBe(0)
    // Sending reads the conversation up to the sent message.
    const reply = send(store, ann, ben, 'three').message.seq
    expect(store.readThrough(ann, ben)).toBe(reply)
    expect(store.unreadFrom(ben, ann)).toBe(1)
  })

  test('summarises every conversation of a Person, newest first, with its last message and unread count', () => {
    const store = openStore()
    const ann = person(store, 'Ann')
    const ben = person(store, 'Ben')
    const cid = person(store, 'Cid')
    send(store, ben, ann, 'from ben', undefined, 10)
    send(store, ann, cid, 'to cid', undefined, 20)
    const last = send(store, ben, ann, 'again', undefined, 30).message
    expect(store.conversations(ann)).toEqual([
      { peer: ben, lastSeq: last.seq, lastSentAt: 30, unread: 2 },
      { peer: cid, lastSeq: last.seq - 1, lastSentAt: 20, unread: 0 },
    ])
    expect(store.conversations(cid)).toEqual([{ peer: ann, lastSeq: last.seq - 1, lastSentAt: 20, unread: 1 }])
    expect(conversationPair(ann, ben)).toBe(conversationPair(ben, ann))
  })

  test('prunes only People with no conversation who were inactive before the cutoff', () => {
    const store = openStore()
    const old = person(store, 'Old', 100)
    const talking = person(store, 'Talking', 100)
    const recent = person(store, 'Recent', 5_000)
    send(store, talking, recent, 'hi')
    expect(store.pruneInactivePeople(1_000)).toBe(1)
    expect(store.personById(old)).toBeUndefined()
    expect(store.personById(talking)).toBeDefined()
    expect(store.countPeople()).toBe(2)
  })

  test('enforces name and token uniqueness in the schema', () => {
    const store = openStore()
    person(store, 'Ann')
    expect(() => person(store, 'Ann')).toThrow()
    expect(store.nameKeysStartingWith('user')).toEqual(new Set())
    person(store, 'User1')
    person(store, 'User3')
    person(store, 'Userless')
    expect(store.nameKeysStartingWith('user')).toEqual(new Set(['user1', 'user3', 'userless']))
  })

  test('refuses unknown schemas and unrecognised tables, and never creates a missing Workspace directory', async () => {
    const foreign = new Database(path, { create: true })
    foreign.exec('CREATE TABLE something (x TEXT)')
    foreign.close()
    expect(openStore).toThrow('Unrecognized People storage')
    await rm(path)
    const future = new Database(path, { create: true })
    future.exec('PRAGMA user_version = 2')
    future.close()
    expect(openStore).toThrow('Unsupported People storage schema: 2')
    await rm(dir, { recursive: true, force: true })
    expect(openStore).toThrow('not provisioned')
    expect(existsSync(dir)).toBe(false)
  })
})
