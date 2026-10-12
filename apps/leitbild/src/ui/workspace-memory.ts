// The remembered Workspace (plan v2 §2, coordinator ruling 6). A browser-local,
// advisory hint in localStorage: never a cookie, never read by a server, never
// a redirect. Every request still names its Workspace in the URL path.
//
// - `remember` sets the launch/Ask default ("Continue in …") and is called ONLY
//   when the user creates a Workspace here, picks one in the switcher, launches
//   a demo or asks the Assistant.
// - `visited` (opening a shared /workspaces/<id> link) only adds to "Recent in
//   this browser"; it never makes the Workspace the default.
// - Storage that is missing or throws (private mode, blocked site data) means
//   "nothing remembered" and writes are dropped. That is the stated rule for an
//   advisory hint, not a fallback: the page works the same without it.

export const LAST_WORKSPACE_KEY = 'leitbild:last-workspace'
export const RECENT_WORKSPACES_KEY = 'leitbild:recent-workspaces'
export const RECENT_LIMIT = 5

export type WorkspaceMemoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** The explicit choices that may set the default. Visiting a link is not one of them. */
export type RememberReason = 'created' | 'picked' | 'launched' | 'asked'

export interface WorkspaceMemory {
  /** The default for launches and Ask, or null. */
  remembered(): string | null
  /** "Recent in this browser", newest first, at most 5. */
  recent(): ReadonlyArray<string>
  remember(workspaceId: string, reason: RememberReason): void
  visited(workspaceId: string): void
  /** The Workspace no longer exists (404) or was deleted here. */
  forget(workspaceId: string): void
}

// Workspace ids are UUIDs (`workspaceIdSchema` = `z.uuid()` in contracts). The
// same pattern is checked here so the landing bundle does not load zod for a hint.
const uuid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/
export const isWorkspaceId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)

const attempt = <T>(action: () => T, otherwise: T): T => {
  try { return action() } catch { return otherwise }
}

export const createWorkspaceMemory = (storage: WorkspaceMemoryStorage | null): WorkspaceMemory => {
  const read = (key: string): string | null => storage === null ? null : attempt(() => storage.getItem(key), null)
  const write = (key: string, value: string): void => { if (storage !== null) attempt(() => storage.setItem(key, value), undefined) }
  const remove = (key: string): void => { if (storage !== null) attempt(() => storage.removeItem(key), undefined) }

  const recent = (): ReadonlyArray<string> => {
    const raw = read(RECENT_WORKSPACES_KEY)
    if (raw === null) return []
    const parsed = attempt<unknown>(() => JSON.parse(raw), null)
    const ids = Array.isArray(parsed) ? [...new Set(parsed.filter(isWorkspaceId))].slice(0, RECENT_LIMIT) : []
    if (!Array.isArray(parsed) || ids.length !== parsed.length) {
      if (ids.length === 0) remove(RECENT_WORKSPACES_KEY)
      else write(RECENT_WORKSPACES_KEY, JSON.stringify(ids))
    }
    return ids
  }
  const addRecent = (workspaceId: string): void => {
    write(RECENT_WORKSPACES_KEY, JSON.stringify([workspaceId, ...recent().filter(id => id !== workspaceId)].slice(0, RECENT_LIMIT)))
  }

  return {
    remembered: () => {
      const value = read(LAST_WORKSPACE_KEY)
      if (value === null) return null
      if (isWorkspaceId(value)) return value
      remove(LAST_WORKSPACE_KEY)
      return null
    },
    recent,
    remember: (workspaceId, _reason) => {
      if (!isWorkspaceId(workspaceId)) throw new Error(`Not a Workspace id: ${workspaceId}`)
      write(LAST_WORKSPACE_KEY, workspaceId)
      addRecent(workspaceId)
    },
    visited: workspaceId => {
      if (!isWorkspaceId(workspaceId)) throw new Error(`Not a Workspace id: ${workspaceId}`)
      addRecent(workspaceId)
    },
    forget: workspaceId => {
      if (read(LAST_WORKSPACE_KEY) === workspaceId) remove(LAST_WORKSPACE_KEY)
      const kept = recent().filter(id => id !== workspaceId)
      if (kept.length === 0) remove(RECENT_WORKSPACES_KEY)
      else write(RECENT_WORKSPACES_KEY, JSON.stringify(kept))
    },
  }
}

/** The page's memory. Reading `localStorage` itself can throw, so it is guarded too. */
export const browserWorkspaceMemory = (): WorkspaceMemory =>
  createWorkspaceMemory(attempt<WorkspaceMemoryStorage | null>(() => globalThis.localStorage ?? null, null))
