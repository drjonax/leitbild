import { haversineKm, kmPerDegreeLon, type LonLat } from '../topology/geometry.ts'
import { roundLonLat, simplifyPath } from './geo.ts'
import type { WaterCrossings } from './water-crossings.ts'

// Designed routes for the lines of a fictional connection (a Model Addition), which have no mapped
// route. They are drawn the way a planner would lay new circuits: along the existing transmission
// corridors of a suitable voltage (the shortest path over the base model's mapped routes), with a
// short new spur where an end stands off every corridor. A spur never crosses open sea (the OSM
// coastline) and joins its corridor in a smooth curve; corners are rounded, and each lane is set
// beside the corridor it follows, on the side its plant stands, so new circuits read as running
// next to the existing ones without crossing them. Presentation only: the routes never enter the
// model or its electrical values.

/** A mapped route of the base model: a line or cable with its path from the geometry artifact. */
export interface CorridorRoute {
  readonly id: string
  readonly kind: 'ac_line' | 'cable'
  readonly kv: number
  readonly path: ReadonlyArray<LonLat>
}

/** One designed line: from its own end to the end it connects to, in a lane beside the corridor (0 = on it). */
export interface DesignedRouteRequest {
  readonly id: string
  readonly kv: number
  readonly from: LonLat
  readonly to: LonLat
  readonly lane: number
}

export interface DesignedRoute {
  readonly id: string
  readonly path: ReadonlyArray<LonLat>
  /** Along existing corridors, km. */
  readonly corridorKm: number
  /** New spurs at the ends, km. */
  readonly spurKm: number
  /** The corridor routes it follows, in order. */
  readonly corridorIds: ReadonlyArray<string>
}

export const designedRouteRules = {
  /** Corridors of at least this share of the line's voltage carry it (300 kV and 420 kV for a 420 kV line). */
  minimumCorridorKvShare: 0.7,
  /** An end this close to a corridor vertex starts on it, km. */
  onCorridorKm: 0.2,
  /** A spur joins a corridor at most this far away, km. */
  spurSearchKm: 12,
  /** Spur candidates per end: the nearest corridor segments. */
  spurCandidates: 24,
  /** A km of new spur weighs as much as this many km along an existing corridor. */
  spurWeight: 3,
  /** Distance between lanes beside the corridor, km. */
  laneSpacingKm: 0.15,
  /** Over this length at each end a lane closes in to the end point, km. */
  laneTaperKm: 1.5,
  /** A spur meets its corridor this many times its own length along it, within the bounds below. */
  spurMergeFactor: 4,
  spurMergeMinKm: 0.8,
  spurMergeMaxKm: 3,
  /** Corners are rounded within this distance of their vertex, km. */
  cornerKm: 0.8,
  /** Douglas–Peucker tolerance at which a route follows its corridors, m. */
  corridorSimplificationMeters: 150,
  /** Douglas–Peucker tolerance of the drawn route, m: fine enough to keep the curves. */
  simplificationMeters: 10,
} as const

const kmPerDegreeLat = 110.574

/** Local plane around a reference latitude, km. */
const planar = (reference: number) => {
  const kx = kmPerDegreeLon(reference)
  return {
    toXy: (point: LonLat): readonly [number, number] => [point[0] * kx, point[1] * kmPerDegreeLat],
    toLonLat: (xy: readonly [number, number]): LonLat => [xy[0] / kx, xy[1] / kmPerDegreeLat],
  }
}

const keyOf = (point: LonLat): string => `${point[0].toFixed(5)},${point[1].toFixed(5)}`

interface Edge { readonly to: number; readonly km: number; readonly weight: number; readonly corridor: string | null }

const createHeap = () => {
  const items: Array<readonly [number, number]> = []
  const less = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  return {
    push: (priority: number, value: number): void => {
      items.push([priority, value])
      let index = items.length - 1
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (!less(items[index]!, items[parent]!)) break
        ;[items[parent], items[index]] = [items[index]!, items[parent]!]
        index = parent
      }
    },
    pop: (): readonly [number, number] | undefined => {
      if (items.length === 0) return undefined
      const top = items[0]!
      const last = items.pop()!
      if (items.length > 0) {
        items[0] = last
        let index = 0
        for (;;) {
          const left = index * 2 + 1
          const right = left + 1
          let smallest = index
          if (left < items.length && less(items[left]!, items[smallest]!)) smallest = left
          if (right < items.length && less(items[right]!, items[smallest]!)) smallest = right
          if (smallest === index) break
          ;[items[smallest], items[index]] = [items[index]!, items[smallest]!]
          index = smallest
        }
      }
      return top
    },
  }
}

