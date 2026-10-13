// ============================================================================
// PeopleMetrics — process-global aggregate counters for People and direct chat.
//
// Same shape as LimitMetrics (inc + snapshot): counts only, never names,
// message text, tokens or per-Person data. Surfaced with the operator
// diagnostics snapshot together with live gauges (open directories, waiting
// syncs, live screens) that the registry reads at snapshot time.
// ============================================================================

export interface PeopleCounters {
  joins: number
  renames: number
  messagesSent: number
  messagesReplayed: number
  messagesPruned: number
  peoplePruned: number
  syncsImmediate: number
  syncsWoken: number
  syncsHeldToExpiry: number
  syncsAborted: number
  syncsClosed: number
  syncsSuperseded: number
  syncWaiterOverflow: number
  leaves: number
  directoriesEvicted: number
  /** Unexpected failures (storage, invariants), answered as people_unavailable. */
  storeFailures: number
}

export interface PeopleMetricsSnapshot extends PeopleCounters {
  /** Refusals by error code, e.g. people_rate_limited or person_name_taken. */
  readonly rejections: Readonly<Record<string, number>>
}

export interface PeopleMetrics {
  readonly inc: (field: keyof PeopleCounters, by?: number) => void
  readonly reject: (code: string) => void
  readonly snapshot: () => PeopleMetricsSnapshot
}

const zeroCounters = (): PeopleCounters => ({
  joins: 0,
  renames: 0,
  messagesSent: 0,
  messagesReplayed: 0,
  messagesPruned: 0,
  peoplePruned: 0,
  syncsImmediate: 0,
  syncsWoken: 0,
  syncsHeldToExpiry: 0,
  syncsAborted: 0,
  syncsClosed: 0,
  syncsSuperseded: 0,
  syncWaiterOverflow: 0,
  leaves: 0,
  directoriesEvicted: 0,
  storeFailures: 0,
})

export const createPeopleMetrics = (): PeopleMetrics => {
  const counts = zeroCounters()
  const rejections = new Map<string, number>()
  return {
    inc: (field, by = 1) => { counts[field] += by },
    reject: code => { rejections.set(code, (rejections.get(code) ?? 0) + 1) },
    snapshot: () => ({ ...counts, rejections: Object.fromEntries(rejections) }),
  }
}
