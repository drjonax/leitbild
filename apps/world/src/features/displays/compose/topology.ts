/**
 * A topology view's drawing (architecture A4, A5): the generic scope of its
 * request on the graph the caller reads, at most 60 nodes (a one-ended or
 * around request's reach shrinks first), laid out in grid units by family and
 * kept across vignettes by the graph's revision and scope.
 */
import type { ObjectId } from '../../../core/model/index.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { drawingCache, drawingKey } from '../topology/cache.ts'
import { flowLayout, type DrawnStops } from '../topology/flow-sizing.ts'
import type { TopologyLayout } from '../topology/layout.ts'
import { networkLayout, type NetworkSizing } from '../topology/network.ts'
import { scopeTopology, TOPOLOGY_REACH, type ScopedTopology, type TopologyRequest } from '../topology/scope.ts'
import type { SearchRun } from '../observation/search.ts'
import type { VignetteSection } from './model.ts'

export const TOPOLOGY_MAX_NODES = 60
/** The room a drawing gets, in grid units: a vignette's width and its rows below the frame. */
const ROOM = { columns: 40, rows: 30 }

const labelOf = (graph: TopologyGraph, id: string): string => {
  const node = graph.nodes.find(entry => entry.id === id)
  return node?.shortLabel ?? node?.label ?? id
}
/** A stop's label: the names of what lies beyond, at most 24 characters. */
export const stopLabel = (names: ReadonlyArray<string>): string => names.join(', ').slice(0, 24)
/** Boxes that keep every drawn name whole at the renderer's 12 text (about 7 a character, 6 of padding, 24 a grid unit): a name and one reading. */
const box = (text: string, height: number) => ({ width: Math.max(2, Math.ceil((text.length * 7 + 6) / 24)), height })
const networkSizing = (graph: TopologyGraph): NetworkSizing => ({
  key: 'vignette-network-2',
  node: node => box(node.shortLabel ?? node.label, 2),
  stop: stop => box(stopLabel(stop.others.map(other => labelOf(graph, other.node))), 1),
  spacing: 1, groupLabel: 1,
})

export type Scoped = { readonly ok: true; readonly scoped: ScopedTopology; readonly reach?: number } | { readonly ok: false; readonly reason: string }

/** The request's scope within the node cap; a narrowed reach comes back with it. */
export const scopeWithin = (graph: TopologyGraph, asked: { readonly [K in keyof TopologyRequest]?: TopologyRequest[K] | undefined }): Scoped => {
  const request = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== undefined)) as TopologyRequest
  const oneEnded = !(request.from !== undefined && request.to !== undefined)
  for (let reach = request.reach ?? TOPOLOGY_REACH; reach >= 1; reach -= 1) {
    const result = scopeTopology(graph, { ...request, ...(oneEnded ? { reach } : {}) })
    if (!result.ok) return { ok: false, reason: result.refusal.code }
    if (result.scoped.nodes.length <= TOPOLOGY_MAX_NODES) return { ok: true, scoped: result.scoped, ...(oneEnded && reach !== (request.reach ?? TOPOLOGY_REACH) ? { reach } : {}) }
    if (!oneEnded) break
  }
  return { ok: false, reason: `more than ${TOPOLOGY_MAX_NODES} nodes` }
}

export interface Drawing { readonly layout: TopologyLayout; readonly stops: DrawnStops }
const drawings = drawingCache<Promise<Drawing | null>>(64)
export const drawingOf = (scoped: ScopedTopology): Promise<Drawing | null> => drawings.get(drawingKey(scoped, scoped.graph.family), async () => {
  if (scoped.graph.family === 'flow') return flowLayout(scoped, ROOM)
  const layout = await networkLayout(scoped, networkSizing(scoped.graph))
  const mediumOf = (edge: string): string => scoped.graph.edges.find(entry => entry.id === edge)!.medium
  return { layout, stops: Object.fromEntries(scoped.stubs.map((stop, at) => [`s${at}`, { direction: stop.direction, others: stop.others.map(other => labelOf(scoped.graph, other.node)), medium: mediumOf(stop.edges[0]!) }])) }
})

export const topologyOf = async (run: SearchRun, objectId: ObjectId): Promise<TopologyGraph | null> => {
  if (run.denied.has(objectId)) return null
  const graph = await run.port.topology(objectId)
  return 'refused' in graph ? null : graph
}

/** What the renderer draws: the layout, every drawn node (stops as `s<n>`, labelled by their far ends) and edge with its medium's kind, and bindings the caller reads, with their declared units. */
export const topologySection = (objectId: string, scoped: ScopedTopology, drawing: Drawing, rows: number, unitOf: (ref: string) => string | undefined): VignetteSection => {
  const { graph } = scoped
  const [nodes, edges] = [new Set(scoped.nodes), new Set(scoped.edges)]
  const kindOf = (medium: string) => graph.media.find(entry => entry.id === medium)!.kind
  const bound = (bindings: TopologyGraph['nodes'][number]['bindings']) => bindings.flatMap(binding => { const unit = unitOf(binding.ref); return unit === undefined ? [] : [{ ...binding, unit }] })
  return {
    kind: 'topology', rows, objectId, family: graph.family, layout: drawing.layout,
    nodes: [
      ...graph.nodes.filter(node => nodes.has(node.id)).map(node => ({
        id: node.id, class: node.class, label: node.label, bindings: bound(node.bindings),
        ...(node.shortLabel === undefined ? {} : { shortLabel: node.shortLabel }), ...(node.element === undefined ? {} : { element: node.element }),
      })),
      ...Object.entries(drawing.stops).map(([id, stop]) => ({ id, class: 'stop' as const, label: stopLabel(stop.others) || id, bindings: [] })),
    ],
    edges: [
      ...graph.edges.filter(edge => edges.has(edge.id)).map(edge => ({ id: edge.id, mediumKind: kindOf(edge.medium), bindings: bound(edge.bindings) })),
      ...Object.entries(drawing.stops).map(([id, stop]) => ({ id: `${id}.edge`, mediumKind: kindOf(stop.medium), bindings: [] })),
    ],
    groups: drawing.layout.groups.flatMap(frame => {
      const group = graph.groups.find(entry => entry.id === frame.id || entry.lane?.key === frame.id)
      return group === undefined ? [] : [{ id: frame.id, label: group.label }]
    }),
    ...(graph.attribution === undefined ? {} : { attribution: graph.attribution }),
  }
}

/** The values a drawing binds: every drawn node's and edge's binding refs. */
export const bindingRefs = (scoped: ScopedTopology): ReadonlyArray<string> => {
  const [nodes, edges] = [new Set(scoped.nodes), new Set(scoped.edges)]
  return [...new Set([...scoped.graph.nodes.filter(node => nodes.has(node.id)), ...scoped.graph.edges.filter(edge => edges.has(edge.id))].flatMap(item => item.bindings.map(binding => binding.ref)))]
}
