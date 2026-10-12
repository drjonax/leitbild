import type { GeoJsonLineString, GeoJsonPoint, Meters } from '../core/model/index.ts'

export interface RouteRequest {
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
  /** Cancels provider work; a cancelled request must never resolve with a route. */
  readonly signal?: AbortSignal
}

export interface RouteResult {
  readonly geometry: GeoJsonLineString
  readonly distanceM: Meters
  readonly durationSeconds: number
  readonly provider: string
}

/** Travel from every source to every destination in one request. */
export interface RouteTableRequest {
  readonly sources: ReadonlyArray<GeoJsonPoint>
  readonly destinations: ReadonlyArray<GeoJsonPoint>
  /** Cancels provider work; a cancelled request must never resolve with a table. */
  readonly signal?: AbortSignal
}

/**
 * Rows follow the sources and columns the destinations. A cell is null where
 * the provider found no route between the pair. Each snap is how far a
 * source or destination lies from the point where the router joined it to
 * its network; a router that models no network snaps nothing (0). `basis`
 * says what the numbers are: road routes, or straight lines from a router
 * that models no roads.
 */
export interface RouteTableResult {
  readonly durationsSeconds: ReadonlyArray<ReadonlyArray<number | null>>
  readonly distancesM: ReadonlyArray<ReadonlyArray<Meters | null>>
  readonly sourceSnapsM: ReadonlyArray<Meters>
  readonly destinationSnapsM: ReadonlyArray<Meters>
  readonly basis: 'routed' | 'straight-line'
  readonly provider: string
}

export interface RoutingAdapter {
  readonly id: string
  readonly route: (request: RouteRequest) => Promise<RouteResult>
  readonly table: (request: RouteTableRequest) => Promise<RouteTableResult>
}
