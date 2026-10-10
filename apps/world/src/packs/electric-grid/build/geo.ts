import { haversineKm, kmPerDegreeLon, type LonLat } from '../topology/geometry.ts'

// Small geodesy helpers of the model build. Coordinates are [lon, lat] in WGS84 degrees.

export { haversineKm, type LonLat }

// Length of one degree of latitude, km (WGS84 mean; as in topology/geometry.ts).
const kmPerDegreeLat = 110.574

/** Perpendicular distance in km from `point` to the segment a–b in a local equirectangular frame. */
const segmentDistanceKm = (point: LonLat, a: LonLat, b: LonLat): number => {
  const kx = kmPerDegreeLon(point[1])
  const ax = (a[0] - point[0]) * kx
  const ay = (a[1] - point[1]) * kmPerDegreeLat
  const bx = (b[0] - point[0]) * kx
  const by = (b[1] - point[1]) * kmPerDegreeLat
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
  return Math.hypot(ax + t * dx, ay + t * dy)
}

/** Douglas–Peucker simplification keeping both ends; tolerance in metres. */
export const simplifyPath = (path: ReadonlyArray<LonLat>, toleranceM: number): ReadonlyArray<LonLat> => {
  if (path.length <= 2) return path
  const toleranceKm = toleranceM / 1000
  const keep = new Uint8Array(path.length)
  keep[0] = 1
  keep[path.length - 1] = 1
  const stack: Array<readonly [number, number]> = [[0, path.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let farthest = -1
    let farthestKm = toleranceKm
    for (let index = first + 1; index < last; index += 1) {
      const distance = segmentDistanceKm(path[index]!, path[first]!, path[last]!)
      if (distance > farthestKm) {
        farthestKm = distance
        farthest = index
      }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    stack.push([first, farthest], [farthest, last])
  }
  return path.filter((_, index) => keep[index] === 1)
}

/** Rounds a coordinate to 1e-5° (≈ 1 m), enough for a 50 m simplified path. */
export const roundLonLat = (point: LonLat): LonLat => [Math.round(point[0] * 1e5) / 1e5, Math.round(point[1] * 1e5) / 1e5]

export const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Rounds to a number of significant digits, so per-unit values keep their precision at any scale. */
export const roundSignificant = (value: number, digits: number): number => {
  if (value === 0 || !Number.isFinite(value)) return value
  return Number(value.toPrecision(digits))
}
