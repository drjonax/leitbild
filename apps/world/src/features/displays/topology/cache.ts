// Drawings kept across rooms (architecture A5): keyed by the graph's identity
// and revision, what the view draws and how it is sized, so a new revision or
// a new sizing never meets an old drawing; the one used longest ago goes first.
import { DIAGRAM_ENGINE_VERSION } from '../diagram/index.ts'
import type { ScopedTopology } from './scope.ts'

/** What a drawing of this scope under this sizing depends on. */
export const drawingKey = (scoped: ScopedTopology, sizingKey: string): string => JSON.stringify([
  scoped.graph.objectId, scoped.graph.revision, scoped.graph.family, scoped.nodes, scoped.edges, scoped.stubs, scoped.media, sizingKey, DIAGRAM_ENGINE_VERSION,
])

export const drawingCache = <T>(limit: number) => {
  const entries = new Map<string, T>()
  return {
    get: (key: string, make: () => T): T => {
      const known = entries.get(key)
      if (known !== undefined) {
        entries.delete(key)
        entries.set(key, known)
        return known
      }
      const made = make()
      if (entries.size >= limit) entries.delete(entries.keys().next().value!)
      entries.set(key, made)
      return made
    },
  }
}
