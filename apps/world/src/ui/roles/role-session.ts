/**
 * The role set this World frame plays in a Run that declares roles. It lives
 * per tab: in the World frame's own URL query (`?roles=a,b`) and in
 * sessionStorage, never in a cookie and never in the Host URL; the Workspace
 * stays in the path. Every Run-scoped World-direct request carries it.
 */

export const roleSetQueryParameter = 'roles'

export interface RoleSetStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

export const roleSetStorageKey = (workspaceId: string, simulationRunId: string): string =>
  `leitbild.world.roles:${workspaceId}:${simulationRunId}`

const roleIdsFromList = (raw: string): ReadonlyArray<string> =>
  [...new Set(raw.split(',').map(value => value.trim()).filter(value => value.length > 0))]

/** The role set named in a URL query, or null when it names none. */
export const roleSetFromSearch = (search: string): ReadonlyArray<string> | null => {
  const raw = new URLSearchParams(search).get(roleSetQueryParameter)
  if (raw === null) return null
  const roleIds = roleIdsFromList(raw)
  return roleIds.length === 0 ? null : roleIds
}

/** The same query with the role set replaced (or removed when null), other parameters kept. */
export const searchWithRoleSet = (search: string, roleIds: ReadonlyArray<string> | null): string => {
  const params = new URLSearchParams(search)
  if (roleIds === null || roleIds.length === 0) params.delete(roleSetQueryParameter)
  else params.set(roleSetQueryParameter, roleIds.join(','))
  const next = params.toString()
  return next.length === 0 ? '' : `?${next}`
}

export const readStoredRoleSet = (storage: RoleSetStorage, key: string): ReadonlyArray<string> | null => {
  const raw = storage.getItem(key)
  if (raw === null) return null
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new Error(`Stored role set is not a list of role ids: ${key}`)
  }
  const roleIds = roleIdsFromList(parsed.join(','))
  return roleIds.length === 0 ? null : roleIds
}

export const writeStoredRoleSet = (storage: RoleSetStorage, key: string, roleIds: ReadonlyArray<string> | null): void => {
  if (roleIds === null || roleIds.length === 0) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify(roleIds))
}

/** The role set a frame opens with: its URL first, then this tab's stored set. */
export const initialRoleSet = (config: {
  readonly search: string
  readonly storage: RoleSetStorage
  readonly key: string
}): ReadonlyArray<string> | null =>
  roleSetFromSearch(config.search) ?? readStoredRoleSet(config.storage, config.key)

export const sameRoleSet = (left: ReadonlyArray<string> | null, right: ReadonlyArray<string> | null): boolean =>
  (left ?? []).length === (right ?? []).length && (left ?? []).every(roleId => (right ?? []).includes(roleId))

let activeRoleSet: ReadonlyArray<string> | null = null

/** Sets the role set Run-scoped requests carry; null in a Run without roles. */
export const configureActiveRoleSet = (roleIds: ReadonlyArray<string> | null): void => {
  activeRoleSet = roleIds === null || roleIds.length === 0 ? null : [...roleIds]
}

export const currentActiveRoleSet = (): ReadonlyArray<string> | null => activeRoleSet

/** A Run-scoped World-direct path with the active role set as its query. */
export const withActiveRoleSet = (path: string): string => {
  if (activeRoleSet === null) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${roleSetQueryParameter}=${encodeURIComponent(activeRoleSet.join(','))}`
}
