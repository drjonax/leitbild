/**
 * The one topology contract for the `flow` and `network` families (plan v3.1
 * §2.9): a Pack returns a semantic graph, World scopes and lays it out. Nodes
 * are equipment with ports, edges pure connectivity between two ports that
 * carry the edge's medium; boundaries join other graphs only through Scenario
 * connections.
 */
import { z } from 'zod'
import { observableRefSchema, refObjectId } from '../model/alerts.ts'
import { objectIdSchema } from '../model/ids.ts'

const id = z.string().min(1).max(200)
const rank = z.string().min(1).max(120)
const end = z.object({ node: id, port: id }).strict()
/** What a binding drives in a drawing; `position` is a fraction of travel: a valve's opening (1 open), or a part's insertion (a rod bank's, 1 fully in). */
const bindings = z.array(z.object({
  role: z.enum(['flow', 'loading', 'level', 'conducting', 'available', 'running', 'position', 'value']),
  ref: observableRefSchema,
}).strict()).max(16)

export const topologyNodeClassSchema = z.enum(['source', 'sink', 'store', 'transfer', 'converter', 'switch', 'mover', 'bus', 'junction', 'boundary'])

export const topologyGraphSchema = z.object({
  objectId: objectIdSchema,
  revision: z.string().min(1).max(128),
  family: z.enum(['flow', 'network']),
  /** Credits for licensed data the graph is drawn from. */
  attribution: z.string().min(1).max(300).optional(),
  media: z.array(z.object({
    id, label: z.string().min(1).max(40), kind: z.enum(['fluid', 'steam', 'gas', 'heat', 'electric-ac', 'electric-dc', 'signal']),
    level: z.object({ value: z.number().finite(), unit: z.string().min(1).max(8) }).strict().optional(),
  }).strict()).min(1).max(64),
  groups: z.array(z.object({
    id, label: z.string().min(1).max(120), shortLabel: z.string().min(1).max(24).optional(), kind: z.string().min(1).max(40),
    parent: id.optional(), lane: z.object({ key: z.string().min(1).max(64), order: z.number().int() }).strict().optional(),
  }).strict()).max(10_000),
  nodes: z.array(z.object({
    id, element: id.optional(), class: topologyNodeClassSchema, kind: z.string().min(1).max(60),
    /** Grid tee labels exceed 120 characters (proto-topology); `shortLabel` is what a drawing fits. */
    label: z.string().min(1).max(300), shortLabel: z.string().min(1).max(24).optional(), rank, group: id.optional(),
    ports: z.array(z.object({
      id, rank, media: z.array(id).min(1).max(16), direction: z.enum(['in', 'out', 'both']),
      /** Ports of one circuit connect inside the node; a port in no circuit is a terminal. Reach follows flow only into a port of the circuit it entered by. */
      circuit: id.optional(),
    }).strict()).min(1).max(256),
    bindings,
  }).strict()).max(20_000),
  edges: z.array(z.object({ id, rank, from: end, to: end, medium: id, directed: z.boolean(), bindings, group: id.optional() }).strict()).max(40_000),
  boundaries: z.array(z.object({ node: id, port: id, externalPortId: id }).strict()).max(256),
  /** What the object's overview draws, as its Pack judges its principal equipment: these nodes and the edges among them; World adds where the drawing stops. */
  overview: z.object({ nodes: z.array(id).min(1).max(60), edges: z.array(id).max(240) }).strict().optional(),
}).strict().superRefine((graph, context) => {
  const issue = (message: string): void => context.addIssue({ code: 'custom', message })
  const unique = (kind: string, ids: ReadonlyArray<string>): void => {
    if (new Set(ids).size !== ids.length) issue(`duplicate ${kind} id`)
  }
  unique('medium', graph.media.map(medium => medium.id))
  unique('group', graph.groups.map(group => group.id))
  unique('node', graph.nodes.map(node => node.id))
  unique('edge', graph.edges.map(edge => edge.id))
  const media = new Set(graph.media.map(medium => medium.id))
  const groups = new Map(graph.groups.map(group => [group.id, group]))
  for (const group of graph.groups) {
    const seen = new Set<string>()
    for (let at: typeof group | undefined = group; at?.parent !== undefined; at = groups.get(at.parent)) {
      if (!groups.has(at.parent)) { issue(`group ${at.id} has unknown parent ${at.parent}`); break }
      if (seen.has(at.id)) { issue(`group ${group.id} is its own ancestor`); break }
      seen.add(at.id)
    }
  }
  const ports = new Map<string, ReadonlyArray<string>>()
  for (const node of graph.nodes) {
    if (node.group !== undefined && !groups.has(node.group)) issue(`node ${node.id} has unknown group ${node.group}`)
    unique(`port of node ${node.id}`, node.ports.map(port => port.id))
    for (const port of node.ports) {
      for (const medium of port.media) if (!media.has(medium)) issue(`port ${node.id}.${port.id} has unknown medium ${medium}`)
      ports.set(`${node.id}\u0000${port.id}`, port.media)
    }
  }
  for (const edge of graph.edges) {
    if (!media.has(edge.medium)) issue(`edge ${edge.id} has unknown medium ${edge.medium}`)
    if (edge.group !== undefined && !groups.has(edge.group)) issue(`edge ${edge.id} has unknown group ${edge.group}`)
    for (const at of [edge.from, edge.to]) {
      const carried = ports.get(`${at.node}\u0000${at.port}`)
      if (carried === undefined) issue(`edge ${edge.id} ends at unknown port ${at.node}.${at.port}`)
      else if (!carried.includes(edge.medium)) issue(`edge ${edge.id} carries ${edge.medium} into port ${at.node}.${at.port} of ${carried.join(', ')}`)
    }
  }
  if (graph.overview !== undefined) {
    const nodes = new Set(graph.nodes.map(node => node.id))
    const drawn = new Set(graph.overview.nodes)
    for (const node of graph.overview.nodes) if (!nodes.has(node)) issue(`the overview names unknown node ${node}`)
    for (const id of graph.overview.edges) {
      const edge = graph.edges.find(entry => entry.id === id)
      if (edge === undefined) issue(`the overview names unknown edge ${id}`)
      else if (!drawn.has(edge.from.node) || !drawn.has(edge.to.node)) issue(`the overview edge ${id} ends outside the overview's nodes`)
    }
  }
  for (const boundary of graph.boundaries) {
    if (!ports.has(`${boundary.node}\u0000${boundary.port}`)) issue(`boundary ${boundary.externalPortId} names unknown port ${boundary.node}.${boundary.port}`)
  }
  // Every binding reads the graph's own object, so inspecting that object covers the whole graph.
  for (const item of [...graph.nodes, ...graph.edges]) {
    for (const binding of item.bindings) {
      if (refObjectId(binding.ref) !== graph.objectId) issue(`${item.id} binds ${binding.ref} of another object`)
    }
  }
})

export type TopologyGraph = z.output<typeof topologyGraphSchema>
export type TopologyNode = TopologyGraph['nodes'][number]
export type TopologyEdge = TopologyGraph['edges'][number]
