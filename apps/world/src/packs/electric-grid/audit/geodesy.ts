import { distanceToStationKm } from '../topology/geometry.ts'
import type { AuditFootprint, LonLat } from './audit-graph.ts'

/** Mean Earth radius in km (IUGG), adequate for audit distances below a few hundred km. */
const earthRadiusKm = 6371.0088
const radians = (degrees: number): number => degrees * Math.PI / 180

export const haversineKm = (a: LonLat, b: LonLat): number => {
  const dLat = radians(b[1] - a[1])
  const dLon = radians(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const polylineLengthKm = (line: ReadonlyArray<LonLat>): number => {
  let total = 0
  for (let index = 1; index < line.length; index += 1) total += haversineKm(line[index - 1]!, line[index]!)
  return total
}

/** Distance from a point to segment ab in km, in a local equirectangular frame centred on the point. */
export const pointToSegmentKm = (point: LonLat, a: LonLat, b: LonLat): number => {
  const kx = (Math.PI / 180) * earthRadiusKm * Math.cos(radians(point[1]))
  const ky = (Math.PI / 180) * earthRadiusKm
  const ax = (a[0] - point[0]) * kx
  const ay = (a[1] - point[1]) * ky
  const bx = (b[0] - point[0]) * kx
  const by = (b[1] - point[1]) * ky
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
  return Math.hypot(ax + t * dx, ay + t * dy)
}

/**
 * Distance from a point to a footprint: 0 inside a polygon, otherwise to its nearest edge or point.
 * It is the topology compiler's own station distance, so the audit judges a terminal by the same
 * measure as the rule that made it (local flat-earth frames differ by about 1 % in north–south scale).
 */
export const distanceToFootprintKm = (point: LonLat, footprint: AuditFootprint): number =>
  distanceToStationKm(point, footprint.kind === 'point'
    ? { type: 'Point', coordinates: footprint.location }
    : { type: 'MultiPolygon', coordinates: footprint.polygons })

/** Whether a point lies within a footprint's capture zone (polygon + buffer, or point radius). */
export const withinFootprint = (
  point: LonLat,
  footprint: AuditFootprint,
  limits: { readonly polygonBufferKm: number; readonly pointRadiusKm: number },
): boolean => distanceToFootprintKm(point, footprint) <= (footprint.kind === 'point' ? limits.pointRadiusKm : limits.polygonBufferKm)
