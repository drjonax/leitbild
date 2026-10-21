// The generic scope of a topology view (plan v3.1 §2.9, architecture A5): which
// nodes and edges a request draws and where the drawing stops, from the graph
// alone (never from live values), so one request on one graph always draws the
// same. Flow follows edges of the chosen media from port to port, into a node
// by one port and out by a port of the same circuit; groups narrow a drawing
// to their own edges and the shared nodes on routes into and out of them. A
// refusal is a code with what it found; the caller words it.
import type { TopologyEdge, TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'

/** Edges a one-ended or around request follows unless it asks for fewer: a node's neighbours and theirs. */
export const TOPOLOGY_REACH = 3

export interface TopologyRequest {
  readonly from?: ReadonlyArray<string>
  readonly to?: ReadonlyArray<string>
  readonly around?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly media?: ReadonlyArray<string>
  readonly groups?: ReadonlyArray<string>
  readonly reach?: number
  /** What the drawing is about, as named (several nodes for alike items named together): groups never narrow it to none of one. Default: each node of from, to and around alone. */
  readonly anchors?: ReadonlyArray<ReadonlyArray<string>>
}

/** Where a drawing stops: edges of a drawn node to nodes not drawn, one stop per port circuit and direction. */
export interface ScopedStub {
  readonly node: string
  readonly port: string
  /** `out`: flow leaves the drawing here; `in`: flow enters it. */
  readonly direction: 'in' | 'out'
  readonly edges: ReadonlyArray<string>
  readonly others: ReadonlyArray<{ readonly node: string; readonly port: string }>
}

export interface ScopedTopology {
  readonly graph: TopologyGraph
  /** In graph order. */
  readonly nodes: ReadonlyArray<string>
  readonly edges: ReadonlyArray<string>
  readonly stubs: ReadonlyArray<ScopedStub>
  /** Sorted. */
  readonly media: ReadonlyArray<string>
  /** The nodes the view is drawn around or from, in request order: a layout grows away from them. */
  readonly roots: ReadonlyArray<string>
  readonly anchors: ReadonlyArray<ReadonlyArray<string>>
}

export type ScopeRefusal =
  | { readonly code: 'media-ambiguous'; readonly side: 'from' | 'to'; readonly nodes: ReadonlyArray<string>; readonly media: ReadonlyArray<string> }
  | { readonly code: 'no-shared-media' | 'reversed' | 'no-route' | 'unreached'; readonly media: ReadonlyArray<string> }
  | { readonly code: 'groups-empty'; readonly media: ReadonlyArray<string>; readonly reached: ReadonlyArray<string> }
  | { readonly code: 'groups-drop-anchors'; readonly lost: ReadonlyArray<{ readonly anchor: number; readonly groups: ReadonlyArray<string> }> }

export type ScopeResult = { readonly ok: true; readonly scoped: ScopedTopology } | { readonly ok: false; readonly refusal: ScopeRefusal }

/** A graph indexed for scoping: by position, which every order follows. */
interface Indexed {
  readonly graph: TopologyGraph
  readonly node: ReadonlyMap<string, number>
  readonly out: ReadonlyArray<ReadonlyArray<number>>
  readonly into: ReadonlyArray<ReadonlyArray<number>>
  readonly port: (node: number, port: string) => TopologyNode['ports'][number] | undefined
}

const indexes = new WeakMap<TopologyGraph, Indexed>()
const indexed = (graph: TopologyGraph): Indexed => {
  const known = indexes.get(graph)
  if (known !== undefined) return known
  const node = new Map(graph.nodes.map((entry, at) => [entry.id, at]))
  const out: number[][] = graph.nodes.map(() => [])
  const into: number[][] = graph.nodes.map(() => [])
  graph.edges.forEach((edge, at) => {
    out[node.get(edge.from.node)!]!.push(at)
    into[node.get(edge.to.node)!]!.push(at)
  })
  const ports = graph.nodes.map(entry => new Map(entry.ports.map(port => [port.id, port])))
  const made = { graph, node, out, into, port: (at: number, port: string) => ports[at]!.get(port) }
  indexes.set(graph, made)
  return made
}

const sorted = (values: Iterable<number>): ReadonlyArray<number> => [...new Set(values)].sort((left, right) => left - right)
const ends = (g: Indexed, edge: number) => [g.node.get(g.graph.edges[edge]!.from.node)!, g.node.get(g.graph.edges[edge]!.to.node)!] as const
const sameCircuit = (g: Indexed, node: number, a: string, b: string): boolean => {
  const circuit = g.port(node, a)?.circuit
  return circuit !== undefined && circuit === g.port(node, b)?.circuit
}

/**
 * Edges reached from these nodes downstream (or upstream), at most `depth`
 * edges deep: flow leaves a node only by a port of the circuit it entered by,
 * and a directed edge only from its `from` end going down (its `to` end going
 * up); an undirected edge (a grid line) leads from either end to the other.
 */
const reachFrom = (g: Indexed, nodes: ReadonlyArray<number>, media: ReadonlySet<string>, direction: 'down' | 'up', depth?: number): ReadonlySet<number> => {
  type Step = { readonly edge: number; readonly end: string; readonly far: { readonly node: string; readonly port: string } }
  const leaving = (node: number): ReadonlyArray<Step> => {
    const steps: Step[] = []
    for (const edge of direction === 'down' ? g.out[node]! : g.into[node]!) {
      const at = g.graph.edges[edge]!
      if (media.has(at.medium)) steps.push(direction === 'down' ? { edge, end: at.from.port, far: at.to } : { edge, end: at.to.port, far: at.from })
    }
    for (const edge of direction === 'down' ? g.into[node]! : g.out[node]!) {
      const at = g.graph.edges[edge]!
      if (!at.directed && media.has(at.medium)) steps.push(direction === 'down' ? { edge, end: at.to.port, far: at.from } : { edge, end: at.from.port, far: at.to })
    }
    return steps
  }
  const onward = (node: number, port: string): ReadonlyArray<Step> => leaving(node).filter(step => sameCircuit(g, node, port, step.end)
    && (!g.graph.edges[step.edge]!.directed || [direction === 'down' ? 'out' : 'in', 'both'].includes(g.port(node, step.end)?.direction ?? '')))
  const start = nodes.flatMap(leaving)
  const seen = new Set(start.map(step => step.edge))
  let frontier = [...start]
  for (let level = 1; frontier.length > 0 && (depth === undefined || level < depth); level += 1) {
    const next: Step[] = []
    for (const step of frontier) {
      for (const candidate of onward(g.node.get(step.far.node)!, step.far.port)) if (!seen.has(candidate.edge)) { seen.add(candidate.edge); next.push(candidate) }
    }
    frontier = next
  }
  return seen
}

const routeEdges = (g: Indexed, from: ReadonlyArray<number>, to: ReadonlyArray<number>, media: ReadonlySet<string>): ReadonlySet<number> => {
  const upstream = reachFrom(g, to, media, 'up')
  return new Set([...reachFrom(g, from, media, 'down')].filter(edge => upstream.has(edge)))
}

/** The media a node's edges carry on one side, in order: what it delivers (out) or receives (in). */
export const mediaAt = (graph: TopologyGraph, node: string, side: 'in' | 'out'): ReadonlyArray<string> => {
  const g = indexed(graph)
  const at = g.node.get(node)!
  return [...new Set((side === 'in' ? g.into[at]! : g.out[at]!).map(edge => graph.edges[edge]!.medium))].sort()
}

const groupOf = (g: Indexed, edge: number): string | undefined => {
  const at = g.graph.edges[edge]!
  return at.group ?? g.graph.nodes[g.node.get(at.from.node)!]!.group ?? g.graph.nodes[g.node.get(at.to.node)!]!.group
}

const labelOf = (node: TopologyNode): string => node.shortLabel ?? node.label

const stopsOf = (g: Indexed, nodes: ReadonlyArray<number>, drawn: ReadonlySet<number>, media: ReadonlySet<string>, ignoreIncoming: (edge: TopologyEdge) => boolean): ReadonlyArray<ScopedStub> => {
  const drawnNodes = new Set(nodes)
  const byKey = new Map<string, { node: number; direction: 'in' | 'out'; edges: number[]; others: Array<{ node: number; port: string }> }>()
  for (const node of nodes) {
    for (const [direction, list] of [['out', g.out[node]!], ['in', g.into[node]!]] as const) {
      for (const index of list) {
        const edge = g.graph.edges[index]!
        if (drawn.has(index) || !media.has(edge.medium)) continue
        if (direction === 'in' && (ignoreIncoming(edge) || drawnNodes.has(g.node.get(edge.from.node)!))) continue
        const port = direction === 'out' ? edge.from.port : edge.to.port
        // Alike ports of one circuit (a header's outlets) stop the drawing once, naming every far end.
        const key = `${node}|${g.port(node, port)?.circuit ?? port}|${direction}`
        const stop = byKey.get(key) ?? { node, direction, edges: [], others: [] }
        stop.edges.push(index)
        const far = direction === 'out' ? edge.to : edge.from
        stop.others.push({ node: g.node.get(far.node)!, port: far.port })
        byKey.set(key, stop)
      }
    }
  }
  // A stop over alike ports sits at the first of them by name and names its far ends by label, then port.
  const farLabel = (other: { readonly node: number }): string => labelOf(g.graph.nodes[other.node]!)
  return [...byKey.values()]
    .map(stop => ({
      node: stop.node,
      direction: stop.direction,
      port: stop.edges.map(index => (stop.direction === 'out' ? g.graph.edges[index]!.from.port : g.graph.edges[index]!.to.port)).sort()[0]!,
      edges: sorted(stop.edges),
      others: [...stop.others].sort((left, right) => farLabel(left).localeCompare(farLabel(right)) || left.port.localeCompare(right.port) || left.node - right.node),
    }))
    .sort((left, right) => left.node - right.node || left.port.localeCompare(right.port) || left.direction.localeCompare(right.direction))
    .map(stop => ({ ...stop, node: g.graph.nodes[stop.node]!.id, edges: stop.edges.map(index => g.graph.edges[index]!.id), others: stop.others.map(other => ({ node: g.graph.nodes[other.node]!.id, port: other.port })) }))
}

/** Where a drawing of these nodes and edges stops for these media: every other edge of them at a drawn node; flow in that `ignoreIncoming` names is left out. */
export const drawingStops = (graph: TopologyGraph, nodes: ReadonlyArray<string>, edges: ReadonlySet<string>, media: ReadonlySet<string>, ignoreIncoming: (edge: TopologyEdge) => boolean = () => false): ReadonlyArray<ScopedStub> => {
  const g = indexed(graph)
  return stopsOf(g, nodes.map(node => g.node.get(node)!), new Set(graph.edges.flatMap((edge, at) => (edges.has(edge.id) ? [at] : []))), media, ignoreIncoming)
}

const electric = (graph: TopologyGraph): ReadonlySet<string> => new Set(graph.media.filter(medium => medium.kind === 'electric-ac' || medium.kind === 'electric-dc').map(medium => medium.id))

export const scopeTopology = (graph: TopologyGraph, request: TopologyRequest): ScopeResult => {
  const g = indexed(graph)
  const at = (ids: ReadonlyArray<string> | undefined): ReadonlyArray<number> => (ids ?? []).map(id => g.node.get(id)!)
  const [from, to, around, excluded] = [at(request.from), at(request.to), at(request.around), new Set(at(request.exclude))]
  const known = new Set(graph.media.map(medium => medium.id))
  const anchors = request.anchors?.map(at) ?? [...from, ...to, ...around].map(node => [node])
  const ids = (list: Iterable<number>) => [...list].map(node => graph.nodes[node]!.id)

  // Without media, a route uses what its ends deliver and receive, around the media of each item's process (its
  // fluids; power where it carries nothing else); one end must have one medium.
  const delivered = (list: ReadonlyArray<number>) => new Set(list.flatMap(node => mediaAt(graph, graph.nodes[node]!.id, 'out')).filter(medium => known.has(medium)))
  const received = (list: ReadonlyArray<number>) => new Set(list.flatMap(node => mediaAt(graph, graph.nodes[node]!.id, 'in')).filter(medium => known.has(medium)))
  const shared = (left: ReadonlySet<string>, right: ReadonlySet<string>) => new Set([...left].filter(medium => right.has(medium)))
  const power = electric(graph)
  const carriedAt = (node: number): ReadonlySet<string> => new Set([...delivered([node]), ...received([node])])
  const processOf = (node: number): ReadonlyArray<string> => {
    const fluid = [...carriedAt(node)].filter(medium => !power.has(medium))
    return fluid.length > 0 ? fluid : [...carriedAt(node)]
  }
  const route = from.length > 0 && to.length > 0
  const media: ReadonlySet<string> = request.media !== undefined ? new Set(request.media)
    : around.length > 0 ? new Set(around.flatMap(processOf))
      : route ? shared(delivered(from), received(to))
        : from.length > 0 ? delivered(from) : received(to)
  if (request.media === undefined && around.length === 0 && !route && media.size > 1) {
    return { ok: false, refusal: { code: 'media-ambiguous', side: from.length > 0 ? 'from' : 'to', nodes: ids(from.length > 0 ? from : to), media: [...media].sort() } }
  }

  const allowed = new Set(graph.edges.flatMap((edge, index) => media.has(edge.medium) && !ends(g, index).some(node => excluded.has(node)) ? [index] : []))
  const within = (edges: ReadonlySet<number>) => new Set([...edges].filter(edge => allowed.has(edge)))
  const upstreamOf = to.length > 0 && from.length === 0 ? to : around
  const downstreamOf = from.length > 0 && to.length === 0 ? from : around
  const reach = request.reach ?? TOPOLOGY_REACH
  const upstream = within(route || upstreamOf.length === 0 ? new Set() : reachFrom(g, upstreamOf, media, 'up', reach))
  const downstream = within(route || downstreamOf.length === 0 ? new Set() : reachFrom(g, downstreamOf, media, 'down', reach))
  const reached = route ? within(routeEdges(g, from, to, media)) : upstreamOf.length > 0 || downstreamOf.length > 0 ? new Set([...upstream, ...downstream]) : allowed
  // A reach that stops one step short of where the flow starts or ends draws that end too: one symbol says more than
  // a stop at every node it feeds. Only along the reach.
  const endsOf = (edges: ReadonlySet<number>) => new Set([...edges].flatMap(edge => ends(g, edge)))
  const [reachedEnds, upstreamEnds, downstreamEnds] = [endsOf(reached), endsOf(upstream), endsOf(downstream)]
  const carried = (list: ReadonlyArray<number>) => list.filter(edge => allowed.has(edge))
  const terminal = [...allowed].filter(edge => {
    if (reached.has(edge)) return false
    const [source, target] = ends(g, edge)
    return (upstreamEnds.has(target) && !reachedEnds.has(source) && carried(g.into[source]!).length === 0)
      || (downstreamEnds.has(source) && !reachedEnds.has(target) && carried(g.out[target]!).length === 0)
  })
  const selected = new Set([...reached, ...terminal])
  if (selected.size === 0) {
    const reverse = route && routeEdges(g, to, from, request.media !== undefined ? media : shared(delivered(to), received(from))).size > 0
    const code = route && media.size === 0 && !reverse ? 'no-shared-media' : reverse ? 'reversed' : route ? 'no-route' : 'unreached'
    return { ok: false, refusal: { code, media: [...media] } }
  }

  // Groups narrow a drawing to their own edges and the shared ones on routes into or out of them.
  const groups = request.groups === undefined ? undefined : new Set(request.groups)
  const inGroups = (() => {
    if (groups === undefined) return selected
    const own = new Set([...selected].filter(edge => groups.has(groupOf(g, edge) ?? '')))
    const sharedEdges = new Set([...selected].filter(edge => groupOf(g, edge) === undefined))
    const both = new Set([...sharedEdges, ...own])
    const linked = new Set([...reachFrom(g, [...own].map(edge => ends(g, edge)[0]), media, 'up'), ...reachFrom(g, [...own].map(edge => ends(g, edge)[1]), media, 'down')].filter(edge => both.has(edge)))
    return new Set([...own, ...[...sharedEdges].filter(edge => linked.has(edge))])
  })()
  const ordered = graph.groups.map(group => group.id)
  if (inGroups.size === 0) {
    return { ok: false, refusal: { code: 'groups-empty', media: [...media], reached: ordered.filter(group => [...selected].some(edge => groupOf(g, edge) === group)) } }
  }
  const nodes = sorted([...inGroups].flatMap(edge => ends(g, edge)))
  const drawn = new Set(nodes)
  const reachedNodes = endsOf(selected)
  const lost = anchors.flatMap((anchor, index) => anchor.some(node => reachedNodes.has(node)) && !anchor.some(node => drawn.has(node))
    ? [{ anchor: index, groups: [...new Set(anchor.flatMap(node => ordered.filter(group => [...selected].some(edge => ends(g, edge).includes(node) && groupOf(g, edge) === group))))] }]
    : [])
  if (lost.length > 0) return { ok: false, refusal: { code: 'groups-drop-anchors', lost } }
  // Edges among drawn nodes of the drawn media are drawn too (a recirculation line, a cross-tie).
  const edges = sorted([...allowed].filter(edge => inGroups.has(edge)
    || (ends(g, edge).every(node => drawn.has(node)) && (groups === undefined || groupOf(g, edge) === undefined || groups.has(groupOf(g, edge)!)))))
  const drawnEdges = new Set(edges)
  // Narrowed to groups, flow into a shared node from the other groups is not part of the question; flow leaving toward them is.
  const otherGroup = (edge: TopologyEdge): boolean => {
    const group = groupOf(g, graph.edges.findIndex(candidate => candidate === edge))
    return groups !== undefined && group !== undefined && !groups.has(group)
  }
  const stubs = stopsOf(g, nodes, drawnEdges, media, otherGroup)
  // Around items, each medium left out of the drawing stops it at them (a pump's power supply).
  const leftOut = request.media === undefined ? new Set(around.flatMap(node => [...carriedAt(node)]).filter(medium => !media.has(medium))) : new Set<string>()
  const joins = leftOut.size === 0 ? [] : stopsOf(g, around.filter(node => drawn.has(node)), drawnEdges, leftOut, () => false)
  return {
    ok: true,
    scoped: {
      graph, nodes: ids(nodes), edges: edges.map(edge => graph.edges[edge]!.id), stubs: [...stubs, ...joins], media: [...media].sort(),
      roots: ids([...from, ...around]), anchors: anchors.map(ids),
    },
  }
}

/**
 * A scope's parallel supplies: where its flow ends, at a port of a node no
 * drawn fluid edge leaves, every other fluid edge into that port from a node
 * that feeds it once through, not as part of a loop through it. Null where
 * there are none. `drawn` draws each from where its line branches, through
 * the nodes in series on it, and stops the drawing at what feeds that;
 * `stopped` only stops the drawing at the port, naming them.
 */
export const withParallelSupplies = (scoped: ScopedTopology, style: 'drawn' | 'stopped'): ScopedTopology | null => {
  const { graph } = scoped
  const g = indexed(graph)
  const power = electric(graph)
  const isFluid = (edge: number) => !power.has(graph.edges[edge]!.medium)
  const fluidMedia = new Set(graph.media.filter(medium => !power.has(medium.id)).map(medium => medium.id))
  const drawnEdges = new Set(scoped.edges.map(id => graph.edges.findIndex(edge => edge.id === id)))
  const nodes = scoped.nodes.map(id => g.node.get(id)!)
  const endNodes = nodes.filter(node => !g.out[node]!.some(edge => drawnEdges.has(edge) && isFluid(edge)))
  const supplies = endNodes.flatMap(end => {
    const ports = new Set(g.into[end]!.filter(edge => drawnEdges.has(edge) && isFluid(edge)).map(edge => graph.edges[edge]!.to.port))
    if (ports.size === 0) return []
    const looping = new Set([...reachFrom(g, [end], fluidMedia, 'down')].map(edge => ends(g, edge)[1]))
    return g.into[end]!.filter(edge => isFluid(edge) && !drawnEdges.has(edge) && ports.has(graph.edges[edge]!.to.port) && !looping.has(ends(g, edge)[0]))
  })
  if (supplies.length === 0) return null
  const media = new Set(supplies.map(edge => graph.edges[edge]!.medium))
  if (style === 'stopped') {
    const supplied = new Set(supplies)
    const stops = stopsOf(g, [...new Set(supplies.map(edge => ends(g, edge)[1]))], drawnEdges, media, edge => !supplied.has(graph.edges.indexOf(edge)))
    return { ...scoped, stubs: [...scoped.stubs, ...stops] }
  }
  // Upstream through what only passes the flow on (one edge in, one out), to where the supply's line branches.
  const lines = supplies.flatMap(supply => {
    const line = [supply]
    for (let step = 0; step < TOPOLOGY_REACH; step += 1) {
      const source = ends(g, line.at(-1)!)[0]
      const same = (edge: number) => graph.edges[edge]!.medium === graph.edges[supply]!.medium
      const [into, out] = [g.into[source]!.filter(same), g.out[source]!.filter(same)]
      if (into.length !== 1 || out.length !== 1) break
      line.push(into[0]!)
    }
    return line
  })
  const added = sorted(lines.map(edge => ends(g, edge)[0])).filter(node => !nodes.includes(node))
  const edges = sorted([...drawnEdges, ...lines])
  const stops = stopsOf(g, added, new Set(edges), media, () => false)
  return {
    ...scoped,
    nodes: sorted([...nodes, ...added]).map(node => graph.nodes[node]!.id),
    edges: edges.map(edge => graph.edges[edge]!.id),
    stubs: [...scoped.stubs, ...stops],
    media: [...new Set([...scoped.media, ...media])].sort(),
  }
}

/**
 * A scope with its leaves stopped where they join: a node whose one edge of
 * the drawn media brings it flow from a drawn node (in a drawing of power, the
 * loads a bus feeds) becomes part of a stop on what feeds it, unless it is
 * what the drawing is about. Null where there are none: what a drawing too
 * much to read tries, since leaves carry nothing further.
 */
export const withLeavesStopped = (scoped: ScopedTopology): ScopedTopology | null => {
  const { graph } = scoped
  const g = indexed(graph)
  const named = new Set(scoped.anchors.flat())
  const media = new Set(scoped.media)
  const edgesOf = (node: number) => [...g.into[node]!, ...g.out[node]!].filter(edge => media.has(graph.edges[edge]!.medium))
  const drawnEdges = new Set(scoped.edges.map(id => graph.edges.findIndex(edge => edge.id === id)))
  const nodes = scoped.nodes.map(id => g.node.get(id)!)
  const leaves = nodes.filter(node => {
    if (named.has(graph.nodes[node]!.id)) return false
    const edges = edgesOf(node)
    if (edges.length !== 1 || !drawnEdges.has(edges[0]!)) return false
    // Only what the drawn flow ends in: a source is where the flow comes from and stays drawn.
    const [source, target] = ends(g, edges[0]!)
    return target === node && nodes.includes(source)
  })
  if (leaves.length === 0) return null
  const removed = new Set(leaves)
  const leafEdges = new Set(leaves.flatMap(edgesOf))
  const parents = sorted([...leafEdges].map(edge => ends(g, edge)).map(([source, target]) => (removed.has(source) ? target : source)))
  const edges = [...drawnEdges].filter(edge => !leafEdges.has(edge)).sort((left, right) => left - right)
  const parentIds = new Set(parents.map(node => graph.nodes[node]!.id))
  const stops = stopsOf(g, parents, new Set(edges), media, () => false)
  return {
    ...scoped,
    nodes: nodes.filter(node => !removed.has(node)).map(node => graph.nodes[node]!.id),
    edges: edges.map(edge => graph.edges[edge]!.id),
    stubs: [...scoped.stubs.filter(stub => !parentIds.has(stub.node)), ...stops],
  }
}

/** A scope narrowed to some media, with a stop at the given nodes for every other medium they carry, so what it leaves out still shows where it joins. */
export const withOtherMediaStopped = (scoped: ScopedTopology, nodes: ReadonlyArray<string>, media: ReadonlyArray<string>): ScopedTopology => {
  const others = new Set(media.filter(medium => !scoped.media.includes(medium)))
  const stops = drawingStops(scoped.graph, nodes.filter(node => scoped.nodes.includes(node)), new Set(scoped.edges), others)
  return { ...scoped, stubs: [...scoped.stubs, ...stops] }
}
