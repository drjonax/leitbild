// The Grid's topology for the `network` family (N3; architecture A5): buses, branches, HVDC links and connection points
// are equipment nodes with ports at their buses' voltage levels, edges pure connectivity, stations the groups, and the
// connection points the boundaries a Scenario connection joins. Bindings read the declared signals. No geometry.
import { defineObservationCapability, observationShapes } from '../../../core/observation/capabilities.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { gridModelAttribution } from '../model.ts'
import { gridFor, type GridRuntimes } from '../queries/common.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { gridElement, gridSignalId } from './declarations.ts'

type Node = TopologyGraph['nodes'][number]
const graphs = new WeakMap<GridRuntimeInstance['definition'], TopologyGraph>()

export const gridTopology = (grid: GridRuntimeInstance): TopologyGraph => graphs.get(grid.definition) ?? (() => {
  const { gridId, model, index, definitionDigest } = grid.definition
  const medium = (busId: string): string => `ac-${index.busById.get(busId)!.nominalKv}`
  const port = (id: string, busId: string) => ({ id, rank: id, medium: medium(busId), direction: 'both' as const })
  const bind = (role: Node['bindings'][number]['role'], id: string, key: string) => ({ role, ref: `${gridId}#${gridSignalId('', id, key)}` })
  const at = (prefix: string, position: number): string => `${prefix}${String(position).padStart(5, '0')}`
  const group = (id: string): { group?: string } => { const station = gridElement(grid, id)?.group; return station === undefined ? {} : { group: station } }
  const links = [
    ...model.branches.map(branch => ({ ...branch, class: branch.kind === 'transformer' ? 'converter' as const : 'transfer' as const, keys: ['flow', 'loading', 'state'] })),
    ...model.hvdcLinks.map(link => ({ ...link, kind: 'hvdc', class: 'converter' as const, keys: ['transfer', 'state'] })),
  ]
  const edge = (id: string, position: number, from: readonly [string, string], to: readonly [string, string], busId: string) =>
    ({ id, rank: at('e', position), from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] }, medium: medium(busId), directed: false, bindings: [] })
  const graph: TopologyGraph = {
    objectId: gridId as TopologyGraph['objectId'], revision: definitionDigest.slice(0, 40), family: 'network', attribution: gridModelAttribution,
    media: [...new Set(model.buses.map(bus => bus.nominalKv))].map(kv => ({ id: `ac-${kv}`, label: `${kv} kV`, kind: 'electric-ac', level: { value: kv, unit: 'kV' } })),
    groups: [...new Set(model.buses.flatMap(bus => group(bus.id).group ?? []))].map(id => { const station = gridElement(grid, id)!; return { id, label: station.label, kind: 'station', ...(station.shortLabel ? { shortLabel: station.shortLabel } : {}) } }),
    nodes: [
      ...model.buses.map((bus, position): Node => ({
        id: bus.id, element: bus.id, class: bus.kind === 'junction' || bus.kind === 'boundary' ? bus.kind : 'bus', kind: bus.kind, label: bus.label, rank: at('b', position), ...group(bus.id),
        ports: [port('bus', bus.id)], bindings: [bind('level', bus.id, 'voltage'), bind('conducting', bus.id, 'energized')],
      })),
      ...links.map((link, position): Node => ({
        id: link.id, element: link.id, class: link.class, kind: link.kind, label: link.label, rank: at('l', position),
        ports: [port('a', link.fromBusId), port('b', link.toBusId)], bindings: link.keys.map(key => bind(key === 'state' ? 'conducting' : key === 'loading' ? 'loading' : 'flow', link.id, key)),
      })),
      ...model.connectionPoints.map((point, position): Node => ({
        id: point.id, element: point.id, class: 'boundary', kind: 'connection-point', label: point.label, rank: at('c', position), ...group(point.id),
        ports: [port('bus', point.busId), port('system', point.busId)], bindings: [bind('flow', point.id, 'exchange')],
      })),
    ],
    edges: [
      ...links.flatMap((link, position) => [edge(`${link.id}:a`, 2 * position, [link.fromBusId, 'bus'], [link.id, 'a'], link.fromBusId), edge(`${link.id}:b`, 2 * position + 1, [link.id, 'b'], [link.toBusId, 'bus'], link.toBusId)]),
      ...model.connectionPoints.map((point, position) => edge(`${point.id}:bus`, 2 * links.length + position, [point.busId, 'bus'], [point.id, 'bus'], point.busId)),
    ],
    boundaries: model.connectionPoints.map(point => ({ node: point.id, port: 'system', externalPortId: point.id })),
  }
  graphs.set(grid.definition, graph)
  return graph
})()

export const gridObservationTopologyQuery = {
  capability: defineObservationCapability('topology', {
    id: 'world.electric-grid.observation.topology', title: 'Grid topology', description: 'World-internal: the Grid\'s semantic graph for network views.',
  }),
  answer: (rawInput: unknown, grids: GridRuntimes) => {
    const input = observationShapes.topology.input.parse(rawInput)
    const graph = gridTopology(gridFor(grids, input.objectId))
    return input.known === graph.revision ? { objectId: input.objectId, revision: graph.revision, unchanged: true as const } : graph
  },
}
