import type { RoutingAdapter, RouteRequest, RouteResult, RouteTableRequest, RouteTableResult } from './protocol.ts'
import { geoJsonPointSchema, meters, type GeoJsonPoint } from '../core/model/index.ts'

/** The direct model's travel speed: a straight line at 15 m/s. */
const directSpeedMps = 15

const distanceMeters = (request: Pick<RouteRequest, 'from' | 'to'>): number => {
  const [fromLon, fromLat] = request.from.coordinates
  const [toLon, toLat] = request.to.coordinates
  const meanLatRad = ((fromLat + toLat) / 2) * Math.PI / 180
  const dx = (toLon - fromLon) * 111_320 * Math.cos(meanLatRad)
  const dy = (toLat - fromLat) * 110_540
  return Math.sqrt(dx * dx + dy * dy)
}

export const createDirectRoutingAdapter = (): RoutingAdapter => ({
  id: 'direct',
  route: async (request: RouteRequest): Promise<RouteResult> => {
    request.signal?.throwIfAborted()
    const from = geoJsonPointSchema.parse(request.from)
    const to = geoJsonPointSchema.parse(request.to)
    const distanceM = distanceMeters({ from, to })
    return {
      geometry: {
        type: 'LineString',
        coordinates: [from.coordinates, to.coordinates],
      },
      distanceM: meters(distanceM),
      durationSeconds: distanceM / directSpeedMps,
      provider: 'direct',
    }
  },
  table: async (request: RouteTableRequest): Promise<RouteTableResult> => {
    request.signal?.throwIfAborted()
    const sources: ReadonlyArray<GeoJsonPoint> = request.sources.map(point => geoJsonPointSchema.parse(point))
    const destinations: ReadonlyArray<GeoJsonPoint> = request.destinations.map(point => geoJsonPointSchema.parse(point))
    const distances = sources.map(from => destinations.map(to => distanceMeters({ from, to })))
    return {
      durationsSeconds: distances.map(row => row.map(distanceM => distanceM / directSpeedMps)),
      distancesM: distances.map(row => row.map(distanceM => meters(distanceM))),
      basis: 'straight-line',
      provider: 'direct',
    }
  },
})
