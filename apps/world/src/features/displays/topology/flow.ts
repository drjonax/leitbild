// The `flow` family's drawing (plan v3.1 §2.9, architecture A5): a scoped
// topology as the layered P&ID-style diagram the engine lays out. Hidden nodes
// and the edges they end become stops; a node without a group on a lane takes
// its neighbours' lane where its sizing lets it; a node the lanes leave and
// return to is their hub; alike nodes with the same far ends draw as one item;
// devices in line on an edge's ends are chained into it. What each item says
// and how big it is, the caller's sizing decides, and what it keeps of an
// item comes back with it.
import type { DiagramEdge, DiagramGraph, DiagramNode } from '../diagram/index.ts'
import type { TopologyEdge, TopologyNode } from '../../../core/observation/topology.ts'
import type { ScopedStub, ScopedTopology } from './scope.ts'

export type FlowRole = 'device' | 'bar' | 'hub'

/** What the sizing is asked to draw: a node (a group's members with it), or a device chained in line on its host's port. */
export interface FlowItem {
  readonly node: TopologyNode
  readonly members: ReadonlyArray<TopologyNode>
  readonly role: FlowRole
  /** The ports its drawn edges and stops use, sorted; `piped`, those drawn edges reach. */
  readonly ports: ReadonlyArray<string>
  readonly piped: ReadonlySet<string>
  /** An in-line device: its key on the host's port. */
  readonly device?: string
}

/** A stop as drawn: the item it stops at, with its edges and far ends. */
export interface FlowStop extends Omit<ScopedStub, 'node'> {
  readonly node: TopologyNode
}

export interface FlowSizing<T> {
  /** What the sizing depends on, for drawings cached across rooms. */
  readonly key: string
  /** Visibility: whether a node is drawn; an edge between a hidden node and a drawn one stops the drawing. */
  readonly visible: (node: TopologyNode) => boolean
  /** Visibility: an edge into a hidden node that ends the flow with no stop (a relief line venting out of the system). */
  readonly silent: (edge: TopologyEdge) => boolean
  /** Role: whether a node draws as a bar (a header, a bus) spanning what it connects; others draw as devices, or as the lanes' hub. */
  readonly bar: (node: TopologyNode) => boolean
  /** Lane inference: whether a node without a group takes the one group all its drawn neighbours have. */
  readonly infersLane: (node: TopologyNode) => boolean
  /** Parallel group key: alike nodes of one key, lane, ports and far ends draw as one item; null never groups; absent, nothing groups. */
  readonly groupKey?: (node: TopologyNode) => string | null
  /** In-line chain: the devices drawn in series where an edge meets this node's port, by key, in order. */
  readonly chain: (node: TopologyNode, port: string) => ReadonlyArray<string>
  /** Ids: an item's drawing id (an in-line device's with its key), and an edge's (each segment adds `.n`). */
  readonly itemId: (node: TopologyNode, device?: string) => string
  readonly edgeId: (edge: TopologyEdge) => string
  /** Rank parts: the label a node is known by, which orders a group's members. */
  readonly label: (node: TopologyNode) => string
  /** Sizing: an item's footprint, text and frame, its label (the last of its rank parts), and what the caller keeps of it. */
  readonly item: (item: FlowItem) => { readonly label: string; readonly node: Omit<DiagramNode, 'id' | 'rank' | 'role' | 'ports' | 'partition'>; readonly keep: T }
  /** Sizing: a stop's text. */
  readonly stop: (stop: FlowStop) => DiagramNode['text']
}

export interface FlowPlan<T> {
  readonly graph: DiagramGraph
  /** By drawing id, in the order drawn. */
  readonly items: ReadonlyMap<string, { readonly item: FlowItem; readonly keep: T }>
  /** Per diagram edge, the topology edge it draws and the edges of grouped members it stands for too. */
  readonly edges: ReadonlyMap<string, { readonly edge: string; readonly parallel: ReadonlyArray<string> }>
  readonly stops: ReadonlyMap<string, FlowStop>
}

const partitionOf = (group: string | undefined, lanes: ReadonlyMap<string, { readonly key: string; readonly order: number }>): DiagramNode['partition'] | undefined =>
  group === undefined ? undefined : lanes.get(group)

