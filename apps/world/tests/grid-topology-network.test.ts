import { describe, expect, test } from 'bun:test'
import { topologyGraphSchema, type TopologyGraph } from '../src/core/observation/topology.ts'
import { NETWORK_ENGINE_VERSION, networkLayout, type NetworkGraph, type NetworkSizing } from '../src/features/displays/topology/network.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { gridModelAttribution } from '../src/packs/electric-grid/model.ts'
import { gridObservationTopologyQuery, gridTopology } from '../src/packs/electric-grid/observation/topology.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { gridLiveMapLayer } from '../src/packs/electric-grid/ui/grid-live-layer.ts'
import haldenScenario from '../src/scenarios/halden-power-complex.scenario.json'
import { edgesThroughNodes, measureCpu, overlaps } from './helpers/network-layout-measure.ts'

// N3 (plan v3.1 §2.9, architecture A5; T32): the Grid's semantic graph validates against the topology contract,
// and ELK lays out the Halden station views around the plant switchyard. The station-hop selection here is
// test-local until p1-plant's generic scope (P5) lands, after proto-topology's: buses of ≥ 300 kV whose stations
// lie within k line hops of the switchyard's station, collapsed to stations; parallel circuits between two
// stations bundled into one edge; every branch or HVDC link leaving that scope a stub, one per far station and level.
const grid = (() => {
  const definition = compileGridDefinition(gridDefinitionSchema.parse({
    id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
  }))
  const instance = createGridRuntimeInstance({ definition, at: '2026-01-15T17:00:00.000Z' as never })
  advanceGrid(instance, 0, '2026-01-15T17:00:00.000Z' as never)
  return instance
})()
const SWITCHYARD = 'bus:curated-halden-pwr-switchyard@420'

const stationView = (graph: TopologyGraph, anchorBus: string, hops: number): NetworkGraph => {
  const buses = new Map(graph.nodes.filter(node => node.class === 'bus' || node.class === 'junction' || node.class === 'boundary').map(node => [node.id, node]))
  const kv = (busId: string) => graph.media.find(medium => medium.id === buses.get(busId)!.ports[0]!.medium)!.level!.value
  const station = (busId: string) => buses.get(busId)!.group ?? busId
  const label = (id: string) => { const group = graph.groups.find(candidate => candidate.id === id); return group?.shortLabel ?? group?.label ?? buses.get(id)!.label }
  const ends = new Map<string, string[]>()
  for (const edge of graph.edges) for (const [link, end] of [[edge.to.node, edge.from.node], [edge.from.node, edge.to.node]]) if (buses.has(end!) && !buses.has(link!)) ends.set(link!, [...ends.get(link!) ?? [], end!])
  const links = graph.nodes.filter(node => node.class === 'transfer' || node.class === 'converter').map(node => ({ line: node.class === 'transfer', ends: ends.get(node.id)! as [string, string] }))
  const lines = links.filter(link => link.line && kv(link.ends[0]) >= 300 && kv(link.ends[1]) >= 300).map(link => link.ends.map(station) as [string, string]).filter(([a, b]) => a !== b)
  const reach = new Map([[station(anchorBus), 0]])
  for (const [id, hop] of reach) if (hop < hops) for (const [a, b] of lines) for (const next of a === id ? [b] : b === id ? [a] : []) if (!reach.has(next)) reach.set(next, hop + 1)
  const inside = (busId: string) => kv(busId) >= 300 && reach.has(station(busId))
  const pairs = [...new Set(lines.filter(([a, b]) => reach.has(a) && reach.has(b)).map(([a, b]) => [a, b].sort().join('|')))]
  const stubs = new Map(links.flatMap(({ ends: [a, b] }) => [[a, b], [b, a]].filter(([x, y]) => inside(x!) && !inside(y!)).map(([x, y]) => [`stub:${station(y!)}@${kv(y!)}|${station(x!)}`, { at: station(x!), far: `${label(station(y!))} ${kv(y!)} kV` }] as const)))
  const node = (id: string, text: string) => ({ id, class: 'bus' as const, kind: 'station', label: text, rank: id, ports: [{ id: 'bus', rank: 'bus', medium: 'ac', direction: 'both' as const }], bindings: [] })
  const edge = (id: string, a: string, b: string) => ({ id, rank: id, from: { node: a, port: 'bus' }, to: { node: b, port: 'bus' }, medium: 'ac', directed: false, bindings: [] })
  return {
    nodes: [...[...reach.keys()].map(id => node(id, label(id))), ...[...stubs].map(([id, stub]) => node(id, stub.far))],
    edges: [...pairs.map(pair => edge(pair, ...pair.split('|') as [string, string])), ...[...stubs].map(([id, stub]) => edge(`${id}|edge`, stub.at, id))],
    groups: [],
    roots: [station(anchorBus)],
  }
}
/** About two characters per grid unit, one line of text under a one-unit symbol (test-local; the World renderer measures in P2). */
const sizing: NetworkSizing = { key: 'test', node: node => ({ width: Math.max(2, Math.ceil(node.label.length / 2)), height: 2 }), spacing: 1, groupLabel: 1 }

