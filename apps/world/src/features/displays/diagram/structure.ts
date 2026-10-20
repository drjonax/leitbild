// Nets and lanes of edges. Edges that share a port (other than a bar's) are
// one hydraulic net: they meet in a tee and may share a routing track.
import type { Model } from './model.ts'

export interface Structure {
  /** Net per edge, named by its smallest edge index. */
  readonly net: ReadonlyArray<number>
  /** The lane an edge belongs to: its lane endpoint's lane, or null when shared. */
  readonly edgeLane: ReadonlyArray<number | null>
}

export const analyseStructure = (model: Model): Structure => {
  const parent = model.edges.map(edge => edge.index)
  const find = (x: number): number => {
    let root = x
    while (parent[root]! !== root) root = parent[root]!
    while (parent[x]! !== root) {
      const next = parent[x]!
      parent[x] = root
      x = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const firstAtPort = new Map<string, number>()
  for (const edge of model.edges) {
    for (const [node, port] of [[edge.from, edge.fromPort], [edge.to, edge.toPort]] as const) {
      if (model.nodes[node]!.role === 'bar') continue
      const key = `${node}:${port}`
      const first = firstAtPort.get(key)
      if (first === undefined) firstAtPort.set(key, edge.index)
      else union(first, edge.index)
    }
  }
  const net = model.edges.map(edge => find(edge.index))
  const edgeLane = model.edges.map(edge => {
    const a = model.nodes[edge.from]!.lane
    const b = model.nodes[edge.to]!.lane
    if (a === null) return b
    if (b === null || a === b) return a
    return null
  })
  return { net, edgeLane }
}