export const flowPlan = <T>(scoped: ScopedTopology, sizing: FlowSizing<T>): FlowPlan<T> => {
  const graph = scoped.graph
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const edgeById = new Map(graph.edges.map((edge, index) => [edge.id, { edge, index }]))
  const lanes = new Map(graph.groups.flatMap(group => (group.lane === undefined ? [] : [[group.id, group.lane] as const])))
  const portOf = (node: string, port: string) => nodeById.get(node)!.ports.find(candidate => candidate.id === port)
  const hidden = new Set(scoped.nodes.filter(id => !sizing.visible(nodeById.get(id)!)))
  const scopedEdges = scoped.edges.map(id => edgeById.get(id)!.edge)
  const edges = scopedEdges.filter(edge => !hidden.has(edge.from.node) && !hidden.has(edge.to.node))
  const extraStops: ScopedStub[] = scopedEdges.flatMap((edge): ScopedStub[] => {
    if (hidden.has(edge.to.node) && !hidden.has(edge.from.node) && !sizing.silent(edge)) return [{ node: edge.from.node, port: edge.from.port, direction: 'out', edges: [edge.id], others: [edge.to] }]
    if (hidden.has(edge.from.node) && !hidden.has(edge.to.node)) return [{ node: edge.to.node, port: edge.to.port, direction: 'in', edges: [edge.id], others: [edge.from] }]
    return []
  })
  // A hidden node has no ends to stop at: what else flows into it is not this drawing's.
  const scopeStops = [...scoped.stubs.filter(stub => !hidden.has(stub.node)), ...extraStops]
  const farLabel = (node: string): string => nodeById.get(node)!.shortLabel ?? nodeById.get(node)!.label

  const usedPorts = new Map<string, Set<string>>()
  const usePort = (node: string, port: string) => usedPorts.set(node, new Set([...(usedPorts.get(node) ?? []), port]))
  for (const edge of edges) {
    usePort(edge.from.node, edge.from.port)
    usePort(edge.to.node, edge.to.port)
  }
  const piped = new Map([...usedPorts].map(([node, ports]) => [node, new Set(ports)]))
  for (const stop of scopeStops) usePort(stop.node, stop.port)

  const drawn = scoped.nodes.filter(id => !hidden.has(id))
  const drawnEdgeIds = new Set(scoped.edges)
  // A node without a group that groups leave and return to is their hub: edges of two or more groups on both
  // sides, or one group leaving it and returning (the vessel a plant's loops share).
  const groupsAt = (id: string, side: 'in' | 'out') => new Set(scopedEdges
    .filter(edge => drawnEdgeIds.has(edge.id) && (side === 'in' ? edge.to.node : edge.from.node) === id)
    .map(edge => nodeById.get(side === 'in' ? edge.from.node : edge.to.node)!.group)
    .filter((group): group is string => group !== undefined))
  const hubs = new Set(drawn.filter(id => {
    const node = nodeById.get(id)!
    if (sizing.bar(node) || node.group !== undefined) return false
    const [returning, leaving] = [groupsAt(id, 'in'), groupsAt(id, 'out')]
    return (returning.size >= 2 && leaving.size >= 2) || [...returning].some(group => leaving.has(group))
  }))
  const inferred = new Map(drawn.flatMap(id => {
    const node = nodeById.get(id)!
    if (node.group !== undefined || !sizing.infersLane(node)) return []
    const neighbours = edges.flatMap(edge => (edge.from.node === id ? [edge.to.node] : edge.to.node === id ? [edge.from.node] : []))
    const groups = new Set(neighbours.map(neighbour => nodeById.get(neighbour)!.group))
    const [group] = groups
    return groups.size === 1 && group !== undefined ? [[id, group] as const] : []
  }))
  const laneOf = (id: string): string | undefined => nodeById.get(id)!.group ?? inferred.get(id)

  // Alike nodes the sizing groups: one key, lane and ports, and on each port the same far ends (alike ports of a
  // bar count as one) and the same stops. Members in label order.
  const representative = new Map<string, string>()
  const members = new Map<string, ReadonlyArray<string>>()
  if (sizing.groupKey !== undefined) {
    const farKey = (node: string, port: string): string => sizing.bar(nodeById.get(node)!) ? `${node}|${portOf(node, port)?.circuit ?? port}` : `${node}|${port}`
    const signature = (id: string): string | null => {
      const node = nodeById.get(id)!
      const key = sizing.bar(node) || hubs.has(id) ? null : sizing.groupKey!(node)
      if (key === null) return null
      const ports = [...(usedPorts.get(id) ?? [])].sort()
      if (ports.some(port => sizing.chain(node, port).length > 0)) return null
      const sides = ports.map(port => {
        const out = edges.filter(edge => edge.from.node === id && edge.from.port === port).map(edge => farKey(edge.to.node, edge.to.port))
        const into = edges.filter(edge => edge.to.node === id && edge.to.port === port).map(edge => farKey(edge.from.node, edge.from.port))
        if (edges.some(edge => (edge.from.node === id && sizing.chain(nodeById.get(edge.to.node)!, edge.to.port).length > 0) || (edge.to.node === id && sizing.chain(nodeById.get(edge.from.node)!, edge.from.port).length > 0))) return null
        const stops = scopeStops.filter(stop => stop.node === id && stop.port === port).map(stop => `${stop.direction}:${stop.others.map(other => `${other.node}|${other.port}`).join(',')}`)
        return [port, [...new Set(out)].sort(), [...new Set(into)].sort(), stops.sort()]
      })
      return sides.some(side => side === null) ? null : JSON.stringify([key, laneOf(id) ?? null, sides])
    }
    const bySignature = new Map<string, string[]>()
    for (const id of drawn) {
      const key = signature(id)
      if (key !== null) bySignature.set(key, [...(bySignature.get(key) ?? []), id])
    }
    const position = new Map(graph.nodes.map((node, at) => [node.id, at]))
    for (const group of bySignature.values()) {
      if (group.length < 2) continue
      const ordered = [...group].sort((a, b) => sizing.label(nodeById.get(a)!).localeCompare(sizing.label(nodeById.get(b)!)) || position.get(a)! - position.get(b)!)
      for (const id of ordered) representative.set(id, ordered[0]!)
      members.set(ordered[0]!, ordered)
    }
  }
  const drawingIdOf = (id: string): string => sizing.itemId(nodeById.get(representative.get(id) ?? id)!)

  const items = new Map<string, { readonly item: FlowItem; readonly keep: T }>()
  const nodes: DiagramNode[] = []
  const diagramEdges: DiagramEdge[] = []
  const edgePlan = new Map<string, { edge: string; parallel: string[] }>()
  const stops = new Map<string, FlowStop>()
  const rankOf = new Map<string, string>()
  const add = (id: string, rank: string, item: FlowItem, ports: DiagramNode['ports']): void => {
    const sized = sizing.item(item)
    const partition = partitionOf(laneOf(item.node.id), lanes)
    items.set(id, { item, keep: sized.keep })
    nodes.push({ id, rank, role: item.role === 'hub' ? 'common' : item.role, ...sized.node, ports, ...(partition === undefined ? {} : { partition }) })
  }
  const directionOf = (node: string, port: string): 'in' | 'out' | 'both' => portOf(node, port)?.direction ?? 'in'

  for (const id of drawn) {
    if ((representative.get(id) ?? id) !== id) continue
    const node = nodeById.get(id)!
    const role: FlowRole = sizing.bar(node) ? 'bar' : hubs.has(id) ? 'hub' : 'device'
    const group = (members.get(id) ?? [id]).map(member => nodeById.get(member)!)
    const ports = [...(usedPorts.get(id) ?? [])].sort()
    const item: FlowItem = { node, members: group, role, ports, piped: piped.get(id) ?? new Set() }
    const sized = sizing.item(item)
    const rank = [role, node.rank, ports.join(','), sized.label].join('|')
    for (const member of group) rankOf.set(member.id, rank)
    const partition = partitionOf(laneOf(id), lanes)
    items.set(drawingIdOf(id), { item, keep: sized.keep })
    nodes.push({ id: drawingIdOf(id), rank, role: role === 'hub' ? 'common' : role, ...sized.node, ports: ports.map(port => ({ id: port, direction: directionOf(id, port), rank: port })), ...(partition === undefined ? {} : { partition }) })
  }

  // A drawn edge becomes a chain of segments through the devices in line on its ends. Edges of grouped members
  // that join the same two drawn ends (alike ports of a bar counting as one) are one pipe, drawn as the edge of
  // the member first by label.
  const drawnEnds = new Map<string, string>()
  const edgeKey = (edge: TopologyEdge): string => `${farLabel(edge.from.node)}|${edge.from.port}|${farLabel(edge.to.node)}|${edge.to.port}`
  for (const edge of [...edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)) || edgeById.get(a.id)!.index - edgeById.get(b.id)!.index)) {
    const [from, to] = [nodeById.get(edge.from.node)!, nodeById.get(edge.to.node)!]
    const endKey = (node: TopologyNode, port: string) => sizing.bar(node) ? `${drawingIdOf(node.id)}|${portOf(node.id, port)?.circuit ?? port}` : `${drawingIdOf(node.id)}|${port}`
    const ends = `${endKey(from, edge.from.port)}>${endKey(to, edge.to.port)}`
    const grouped = representative.has(from.id) || representative.has(to.id)
    const known = grouped ? drawnEnds.get(ends) : undefined
    if (known !== undefined) {
      edgePlan.get(known)!.parallel.push(edge.id)
      continue
    }
    const inLine = [...sizing.chain(from, edge.from.port).map(device => ({ host: from, device })), ...sizing.chain(to, edge.to.port).map(device => ({ host: to, device }))]
    const chain: Array<{ readonly node: string; readonly inPort: string; readonly outPort: string }> = [
      { node: drawingIdOf(from.id), inPort: '', outPort: edge.from.port },
      ...inLine.map(({ host, device }) => {
        const id = sizing.itemId(host, device)
        if (!items.has(id)) add(id, `${rankOf.get(host.id)}|${device}`, { node: host, members: [host], role: 'device', ports: ['in', 'out'], piped: new Set(), device }, [{ id: 'in', direction: 'in', rank: 'in' }, { id: 'out', direction: 'out', rank: 'out' }])
        return { node: id, inPort: 'in', outPort: 'out' }
      }),
      { node: drawingIdOf(to.id), inPort: edge.to.port, outPort: '' },
    ]
    chain.slice(1).forEach((step, at) => {
      const previous = chain[at]!
      const id = `${sizing.edgeId(edge)}.${at}`
      edgePlan.set(id, { edge: edge.id, parallel: [] })
      if (at === 0 && grouped) drawnEnds.set(ends, id)
      diagramEdges.push({ id, rank: `${edge.medium}|${rankOf.get(from.id)}|${edge.from.port}|${rankOf.get(to.id)}|${edge.to.port}|${at}`, from: { node: previous.node, port: previous.outPort }, to: { node: step.node, port: step.inPort } })
    })
  }

  // A grouped member's stops are its group's: one stop for all, carrying every member's edges.
  const groupedStops = scopeStops.reduce((list, stop) => {
    const owner = representative.get(stop.node) ?? stop.node
    const same = list.find(other => other.node === owner && other.port === stop.port && other.direction === stop.direction)
    if (same === undefined) return [...list, { ...stop, node: owner }]
    return list.map(other => (other === same ? { ...other, edges: [...other.edges, ...stop.edges] } : other))
  }, [] as ScopedStub[])
  groupedStops.forEach((stop, at) => {
    const id = `s${at}`
    const shown: FlowStop = { ...stop, node: nodeById.get(stop.node)!, edges: stop.edges }
    stops.set(id, shown)
    const rank = `stub|${rankOf.get(stop.node)}|${stop.port}|${stop.direction}`
    const partition = partitionOf(laneOf(stop.node), lanes)
    nodes.push({
      id, rank, role: 'stub', cells: { width: 1, height: 1 }, portInset: 0,
      ports: [{ id: 'end', direction: stop.direction === 'out' ? 'in' : 'out', rank: 'end' }],
      ...(partition === undefined ? {} : { partition }),
      text: sizing.stop(shown), frameable: false,
    })
    const edge = { id: `${id}.edge`, rank }
    edgePlan.set(edge.id, { edge: stop.edges[0]!, parallel: stop.edges.slice(1) })
    diagramEdges.push(stop.direction === 'out'
      ? { ...edge, from: { node: drawingIdOf(stop.node), port: stop.port }, to: { node: id, port: 'end' } }
      : { ...edge, from: { node: id, port: 'end' }, to: { node: drawingIdOf(stop.node), port: stop.port } })
  })
  return { graph: { nodes, edges: diagramEdges }, items, edges: edgePlan, stops }
}
