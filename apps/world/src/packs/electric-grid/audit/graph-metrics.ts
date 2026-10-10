// Small undirected multigraph helpers for the grid audit. Nodes are bus ids; edges keep an
// index so parallel branches stay distinct (two circuits are not a bridge).

export interface AuditEdge {
  readonly index: number
  readonly a: string
  readonly b: string
  readonly capacity: number
}

export interface AuditMultigraph {
  readonly nodes: ReadonlyArray<string>
  readonly edges: ReadonlyArray<AuditEdge>
  readonly incident: ReadonlyMap<string, ReadonlyArray<AuditEdge>>
}

export const createMultigraph = (
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ readonly a: string; readonly b: string; readonly capacity: number }>,
): AuditMultigraph => {
  const nodeSet = new Set(nodes)
  const incident = new Map<string, AuditEdge[]>(nodes.map(node => [node, []]))
  const indexed = edges.map((edge, index): AuditEdge => {
    if (!nodeSet.has(edge.a) || !nodeSet.has(edge.b)) throw new Error(`audit edge ${edge.a}–${edge.b} references a node outside the graph`)
    return { index, a: edge.a, b: edge.b, capacity: edge.capacity }
  })
  for (const edge of indexed) {
    incident.get(edge.a)!.push(edge)
    if (edge.b !== edge.a) incident.get(edge.b)!.push(edge)
  }
  return { nodes, edges: indexed, incident }
}

const other = (edge: AuditEdge, node: string): string => edge.a === node ? edge.b : edge.a

/** Connected components, largest first (ties broken by smallest node id for determinism). */
export const connectedComponents = (
  graph: AuditMultigraph,
  skip: { readonly edgeIndex?: number; readonly node?: string } = {},
): ReadonlyArray<ReadonlyArray<string>> => {
  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of graph.nodes) {
    if (seen.has(start) || start === skip.node) continue
    const component: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      const current = stack.pop()!
      component.push(current)
      for (const edge of graph.incident.get(current) ?? []) {
        if (edge.index === skip.edgeIndex) continue
        const next = other(edge, current)
        if (next === skip.node || seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    components.push(component.sort())
  }
  return components.sort((left, right) => right.length - left.length || (left[0]! < right[0]! ? -1 : 1))
}

/** Bridges (edge indices) and articulation points via an iterative Tarjan walk. */
export const bridgesAndArticulationPoints = (graph: AuditMultigraph): {
  readonly bridges: ReadonlyArray<number>
  readonly articulationPoints: ReadonlyArray<string>
} => {
  const discovery = new Map<string, number>()
  const low = new Map<string, number>()
  const bridges: number[] = []
  const articulation = new Set<string>()
  let time = 0
  for (const root of graph.nodes) {
    if (discovery.has(root)) continue
    discovery.set(root, time)
    low.set(root, time)
    time += 1
    let rootChildren = 0
    const stack: Array<{ node: string; parentEdge: number; next: number }> = [{ node: root, parentEdge: -1, next: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const edges = graph.incident.get(frame.node) ?? []
      if (frame.next < edges.length) {
        const edge = edges[frame.next]!
        frame.next += 1
        if (edge.index === frame.parentEdge || edge.a === edge.b) continue
        const next = other(edge, frame.node)
        if (discovery.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, discovery.get(next)!))
          continue
        }
        discovery.set(next, time)
        low.set(next, time)
        time += 1
        if (frame.node === root) rootChildren += 1
        stack.push({ node: next, parentEdge: edge.index, next: 0 })
        continue
      }
      stack.pop()
      const parent = stack[stack.length - 1]
      if (!parent) continue
      low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node)! > discovery.get(parent.node)!) bridges.push(frame.parentEdge)
      if (parent.node !== root && low.get(frame.node)! >= discovery.get(parent.node)!) articulation.add(parent.node)
    }
    if (rootChildren > 1) articulation.add(root)
  }
  return { bridges: bridges.sort((left, right) => left - right), articulationPoints: [...articulation].sort() }
}

/**
 * Maximum number of edge-disjoint unit paths (edge capacity = circuits) from any source to any
 * sink, travelling only through nodes accepted by `passable`. Edmonds–Karp on tiny subgraphs.
 */
export const maximumCircuitFlow = (
  graph: AuditMultigraph,
  sources: ReadonlySet<string>,
  sinks: ReadonlySet<string>,
  passable: (node: string) => boolean,
): number => {
  const residual = new Map<number, { forward: number; backward: number }>()
  for (const edge of graph.edges) residual.set(edge.index, { forward: edge.capacity, backward: edge.capacity })
  const capacityFrom = (edge: AuditEdge, from: string): number => {
    const state = residual.get(edge.index)!
    return edge.a === from ? state.forward : state.backward
  }
  let flow = 0
  for (;;) {
    const previous = new Map<string, { edge: AuditEdge; from: string } | null>()
    const queue: string[] = []
    for (const source of sources) {
      previous.set(source, null)
      queue.push(source)
    }
    let reached: string | null = null
    while (queue.length > 0 && reached === null) {
      const current = queue.shift()!
      for (const edge of graph.incident.get(current) ?? []) {
        const next = other(edge, current)
        if (previous.has(next) || capacityFrom(edge, current) <= 0) continue
        if (!sinks.has(next) && !passable(next)) continue
        previous.set(next, { edge, from: current })
        if (sinks.has(next)) {
          reached = next
          break
        }
        queue.push(next)
      }
    }
    if (reached === null) return flow
    let bottleneck = Number.POSITIVE_INFINITY
    for (let node = reached, step = previous.get(node); step; node = step.from, step = previous.get(node)) {
      bottleneck = Math.min(bottleneck, capacityFrom(step.edge, step.from))
    }
    for (let node = reached, step = previous.get(node); step; node = step.from, step = previous.get(node)) {
      const state = residual.get(step.edge.index)!
      if (step.edge.a === step.from) {
        state.forward -= bottleneck
        state.backward += bottleneck
      } else {
        state.backward -= bottleneck
        state.forward += bottleneck
      }
    }
    flow += bottleneck
  }
}