/** The nearest point of segment a–b to p, as the fraction along it. */
const nearestFraction = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  return lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared))
}

const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** Corner rounding: each interior vertex becomes a quadratic curve between points `cornerKm` before and after it. */
const roundCorners = (path: ReadonlyArray<LonLat>, cornerKm: number): ReadonlyArray<LonLat> => {
  if (path.length < 3) return path
  const result: LonLat[] = [path[0]!]
  for (let index = 1; index < path.length - 1; index += 1) {
    const previous = path[index - 1]!
    const vertex = path[index]!
    const next = path[index + 1]!
    const before = haversineKm(previous, vertex)
    const after = haversineKm(vertex, next)
    if (before === 0 || after === 0) continue
    const cut = Math.min(cornerKm, before * 0.45, after * 0.45)
    const start = lerp(vertex, previous, cut / before)
    const end = lerp(vertex, next, cut / after)
    for (let step = 0; step <= 4; step += 1) {
      const t = step / 4
      const a = lerp(start, vertex, t)
      const b = lerp(vertex, end, t)
      result.push(lerp(a, b, t))
    }
  }
  result.push(path[path.length - 1]!)
  return result
}

/**
 * The path set `offsetKm` to the right of its direction of travel, closing in to the path itself
 * over `taperKm` at each end so the lane still starts and ends at the end points.
 */
const offsetPath = (path: ReadonlyArray<LonLat>, offsetKm: number, taperKm: number): ReadonlyArray<LonLat> => {
  if (offsetKm === 0 || path.length < 2) return path
  const plane = planar(path.reduce((sum, point) => sum + point[1], 0) / path.length)
  const xy = path.map(plane.toXy)
  const along: number[] = [0]
  for (let index = 1; index < xy.length; index += 1) along.push(along[index - 1]! + Math.hypot(xy[index]![0] - xy[index - 1]![0], xy[index]![1] - xy[index - 1]![1]))
  const total = along[along.length - 1]!
  const unitNormal = (from: readonly [number, number], to: readonly [number, number]): readonly [number, number] => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const length = Math.hypot(dx, dy)
    return length === 0 ? [0, 0] : [dy / length, -dx / length]
  }
  return xy.map((point, index) => {
    const before = index > 0 ? unitNormal(xy[index - 1]!, point) : null
    const after = index < xy.length - 1 ? unitNormal(point, xy[index + 1]!) : null
    const sum: readonly [number, number] = [(before?.[0] ?? 0) + (after?.[0] ?? 0), (before?.[1] ?? 0) + (after?.[1] ?? 0)]
    const length = Math.hypot(sum[0], sum[1])
    if (length === 0) return path[index]!
    // Mitre length, bounded so a sharp turn cannot throw a spike.
    const cosine = before !== null && after !== null ? Math.max(0.5, (before[0] * after[0] + before[1] * after[1] + 1) / 2) : 1
    const taper = Math.min(1, along[index]! / taperKm, (total - along[index]!) / taperKm)
    const distance = offsetKm * taper / Math.sqrt(cosine)
    return plane.toLonLat([point[0] + sum[0] / length * distance, point[1] + sum[1] / length * distance])
  })
}

/** The point at `km` along a path, and the unit direction of the path there (local plane). */
const pointAlong = (path: ReadonlyArray<LonLat>, km: number): { readonly index: number; readonly point: LonLat; readonly direction: readonly [number, number] } => {
  const plane = planar(path[0]![1])
  let walked = 0
  for (let index = 1; index < path.length; index += 1) {
    const a = plane.toXy(path[index - 1]!)
    const b = plane.toXy(path[index]!)
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length === 0) continue
    if (walked + length >= km || index === path.length - 1) {
      const t = Math.min(1, (km - walked) / length)
      return { index, point: lerp(path[index - 1]!, path[index]!, t), direction: [(b[0] - a[0]) / length, (b[1] - a[1]) / length] }
    }
    walked += length
  }
  return { index: path.length - 1, point: path[path.length - 1]!, direction: [0, 0] }
}

/**
 * A spur from `end` onto a corridor path that starts where the spur joins it: a curve that meets
 * the corridor some way along it, in its direction of travel, as a new line branching off would;
 * the straight spur when the curve would cross open sea.
 */
