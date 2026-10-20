// A stable hash of the geometry alone. Ids are replaced by canonical indices
// (nodes, ports and edges in their structural order, lanes in lane order) and
// everything is serialised as arrays, so neither ids nor key order reach it.
import { createHash } from 'node:crypto'
import { DIAGRAM_ENGINE_VERSION, type DiagramZone, type PlacedNode, type RoutedEdge } from './diagram.ts'
import type { Model } from './model.ts'

export const geometryHash = (model: Model, width: number, height: number, nodes: ReadonlyArray<PlacedNode>, edges: ReadonlyArray<RoutedEdge>, zones: ReadonlyArray<DiagramZone>): string => {
  const canonical = [
    DIAGRAM_ENGINE_VERSION,
    width,
    height,
    nodes.map((node, n) => [
      model.nodes[n]!.role,
      node.x, node.y, node.width, node.height,
      model.nodes[n]!.ports.map(port => {
        const at = node.ports[port.id]
        return at === undefined ? null : [at.x, at.y, at.face]
      }),
      node.text === null ? null : [node.text.x, node.text.y, node.text.width, node.text.height, node.text.side, node.text.lines],
      node.frame === null ? null : [node.frame.x, node.frame.y, node.frame.width, node.frame.height],
    ]),
    edges.map(edge => [edge.points.map(point => [point[0], point[1]]), edge.gaps.map(point => [point[0], point[1]])]),
    zones.map((zone, lane) => [lane, zone.x, zone.y, zone.width, zone.height]),
  ]
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
