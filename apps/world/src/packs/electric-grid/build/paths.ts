import { haversineKm } from '../topology/geometry.ts'
import type { LonLat } from './geo.ts'

// Ordered geometry of a corridor from its from-bus to its to-bus, rebuilt from the mapped ways the
// topology joined. Every way vertex is a node (OSM node ids join ways; way ends within the
// topology's distances join too), so a corridor that ends at a tee in the middle of a way follows
// only its own part of that way. The shortest chain between the vertices nearest the two buses is
// the corridor path, framed by the bus locations so it starts at the from-bus and ends at the to-bus.

export interface WayGeometry {
  readonly coordinates: ReadonlyArray<LonLat>
  readonly nodeKeys: ReadonlyArray<string>
}

/**
 * Way ends closer than this are one node, km: first the topology's zero-impedance distance (50 m),
 * then its station-polygon buffer around a portal or busbar the corridor passes (up to 500 m).
 */
const endJoinStepsKm = [0.05, 0.15, 0.5] as const

interface Edge { readonly to: number; readonly km: number }

const createHeap = () => {
  const items: Array<readonly [number, number]> = []
  const up = (index: number): void => {
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (items[parent]![0] <= items[index]![0]) return
      ;[items[parent], items[index]] = [items[index]!, items[parent]!]
      index = parent
    }
  }
  const down = (index: number): void => {
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < items.length && items[left]![0] < items[smallest]![0]) smallest = left
      if (right < items.length && items[right]![0] < items[smallest]![0]) smallest = right
      if (smallest === index) return
      ;[items[smallest], items[index]] = [items[index]!, items[smallest]!]
      index = smallest
    }
  }
  return {
    push: (priority: number, value: number): void => { items.push([priority, value]); up(items.length - 1) },
    pop: (): readonly [number, number] | undefined => {
      if (items.length === 0) return undefined
      const top = items[0]!
      const last = items.pop()!
      if (items.length > 0) {
        items[0] = last
        down(0)
      }
      return top
    },
  }
}

const chainedPath = (ways: ReadonlyArray<WayGeometry>, from: LonLat, to: LonLat, endJoinKm: number): ReadonlyArray<LonLat> | undefined => {
  const nodeIndex = new Map<string, number>()
  const location: LonLat[] = []
  const edges: Edge[][] = []
  const node = (key: string, point: LonLat): number => {
    const existing = nodeIndex.get(key)
    if (existing !== undefined) return existing
    nodeIndex.set(key, location.length)
    location.push(point)
    edges.push([])
    return location.length - 1
  }
  const connect = (a: number, b: number, km: number): void => {
    edges[a]!.push({ to: b, km })
    edges[b]!.push({ to: a, km })
  }
  const ends: number[] = []
  for (const way of ways) {
    let previous = node(way.nodeKeys[0]!, way.coordinates[0]!)
    ends.push(previous)
    for (let index = 1; index < way.coordinates.length; index += 1) {
      const current = node(way.nodeKeys[index]!, way.coordinates[index]!)
      if (current !== previous) connect(previous, current, haversineKm(location[previous]!, location[current]!))
      previous = current
    }
    ends.push(previous)
  }
  for (let a = 0; a < ends.length; a += 1) {
    for (let b = a + 1; b < ends.length; b += 1) {
      const km = haversineKm(location[ends[a]!]!, location[ends[b]!]!)
      if (ends[a] !== ends[b] && km <= endJoinKm) connect(ends[a]!, ends[b]!, km)
    }
  }
  const nearest = (target: LonLat, exclude: number): number => {
    let best = -1
    let bestKm = Infinity
    location.forEach((point, index) => {
      if (index === exclude) return
      const km = haversineKm(point, target)
      if (km < bestKm) {
        best = index
        bestKm = km
      }
    })
    return best
  }
  const start = nearest(from, -1)
  const goal = nearest(to, start)
  if (start < 0 || goal < 0) return undefined
  const distance = new Float64Array(location.length).fill(Infinity)
  const previous = new Int32Array(location.length).fill(-1)
  const heap = createHeap()
  distance[start] = 0
  heap.push(0, start)
  for (let entry = heap.pop(); entry !== undefined; entry = heap.pop()) {
    const [km, current] = entry
    if (km > distance[current]!) continue
    if (current === goal) break
    for (const edge of edges[current]!) {
      const candidate = km + edge.km
      if (candidate < distance[edge.to]!) {
        distance[edge.to] = candidate
        previous[edge.to] = current
        heap.push(candidate, edge.to)
      }
    }
  }
  if (!Number.isFinite(distance[goal]!)) return undefined
  const path: LonLat[] = []
  for (let cursor = goal; cursor !== -1; cursor = previous[cursor]!) path.unshift(location[cursor]!)
  return path
}

const withoutRepeats = (points: ReadonlyArray<LonLat>): ReadonlyArray<LonLat> =>
  points.filter((point, index) => index === 0 || point[0] !== points[index - 1]![0] || point[1] !== points[index - 1]![1])

export const corridorPath = (ways: ReadonlyArray<WayGeometry>, from: LonLat, to: LonLat): ReadonlyArray<LonLat> | undefined => {
  if (ways.length === 0) return undefined
  for (const endJoinKm of endJoinStepsKm) {
    const path = chainedPath(ways, from, to, endJoinKm)
    if (path !== undefined) return withoutRepeats([from, ...path, to])
  }
  return undefined
}
