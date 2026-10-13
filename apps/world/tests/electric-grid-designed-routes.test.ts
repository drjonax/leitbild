import { describe, expect, test } from 'bun:test'
import { designedRoutes, type CorridorRoute } from '../src/packs/electric-grid/model-build/designed-routes.ts'
import { haversineKm, type LonLat } from '../src/packs/electric-grid/model-build/geo.ts'
import { createWaterCrossings } from '../src/packs/electric-grid/model-build/water-crossings.ts'

// A small corridor network around 60° N: a 420 kV line A–B running north, a 300 kV line B–C
// turning east, and a 132 kV line A–C straight across (too low for a 420 kV designed line).
const a: LonLat = [10, 60]
const b: LonLat = [10, 60.3]
const c: LonLat = [10.6, 60.3]
const corridors: ReadonlyArray<CorridorRoute> = [
  { id: 'branch:a-b', kind: 'ac_line', kv: 420, path: [a, [10.02, 60.1], [9.99, 60.2], b] },
  { id: 'branch:b-c', kind: 'ac_line', kv: 300, path: [b, [10.3, 60.31], c] },
  { id: 'branch:a-c', kind: 'ac_line', kv: 132, path: [a, c] },
]
const noSea = createWaterCrossings([])
const lengthKm = (path: ReadonlyArray<LonLat>): number => path.slice(1).reduce((sum, point, index) => sum + haversineKm(path[index]!, point), 0)
const distanceToPathKm = (point: LonLat, path: ReadonlyArray<LonLat>): number => {
  let best = Infinity
  for (let index = 1; index < path.length; index += 1) {
    const steps = Math.max(1, Math.ceil(haversineKm(path[index - 1]!, path[index]!) / 0.05))
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      best = Math.min(best, haversineKm(point, [path[index - 1]![0] + (path[index]![0] - path[index - 1]![0]) * t, path[index - 1]![1] + (path[index]![1] - path[index - 1]![1]) * t]))
    }
  }
  return best
}

describe('Designed routes of fictional lines', () => {
  test('follow corridors of a suitable voltage from a spur at the plant to the destination, not the straight line', () => {
    const plant: LonLat = [10.05, 60.05]
    const [route] = designedRoutes({ corridors, water: noSea, requests: [{ id: 'branch:plant-c', kv: 420, from: plant, to: c, lane: 0 }] })
    expect(route!.path[0]).toEqual(plant)
    expect(route!.path[route!.path.length - 1]).toEqual(c)
    // North along A–B, then east along B–C: the 132 kV chord A–C is too low to carry it.
    expect(route!.corridorIds).toEqual(['branch:a-b', 'branch:b-c'])
    expect(route!.spurKm).toBeGreaterThan(1)
    expect(route!.spurKm).toBeLessThan(3)
    expect(lengthKm(route!.path)).toBeGreaterThan(haversineKm(plant, c) * 1.3)
    // Once the spur has merged, every vertex lies on the corridors it follows.
    const followed = [corridors[0]!.path, corridors[1]!.path]
    for (const point of route!.path.filter(point => haversineKm(point, plant) > 4)) {
      expect(Math.min(...followed.map(path => distanceToPathKm(point, path)))).toBeLessThan(0.45)
    }
  })

  test('set each lane beside the corridor on the plant\'s side, joining it in a curve without a corner', () => {
    const plant: LonLat = [10.05, 60.05]
    const routes = designedRoutes({
      corridors,
      water: noSea,
      requests: [1, 2].map(lane => ({ id: `branch:plant-b-${lane}`, kv: 420, from: plant, to: b, lane })),
    })
    for (const [index, route] of routes.entries()) {
      const lane = index + 1
      // Half-way up A–B the lane runs 150 m per lane east of the line, on the plant's side.
      const midway = route.path.reduce((best, point) => Math.abs(point[1] - 60.15) < Math.abs(best[1] - 60.15) ? point : best)
      const offsetKm = distanceToPathKm(midway, corridors[0]!.path)
      expect(offsetKm).toBeGreaterThan(0.15 * lane - 0.05)
      expect(offsetKm).toBeLessThan(0.15 * lane + 0.08)
      // East of A–B at that latitude.
      const segment = corridors[0]!.path.findIndex((point, vertex) => vertex > 0 && point[1] >= midway[1])
      const [south, north] = [corridors[0]!.path[segment - 1]!, corridors[0]!.path[segment]!]
      expect(midway[0]).toBeGreaterThan(south[0] + (north[0] - south[0]) * (midway[1] - south[1]) / (north[1] - south[1]))
      // No turn sharper than 35° between consecutive segments of the drawn route.
      for (let vertex = 1; vertex < route.path.length - 1; vertex += 1) {
        const [p, q, r] = [route.path[vertex - 1]!, route.path[vertex]!, route.path[vertex + 1]!]
        const kx = Math.cos(q[1] * Math.PI / 180)
        const first = Math.atan2(q[1] - p[1], (q[0] - p[0]) * kx)
        const second = Math.atan2(r[1] - q[1], (r[0] - q[0]) * kx)
        const turn = Math.abs(((second - first + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
        expect(turn * 180 / Math.PI).toBeLessThan(35)
      }
    }
  })

  test('never lay a spur across open sea, and fail when no corridor is in reach over land', () => {
    // A sound between the plant and corridor A–B: its two shores at 10.03° E and 10.045° E.
    const coast = createWaterCrossings([[[10.03, 59.9], [10.03, 60.4]], [[10.045, 60.4], [10.045, 59.9]]])
    const plant: LonLat = [10.06, 60.05]
    expect(() => designedRoutes({ corridors, water: coast, requests: [{ id: 'branch:island', kv: 420, from: plant, to: b, lane: 0 }] }))
      .toThrow('branch:island: no corridor within 12 km of its from end reachable over land')
    expect(() => designedRoutes({ corridors: corridors.filter(corridor => corridor.kv < 300), water: noSea, requests: [{ id: 'branch:low', kv: 420, from: plant, to: b, lane: 0 }] }))
      .toThrow('branch:low: no corridor of at least 294 kV to follow')
  })

  test('are deterministic', () => {
    const request = { id: 'branch:plant-c', kv: 420, from: [10.05, 60.05] as LonLat, to: c, lane: 1 }
    expect(designedRoutes({ corridors, water: noSea, requests: [request] })).toEqual(designedRoutes({ corridors: [...corridors].reverse(), water: noSea, requests: [request] }))
  })
})
