import { compareText } from '../topology/ids.ts'
import { haversineKm, polylineKm } from '../topology/geometry.ts'
import type { LonLat } from './geo.ts'

// Ordered geometry of a corridor from its from-bus to its to-bus, rebuilt from the mapped ways the
// topology joined: way ends that share an OSM node (or lie within the topology's zero-impedance
// distance) are connected, and the shortest chain between the way ends nearest the two buses is
// the corridor path. Parallel phase spans contribute alternatives; the shortest one is kept.

export interface WayGeometry {
  readonly coordinates: ReadonlyArray<LonLat>
  readonly nodeKeys: ReadonlyArray<string>
}

/**
 * Way ends closer than this are one node, km: first the topology's zero-impedance distance (50 m),
 * then its station-polygon buffer around a portal or busbar the corridor passes (up to 500 m).
 */
const endJoinStepsKm = [0.05, 0.15, 0.5] as const

interface Edge { readonly to: number; readonly km: number; readonly coordinates: ReadonlyArray<LonLat> }

export const corridorPath = (
  ways: ReadonlyArray<WayGeometry>,
  from: LonLat,
  to: LonLat,
): ReadonlyArray<LonLat> | undefined => {
  for (const endJoinKm of endJoinStepsKm) {
    const path = chainedPath(ways, from, to, endJoinKm)
    if (path !== undefined) return path
  }
  return undefined
}

const chainedPath = (
  ways: ReadonlyArray<WayGeometry>,
  from: LonLat,
  to: LonLat,
  endJoinKm: number,
): ReadonlyArray<LonLat> | undefined => {
  if (ways.length === 0) return undefined
  const nodeIndex = new Map<string, number>()
  const nodeLocation: LonLat[] = []
  const node = (key: string, location: LonLat): number => {
    const existing = nodeIndex.get(key)
    if (existing !== undefined) return existing
    nodeIndex.set(key, nodeLocation.length)
    nodeLocation.push(location)
    return nodeLocation.length - 1
  }
  const edges: Edge[][] = []
  const addEdge = (a: number, b: number, coordinates: ReadonlyArray<LonLat>): void => {
    while (edges.length <= Math.max(a, b)) edges.push([])
    const km = polylineKm(coordinates)
    edges[a]!.push({ to: b, km, coordinates })
    edges[b]!.push({ to: a, km, coordinates: [...coordinates].reverse() })
  }
  for (const way of ways) {
    const first = node(way.nodeKeys[0]!, way.coordinates[0]!)
    const last = node(way.nodeKeys.at(-1)!, way.coordinates.at(-1)!)
    addEdge(first, last, way.coordinates)
  }
  for (let a = 0; a < nodeLocation.length; a += 1) {
    for (let b = a + 1; b < nodeLocation.length; b += 1) {
      if (haversineKm(nodeLocation[a]!, nodeLocation[b]!) <= endJoinKm) addEdge(a, b, [nodeLocation[a]!, nodeLocation[b]!])
    }
  }
  const nearest = (target: LonLat, exclude: number): number => {
    let best = -1
    let bestKm = Infinity
    nodeLocation.forEach((location, index) => {
      if (index === exclude) return
      const km = haversineKm(location, target)
      if (km < bestKm) {
        best = index
        bestKm = km
      }
    })
    return best
  }
  const start = nearest(from, -1)
  const goal = nearest(to, start)
  if (goal < 0) return undefined
  const distance = new Float64Array(nodeLocation.length).fill(Infinity)
  const previous = new Array<{ readonly from: number; readonly edge: Edge } | null>(nodeLocation.length).fill(null)
  const done = new Uint8Array(nodeLocation.length)
  distance[start] = 0
  for (;;) {
    let current = -1
    for (let index = 0; index < nodeLocation.length; index += 1) {
      if (done[index] === 0 && distance[index]! < Infinity && (current < 0 || distance[index]! < distance[current]!)) current = index
    }
    if (current < 0 || current === goal) break
    done[current] = 1
    for (const edge of edges[current] ?? []) {
      const candidate = distance[current]! + edge.km
      if (candidate < distance[edge.to]!) {
        distance[edge.to] = candidate
        previous[edge.to] = { from: current, edge }
      }
    }
  }
  if (!Number.isFinite(distance[goal]!)) return undefined
  const pieces: Array<ReadonlyArray<LonLat>> = []
  for (let cursor = goal; cursor !== start;) {
    const step = previous[cursor]!
    pieces.unshift(step.edge.coordinates)
    cursor = step.from
  }
  const path: LonLat[] = []
  for (const piece of pieces) {
    for (const point of piece) {
      const last = path.at(-1)
      if (last === undefined || last[0] !== point[0] || last[1] !== point[1]) path.push(point)
    }
  }
  return path.length >= 2 ? path : undefined
}

export const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)].sort(compareText)
