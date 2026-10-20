// The verifier checks a finished drawing against the profile's rules. It
// reads only the result and the graph (for nets, roles and frames), never the
// engine's internals, so it also guards against engine defects.
import type { DiagramProfile, DiagramViolation, PlacedNode, RoutedEdge } from './diagram.ts'
import { grow, onStep, rectsOverlap, type Rect } from './geometry.ts'
import type { Model } from './model.ts'
import { drawingSegments, findCrossings, isHorizontal, isVertical, sameOwner, type Owner, type Segment } from './crossings.ts'

const EPSILON = 1e-6

export interface VerifyInput {
  readonly model: Model
  readonly net: ReadonlyArray<number>
  readonly profile: DiagramProfile
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<PlacedNode>
  readonly edges: ReadonlyArray<RoutedEdge>
}

const boxOf = (node: PlacedNode): Rect => ({ x: node.x, y: node.y, width: node.width, height: node.height })
const segmentRect = (segment: Segment, buffer: number): Rect => {
  const x0 = Math.min(segment.a[0], segment.b[0])
  const y0 = Math.min(segment.a[1], segment.b[1])
  return { x: x0 - buffer, y: y0 - buffer, width: Math.abs(segment.a[0] - segment.b[0]) + 2 * buffer, height: Math.abs(segment.a[1] - segment.b[1]) + 2 * buffer }
}
const distance = (p: readonly [number, number], q: readonly [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1])

