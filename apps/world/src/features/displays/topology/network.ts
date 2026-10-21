// The `network` layout family (plan v3.1 §2.9, architecture A5): ELK layered, orthogonal, in grid units. The only
// module that imports elkjs (D6: server-side, unmodified; the boundary lint and the built-UI scan hold it here).
// ELK sees canonical ids in rank order, so ids never reach the geometry, and its JSON never leaves this module.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import ELK, { type ElkNode, type ElkPort } from 'elkjs/lib/elk-api.js'
import type { TopologyNode } from '../../../core/observation/topology.ts'
import { findCrossings, gapsByEdge, type Segment } from '../diagram/crossings.ts'
import type { Face, RoutedEdge } from '../diagram/diagram.ts'
import type { TopologyLayout } from './layout.ts'
import type { ScopedStub, ScopedTopology } from './scope.ts'

const elkFile = (path: string): string => fileURLToPath(import.meta.resolve(`elkjs/${path}`))
/** The installed elkjs, for layout cache keys. */
export const NETWORK_ENGINE_VERSION = `elkjs ${(JSON.parse(readFileSync(elkFile('package.json'), 'utf8')) as { version: string }).version}`

type Size = { readonly width: number; readonly height: number }
/** In grid units: a node's and a stop's box with its text (ELK grows it to fit its ports); the room between nodes and inside group frames (layers keep twice it, edges and ports half); a group label's room on top. */
export interface NetworkSizing { readonly key: string; readonly node: (node: TopologyNode) => Size; readonly stop: (stop: ScopedStub) => Size; readonly spacing: number; readonly groupLabel: number }
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
let engine: InstanceType<typeof ELK> | undefined
/** ELK's worker script run in this thread: in a scope without `self` (Bun defines it) it exports its in-thread worker. */
const elk = (): InstanceType<typeof ELK> => engine ??= (() => {
  const [path, module] = [elkFile('lib/elk-worker.min.js'), { exports: {} as { Worker?: new () => Worker } }]
  runInThisContext(`(function (module, exports, self) {${readFileSync(path, 'utf8')}\n})`, { filename: path })(module, module.exports, undefined)
  const InThread = module.exports.Worker
  if (InThread === undefined) throw new Error(`${NETWORK_ENGINE_VERSION}: its worker script exported no in-thread Worker`)
  return new ELK({ workerFactory: () => new InThread() })
})()
const options = (s: number): Record<string, string> => ({
  'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.randomSeed': '1',
  'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT', 'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': `${s}`, 'elk.layered.spacing.nodeNodeBetweenLayers': `${2 * s}`, 'elk.spacing.componentComponent': `${2 * s}`,
  ...Object.fromEntries(['portPort', 'edgeEdge', 'edgeNode', 'edgeEdgeBetweenLayers', 'edgeNodeBetweenLayers'].map(key => [`elk.${key.endsWith('Layers') ? 'layered.' : ''}spacing.${key}`, `${s / 2}`])),
})
const byRank = <T extends { readonly rank: string }>(a: T, b: T): number => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)
const flat = (node: ElkNode): ElkNode[] => [node, ...(node.children ?? []).flatMap(flat)]

