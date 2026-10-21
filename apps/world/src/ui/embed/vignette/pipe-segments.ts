import { CORNER_RADIUS, OVERLAP_HALF_GAP, type PipeSize, type PipeValue, type Segment } from '@oicl/connector-diagram'

// A routed pipe as OpenBridge connector-diagram segments: straight runs with
// OpenBridge's rounded corners, a clean gap where another run crosses over, a
// flow chevron only where the model computes the direction, and an arrow or
// cap where the drawing stops. Pure, so the geometry is tested without a DOM.

type Point = readonly [number, number]
type Direction = 'top' | 'right' | 'bottom' | 'left'

/** How a pipe's flow reads: in its direction or against it, flowing in a direction not known, none, or not known; a power line live or dead. */
export type PipeLook = 'forward' | 'reverse' | 'flowing' | 'none' | 'unknown' | 'live' | 'dead'

/** Hollow below the no-flow band, dashed when unknown; never `closed`, which would read as a shut pipe. */
export const pipeValue = (look: PipeLook): PipeValue =>
  look === 'none' || look === 'dead' ? 'empty' : look === 'unknown' ? 'closed-dash' : 'open-flow'

const directionOf = (from: Point, to: Point): Direction =>
  to[0] > from[0] ? 'right' : to[0] < from[0] ? 'left' : to[1] > from[1] ? 'bottom' : 'top'

const opposite: Readonly<Record<Direction, Direction>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

const base = (id: string, value: PipeValue, size: PipeSize) => ({ connectionId: id, value, size })

/** Straights and radius-8 corners along an orthogonal polyline, split where another run crosses it. */
export const pipeSegments = (id: string, points: ReadonlyArray<Point>, gaps: ReadonlyArray<Point>, value: PipeValue, size: PipeSize): Segment[] => {
  const segments: Segment[] = []
  const radius = CORNER_RADIUS
  let start = { x: points[0]![0], y: points[0]![1] }
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1]!
    const [bx, by] = points[index]!
    const last = index === points.length - 1
    const step = { x: Math.sign(bx - ax), y: Math.sign(by - ay) }
    const end = last ? { x: bx, y: by } : { x: bx - step.x * radius, y: by - step.y * radius }
    segments.push(...splitAtGaps({ kind: 'straight', ...base(id, value, size), x1: start.x, y1: start.y, x2: end.x, y2: end.y }, gaps, size))
    if (!last) {
      const [cx, cy] = points[index + 1]!
      const to = { x: bx + Math.sign(cx - bx) * radius, y: by + Math.sign(cy - by) * radius }
      // The elbow is the corner of the square spanned by the two tangent points.
      const top = by === Math.min(end.y, to.y)
      const left = bx === Math.min(end.x, to.x)
      segments.push({ kind: 'corner', ...base(id, value, size), from: end, to, direction: `${top ? 'Top' : 'Bottom'}${left ? 'Left' : 'Right'}` })
      start = to
    }
  }
  return segments
}

const splitAtGaps = (straight: Extract<Segment, { kind: 'straight' }>, gaps: ReadonlyArray<Point>, size: PipeSize): Segment[] => {
  const half = OVERLAP_HALF_GAP[size]
  const vertical = straight.x1 === straight.x2
  const from = vertical ? straight.y1 : straight.x1
  const to = vertical ? straight.y2 : straight.x2
  const sign = Math.sign(to - from)
  const cuts = gaps
    .filter(point => (vertical ? point[0] === straight.x1 : point[1] === straight.y1))
    .map(point => vertical ? point[1] : point[0])
    .filter(at => (at - from) * sign > 0 && (to - at) * sign > 0)
    .sort((left, right) => (left - right) * sign)
  if (cuts.length === 0) return [straight]
  // Pieces in flow direction, each stopping half a gap short of a crossing.
  const edges = [from, ...cuts.flatMap(cut => [cut - sign * half, cut + sign * half]), to]
  return Array.from({ length: edges.length / 2 }, (_, at) => [edges[at * 2]!, edges[at * 2 + 1]!] as const)
    .filter(([start, end]) => (end - start) * sign > 0)
    .map(([start, end]) => vertical ? { ...straight, y1: start, y2: end } : { ...straight, x1: start, x2: end })
}

/**
 * One chevron in flow direction, in the middle of the longest straight piece
 * clear of bends (a corner radius) and crossing gaps; none when no piece is
 * long enough to hold it (24 px).
 */
export const chevronSegment = (id: string, points: ReadonlyArray<Point>, gaps: ReadonlyArray<Point>, value: PipeValue, size: PipeSize, reverse: boolean): Segment | null => {
  const pieces = pipeSegments(id, points, gaps, value, size)
    .filter((segment): segment is Extract<Segment, { kind: 'straight' }> => segment.kind === 'straight')
    .map(segment => ({ segment, length: Math.abs(segment.x2 - segment.x1) + Math.abs(segment.y2 - segment.y1) }))
    .filter(piece => piece.length >= 24)
  const longest = pieces.reduce<(typeof pieces)[number] | undefined>((best, piece) => best === undefined || piece.length > best.length ? piece : best, undefined)
  if (longest === undefined) return null
  const { x1, y1, x2, y2 } = longest.segment
  const forward = directionOf([x1, y1], [x2, y2])
  return { kind: 'direction', ...base(id, value, size), x: (x1 + x2) / 2, y: (y1 + y2) / 2, direction: reverse ? opposite[forward] : forward }
}

/** Where a pipe leaves the drawing: an arrow when flow is known to leave (or enter) there, else OpenBridge's end cap. */
export const stubEndSegment = (id: string, points: ReadonlyArray<Point>, direction: 'in' | 'out', value: PipeValue, size: PipeSize, flowing: boolean): Segment => {
  const end = direction === 'out' ? points.at(-1)! : points[0]!
  const neighbour = direction === 'out' ? points.at(-2)! : points[1]!
  const outward = directionOf(neighbour, end)
  if (!flowing) return { kind: 'endpoint', ...base(id, value, size), x: end[0], y: end[1], direction: outward }
  return { kind: 'arrow', ...base(id, value, size), x: end[0], y: end[1], direction: outward, flow: direction === 'out' ? 'going-to' : 'coming-from' }
}
