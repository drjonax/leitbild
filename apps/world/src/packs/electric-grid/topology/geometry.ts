import { pointInPolygon } from '../../../reference-data/point-in-polygon.ts'

export type LonLat = readonly [lon: number, lat: number]

export type TopologyPolygonGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: ReadonlyArray<ReadonlyArray<LonLat>> }
  | { readonly type: 'MultiPolygon'; readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<LonLat>>> }

export type TopologyStationGeometry =
  | { readonly type: 'Point'; readonly coordinates: LonLat }
  | TopologyPolygonGeometry

export type Bbox = readonly [minLon: number, minLat: number, maxLon: number, maxLat: number]

// Mean Earth radius (IUGG), km.
const earthRadiusKm = 6371.0088
// Length of one degree of latitude at the equator, km (WGS84).
const kmPerDegreeLat = 110.574
// Length of one degree of longitude at the equator, km (WGS84).
const kmPerDegreeLonEquator = 111.32

const toRadians = (degrees: number): number => degrees * Math.PI / 180

export const haversineKm = (a: LonLat, b: LonLat): number => {
  const dLat = toRadians(b[1] - a[1])
  const dLon = toRadians(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a[1])) * Math.cos(toRadians(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const polylineKm = (coordinates: ReadonlyArray<LonLat>, from = 0, to = coordinates.length - 1): number => {
  let total = 0
  for (let index = from + 1; index <= to; index += 1) total += haversineKm(coordinates[index - 1]!, coordinates[index]!)
  return total
}

export const kmPerDegreeLon = (lat: number): number => kmPerDegreeLonEquator * Math.cos(toRadians(lat))

export const degreesForKm = (km: number, lat: number): { readonly lon: number; readonly lat: number } => ({
  lon: km / Math.max(kmPerDegreeLon(lat), 1e-6),
  lat: km / kmPerDegreeLat,
})

const polygonsOf = (geometry: TopologyPolygonGeometry): ReadonlyArray<ReadonlyArray<ReadonlyArray<LonLat>>> =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates

export const pointInStationPolygon = (point: LonLat, geometry: TopologyPolygonGeometry): boolean =>
  pointInPolygon(point, geometry)

export const geometryBbox = (geometry: TopologyStationGeometry): Bbox => {
  if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1], geometry.coordinates[0], geometry.coordinates[1]]
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  if (!Number.isFinite(minLon)) throw new Error('topology geometry: polygon without coordinates')
  return [minLon, minLat, maxLon, maxLat]
}

// Signed shoelace terms in a local equirectangular frame (km) anchored at `origin`.
const ringMoments = (ring: ReadonlyArray<LonLat>, origin: LonLat): { area: number; cx: number; cy: number } => {
  const kx = kmPerDegreeLon(origin[1])
  let area = 0
  let cx = 0
  let cy = 0
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]!
    const b = ring[(index + 1) % ring.length]!
    const ax = (a[0] - origin[0]) * kx
    const ay = (a[1] - origin[1]) * kmPerDegreeLat
    const bx = (b[0] - origin[0]) * kx
    const by = (b[1] - origin[1]) * kmPerDegreeLat
    const cross = ax * by - bx * ay
    area += cross
    cx += (ax + bx) * cross
    cy += (ay + by) * cross
  }
  return { area: area / 2, cx, cy }
}

export type PolygonMeasure = { readonly areaKm2: number; readonly centroid: LonLat }

export const measurePolygon = (geometry: TopologyPolygonGeometry): PolygonMeasure => {
  const first = polygonsOf(geometry)[0]?.[0]?.[0]
  if (!first) throw new Error('topology geometry: polygon without coordinates')
  const kx = kmPerDegreeLon(first[1])
  let area = 0
  let cx = 0
  let cy = 0
  for (const polygon of polygonsOf(geometry)) {
    polygon.forEach((ring, ringIndex) => {
      const moments = ringMoments(ring, first)
      // Outer rings add, holes subtract, independent of the ring winding in the source.
      const sign = (ringIndex === 0 ? 1 : -1) * Math.sign(moments.area)
      area += sign * moments.area
      cx += sign * moments.cx
      cy += sign * moments.cy
    })
  }
  if (area <= 0) throw new Error('topology geometry: polygon has no area')
  return {
    areaKm2: area,
    centroid: [first[0] + cx / (6 * area) / kx, first[1] + cy / (6 * area) / kmPerDegreeLat],
  }
}

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

export const distanceToStationKm = (point: LonLat, geometry: TopologyStationGeometry): number => {
  if (geometry.type === 'Point') return haversineKm(point, geometry.coordinates)
  if (pointInStationPolygon(point, geometry)) return 0
  let best = Infinity
  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const distance = segmentDistanceKm(point, ring[index - 1]!, ring[index]!)
        if (distance < best) best = distance
      }
    }
  }
  return best
}
