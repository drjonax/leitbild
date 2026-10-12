import type { CommandEnvelope, CommandResult } from '../model/index.ts'
import type { Actor } from './actors.ts'

export const defaultCommandIdempotencyTtlMs = 60 * 60 * 1_000
export const defaultCommandIdempotencyMaxEntries = 10_000

interface IdempotencyEntry {
  readonly firstSeenMs: number
  readonly tupleKey: string
  readonly bodyFingerprint: string
  readonly inFlight?: Promise<CommandResult>
  readonly result?: CommandResult
}

export interface CommandIdempotencyStore {
  readonly entries: Map<string, IdempotencyEntry>
}

export type IdempotentCommandIssueResult =
  | {
      readonly ok: true
      readonly result: CommandResult
      readonly replayed: boolean
    }
  | {
      readonly ok: false
      readonly status: 409
      readonly code: 'idempotency_conflict'
      readonly message: string
    }

export interface CommandIdempotencyConfig {
  readonly ttlMs: number
  readonly maxEntries: number
}

export class CommandIdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict'
  readonly status = 409
}

export const createCommandIdempotencyStore = (): CommandIdempotencyStore => ({
  entries: new Map(),
})

export const commandIdempotencyConfigFromEnv = (env: Record<string, string | undefined> = process.env): CommandIdempotencyConfig => ({
  ttlMs: positiveIntegerFromEnv(env.LEITBILD_IDEMPOTENCY_TTL_MS, defaultCommandIdempotencyTtlMs),
  maxEntries: positiveIntegerFromEnv(env.LEITBILD_IDEMPOTENCY_MAX_ENTRIES, defaultCommandIdempotencyMaxEntries),
})

const positiveIntegerFromEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

export const commandBodyFingerprint = (command: CommandEnvelope): string =>
  stableJson({
    expectedRevision: command.expectedRevision ?? null,
    payload: command.payload,
    targetObjectIds: command.targetObjectIds,
    ...(command.roleIds === undefined ? {} : { roleIds: command.roleIds }),
  })

export const commandIdempotencyTupleKey = (command: CommandEnvelope): string | null => {
  if (!command.idempotencyKey) return null
  return stableJson([
    command.simulationRunId,
    command.actorId,
    command.clientId ?? null,
    command.kind,
    command.idempotencyKey,
  ])
}

const pruneExpired = (
  store: CommandIdempotencyStore,
  nowMs: number,
  ttlMs: number,
): void => {
  for (const [key, entry] of store.entries) {
    if (nowMs - entry.firstSeenMs >= ttlMs) {
      store.entries.delete(key)
    }
  }
}

const pruneToMaxEntries = (
  store: CommandIdempotencyStore,
  maxEntries: number,
): void => {
  while (store.entries.size > maxEntries) {
    const oldest = [...store.entries]
      .sort((left, right) => left[1].firstSeenMs - right[1].firstSeenMs)[0]
    if (!oldest) return
    store.entries.delete(oldest[0])
  }
}

export const issueCommandWithIdempotency = async (config: {
  readonly store: CommandIdempotencyStore
  readonly idempotency: CommandIdempotencyConfig
  readonly actor: Actor
  readonly command: CommandEnvelope
  readonly issue: (actor: Actor, command: CommandEnvelope) => Promise<CommandResult>
  readonly nowMs?: number
}): Promise<IdempotentCommandIssueResult> => {
  const nowMs = config.nowMs ?? Date.now()
  const tupleKey = commandIdempotencyTupleKey(config.command)
  if (!tupleKey) {
    return {
      ok: true,
      result: await config.issue(config.actor, config.command),
      replayed: false,
    }
  }

  pruneExpired(config.store, nowMs, config.idempotency.ttlMs)

  const bodyFingerprint = commandBodyFingerprint(config.command)
  const existing = config.store.entries.get(tupleKey)
  if (existing) {
    if (existing.bodyFingerprint !== bodyFingerprint) {
      return {
        ok: false,
        status: 409,
        code: 'idempotency_conflict',
        message: 'idempotency key was reused with a different command body',
      }
    }
    if (existing.result) {
      return { ok: true, result: existing.result, replayed: true }
    }
    if (existing.inFlight) {
      return { ok: true, result: await existing.inFlight, replayed: true }
    }
  }

  const inFlight = config.issue(config.actor, config.command)
  config.store.entries.set(tupleKey, {
    firstSeenMs: nowMs,
    tupleKey,
    bodyFingerprint,
    inFlight,
  })
  pruneToMaxEntries(config.store, config.idempotency.maxEntries)

  try {
    const result = await inFlight
    const current = config.store.entries.get(tupleKey)
    if (current?.inFlight === inFlight) {
      config.store.entries.set(tupleKey, {
        firstSeenMs: current.firstSeenMs,
        tupleKey,
        bodyFingerprint,
        result,
      })
    }
    return { ok: true, result, replayed: false }
  } catch (err) {
    const current = config.store.entries.get(tupleKey)
    if (current?.inFlight === inFlight) {
      config.store.entries.delete(tupleKey)
    }
    throw err
  }
}