/** A scope's drawing; each stop is a node `s<n>` beside the node it leaves, its edge `s<n>.edge`; layers grow away from the scope's roots along undirected edges. */
export const networkLayout = async (scoped: ScopedTopology, sizing: NetworkSizing): Promise<TopologyLayout> => {
  const { graph } = scoped
  const [drawnNodes, drawnEdges, rankOf] = [new Set(scoped.nodes), new Set(scoped.edges), new Map(graph.nodes.map(node => [node.id, node.rank]))]
  const stops = scoped.stubs.map((stop, at) => ({ id: `s${at}`, rank: `${rankOf.get(stop.node)}|stop|${stop.port}|${stop.direction}`, stop }))
  const nodes = [...graph.nodes.filter(node => drawnNodes.has(node.id)), ...stops].sort(byRank)
  const edges = [...graph.edges.filter(edge => drawnEdges.has(edge.id)), ...stops.map(({ id, rank, stop }) =>
    ({ id: `${id}.edge`, rank, from: { node: stop.node, port: stop.port }, to: { node: id, port: 'end' }, directed: false }))].sort(byRank)
  const s = sizing.spacing
  const neighbours = new Map<string, string[]>()
  for (const { from, to } of edges) for (const [a, b] of [[from.node, to.node], [to.node, from.node]] as const) neighbours.set(a, [...neighbours.get(a) ?? [], b])
  const hops = new Map(scoped.roots.map(id => [id, 0]))
  for (const [id, hop] of hops) for (const next of neighbours.get(id) ?? []) if (!hops.has(next)) hops.set(next, hop + 1)
  const flipped = edges.map(edge => !edge.directed && (hops.get(edge.to.node) ?? Infinity) < (hops.get(edge.from.node) ?? Infinity))
  const [root, frames, parent] = [{ id: 'root', children: [], edges: [] } as ElkNode, new Map<string, ElkNode>(), new Map(graph.groups.map(group => [group.id, group.parent]))]
  const container = (group: string | undefined): ElkNode => {
    if (group === undefined || frames.has(group)) return group === undefined ? root : frames.get(group)!
    const frame: ElkNode = { id: `g${frames.size}`, children: [], layoutOptions: { 'elk.padding': `[top=${s + sizing.groupLabel},left=${s},bottom=${s},right=${s}]` } }
    frames.set(group, frame)
    container(parent.get(group)).children!.push(frame)
    return frame
  }
  const index = new Map(nodes.map((node, n) => [node.id, n]))
  const elkNodes = nodes.map((node, n) => {
    const { width, height } = 'stop' in node ? sizing.stop(node.stop) : sizing.node(node)
    const elkNode = { id: `n${n}`, width, height, ports: [] as ElkPort[], layoutOptions: { 'elk.nodeSize.constraints': 'PORTS MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${width}, ${height})` } }
    container('stop' in node ? undefined : node.group).children!.push(elkNode)
    return elkNode
  })
  const ends = new Map<string, Array<readonly [port: string, elkPort: string]>>()
  edges.forEach((edge, e) => {
    for (const [end, elkPort] of [[edge.from, flipped[e] ? `e${e}t` : `e${e}s`], [edge.to, flipped[e] ? `e${e}s` : `e${e}t`]] as const) {
      elkNodes[index.get(end.node)!]!.ports.push({ id: elkPort, width: 0, height: 0 })
      ends.set(end.node, [...ends.get(end.node) ?? [], [end.port, elkPort]])
    }
    root.edges!.push({ id: `e${e}`, sources: [`e${e}s`], targets: [`e${e}t`] })
  })
  const out = new Map(flat(await elk().layout(root, { layoutOptions: options(s) })).map(node => [node.id, node]))
  const box = (id: string): Box => { const { x = 0, y = 0, width = 0, height = 0 } = out.get(id)!; return { x, y, width, height } }
  const ports = new Map([...out.values()].flatMap(node => node.ports ?? []).map(port => [port.id, port]))
  const sections = new Map([...out.values()].flatMap(node => node.edges ?? []).map(edge => [edge.id, edge.sections ?? []]))
  const routed = edges.map((edge, e): RoutedEdge => {
    const [section, ...more] = sections.get(`e${e}`) ?? []
    if (section === undefined || more.length > 0) throw new Error(`${NETWORK_ENGINE_VERSION} routed edge ${edge.id} in ${more.length + Number(section !== undefined)} sections`)
    const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint].map(({ x, y }) => [x, y] as const)
    return { id: edge.id, points: flipped[e] ? points.reverse() : points, gaps: [] }
  })
  const faceOf = (at: Box, { x = 0, y = 0 }: ElkPort): Face => (Object.entries({ left: x - at.x, right: at.x + at.width - x, top: y - at.y, bottom: at.y + at.height - y }) as Array<[Face, number]>)
    .reduce((best, face) => (face[1] < best[1] ? face : best))[0]
  const placed = nodes.map((node, n) => {
    const [at, own] = [box(`n${n}`), [...ends.get(node.id) ?? []].reverse()]   // reversed: the first edge's end is written last, so it stays
    return { id: node.id, ...at, ports: Object.fromEntries(own.map(([port, elkPort]) => { const p = ports.get(elkPort)!; return [port, { x: p.x ?? 0, y: p.y ?? 0, face: faceOf(at, p) }] })) }
  })
  const crossings = findCrossings(routed.flatMap((edge, e) => edge.points.slice(1).map((b, i): Segment => ({ owner: { kind: 'edge', edge: e, net: e }, a: edge.points[i]!, b, index: i }))))
  const gaps = gapsByEdge(routed.length, crossings, routed)
  const [drawn, groups, { width, height }] = [routed.map((edge, e) => ({ ...edge, gaps: gaps[e]! })), [...frames].map(([id, frame]) => ({ id, ...box(frame.id) })), box('root')]
  const hash = createHash('sha256').update(JSON.stringify([NETWORK_ENGINE_VERSION, width, height, placed.map(node => [node.x, node.y, node.width, node.height, Object.values(node.ports)]),
    drawn.map(edge => [edge.points, edge.gaps]), groups.map(group => [group.x, group.y, group.width, group.height])])).digest('hex')
  return { family: 'network', unit: 'grid', width, height, nodes: placed, edges: drawn, groups, crossings: crossings.length, hash }
}
