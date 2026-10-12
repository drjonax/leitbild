import { routeDistanceMeters, type GeoJsonPoint } from '../../core/model/index.ts'
import type { RoutingAdapter } from '../../routing/protocol.ts'
import type { Eta } from './capabilities.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './engine/model.ts'
import { isMoving } from './engine/rules.ts'
import { refusal } from './refusal.ts'

/** The routing operation ETAs use: travel times from many units to one point in one request. */
export type TablePort = Pick<RoutingAdapter, 'table'>

/**
 * Turnout still ahead of a unit sent now, as a send would apply it: what is
 * left of a turnout under way, a full turnout for a unit standing still, and
 * none for a unit already moving.
 */
const turnoutSeconds = (state: EngineState, unit: UnitRecord, mobilizeS: number): number => {
  if (unit.phase === 'mobilizing') return Math.max(0, ((unit.phaseDueMs ?? state.timeMs) - state.timeMs) / 1_000)
  return isMoving(unit) ? 0 : mobilizeS
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * ETAs of units to a point, turnout included. A direct unit flies a straight
 * line at its own speed. Road units share one router table: its travel time
 * divided by the unit's speed factor, labelled `routed`, or `straight-line`
 * when the Run routes in straight lines. A pair without a route has no ETA,
 * only its straight distance. A router failure refuses `routing_unavailable`;
 * there is never a straight-line substitute for a road.
 */
export const etasTo = async (state: EngineState, units: ReadonlyArray<UnitRecord>, to: GeoJsonPoint, routing: TablePort): Promise<ReadonlyMap<string, Eta>> => {
  const etas = new Map<string, Eta>()
  const road: Array<{ readonly unit: UnitRecord; readonly from: GeoJsonPoint; readonly speedFactor: number; readonly turnout: number }> = []
  for (const unit of units) {
    const mobility = unitTypeOf(state.catalog, unit).components.mobility
    if (mobility === undefined) throw new Error(`${unit.id} cannot move, so it has no ETA`)
    const from = motionOf(state, unit.id).point
    const turnout = turnoutSeconds(state, unit, mobility.mobilizeS)
    if (mobility.mode === 'direct') {
      const distanceM = routeDistanceMeters(from, to)
      etas.set(unit.id, { kind: 'straight-line', seconds: turnout + distanceM / mobility.speedMps, distanceM })
    } else road.push({ unit, from, speedFactor: mobility.speedFactor, turnout })
  }
  if (road.length === 0) return etas
  let table: Awaited<ReturnType<TablePort['table']>>
  try {
    table = await routing.table({ sources: road.map(entry => entry.from), destinations: [to] })
  } catch (error) {
    throw new Error(refusal('routing_unavailable', `ETA unavailable: ${message(error)}`))
  }
  if (table.durationsSeconds.length !== road.length || table.distancesM.length !== road.length) {
    throw new Error(refusal('routing_unavailable', `ETA unavailable: the router answered ${table.durationsSeconds.length} of ${road.length} units`))
  }
  road.forEach((entry, index) => {
    const durationS = table.durationsSeconds[index]![0]
    const distanceM = table.distancesM[index]![0]
    if (durationS === undefined || distanceM === undefined) throw new Error(refusal('routing_unavailable', 'ETA unavailable: the router answered no destination'))
    etas.set(entry.unit.id, durationS === null || distanceM === null
      ? { kind: 'unavailable', reason: 'No route', straightDistanceM: routeDistanceMeters(entry.from, to) }
      : { kind: table.basis, seconds: entry.turnout + durationS / entry.speedFactor, distanceM })
  })
  return etas
}

/** Seconds to compare ETAs by; a missing ETA sorts last. */
export const etaSeconds = (eta: Eta): number => eta.kind === 'unavailable' ? Number.POSITIVE_INFINITY : eta.seconds
