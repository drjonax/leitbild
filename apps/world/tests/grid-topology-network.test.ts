import { describe, expect, test } from 'bun:test'
import { topologyGraphSchema, type TopologyGraph } from '../src/core/observation/topology.ts'
import { NETWORK_ENGINE_VERSION, networkLayout, type NetworkSizing } from '../src/features/displays/topology/network.ts'
import { scopeTopology, type ScopedTopology } from '../src/features/displays/topology/scope.ts'
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
// and ELK lays out the Halden views the generic scope draws around the plant switchyard: buses and branches of
// ≥ 300 kV, one station hop per two edges (bus to line, line to bus), stopped where they leave the scope.
const grid = (() => {
  const definition = compileGridDefinition(gridDefinitionSchema.parse({
    id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
  }))
  const instance = createGridRuntimeInstance({ definition, at: '2026-01-15T17:00:00.000Z' as never })
  advanceGrid(instance, 0, '2026-01-15T17:00:00.000Z' as never)
  return instance
})()
const SWITCHYARD = 'bus:curated-halden-pwr-switchyard@420'

const HASLE = 'bus:osm-way-60495669@420'
/** The k-station-hop view around a bus (the switchyard unless named), as the generic scope draws it. */
const stationView = (graph: TopologyGraph, hops: number, around = SWITCHYARD): ScopedTopology => {
  const result = scopeTopology(graph, { around: [around], media: graph.media.filter(medium => (medium.level?.value ?? 0) >= 300).map(medium => medium.id), reach: 2 * hops })
  if (!result.ok) throw new Error(`the scope refused the ${hops}-hop view: ${result.refusal.code}`)
  return result.scoped
}
/** About two characters per grid unit, one line of text under a one-unit symbol; a stop names its far ends (test-local; the World renderer measures in P2). */
const sizing: NetworkSizing = {
  key: 'test', node: node => ({ width: Math.max(2, Math.ceil((node.shortLabel ?? node.label).length / 2)), height: 2 }),
  stop: stop => ({ width: Math.max(2, Math.ceil(stop.others.length * 6)), height: 1 }), spacing: 1, groupLabel: 1,
}

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

  test('views around a bus inside a station frame lay out too (ELK\'s model-order option threw on them), without overlaps', async () => {
    for (const hops of [1, 2]) {
      const view = stationView(gridTopology(grid), hops, HASLE)
      const layout = await networkLayout(view, sizing)
      expect(overlaps(layout, group => new Set(view.graph.nodes.filter(node => node.group === group).map(node => node.id)))).toEqual([])
    }
  })

  for (const hops of [1, 2]) {
    test(`T32 on the Halden ${hops}-hop view: ≤ 2 crossings, 0 overlaps, warm p95 CPU ≤ 30 ms; cold reported`, async () => {
      const view = stationView(gridTopology(grid), hops)
      const report = await measureCpu(() => networkLayout(view, sizing), 40)
      const layout = await networkLayout(view, sizing)
      const stations = new Set(view.nodes.flatMap(id => view.graph.nodes.find(node => node.id === id)!.group ?? []))
      console.log(`T32 Halden ${hops}-hop (${view.nodes.length} nodes in ${stations.size} stations, ${view.edges.length} edges, ${view.stubs.length} stops, ${NETWORK_ENGINE_VERSION}): ${layout.width}×${layout.height} grid, ${layout.crossings} crossings, cold ${report.coldMs.toFixed(1)} ms CPU (first in this test), warm p95 ${report.warmP95Ms.toFixed(1)} ms, median ${report.warmMedianMs.toFixed(1)} ms (quiet ms, ${report.rounds} rounds)`)
      expect(view.roots).toEqual([SWITCHYARD])
      expect(layout.crossings).toBeLessThanOrEqual(2)
      const members = (group: string) => new Set(view.graph.nodes.filter(node => node.group === group).map(node => node.id))
      expect(overlaps(layout, members)).toEqual([])
      const endsOf = new Map([...view.graph.edges.map(edge => [edge.id, [edge.from.node, edge.to.node]] as const), ...view.stubs.map((stop, at) => [`s${at}.edge`, [stop.node, `s${at}`]] as const)])
      expect(edgesThroughNodes(layout, id => endsOf.get(id)!)).toEqual([])
      expect(report.warmP95Ms).toBeLessThanOrEqual(30)
      // The bar is CPU, measured above; the wall-clock timeout only has to outlast 41 layouts on a loaded machine.
    }, 60_000)
  }
})
