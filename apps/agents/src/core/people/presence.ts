// ============================================================================
// Presence — which People have a screen open on which Run, in memory only.
//
// A screen is one browser page instance (a client-random id per page load).
// It is live while it has a sync pending, or for PRESENCE_TIMEOUT_MS after it
// was last seen; a Person is present in a Run while any of their screens
// viewing that Run is live. Nothing here is persisted: a restart forgets
// presence and every screen announces itself again with its next sync.
// ============================================================================

/** A screen that stopped syncing (closed, crashed, offline) disappears after this long. */
export const PRESENCE_TIMEOUT_MS = 30_000

/** Waiting syncs one process holds at most; beyond it, syncs answer at once. */
export const MAX_WAITERS_PER_PROCESS = 1_000

export interface ScreenEntry {
  readonly personId: string
  readonly screenId: string
  viewingKey: string
  lastSeenAt: number
  pending: number
}

/** `now` is a monotonic clock, so a wall-clock step never expires or revives a screen. */
export const createPresence = (options: { readonly now: () => number; readonly timeoutMs?: number }) => {
  const timeoutMs = options.timeoutMs ?? PRESENCE_TIMEOUT_MS
  const screens = new Map<string, ScreenEntry>()
  const keyOf = (personId: string, screenId: string): string => `${personId}|${screenId}`
  const isLive = (entry: ScreenEntry, now: number): boolean => entry.pending > 0 || now - entry.lastSeenAt < timeoutMs

  return {
    /**
     * Records that a screen of this Person is viewing `viewingKey` now.
     * `changed` is true when what other People see may differ: a new screen,
     * a screen that switched Run, or one that had already expired.
     */
    touch: (personId: string, screenId: string, viewingKey: string): { readonly entry: ScreenEntry; readonly changed: boolean } => {
      const now = options.now()
      const key = keyOf(personId, screenId)
      const existing = screens.get(key)
      if (!existing) {
        const entry: ScreenEntry = { personId, screenId, viewingKey, lastSeenAt: now, pending: 0 }
        screens.set(key, entry)
        return { entry, changed: true }
      }
      const changed = existing.viewingKey !== viewingKey || !isLive(existing, now)
      existing.viewingKey = viewingKey
      existing.lastSeenAt = now
      return { entry: existing, changed }
    },
    /** A pending sync keeps its screen live however long it waits. */
    hold: (entry: ScreenEntry): void => { entry.pending += 1 },
    /**
     * Ends one pending sync. An answered sync counts as seen now; an aborted
     * one does not, so a closed page expires from when it was last seen.
     * A screen removed by leave() meanwhile is detached and stays removed.
     */
    release: (entry: ScreenEntry, seen: boolean): void => {
      if (entry.pending < 1) throw new Error('Presence release without a pending sync')
      entry.pending -= 1
      if (seen) entry.lastSeenAt = options.now()
    },
    remove: (personId: string, screenId: string): boolean => screens.delete(keyOf(personId, screenId)),
    /** Forgets expired screens; returns how many expired. */
    sweep: (): number => {
      const now = options.now()
      let removed = 0
      for (const [key, entry] of screens) {
        if (!isLive(entry, now)) { screens.delete(key); removed += 1 }
      }
      return removed
    },
    /** People with a live screen viewing this Run. */
    presentIn: (viewingKey: string): Set<string> => {
      const now = options.now()
      const present = new Set<string>()
      for (const entry of screens.values()) {
        if (entry.viewingKey === viewingKey && isLive(entry, now)) present.add(entry.personId)
      }
      return present
    },
    /** People with any live screen, whichever Run it views. */
    livePeople: (): Set<string> => {
      const now = options.now()
      const live = new Set<string>()
      for (const entry of screens.values()) if (isLive(entry, now)) live.add(entry.personId)
      return live
    },
    liveScreenCount: (now: number = options.now()): number => {
      let live = 0
      for (const entry of screens.values()) if (isLive(entry, now)) live += 1
      return live
    },
    clear: (): void => screens.clear(),
  }
}

export type Presence = ReturnType<typeof createPresence>

/** Process-wide count of waiting syncs, shared by every Workspace's People directory. */
export const createWaiterBudget = (max: number = MAX_WAITERS_PER_PROCESS) => {
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('Waiter budget must be a non-negative integer')
  let held = 0
  return {
    available: (): boolean => held < max,
    tryTake: (): boolean => {
      if (held >= max) return false
      held += 1
      return true
    },
    release: (): void => {
      if (held < 1) throw new Error('Waiter budget released more often than taken')
      held -= 1
    },
    held: (): number => held,
  }
}

export type WaiterBudget = ReturnType<typeof createWaiterBudget>

/** Waiting syncs of one directory, in registration order (oldest first). */
export const createWaiterSet = <W extends { readonly personId: string }>() => {
  const waiters = new Set<W>()
  return {
    add: (waiter: W): void => { waiters.add(waiter) },
    delete: (waiter: W): boolean => waiters.delete(waiter),
    has: (waiter: W): boolean => waiters.has(waiter),
    forPerson: (personId: string): W[] => [...waiters].filter(waiter => waiter.personId === personId),
    all: (): W[] => [...waiters],
    size: (): number => waiters.size,
  }
}
