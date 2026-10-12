import { geoPointFromLonLat, routeDistanceMeters, type GeoJsonLineString, type GeoJsonPoint, type RouteImpact } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { Mobility } from '../config-schema.ts'
import { refusal } from '../refusal.ts'
import { legSchema, type Leg } from './model.ts'

/** The one routing operation the engine uses: a route between two points. */
export type RoutePort = Pick<RoutingAdapter, 'id' | 'route'>

/** A road route may start or end at most this far from the requested point; further away there is no road to use. */
export const roadSnapLimitM = 1_000

/** The refusal for a point more than `roadSnapLimitM` from a road: the unit's own position when labelled, else the destination. */
export const noRoadNear = (label?: string): string =>
  refusal('no_road_near_point', label === undefined ? 'The destination is more than 1 km from a road' : `${label} is more than 1 km from a road`)
const arrivalToleranceMs = 0.000001

const routeDistances = new WeakMap<GeoJsonLineString, Float64Array>()
const cumulativeDistances = (route: GeoJsonLineString): Float64Array => {
  const cached = routeDistances.get(route)
  if (cached) return cached
  const distances = new Float64Array(route.coordinates.length)
  for (let index = 1; index < distances.length; index++) {
    distances[index] = distances[index - 1]! + routeDistanceMeters(geoPointFromLonLat(...route.coordinates[index - 1]!), geoPointFromLonLat(...route.coordinates[index]!))
  }
  routeDistances.set(route, distances)
  return distances
}
const geometricLength = (route: GeoJsonLineString): number => cumulativeDistances(route).at(-1) ?? 0

/** Where a unit is after `progressMs` of its leg, interpolated along the geometry by distance. */
export const legPosition = (leg: Leg, progressMs: number): { readonly point: GeoJsonPoint; readonly segmentIndex: number } => {
  const coordinates = leg.geometry.coordinates
  const distances = cumulativeDistances(leg.geometry)
  const target = geometricLength(leg.geometry) * (leg.durationMs === 0 ? 1 : Math.min(1, progressMs / leg.durationMs))
  let lower = 1
  let upper = coordinates.length - 1
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (distances[middle]! < target) lower = middle + 1
    else upper = middle
  }
  const a = coordinates[lower - 1]!
  const b = coordinates[lower]!
  const span = distances[lower]! - distances[lower - 1]!
  const fraction = span > 0 ? (target - distances[lower - 1]!) / span : 1
  return { point: geoPointFromLonLat(a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction), segmentIndex: lower }
}

export const legEnd = (leg: Leg): GeoJsonPoint => geoPointFromLonLat(...leg.geometry.coordinates.at(-1)!)

/** The slowest canonical route impact sets the pace; without impacts a unit moves at full speed, and a factor of 0 stops it. */
export const speedFactor = (impacts: ReadonlyArray<RouteImpact>): number => Math.min(1, ...impacts.map(impact => impact.speedFactor ?? 1))

export const hasArrived = (leg: Leg, progressMs: number): boolean => progressMs >= leg.durationMs - arrivalToleranceMs

/**
 * Run milliseconds until arrival at the current pace, or undefined while
 * stopped. Route durations may be fractional while the Run clock counts whole
 * milliseconds, so the arrival boundary rounds up: adding a fractional
 * remainder to an epoch time can produce the same number and stall the clock.
 */
export const msToArrival = (leg: Leg, progressMs: number, factor: number): number | undefined =>
  factor > 0 ? Math.max(1, Math.ceil((leg.durationMs - progressMs) / factor)) : undefined

export const advanceProgress = (leg: Leg, progressMs: number, elapsedMs: number, factor: number): number =>
  Math.min(leg.durationMs, progressMs + elapsedMs * factor)

export type LegResult = { readonly ok: true; readonly leg: Leg } | { readonly ok: false; readonly reason: string }

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Prepares one leg for a unit's mobility. `direct` is a straight line at
 * `speedMps`. `road` asks the router and divides its travel time by the
 * unit's `speedFactor`; a router failure refuses `routing_unavailable` and a
 * route that starts or ends more than 1 km from the requested points refuses
 * `no_road_near_point`. There is never a straight-line substitute for a road.
 */
export const prepareLeg = async (routing: RoutePort, mobility: Mobility, from: GeoJsonPoint, to: GeoJsonPoint, label: string): Promise<LegResult> => {
  if (mobility.mode === 'direct') {
    const distanceM = routeDistanceMeters(from, to)
    return { ok: true, leg: legSchema.parse({ geometry: { type: 'LineString', coordinates: [from.coordinates, to.coordinates] }, durationMs: distanceM / mobility.speedMps * 1_000, distanceM, provider: 'direct' }) }
  }
  let route: Awaited<ReturnType<RoutePort['route']>>
  try {
    route = await routing.route({ from, to })
  } catch (error) {
    return { ok: false, reason: refusal('routing_unavailable', `No route for ${label}: ${message(error)}`) }
  }
  const parsed = legSchema.safeParse({ geometry: route.geometry, durationMs: route.durationSeconds * 1_000 / mobility.speedFactor, distanceM: route.distanceM, provider: route.provider })
  if (!parsed.success) return { ok: false, reason: refusal('routing_unavailable', `The router returned no usable route for ${label}`) }
  const leg = parsed.data
  if (leg.durationMs <= 0 && geometricLength(leg.geometry) > 0.01) return { ok: false, reason: refusal('routing_unavailable', `The router returned a route without travel time for ${label}`) }
  const first = geoPointFromLonLat(...leg.geometry.coordinates[0]!)
  if (routeDistanceMeters(first, from) > roadSnapLimitM) return { ok: false, reason: noRoadNear(label) }
  if (routeDistanceMeters(legEnd(leg), to) > roadSnapLimitM) return { ok: false, reason: noRoadNear() }
  return { ok: true, leg }
}