const mergeSpur = (end: LonLat, corridor: ReadonlyArray<LonLat>, spurKm: number, water: WaterCrossings): ReadonlyArray<LonLat> => {
  const rules = designedRouteRules
  const corridorKm = corridor.slice(1).reduce((sum, point, index) => sum + haversineKm(corridor[index]!, point), 0)
  const mergeKm = Math.min(corridorKm / 2, Math.max(rules.spurMergeMinKm, Math.min(rules.spurMergeMaxKm, spurKm * rules.spurMergeFactor)))
  const merge = pointAlong(corridor, mergeKm)
  const plane = planar(merge.point[1])
  const e = plane.toXy(end)
  const m = plane.toXy(merge.point)
  const reach = Math.hypot(m[0] - e[0], m[1] - e[1])
  const control2: readonly [number, number] = [m[0] - merge.direction[0] * reach * 0.45, m[1] - merge.direction[1] * reach * 0.45]
  const control1: readonly [number, number] = [e[0] + (control2[0] - e[0]) * 0.3, e[1] + (control2[1] - e[1]) * 0.3]
  const curve: LonLat[] = [end]
  const steps = 16
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps
    const u = 1 - t
    curve.push(plane.toLonLat([
      u * u * u * e[0] + 3 * u * u * t * control1[0] + 3 * u * t * t * control2[0] + t * t * t * m[0],
      u * u * u * e[1] + 3 * u * u * t * control1[1] + 3 * u * t * t * control2[1] + t * t * t * m[1],
    ]))
  }
  curve.push(merge.point)
  if (curve.slice(1).some((point, step) => water.openWaterKm(curve[step]!, point) > 0)) return [end, ...corridor]
  return [...curve, ...corridor.slice(merge.index)]
}

/** +1 when `end` lies right of the path's direction at its start (or on it), −1 when left. */
const sideOf = (end: LonLat, path: ReadonlyArray<LonLat>): 1 | -1 => {
  const along = pointAlong(path, 0)
  const plane = planar(along.point[1])
  const v = plane.toXy(end)
  const o = plane.toXy(along.point)
  return along.direction[0] * (v[1] - o[1]) - along.direction[1] * (v[0] - o[0]) > 0 ? -1 : 1
}

