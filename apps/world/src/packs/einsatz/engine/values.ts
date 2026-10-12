/**
 * Plain-data helpers for engine records. Records are immutable values whose
 * optional fields are absent rather than `undefined`, so a change that clears
 * a field removes its key.
 */

/** A copy of `value` with `changes` applied; a change to `undefined` removes the key. */
export const patch = <T extends object>(value: T, changes: { readonly [K in keyof T]?: T[K] | undefined }): T => {
  const next = { ...value } as Record<string, unknown>
  for (const [key, entry] of Object.entries(changes)) {
    if (entry === undefined) delete next[key]
    else next[key] = entry
  }
  return next as T
}

/** Structural equality of plain data: objects, arrays and primitives, ignoring key order. */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

/** Counts per id. A zero count is never stored, so an absent id counts zero. */
export type Counts = Readonly<Record<string, number>>

export const countOf = (counts: Counts, id: string): number => counts[id] ?? 0

export const total = (counts: Counts): number => Object.values(counts).reduce((sum, count) => sum + count, 0)

/** Counts in the given key order, dropping zeros. */
export const countsOf = (entries: Iterable<readonly [string, number]>): Counts =>
  Object.fromEntries([...entries].filter(([, count]) => count > 0))

export const addCounts = (order: ReadonlyArray<string>, a: Counts, b: Counts): Counts =>
  countsOf(order.map(id => [id, countOf(a, id) + countOf(b, id)] as const))

export const byId = <T extends { readonly id: string }>(a: T, b: T): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
