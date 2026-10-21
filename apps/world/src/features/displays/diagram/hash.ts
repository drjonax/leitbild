// A stable hash of the geometry alone. Ids are replaced by canonical indices
// (nodes, ports and edges in their structural order) and
// everything is serialised as arrays, so neither ids nor key order reach it.
import { createHash } from 'node:crypto'
import { DIAGRAM_ENGINE_VERSION, type PlacedNode, type RoutedEdge } from './diagram.ts'
import type { Model, Role } from './model.ts'

/**
 * How the hash writes each node's role: fixed tokens, never the vocabulary's
 * names, so renaming a role changes no drawing's identity. A stored display
 * compares its drawing's hash to say the drawing changed; a common node was
 * written `hub` when the hash was defined (DIAGRAM_ENGINE_VERSION 8).
 */
const ROLE_TOKENS: Readonly<Record<Role, string>> = { device: 'device', bar: 'bar', common: 'hub', stub: 'stub' }

export const geometryHash = (model: Model, width: number, height: number, nodes: ReadonlyArray<PlacedNode>, edges: ReadonlyArray<RoutedEdge>): string => {
  const canonical = [
    DIAGRAM_ENGINE_VERSION,
    width,
    height,
    nodes.map((node, n) => [
      ROLE_TOKENS[model.nodes[n]!.role],
      node.x, node.y, node.width, node.height,
      model.nodes[n]!.ports.map(port => {
        const at = node.ports[port.id]
        return at === undefined ? null : [at.x, at.y, at.face]
      }),
      node.text === null ? null : [node.text.x, node.text.y, node.text.width, node.text.height, node.text.side, node.text.lines],
      node.frame === null ? null : [node.frame.x, node.frame.y, node.frame.width, node.frame.height],
    ]),
    edges.map(edge => [edge.points.map(point => [point[0], point[1]]), edge.gaps.map(point => [point[0], point[1]])]),
  ]
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
