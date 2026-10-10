/** Symmetric sparsity pattern: the neighbours of v are `adjacency[start[v] .. start[v + 1])`, excluding v, without duplicates. */
export interface SymmetricPattern {
  readonly size: number
  readonly start: Int32Array
  readonly adjacency: Int32Array
}

export interface EliminationOrdering {
  readonly size: number
  /** `perm[k]` is the vertex eliminated at step k; `iperm` is its inverse. */
  readonly perm: Int32Array
  readonly iperm: Int32Array
  /** Vertices adjacent to `perm[k]` when it is eliminated: `pattern[patternStart[k] .. patternStart[k + 1])`, the off-diagonal rows of factor column k. */
  readonly patternStart: Int32Array
  readonly pattern: Int32Array
}

/**
 * Fill-reducing minimum-degree ordering on the explicit elimination graph. Eliminating a
 * vertex turns its neighbours into a clique; the neighbour set at elimination time is
 * exactly the off-diagonal pattern of its Cholesky column, so the symbolic analysis
 * falls out of the ordering. Degree buckets make each pick O(1); transmission graphs keep
 * the cliques small, so the update cost stays near linear in the factor size.
 */
export const minimumDegreeOrdering = (graph: SymmetricPattern): EliminationOrdering => {
  const n = graph.size
  const neighbours: number[][] = new Array<number[]>(n)
  for (let vertex = 0; vertex < n; vertex += 1) {
    neighbours[vertex] = Array.from(graph.adjacency.subarray(graph.start[vertex]!, graph.start[vertex + 1]!))
  }
  const head = new Int32Array(n).fill(-1)
  const next = new Int32Array(n)
  const previous = new Int32Array(n)
  const degree = new Int32Array(n)
  const insert = (vertex: number, vertexDegree: number): void => {
    const first = head[vertexDegree]!
    degree[vertex] = vertexDegree
    previous[vertex] = -1
    next[vertex] = first
    if (first !== -1) previous[first] = vertex
    head[vertexDegree] = vertex
  }
  const detach = (vertex: number): void => {
    const before = previous[vertex]!
    const after = next[vertex]!
    if (before === -1) head[degree[vertex]!] = after
    else next[before] = after
    if (after !== -1) previous[after] = before
  }
  for (let vertex = 0; vertex < n; vertex += 1) insert(vertex, neighbours[vertex]!.length)
  const perm = new Int32Array(n)
  const iperm = new Int32Array(n)
  const patternStart = new Int32Array(n + 1)
  const pattern: number[] = []
  const marker = new Int32Array(n)
  let stamp = 0
  let minimumDegree = 0
  for (let step = 0; step < n; step += 1) {
    while (head[minimumDegree] === -1) minimumDegree += 1
    const pivot = head[minimumDegree]!
    detach(pivot)
    perm[step] = pivot
    iperm[pivot] = step
    const clique = neighbours[pivot]!
    neighbours[pivot] = []
    for (const vertex of clique) pattern.push(vertex)
    patternStart[step + 1] = pattern.length
    for (const vertex of clique) {
      detach(vertex)
      const adjacent = neighbours[vertex]!
      const at = adjacent.indexOf(pivot)
      if (at === -1) throw new Error(`sparsity pattern is not symmetric: ${vertex} does not list ${pivot}`)
      adjacent[at] = adjacent[adjacent.length - 1]!
      adjacent.pop()
      stamp += 1
      marker[vertex] = stamp
      for (const other of adjacent) marker[other] = stamp
      for (const other of clique) {
        if (marker[other] === stamp) continue
        marker[other] = stamp
        adjacent.push(other)
      }
      insert(vertex, adjacent.length)
      if (adjacent.length < minimumDegree) minimumDegree = adjacent.length
    }
  }
  return { size: n, perm, iperm, patternStart, pattern: Int32Array.from(pattern) }
}
