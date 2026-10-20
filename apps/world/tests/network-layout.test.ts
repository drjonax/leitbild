import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'
import { NETWORK_ENGINE_VERSION, networkLayout, type NetworkGraph, type NetworkSizing } from '../src/features/displays/topology/network.ts'
import { edgesThroughNodes, measureCpu, overlaps } from './helpers/network-layout-measure.ts'

// The `network` family's ELK adapter on a stub graph from the Grid Model v2
// fixture, validated against the topology contract: buses are nodes grouped by
// station, lines undirected edges between bus ports, the transformer and the
// HVDC link two-port converters. Station grouping and sizing are test-local; the
// grid's own provider (N3) and the World renderer's sizing replace them.
interface Link { readonly id: string; readonly kind?: string; readonly label: string; readonly fromBusId: string; readonly toBusId: string }
interface FixtureModel {
  readonly buses: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly label: string; readonly substationId?: string }>
  readonly branches: ReadonlyArray<Link>
  readonly hvdcLinks: ReadonlyArray<Link>
}
const model = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/grid-model-v2.fixture.json'), 'utf8')) as FixtureModel
const PLANT = 'bus:curated-test-plant-switchyard@420'

const fixtureGraph = (rename: (id: string) => string = id => id): NetworkGraph => {
  const busOf = new Map(model.buses.map(bus => [bus.id, bus]))
  const station = (busId: string) => { const substation = busOf.get(busId)!.substationId; return substation === undefined ? {} : { group: rename(`station:${substation}`) } }
  const converters = [...model.branches.filter(link => link.kind === 'transformer'), ...model.hvdcLinks]
  const lines = model.branches.filter(link => link.kind !== 'transformer')
  const port = (id: string) => ({ id, rank: id, medium: 'ac', direction: 'both' })
  const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) =>
    ({ id: rename(id), rank: id, medium: 'ac', directed: false, bindings: [], from: { node: rename(from[0]), port: from[1] }, to: { node: rename(to[0]), port: to[1] } })
  const graph = topologyGraphSchema.parse({
    objectId: 'grid-fixture', revision: 'fixture', family: 'network', boundaries: [],
    media: [{ id: 'ac', label: 'AC', kind: 'electric-ac' }],
    groups: [...new Set(model.buses.flatMap(bus => bus.substationId ?? []))].map(id => ({ id: rename(`station:${id}`), label: id, kind: 'station' })),
    nodes: [
      ...model.buses.map(bus => ({ id: rename(bus.id), class: bus.kind === 'boundary' || bus.kind === 'junction' ? bus.kind : 'bus', kind: bus.kind, label: bus.label, rank: bus.id, ports: [port('bus')], bindings: [], ...station(bus.id) })),
      ...converters.map(link => ({ id: rename(link.id), class: 'converter', kind: link.kind ?? 'hvdc', label: link.label, rank: link.id, ports: [port('a'), port('b')], bindings: [], ...station(link.fromBusId) })),
    ],
    edges: [
      ...lines.map(link => edge(link.id, [link.fromBusId, 'bus'], [link.toBusId, 'bus'])),
      ...converters.flatMap(link => [edge(`${link.id}:a`, [link.fromBusId, 'bus'], [link.id, 'a']), edge(`${link.id}:b`, [link.id, 'b'], [link.toBusId, 'bus'])]),
    ],
  })
  return { ...graph, roots: [rename(PLANT)] }
}
const membersOf = (graph: NetworkGraph) => (group: string): ReadonlySet<string> => new Set(graph.nodes.filter(node => node.group === group).map(node => node.id))
/** About two characters per grid unit, one line of text under a one-unit symbol. */
const sizing: NetworkSizing = { key: 'test', node: node => ({ width: Math.max(2, Math.ceil(node.label.length / 2)), height: 2 }), spacing: 1, groupLabel: 1 }