export const designedRoutes = (config: {
  readonly corridors: ReadonlyArray<CorridorRoute>
  readonly water: WaterCrossings
  readonly requests: ReadonlyArray<DesignedRouteRequest>
}): ReadonlyArray<DesignedRoute> => {
  const rules = designedRouteRules
  return config.requests.map((request): DesignedRoute => {
    const corridors = config.corridors
      .filter(corridor => corridor.kv >= request.kv * rules.minimumCorridorKvShare && corridor.path.length >= 2)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    if (corridors.length === 0) throw new Error(`${request.id}: no corridor of at least ${request.kv * rules.minimumCorridorKvShare} kV to follow`)
    const plane = planar(request.from[1])
    const nodeIndex = new Map<string, number>()
    const location: LonLat[] = []
    const edges: Edge[][] = []
    const node = (point: LonLat): number => {
      const key = keyOf(point)
      const existing = nodeIndex.get(key)
      if (existing !== undefined) return existing
      nodeIndex.set(key, location.length)
      location.push(point)
      edges.push([])
      return location.length - 1
    }
    const connect = (a: number, b: number, km: number, weight: number, corridor: string | null): void => {
      edges[a]!.push({ to: b, km, weight, corridor })
      edges[b]!.push({ to: a, km, weight, corridor })
    }
    // Spurs join overhead lines only: a cable may run under a fjord or a town.
    const segments: Array<{ readonly a: number; readonly b: number; readonly corridor: string }> = []
    for (const corridor of corridors) {
      for (let index = 1; index < corridor.path.length; index += 1) {
        const a = node(corridor.path[index - 1]!)
        const b = node(corridor.path[index]!)
        if (a === b) continue
        const km = haversineKm(location[a]!, location[b]!)
        connect(a, b, km, km, corridor.id)
        if (corridor.kind === 'ac_line') segments.push({ a, b, corridor: corridor.id })
      }
    }
    // Each end: a corridor vertex it stands on, or spurs to the nearest corridor segments, which
    // split there; a spur over open sea is never a candidate.
    const endNode = (end: LonLat, label: string): number => {
      const endIndex = node(end)
      if (edges[endIndex]!.length > 0) return endIndex
      const near = location.findIndex((point, index) => index !== endIndex && edges[index]!.length > 0 && haversineKm(point, end) <= rules.onCorridorKm)
      if (near >= 0) {
        connect(endIndex, near, haversineKm(end, location[near]!), 0, null)
        return endIndex
      }
      const endXy = plane.toXy(end)
      const candidates = segments.map(segment => {
        const a = plane.toXy(location[segment.a]!)
        const b = plane.toXy(location[segment.b]!)
        const t = nearestFraction(endXy, a, b)
        const point = plane.toLonLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        return { segment, t, point, km: haversineKm(end, point) }
      }).filter(candidate => candidate.km <= rules.spurSearchKm && config.water.openWaterKm(end, candidate.point) === 0)
        .sort((left, right) => left.km - right.km || left.segment.a - right.segment.a || left.segment.b - right.segment.b)
        .slice(0, rules.spurCandidates)
      if (candidates.length === 0) throw new Error(`${request.id}: no corridor within ${rules.spurSearchKm} km of its ${label} end reachable over land`)
      for (const candidate of candidates) {
        const join = node(candidate.point)
        const { a, b, corridor } = candidate.segment
        if (join !== a) connect(join, a, haversineKm(candidate.point, location[a]!), haversineKm(candidate.point, location[a]!), corridor)
        if (join !== b) connect(join, b, haversineKm(candidate.point, location[b]!), haversineKm(candidate.point, location[b]!), corridor)
        connect(endIndex, join, candidate.km, candidate.km * rules.spurWeight, null)
      }
      return endIndex
    }
    const source = endNode(request.from, 'from')
    const target = endNode(request.to, 'to')
    const distance = new Float64Array(location.length).fill(Number.POSITIVE_INFINITY)
    const previous = new Int32Array(location.length).fill(-1)
    const via = new Array<Edge | null>(location.length).fill(null)
    distance[source] = 0
    const heap = createHeap()
    heap.push(0, source)
    for (let item = heap.pop(); item !== undefined; item = heap.pop()) {
      const [cost, current] = item
      if (cost > distance[current]!) continue
      if (current === target) break
      for (const edge of edges[current]!) {
        const next = cost + edge.weight
        if (next < distance[edge.to]!) {
          distance[edge.to] = next
          previous[edge.to] = current
          via[edge.to] = edge
          heap.push(next, edge.to)
        }
      }
    }
    if (!Number.isFinite(distance[target]!)) throw new Error(`${request.id}: its ends are not connected by corridors of at least ${request.kv * rules.minimumCorridorKvShare} kV`)
    const chain: number[] = []
    for (let current = target; current !== -1; current = previous[current]!) chain.push(current)
    chain.reverse()
    // The corridor part runs from the first join to the last; spur edges carry no corridor.
    const corridorPart: LonLat[] = []
    const corridorIds: string[] = []
    let corridorKm = 0
    let spurKm = 0
    let fromSpurKm = 0
    let toSpurKm = 0
    for (let index = 1; index < chain.length; index += 1) {
      const edge = via[chain[index]!]!
      const from = location[chain[index - 1]!]!
      const to = location[chain[index]!]!
      if (corridorPart.length === 0) corridorPart.push(from)
      if (edge.corridor !== null) {
        corridorKm += edge.km
        if (corridorIds[corridorIds.length - 1] !== edge.corridor) corridorIds.push(edge.corridor)
      } else {
        spurKm += edge.km
        // A spur leaves the from end (the first edge) or arrives at the to end (the last edge).
        if (edge.weight > 0 && index === 1) {
          fromSpurKm = edge.km
          corridorPart.length = 0
          corridorPart.push(to)
          continue
        }
        if (edge.weight > 0) {
          toSpurKm = edge.km
          break
        }
      }
      corridorPart.push(to)
    }
    // A planner's route takes the corridor's line, not every bend its ways make inside a station.
    let parts: ReadonlyArray<LonLat> = simplifyPath(corridorPart, rules.corridorSimplificationMeters)
    if (fromSpurKm > 0) parts = mergeSpur(request.from, parts, fromSpurKm, config.water)
    if (toSpurKm > 0) parts = [...mergeSpur(request.to, [...parts].reverse(), toSpurKm, config.water)].reverse()
    // Lanes lie on the side of the corridor where the from end stands, so new circuits never cross it.
    const side = fromSpurKm > 0 ? sideOf(request.from, corridorPart) : toSpurKm > 0 ? -sideOf(request.to, [...corridorPart].reverse()) : 1
    const smoothed = roundCorners(parts, rules.cornerKm)
    const laned = roundCorners(offsetPath(smoothed, side * request.lane * rules.laneSpacingKm, rules.laneTaperKm), rules.cornerKm)
    const path = simplifyPath(laned, rules.simplificationMeters).map(roundLonLat)
    return { id: request.id, path, corridorKm: Math.round(corridorKm * 1000) / 1000, spurKm: Math.round(spurKm * 1000) / 1000, corridorIds }
  })
}
