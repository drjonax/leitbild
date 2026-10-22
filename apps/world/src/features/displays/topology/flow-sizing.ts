// A flow drawing's sizing from the topology contract alone (architecture A6,
// audit B11): a bus that joins more than two lines, and a header (a junction
// whose ports, more than two, are one circuit), draw as bars; a switch takes
// its neighbours' lane; alike nodes group by kind; flow into a sink or
// boundary that leads nowhere ends without a stop; nothing is chained in line,
// and drawing ids are the graph's node and edge ids. A store stands two cells
// by four, as OpenBridge's tank does, and the lanes' hub as the vessel it is
// drawn as, its head above its nozzles. Each item writes its name and under
// it its state word, the command it does not follow and, where there is room,
// its readings (layout.ts itemText); a group writes how many of its members
// run. The ceilings are today's displays': a drawing across lanes keeps the
// unit overview's twelve crossings, one within a lane an equipment detail's
// four. The layout comes back in grid units.
import { layoutDiagram, type DiagramProfile } from '../diagram/index.ts'
import type { TopologyGraph, TopologyNode } from '../../../core/observation/topology.ts'
import { flowPlan, type FlowSizing } from './flow.ts'
import { groupName, itemText, type TopologyLayout } from './layout.ts'
import type { ScopedTopology } from './scope.ts'

/** The renderer's grid pitch and its text lines (16 high, about 8 a character), in the engine's units; a reading takes up to ten characters ("15.51 MPa"). */
const GRID = 24
const LINE = { height: 16, perCharacter: 8 }
const READING_CHARACTERS = 10
/** A state word ("ON LINE", "part open"), and the command it does not follow ("commanded RUN"). */
const STATE_CHARACTERS = 9
const COMMAND_CHARACTERS = 13
/** The vessel's head and flange above its first nozzle, and its bottom below its last. */
const VESSEL_ENDS = { top: 2 * GRID, bottom: GRID }

const limits = { symbols: 60, symbolsPerPartition: 12, sharedSymbols: 30, partitions: 8, bendsPerEdge: 3 } as const
const profile = (crossings: number): DiagramProfile => ({
  grid: GRID, cell: GRID, pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5, trackGap: 4 }, textClearance: 9, frameMargin: 1, flapHeight: 0, flapLabelPadding: 0,
  limits: { ...limits, crossings },
  fit: (['full', 'required'] as const).flatMap(detail => (['right', 'partitionsBelow', 'allBelow'] as const).map(text => ({ detail, text }))),
})
/** Across lanes, and within one lane or none. */
export const flowProfiles = { lanes: profile(12), lane: profile(4) } as const

/** A header: a junction whose ports, more than two, are all one circuit. */
const isHeader = (node: TopologyNode): boolean => node.class === 'junction' && node.ports.length > 2 && new Set(node.ports.map(port => port.circuit ?? port.id)).size === 1
const TALL: ReadonlySet<string> = new Set(['store'])
/** A stop names each far end once, however many of its ports the drawing stops at. */
const farNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(names)]

export const flowSizing = (graph: TopologyGraph): FlowSizing<null> => {
  const classOf = new Map(graph.nodes.map(node => [node.id, node.class]))
  // A bus joins more than two lines; one with fewer (a battery, an inverter, a load at the end of a line) is an item on its line.
  const lines = new Map<string, number>()
  for (const edge of graph.edges) for (const end of [edge.from.node, edge.to.node]) lines.set(end, (lines.get(end) ?? 0) + 1)
  const leaving = new Set(graph.edges.map(edge => edge.from.node))
  const label = (node: TopologyNode): string => node.shortLabel ?? node.label
  const line = (characters: number, required: boolean) => ({ width: Math.max(GRID, characters * LINE.perCharacter), height: LINE.height, required })
  return {
    key: 'vignette-flow-7',
    visible: () => true,
    silent: edge => ['sink', 'boundary'].includes(classOf.get(edge.to.node) ?? '') && !leaving.has(edge.to.node),
    bar: node => (node.class === 'bus' && (lines.get(node.id) ?? 0) > 2) || isHeader(node),
    infersLane: node => node.class === 'switch',
    groupKey: node => node.kind,
    chain: () => [],
    itemId: node => node.id,
    edgeId: edge => edge.id,
    label,
    item: item => {
      const grouped = item.members.length > 1
      const text = grouped ? groupName(item.members.map(label)) : label(item.node)
      // A group says how many of its members run ("RUN 2/2"); a lone item its state word, the command it does not follow, and its readings.
      const written = itemText(item.node.bindings)
      const lines = [line(text.length, true), ...(grouped ? [line(7, true)] : [
        ...(written.state === null ? [] : [line(STATE_CHARACTERS, true), line(COMMAND_CHARACTERS, false)]),
        ...written.readings.map(() => line(READING_CHARACTERS, false)),
      ])]
      const vessel = item.role === 'hub'
      const cells = vessel || TALL.has(item.node.class) ? { width: 2, height: 4 } : { width: 2, height: 2 }
      return { label: text, node: { cells, portInset: 0, text: { lines }, frameable: false, ...(vessel ? { ends: VESSEL_ENDS } : {}) }, keep: null }
    },
    stop: stop => ({ lines: [line(farNames(stop.others.map(other => label(graph.nodes.find(node => node.id === other.node)!))).join(', ').slice(0, 24).length, true)] }),
  }
}

