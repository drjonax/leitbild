// A flow drawing's sizing from the topology contract alone (architecture A6,
// audit B11): a bus draws as a bar, a switch takes its neighbours' lane, alike
// nodes group by kind, and flow into a sink or boundary that leads nowhere
// ends without a stop; nothing is chained in line, and drawing ids are the
// graph's node and edge ids. Text is one line per item, as the vignette
// renderer writes it on OpenBridge's grid; the layout comes back in grid units.
import { layoutDiagram, type DiagramProfile } from '../diagram/index.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { flowPlan, type FlowSizing } from './flow.ts'
import type { TopologyLayout } from './layout.ts'
import type { ScopedTopology } from './scope.ts'

/** The renderer's grid pitch and its one text line (16 high, about 8 a character), in the engine's units. */
const GRID = 24
const LINE = { height: 16, perCharacter: 8 }
const line = (text: string) => ({ lines: [{ width: Math.max(GRID, text.length * LINE.perCharacter), height: LINE.height, required: true }] })

export const vignetteFlowProfile: DiagramProfile = {
  grid: GRID, cell: GRID, pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5, trackGap: 4 }, textClearance: 9, frameMargin: 1, flapHeight: 0, flapLabelPadding: 0,
  limits: { symbols: 60, symbolsPerPartition: 12, sharedSymbols: 30, partitions: 4, crossings: 6, bendsPerEdge: 3 },
  fit: [{ detail: 'full', text: 'right' }, { detail: 'full', text: 'allBelow' }],
}

export const flowSizing = (graph: TopologyGraph): FlowSizing<null> => {
  const classOf = new Map(graph.nodes.map(node => [node.id, node.class]))
  const leaving = new Set(graph.edges.map(edge => edge.from.node))
  const label = (node: TopologyGraph['nodes'][number]): string => node.shortLabel ?? node.label
  return {
    key: 'vignette-flow-1',
    visible: () => true,
    silent: edge => ['sink', 'boundary'].includes(classOf.get(edge.to.node) ?? '') && !leaving.has(edge.to.node),
    bar: node => node.class === 'bus',
    infersLane: node => node.class === 'switch',
    groupKey: node => node.kind,
    chain: () => [],
    itemId: node => node.id,
    edgeId: edge => edge.id,
    label,
    item: item => {
      const text = item.members.length > 1 ? `${label(item.node)} ×${item.members.length}` : label(item.node)
      return { label: text, node: { cells: { width: 2, height: 2 }, portInset: 0, text: line(text), frameable: false }, keep: null }
    },
    stop: stop => line(stop.others.map(other => label(graph.nodes.find(node => node.id === other.node)!)).join(', ').slice(0, 24)),
  }
}

/** Where a drawing stops, by its layout id: the labels of what lies beyond. */
export type DrawnStops = Readonly<Record<string, { readonly direction: 'in' | 'out'; readonly others: ReadonlyArray<string>; readonly medium: string }>>

/** A scoped flow graph laid out for a room in grid units, or null where no drawing verifies within the profile's limits. */
export const flowLayout = (scoped: ScopedTopology, room: { readonly columns: number; readonly rows: number }): { readonly layout: TopologyLayout; readonly stops: DrawnStops } | null => {
  const sizing = flowSizing(scoped.graph)
  const planned = flowPlan(scoped, sizing)
  if (planned.graph.nodes.length === 0) return null
  const result = layoutDiagram(planned.graph, vignetteFlowProfile, { maxWidth: room.columns * GRID, maxHeight: room.rows * GRID })
  if (!result.ok) return null
  const grid = (value: number): number => value / GRID
  const box = <T extends { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>(at: T) => ({ x: grid(at.x), y: grid(at.y), width: grid(at.width), height: grid(at.height) })
  const label = (id: string): string => sizing.label(scoped.graph.nodes.find(node => node.id === id)!)
  const mediumOf = (edge: string): string => scoped.graph.edges.find(entry => entry.id === edge)!.medium
  const stops = Object.fromEntries([...planned.stops].map(([id, stop]) => [id, { direction: stop.direction, others: stop.others.map(other => label(other.node)), medium: mediumOf(stop.edges[0]!) }]))
  return { stops, layout: {
    family: 'flow', unit: 'grid', width: Math.ceil(grid(result.width)), height: Math.ceil(grid(result.height)),
    nodes: result.nodes.map(node => ({ id: node.id, ...box(node), ports: Object.fromEntries(Object.entries(node.ports).map(([id, port]) => [id, { x: grid(port.x), y: grid(port.y), face: port.face }])) })),
    edges: result.edges.map(edge => ({ id: edge.id, points: edge.points.map(([x, y]) => [grid(x), grid(y)] as const), gaps: edge.gaps.map(([x, y]) => [grid(x), grid(y)] as const) })),
    crossings: result.crossings, hash: result.hash,
  } }
}