describe('network layout (ELK layered, grid units)', () => {
  test('T32 harness on the fixture: ≤ 2 crossings, 0 overlaps, warm p95 CPU ≤ 30 ms; cold reported', async () => {
    const graph = fixtureGraph()
    const report = await measureCpu(() => networkLayout(graph, sizing), 40)
    const layout = await networkLayout(graph, sizing)
    console.log(`T32 fixture (${graph.nodes.length} nodes, ${graph.edges.length} edges, ${NETWORK_ENGINE_VERSION}): ${layout.width}×${layout.height} grid, ${layout.crossings} crossings, cold ${report.coldMs.toFixed(1)} ms CPU, warm p95 ${report.warmP95Ms.toFixed(1)} ms, median ${report.warmMedianMs.toFixed(1)} ms (quiet ms, ${report.rounds} rounds)`)
    expect(layout.crossings).toBeLessThanOrEqual(2)
    expect(overlaps(layout, membersOf(graph))).toEqual([])
    expect(edgesThroughNodes(layout, id => { const edge = graph.edges.find(candidate => candidate.id === id)!; return [edge.from.node, edge.to.node] })).toEqual([])
    expect(report.warmP95Ms).toBeLessThanOrEqual(30)
    // The bar is CPU, measured above; the wall-clock timeout only has to outlast 41 layouts on a loaded machine
    // (Bun's 5 s default failed at load ~10 on the integration branch while the CPU stayed in budget).
  }, 60_000)

  test('grid units: node boxes keep their size, frames hold their members below the label room, routes are orthogonal', async () => {
    const graph = fixtureGraph()
    const layout = await networkLayout(graph, sizing)
    expect(layout).toMatchObject({ family: 'network', unit: 'grid' })
    for (const node of graph.nodes) {
      const placed = layout.nodes.find(candidate => candidate.id === node.id)!
      expect(placed.width).toBeGreaterThanOrEqual(sizing.node(node).width)
      expect(placed.height).toBeGreaterThanOrEqual(sizing.node(node).height)
      const frame = layout.groups.find(group => group.id === node.group)
      if (frame !== undefined) expect(placed.x >= frame.x && placed.y >= frame.y + sizing.spacing + sizing.groupLabel && placed.x + placed.width <= frame.x + frame.width && placed.y + placed.height <= frame.y + frame.height).toBe(true)
    }
    expect(layout.groups.map(group => group.id).sort()).toEqual(graph.groups.map(group => group.id).sort())
    for (const edge of layout.edges) for (const [a, b] of edge.points.slice(1).map((point, i) => [edge.points[i]!, point] as const)) expect(a[0] === b[0] || a[1] === b[1]).toBe(true)
  })

  test('each edge runs from its `from` end to its `to` end; undirected edges grow away from the roots', async () => {
    const graph = fixtureGraph()
    const layout = await networkLayout(graph, sizing)
    const node = (id: string) => layout.nodes.find(candidate => candidate.id === id)!
    const on = (point: readonly [number, number], id: string) => { const at = node(id); return point[0] >= at.x && point[0] <= at.x + at.width && point[1] >= at.y && point[1] <= at.y + at.height }
    for (const edge of graph.edges) {
      const points = layout.edges.find(candidate => candidate.id === edge.id)!.points
      expect(on(points[0]!, edge.from.node) && on(points.at(-1)!, edge.to.node)).toBe(true)
    }
    // The plant switchyard is the root: everything else lies right of it, and its one line leaves rightwards.
    const plant = node(PLANT)
    expect(Math.min(...layout.nodes.filter(other => other.id !== PLANT).map(other => other.x))).toBeGreaterThan(plant.x + plant.width)
    expect(plant.ports.bus!.face).toBe('right')
  })

  test('deterministic, and ids never reach the geometry (spatial constancy)', async () => {
    const first = await networkLayout(fixtureGraph(), sizing)
    expect((await networkLayout(fixtureGraph(), sizing)).hash).toBe(first.hash)
    expect((await networkLayout(fixtureGraph(id => `renamed.${id.split('').reverse().join('')}`), sizing)).hash).toBe(first.hash)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
