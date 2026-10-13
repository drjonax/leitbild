import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

// ============================================================================
// People store — one SQLite file per Workspace (workspaces/{id}/agents/people.sqlite).
//
// Holds the People of a Workspace, their direct messages and how far each has
// read. Presence is never written here: it lives in memory, so a heartbeat
// never touches this file. Every write is one synchronous transaction that has
// committed before the call returns, so a caller acknowledges only durable
// state. Follows the execution store: strict schema, rollback journal,
// user_version checked, no migrations.
// ============================================================================

const SCHEMA_VERSION = 1

export interface StoredPerson {
  readonly id: string
  readonly name: string
  readonly nameKey: string
  readonly createdAt: number
  readonly lastActiveAt: number
}

export interface StoredMessage {
  readonly seq: number
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  readonly sentAt: number
  readonly idempotencyKey: string
}

export interface ConversationSummary {
  readonly peer: string
  readonly lastSeq: number
  readonly lastSentAt: number
  readonly unread: number
}

export type AppendOutcome =
  | { readonly kind: 'appended'; readonly message: StoredMessage; readonly pruned: number }
  | { readonly kind: 'existing'; readonly message: StoredMessage }

interface PersonRow { id: string; name: string; name_key: string; created_at: number; last_active_at: number }
interface MessageRow { seq: number; id: string; sender: string; recipient: string; text: string; sent_at: number; idem_key: string }
interface SummaryRow { peer: string; last_seq: number; last_sent_at: number; unread: number }

const personFromRow = (row: PersonRow): StoredPerson => ({
  id: row.id, name: row.name, nameKey: row.name_key, createdAt: row.created_at, lastActiveAt: row.last_active_at,
})
const messageFromRow = (row: MessageRow): StoredMessage => ({
  seq: row.seq, id: row.id, from: row.sender, to: row.recipient, text: row.text, sentAt: row.sent_at, idempotencyKey: row.idem_key,
})