describe('grid topology for the network family (N3)', () => {
  test('the Grid\'s graph validates against the topology contract, with the one attribution constant and the connection points as its boundaries', () => {
    const graph = topologyGraphSchema.parse(gridTopology(grid))
    expect(graph.attribution).toBe(gridModelAttribution)
    expect(gridLiveMapLayer.attribution).toBe(gridModelAttribution)
    expect(graph.nodes.filter(node => node.class === 'transfer' || node.class === 'converter').length).toBe(grid.definition.model.branches.length + grid.definition.model.hvdcLinks.length)
    const joined = haldenScenario.connections.map(connection => connection.network.portId)
    expect(joined.filter(portId => !graph.boundaries.some(boundary => boundary.externalPortId === portId))).toEqual([])
    expect(graph.nodes.find(node => node.id === SWITCHYARD)!.bindings.map(binding => binding.ref)).toEqual([`${grid.definition.gridId}#${SWITCHYARD}.voltage`, `${grid.definition.gridId}#${SWITCHYARD}.energized`])
  })

  test('the topology Capability answers unchanged for a held revision', () => {
    const grids = new Map([[grid.definition.gridId, grid]])
    const graph = gridObservationTopologyQuery.answer({ objectId: grid.definition.gridId }, grids) as TopologyGraph
    expect(gridObservationTopologyQuery.answer({ objectId: grid.definition.gridId, known: graph.revision }, grids)).toEqual({ objectId: grid.definition.gridId as never, revision: graph.revision, unchanged: true })
  })

  for (const hops of [1, 2]) {
    test(`T32 on the Halden ${hops}-hop station view: ≤ 2 crossings, 0 overlaps, warm p95 CPU ≤ 30 ms; cold reported`, async () => {
      const view = stationView(gridTopology(grid), SWITCHYARD, hops)
      const report = await measureCpu(() => networkLayout(view, sizing), 40)
      const layout = await networkLayout(view, sizing)
      console.log(`T32 Halden ${hops}-hop stations (${view.nodes.length} nodes, ${view.edges.length} edges, ${NETWORK_ENGINE_VERSION}): ${layout.width}×${layout.height} grid, ${layout.crossings} crossings, cold ${report.coldMs.toFixed(1)} ms CPU (first in this test), warm p95 ${report.warmP95Ms.toFixed(1)} ms, median ${report.warmMedianMs.toFixed(1)} ms (quiet ms, ${report.rounds} rounds)`)
      expect(view.nodes.length).toBeGreaterThanOrEqual(hops === 1 ? 10 : 16)
      expect(layout.crossings).toBeLessThanOrEqual(2)
      expect(overlaps(layout, () => new Set())).toEqual([])
      expect(edgesThroughNodes(layout, id => { const edge = view.edges.find(candidate => candidate.id === id)!; return [edge.from.node, edge.to.node] })).toEqual([])
      expect(report.warmP95Ms).toBeLessThanOrEqual(30)
      // The bar is CPU, measured above; the wall-clock timeout only has to outlast 41 layouts on a loaded machine.
    }, 60_000)
  }
})
