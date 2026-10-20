// Segments of the drawing and where they cross. A crossing is a vertical and
// a horizontal segment of different nets meeting strictly inside both; bars
// count as segments. The gap goes on the pipe: of two pipes, the vertical one.
import type { PlacedNode, RoutedEdge } from './diagram.ts'
import type { Model } from './model.ts'

export type Owner = { readonly kind: 'edge'; readonly edge: number; readonly net: number } | { readonly kind: 'bar'; readonly node: number }

export interface Segment {
  readonly owner: Owner
  readonly a: readonly [number, number]
  readonly b: readonly [number, number]
  /** Index of the segment in its edge's polyline (bars: 0). */
  readonly index: number
}

export interface Crossing {
  readonly point: readonly [number, number]
  /** The edge that takes the gap. */
  readonly gapEdge: number
  readonly vertical: Segment
  readonly horizontal: Segment
}

const EPSILON = 1e-6

export const isHorizontal = (segment: Segment): boolean => Math.abs(segment.a[1] - segment.b[1]) < EPSILON && Math.abs(segment.a[0] - segment.b[0]) >= EPSILON
export const isVertical = (segment: Segment): boolean => Math.abs(segment.a[0] - segment.b[0]) < EPSILON && Math.abs(segment.a[1] - segment.b[1]) >= EPSILON

/** A bar's centre line along its longer side. */
export const barSegment = (node: PlacedNode, index: number): Segment => node.width >= node.height
  ? { owner: { kind: 'bar', node: index }, a: [node.x, node.y + node.height / 2], b: [node.x + node.width, node.y + node.height / 2], index: 0 }
  : { owner: { kind: 'bar', node: index }, a: [node.x + node.width / 2, node.y], b: [node.x + node.width / 2, node.y + node.height], index: 0 }

export const drawingSegments = (model: Model, net: ReadonlyArray<number>, nodes: ReadonlyArray<PlacedNode>, edges: ReadonlyArray<RoutedEdge>): Segment[] => [
  ...edges.flatMap((edge, e) => edge.points.slice(1).map((b, i): Segment => ({ owner: { kind: 'edge', edge: e, net: net[e]! }, a: edge.points[i]!, b, index: i }))),
  ...model.nodes.filter(node => node.role === 'bar').map(node => barSegment(nodes[node.index]!, node.index)),
]

export const sameOwner = (x: Owner, y: Owner): boolean =>
  x.kind === 'edge' && y.kind === 'edge' ? x.net === y.net : x.kind === 'bar' && y.kind === 'bar' ? x.node === y.node : false

export const findCrossings = (segments: ReadonlyArray<Segment>): Crossing[] => {
  const verticals = segments.filter(isVertical)
  // Horizontals by height, so each vertical looks only at those within its span.
  const horizontals = segments.filter(isHorizontal).map(segment => ({
    segment,
    y: segment.a[1],
    x0: Math.min(segment.a[0], segment.b[0]),
    x1: Math.max(segment.a[0], segment.b[0]),
  })).sort((p, q) => p.y - q.y)
  const firstAbove = (y: number): number => {
    let low = 0
    let high = horizontals.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (horizontals[middle]!.y <= y + EPSILON) low = middle + 1
      else high = middle
    }
    return low
  }
  const crossings: Crossing[] = []
  const seen = new Set<string>()
  for (const vertical of verticals) {
    const x = vertical.a[0]
    const [y0, y1] = [Math.min(vertical.a[1], vertical.b[1]), Math.max(vertical.a[1], vertical.b[1])]
    for (let at = firstAbove(y0); at < horizontals.length && horizontals[at]!.y < y1 - EPSILON; at++) {
      const { segment: horizontal, y, x0, x1 } = horizontals[at]!
      if (!(x > x0 + EPSILON && x < x1 - EPSILON)) continue
      if (sameOwner(vertical.owner, horizontal.owner)) continue
      if (vertical.owner.kind === 'bar' && horizontal.owner.kind === 'bar') continue
      const gapEdge = vertical.owner.kind === 'edge' ? vertical.owner.edge : (horizontal.owner as { edge: number }).edge
      // Pipes of one net that share a track are one pipe there: a run across them crosses it once.
      const key = `${x},${y}|${ownerKey(vertical.owner)}|${ownerKey(horizontal.owner)}`
      if (seen.has(key)) continue
      seen.add(key)
      crossings.push({ point: [x, y], gapEdge, vertical, horizontal })
    }
  }
  // In the order the segments were given: verticals first, then horizontals within each.
  return crossings
}

const ownerKey = (owner: Owner): string => (owner.kind === 'edge' ? `n${owner.net}` : `b${owner.node}`)

/** Gaps per edge, ordered along the edge. */
export const gapsByEdge = (edgeCount: number, crossings: ReadonlyArray<Crossing>, edges: ReadonlyArray<RoutedEdge>): Array<Array<readonly [number, number]>> => {
  const gaps = Array.from({ length: edgeCount }, () => [] as Array<{ point: readonly [number, number]; order: number }>)
  for (const crossing of crossings) {
    const segment = crossing.vertical.owner.kind === 'edge' && crossing.vertical.owner.edge === crossing.gapEdge ? crossing.vertical : crossing.horizontal
    const start = edges[crossing.gapEdge]!.points[segment.index]!
    const distance = Math.abs(crossing.point[0] - start[0]) + Math.abs(crossing.point[1] - start[1])
    gaps[crossing.gapEdge]!.push({ point: crossing.point, order: segment.index * 1e6 + distance })
  }
  return gaps.map(list => list.sort((a, b) => a.order - b.order).map(entry => entry.point))
}