/** Two bars joined only to each other have nowhere to stand (the engine refuses them): such a scope draws nothing. */
const barsOnlyJoinBars = (graph: ReturnType<typeof flowPlan>['graph']): boolean => {
  const bars = new Set(graph.nodes.filter(node => node.role === 'bar').map(node => node.id))
  const neighbours = (id: string): ReadonlyArray<string> => graph.edges.flatMap(edge => (edge.from.node === id ? [edge.to.node] : edge.to.node === id ? [edge.from.node] : []))
  return graph.edges.some(edge => bars.has(edge.from.node) && bars.has(edge.to.node) && [edge.from.node, edge.to.node].every(bar => neighbours(bar).every(other => bars.has(other))))
}

/** Where a drawing stops, by its layout id: the labels of what lies beyond. */
export type DrawnStops = Readonly<Record<string, { readonly direction: 'in' | 'out'; readonly others: ReadonlyArray<string>; readonly medium: string }>>

/** A scoped flow graph laid out for a room in grid units, or null where no drawing verifies within its ceilings. */
export const flowLayout = (scoped: ScopedTopology, room: { readonly columns: number; readonly rows: number }): { readonly layout: TopologyLayout; readonly stops: DrawnStops } | null => {
  const sizing = flowSizing(scoped.graph)
  const planned = flowPlan(scoped, sizing)
  if (planned.graph.nodes.length === 0 || barsOnlyJoinBars(planned.graph)) return null
  const lanes = new Set(planned.graph.nodes.flatMap(node => (node.partition === undefined ? [] : [node.partition.key]))).size
  const result = layoutDiagram(planned.graph, lanes > 1 ? flowProfiles.lanes : flowProfiles.lane, { maxWidth: room.columns * GRID, maxHeight: room.rows * GRID })
  if (!result.ok) return null
  const grid = (value: number): number => value / GRID
  const box = <T extends { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>(at: T) => ({ x: grid(at.x), y: grid(at.y), width: grid(at.width), height: grid(at.height) })
  const label = (id: string): string => sizing.label(scoped.graph.nodes.find(node => node.id === id)!)
  const mediumOf = (edge: string): string => scoped.graph.edges.find(entry => entry.id === edge)!.medium
  const stops = Object.fromEntries([...planned.stops].map(([id, stop]) => [id, { direction: stop.direction, others: farNames(stop.others.map(other => label(other.node))), medium: mediumOf(stop.edges[0]!) }]))
  const membersOf = (id: string): ReadonlyArray<string> => planned.items.get(id)?.item.members.map(member => member.id) ?? []
  return { stops, layout: {
    family: 'flow', unit: 'grid', width: Math.ceil(grid(result.width)), height: Math.ceil(grid(result.height)),
    nodes: result.nodes.map(node => ({
      id: node.id, ...box(node), ports: Object.fromEntries(Object.entries(node.ports).map(([id, port]) => [id, { x: grid(port.x), y: grid(port.y), face: port.face }])),
      ...(membersOf(node.id).length > 1 ? { members: membersOf(node.id) } : {}),
      ...(node.text === null ? {} : { text: { ...box(node.text), lines: node.text.lines, side: node.text.side } }),
    })),
    edges: result.edges.map(edge => ({ id: edge.id, points: edge.points.map(([x, y]) => [grid(x), grid(y)] as const), gaps: edge.gaps.map(([x, y]) => [grid(x), grid(y)] as const) })),
    crossings: result.crossings, hash: result.hash,
  } }
}