export const verifyLayout = (input: VerifyInput): DiagramViolation[] => {
  const { model, net, profile, width, height, nodes, edges } = input
  const violations: DiagramViolation[] = []
  const push = (rule: DiagramViolation['rule'], subject: string, detail: string): void => {
    violations.push({ rule, subject, detail })
  }
  const outline = profile.pipe.outline
  const grid = profile.grid
  const name = (owner: Owner): string => (owner.kind === 'edge' ? `edge ${model.edges[owner.edge]!.id}` : `bar ${model.nodes[owner.node]!.id}`)

  // Shape of each polyline.
  edges.forEach((edge, e) => {
    const id = model.edges[e]!.id
    const points = edge.points
    const bends: number[] = []
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1]!, points[i]!]
      if (Math.abs(a[0] - b[0]) > EPSILON && Math.abs(a[1] - b[1]) > EPSILON) push('diagonal', `edge ${id}`, `segment ${i} runs from (${a[0]}, ${a[1]}) to (${b[0]}, ${b[1]})`)
      if (i + 1 < points.length) {
        const c = points[i + 1]!
        const straight = (Math.abs(a[0] - b[0]) < EPSILON && Math.abs(b[0] - c[0]) < EPSILON) || (Math.abs(a[1] - b[1]) < EPSILON && Math.abs(b[1] - c[1]) < EPSILON)
        if (!straight) bends.push(i)
        if (!onStep(b[0], grid / 2) || !onStep(b[1], grid / 2)) push('pitch', `edge ${id}`, `point (${b[0]}, ${b[1]}) is off the half grid`)
      }
    }
    if (bends.length > profile.limits.bendsPerEdge) push('bends', `edge ${id}`, `${bends.length} bends, at most ${profile.limits.bendsPerEdge}`)
    const radius = profile.pipe.cornerRadius
    const marks = [0, ...bends, points.length - 1]
    for (let k = 1; k < marks.length; k++) {
      const span = distance(points[marks[k - 1]!]!, points[marks[k]!]!)
      const atEnd = k === 1 || k === marks.length - 1
      const needed = atEnd ? radius : 2 * radius
      if (marks.length > 2 && span < needed - EPSILON) push('bendSpacing', `edge ${id}`, `${span} px between ${atEnd ? 'an end and a bend' : 'bends'}, at least ${needed}`)
    }
  })

  // Symbols, ports and boxes on the grid.
  model.nodes.forEach((node, n) => {
    const placed = nodes[n]!
    if (node.role === 'bar') return
    if (!onStep(placed.x, grid) || !onStep(placed.y, grid) || !onStep(placed.width, grid) || !onStep(placed.height, grid)) push('pitch', `node ${node.id}`, 'box is off the grid')
    for (const [port, at] of Object.entries(placed.ports)) {
      const along = at.face === 'left' || at.face === 'right' ? at.y : at.x
      if (!onStep(along, node.role === 'hub' ? grid / 2 : grid)) push('pitch', `node ${node.id}`, `port ${port} is off the grid along its face`)
    }
  })

  // Everything inside the box.
  const inside = (rect: Rect): boolean => rect.x >= -EPSILON && rect.y >= -EPSILON && rect.x + rect.width <= width + EPSILON && rect.y + rect.height <= height + EPSILON
  nodes.forEach((placed, n) => {
    const id = model.nodes[n]!.id
    if (!inside(boxOf(placed))) push('outsideBox', `node ${id}`, 'symbol')
    if (placed.text !== null && !inside(placed.text)) push('outsideBox', `node ${id}`, 'text')
    if (placed.frame !== null && !inside(placed.frame)) push('outsideBox', `node ${id}`, 'frame')
  })
  edges.forEach((edge, e) => {
    if (edge.points.some(([x, y]) => !inside({ x: x - outline / 2, y: y - outline / 2, width: outline, height: outline }))) push('outsideBox', `edge ${model.edges[e]!.id}`, 'pipe')
  })

  // Overlaps among symbols and text.
  const solid = model.nodes.map((node, n) => ({ n, rect: boxOf(nodes[n]!), id: node.id }))
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      if (rectsOverlap(solid[i]!.rect, solid[j]!.rect)) push('overlap', `node ${solid[i]!.id}`, `symbol overlaps node ${solid[j]!.id}`)
    }
  }
  const texts = nodes.flatMap((placed, n) => (placed.text === null ? [] : [{ n, rect: placed.text as Rect, id: model.nodes[n]!.id }]))
  for (const text of texts) {
    for (const other of texts) if (other.n > text.n && rectsOverlap(text.rect, other.rect)) push('overlap', `node ${text.id}`, `text overlaps text of ${other.id}`)
    for (const node of solid) if (rectsOverlap(text.rect, node.rect)) push('overlap', `node ${text.id}`, `text overlaps node ${node.id}`)
    for (const framed of nodes.map((placed, n) => ({ n, frame: placed.frame }))) {
      if (framed.frame === null || framed.n === text.n) continue
      if (rectsOverlap(grow(text.rect, profile.textClearance), framed.frame)) push('textClearance', `node ${text.id}`, `text is within ${profile.textClearance} px of the frame of ${model.nodes[framed.n]!.id}`)
    }
  }

  // Pipes against symbols, text and each other.
  const segments = drawingSegments(model, net, nodes, edges)
  const pipeSegments = segments.filter(segment => segment.owner.kind === 'edge')
  for (const segment of pipeSegments) {
    const owner = segment.owner as Extract<Owner, { kind: 'edge' }>
    const edge = model.edges[owner.edge]!
    const buffered = segmentRect(segment, outline / 2)
    for (const node of model.nodes) {
      if (node.role === 'bar') continue
      const own = node.index === edge.from || node.index === edge.to
      const box = boxOf(nodes[node.index]!)
      if (!own && rectsOverlap(buffered, box)) push('overlap', name(owner), `pipe overlaps node ${node.id}`)
      if (own && rectsOverlap(segmentRect(segment, 0), grow(box, -node.portInset - 0.5))) push('overlap', name(owner), `pipe runs into its own node ${node.id}`)
    }
    for (const text of texts) if (rectsOverlap(buffered, text.rect)) push('overlap', name(owner), `pipe overlaps text of ${text.id}`)
  }
  const spacing = outline + 4
  // Each segment as its axis (0: horizontal, 1: vertical, -1: neither), the coordinate it lies at, and its extent along it.
  const shapes = segments.map(segment => {
    const axis = isHorizontal(segment) ? 0 : isVertical(segment) ? 1 : -1
    const along = axis === 1 ? 1 : 0
    return { axis, at: segment.a[1 - along]!, low: Math.min(segment.a[along]!, segment.b[along]!), high: Math.max(segment.a[along]!, segment.b[along]!) }
  })
  for (let i = 0; i < segments.length; i++) {
    const p = shapes[i]!
    if (p.axis < 0) continue
    for (let j = i + 1; j < segments.length; j++) {
      const q = shapes[j]!
      if (q.axis !== p.axis) continue
      const across = Math.abs(p.at - q.at)
      if (across >= spacing - EPSILON) continue
      const overlap = Math.min(p.high, q.high) - Math.max(p.low, q.low)
      if (overlap <= EPSILON) continue
      const s = segments[i]!
      const t = segments[j]!
      if (sameOwner(s.owner, t.owner) || (s.owner.kind === 'bar' && t.owner.kind === 'bar')) continue
      if (across < EPSILON) push('overlap', name(s.owner), `runs along ${name(t.owner)}`)
      else push('pipeSpacing', name(s.owner), `${across} px from ${name(t.owner)}, at least ${spacing}`)
    }
  }

  // Crossings stay clear of bends, ends and junctions on both pipes.
  const known = new Map<string, Array<readonly [number, number]>>()
  const vertices = (owner: Owner): Array<readonly [number, number]> => {
    const key = owner.kind === 'edge' ? `n${owner.net}` : `b${owner.node}`
    const cached = known.get(key)
    if (cached !== undefined) return cached
    let found: Array<readonly [number, number]>
    if (owner.kind === 'edge') found = edges.flatMap((edge, e) => (net[e] === owner.net ? edge.points : []))
    else {
      const bar = segments.find(segment => segment.owner.kind === 'bar' && segment.owner.node === owner.node)!
      const tees = model.edges.flatMap((edge, e) => (edge.from === owner.node ? [edges[e]!.points[0]!] : edge.to === owner.node ? [edges[e]!.points.at(-1)!] : []))
      found = [bar.a, bar.b, ...tees]
    }
    known.set(key, found)
    return found
  }
  const keepOff = profile.pipe.cornerRadius + profile.pipe.crossingHalfGap
  for (const crossing of findCrossings(segments)) {
    for (const participant of [crossing.vertical, crossing.horizontal]) {
      const near = vertices(participant.owner).find(point => distance(point, crossing.point) < keepOff - EPSILON)
      if (near !== undefined) push('crossingAtJunction', name(participant.owner), `crossing at (${crossing.point[0]}, ${crossing.point[1]}) is ${distance(near, crossing.point)} px from a bend, end or junction`)
    }
  }
  return violations
}