/** The order-free key of a two-Person conversation. */
export const conversationPair = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`

const createSchema = (db: Database, storeId: string): void => {
  // New database only: pruning must return free pages to the filesystem,
  // otherwise the physical-byte admission budget never recovers.
  db.exec('PRAGMA auto_vacuum = FULL')
  db.transaction(() => {
    db.exec(`
      CREATE TABLE meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        store_id TEXT NOT NULL CHECK(length(store_id) > 0)
      ) STRICT;
      CREATE TABLE people (
        id TEXT PRIMARY KEY CHECK(id GLOB 'person-*' AND length(id) > 7),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32),
        name_key TEXT NOT NULL UNIQUE CHECK(length(name_key) > 0),
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE CHECK(id GLOB 'msg-*' AND length(id) > 4),
        sender TEXT NOT NULL REFERENCES people(id),
        recipient TEXT NOT NULL REFERENCES people(id),
        pair TEXT NOT NULL,
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
        sent_at INTEGER NOT NULL,
        idem_key TEXT NOT NULL CHECK(length(idem_key) BETWEEN 1 AND 256),
        CHECK(sender <> recipient),
        CHECK(pair = CASE WHEN sender < recipient THEN sender || '|' || recipient ELSE recipient || '|' || sender END),
        UNIQUE(sender, idem_key)
      ) STRICT;
      CREATE INDEX messages_pair ON messages(pair, seq);
      CREATE INDEX messages_recipient ON messages(recipient, seq);
      CREATE INDEX messages_sender ON messages(sender, seq);
      CREATE TABLE reads (
        person TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        peer TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        through INTEGER NOT NULL CHECK(through >= 0),
        PRIMARY KEY(person, peer)
      ) STRICT;
    `)
    db.query('INSERT INTO meta(singleton, store_id) VALUES(1, ?)').run(storeId)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })()
}

/**
 * Opens (or creates) one Workspace's People database. The parent directory
 * must already exist: it is the provisioned Agents Workspace directory, and
 * opening the store must never recreate a Workspace that is being removed.
 */
export const createPeopleStore = (path: string, options: { readonly newStoreId: () => string }) => {
  if (path !== ':memory:' && !existsSync(dirname(path))) {
    throw new Error('People storage directory is missing; the Agents Workspace is not provisioned')
  }
  const db = new Database(path, { create: true, strict: true })
  let storeId: string
  try {
    // Rollback journaling avoids checkpoint machinery and the WAL-reset issue
    // in SQLite 3.51.0 bundled with the pinned Bun 1.4.0 runtime.
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA')
    const schema = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
    if (schema !== 0 && schema !== SCHEMA_VERSION) throw new Error(`Unsupported People storage schema: ${schema}`)
    if (schema === 0) {
      const tables = db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get()!.count
      if (tables !== 0) throw new Error('Unrecognized People storage; existing tables are not replaced')
      createSchema(db, options.newStoreId())
    }
    const meta = db.query<{ store_id: string }, []>('SELECT store_id FROM meta WHERE singleton = 1').get()
    if (!meta) throw new Error('People storage has no store identity')
    storeId = meta.store_id
  } catch (error) { db.close(); throw error }

  const personBy = (column: 'id' | 'token_hash', value: string): StoredPerson | undefined => {
    const row = db.query<PersonRow, [string]>(`SELECT id, name, name_key, created_at, last_active_at FROM people WHERE ${column} = ?`).get(value)
    return row ? personFromRow(row) : undefined
  }
  const messageBySenderKey = (sender: string, key: string): StoredMessage | undefined => {
    const row = db.query<MessageRow, [string, string]>('SELECT * FROM messages WHERE sender = ? AND idem_key = ?').get(sender, key)
    return row ? messageFromRow(row) : undefined
  }
  const maxSeqInPair = (pair: string): number =>
    db.query<{ seq: number }, [string]>('SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE pair = ?').get(pair)!.seq
  // No marker row means nothing has been read yet, which is exactly seq 0.
  const readThrough = (person: string, peer: string): number =>
    db.query<{ through: number }, [string, string]>('SELECT through FROM reads WHERE person = ? AND peer = ?').get(person, peer)?.through ?? 0
  const advanceRead = (person: string, peer: string, through: number): void => {
    db.query(`INSERT INTO reads(person, peer, through) VALUES(?1, ?2, ?3)
      ON CONFLICT(person, peer) DO UPDATE SET through = excluded.through WHERE excluded.through > reads.through`).run(person, peer, through)
  }

  const append = db.transaction((message: Omit<StoredMessage, 'seq'>, keep: number): AppendOutcome => {
    // Re-checked inside the transaction: a concurrent send with the same key
    // may have committed while this one awaited storage admission.
    const existing = messageBySenderKey(message.from, message.idempotencyKey)
    if (existing) return { kind: 'existing', message: existing }
    const pair = conversationPair(message.from, message.to)
    const inserted = db.query('INSERT INTO messages(id, sender, recipient, pair, text, sent_at, idem_key) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, message.from, message.to, pair, message.text, message.sentAt, message.idempotencyKey)
    const seq = Number(inserted.lastInsertRowid)
    // Sending a message reads the conversation up to it.
    advanceRead(message.from, message.to, seq)
    const pruned = db.query(`DELETE FROM messages WHERE pair = ?1
      AND seq < (SELECT seq FROM messages WHERE pair = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)`).run(pair, keep - 1).changes
    return { kind: 'appended', message: { ...message, seq }, pruned }
  })

  return {
    storeId,
    insertPerson: (person: { readonly id: string; readonly name: string; readonly nameKey: string; readonly tokenHash: string; readonly now: number }): void => {
      db.query('INSERT INTO people(id, name, name_key, token_hash, created_at, last_active_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(person.id, person.name, person.nameKey, person.tokenHash, person.now, person.now)
    },
    personById: (id: string): StoredPerson | undefined => personBy('id', id),
    personByTokenHash: (tokenHash: string): StoredPerson | undefined => personBy('token_hash', tokenHash),
    personIdByNameKey: (nameKey: string): string | undefined =>
      db.query<{ id: string }, [string]>('SELECT id FROM people WHERE name_key = ?').get(nameKey)?.id,
    nameKeysStartingWith: (prefix: string): Set<string> => new Set(
      db.query<{ name_key: string }, [string]>('SELECT name_key FROM people WHERE substr(name_key, 1, length(?1)) = ?1').all(prefix).map(row => row.name_key),
    ),
    renamePerson: (id: string, name: string, nameKey: string): void => {
      db.query('UPDATE people SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey, id)
    },
    recordActivity: (id: string, now: number): void => {
      db.query('UPDATE people SET last_active_at = ? WHERE id = ?').run(now, id)
    },
    countPeople: (): number => db.query<{ count: number }, []>('SELECT count(*) AS count FROM people').get()!.count,
    /**
     * Removes People who never had a conversation and were last active before
     * the cutoff, except those listed in `keep` (People with a screen open).
     */
    pruneInactivePeople: (activeBefore: number, keep: ReadonlyArray<string>): number => db.query(`DELETE FROM people WHERE last_active_at < ?1
      AND id NOT IN (SELECT value FROM json_each(?2))
      AND NOT EXISTS (SELECT 1 FROM messages WHERE sender = people.id)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE recipient = people.id)`).run(activeBefore, JSON.stringify(keep)).changes,
    messageBySenderKey,
    pairHasMessages: (a: string, b: string): boolean => maxSeqInPair(conversationPair(a, b)) > 0,
    appendMessage: (message: Omit<StoredMessage, 'seq'>, keep: number): AppendOutcome => {
      if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Conversation retention must be a positive integer')
      return append(message, keep)
    },
    messagesAfter: (person: string, after: number, limit: number): StoredMessage[] => db.query<MessageRow, [string, number, number]>(
      'SELECT * FROM messages WHERE (sender = ?1 OR recipient = ?1) AND seq > ?2 ORDER BY seq LIMIT ?3',
    ).all(person, after, limit).map(messageFromRow),
    maxSeqFor: (person: string): number => db.query<{ seq: number }, [string]>(`SELECT max(
      coalesce((SELECT max(seq) FROM messages WHERE sender = ?1), 0),
      coalesce((SELECT max(seq) FROM messages WHERE recipient = ?1), 0)) AS seq`).get(person)!.seq,
    /** Every conversation involving the Person, newest first. */
    conversations: (person: string): ConversationSummary[] => db.query<SummaryRow, [string]>(`
      SELECT peer, max(seq) AS last_seq, sent_at AS last_sent_at, sum(incoming_unread) AS unread FROM (
        SELECT m.seq, m.sent_at,
          CASE WHEN m.sender = ?1 THEN m.recipient ELSE m.sender END AS peer,
          CASE WHEN m.recipient = ?1 AND m.seq > coalesce(r.through, 0) THEN 1 ELSE 0 END AS incoming_unread
        FROM messages m LEFT JOIN reads r ON r.person = ?1 AND r.peer = m.sender
        WHERE m.sender = ?1 OR m.recipient = ?1
      ) GROUP BY peer ORDER BY last_seq DESC`,
    // SQLite takes the bare sent_at from the row holding max(seq).
    ).all(person).map(row => ({ peer: row.peer, lastSeq: row.last_seq, lastSentAt: row.last_sent_at, unread: row.unread })),
    /** The newest `limit` messages of a conversation, oldest first. */
    conversation: (person: string, peer: string, limit: number): StoredMessage[] => db.query<MessageRow, [string, number]>(
      'SELECT * FROM (SELECT * FROM messages WHERE pair = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
    ).all(conversationPair(person, peer), limit).map(messageFromRow),
    readThrough,
    /** Moves the read marker forward only, never past the conversation's last message. */
    markRead: (person: string, peer: string, through: number): boolean => {
      const target = Math.min(through, maxSeqInPair(conversationPair(person, peer)))
      if (target <= readThrough(person, peer)) return false
      advanceRead(person, peer, target)
      return true
    },
    unreadFrom: (person: string, peer: string): number => db.query<{ count: number }, [string, string, number]>(
      'SELECT count(*) AS count FROM messages WHERE sender = ? AND recipient = ? AND seq > ?',
    ).get(peer, person, readThrough(person, peer))!.count,
    close: (): void => db.close(),
  }
}

export type PeopleStore = ReturnType<typeof createPeopleStore>
