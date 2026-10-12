import { routeDistanceMeters, type GeoJsonPoint } from '../../core/model/index.ts'
import type { RouteTableResult, RoutingAdapter } from '../../routing/protocol.ts'
import type { Eta } from './recommendation-schema.ts'
import { motionOf, unitTypeOf, type EngineState, type UnitRecord } from './engine/model.ts'
import { noRoadNear, roadSnapLimitM } from './engine/movement.ts'
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

interface RoadEntry {
  readonly unit: UnitRecord
  readonly from: GeoJsonPoint
  readonly speedFactor: number
  readonly turnout: number
}

type TableAnswer = { readonly ok: true; readonly table: RouteTableResult } | { readonly ok: false; readonly reason: string }

/** The router's table from these sources to one point, or why there is none. A failing router is answered, never thrown. */
const tableTo = async (routing: TablePort, sources: ReadonlyArray<GeoJsonPoint>, to: GeoJsonPoint): Promise<TableAnswer> => {
  let table: RouteTableResult
  try {
    table = await routing.table({ sources, destinations: [to] })
  } catch (error) {
    return { ok: false, reason: refusal('routing_unavailable', `ETA unavailable: ${message(error)}`) }
  }
  const rows = [table.durationsSeconds, table.distancesM]
  const answered = rows.every(cells => cells.length === sources.length && cells.every(row => row.length === 1))
    && table.sourceSnapsM.length === sources.length && table.destinationSnapsM.length === 1
  if (!answered) return { ok: false, reason: refusal('routing_unavailable', `ETA unavailable: the router answered another table than ${sources.length} units to one point`) }
  return { ok: true, table }
}

/** A road unit's ETA from its row of the table, refused for the same reasons a send of it would be. */
const roadEta = (entry: RoadEntry, answer: TableAnswer, index: number, to: GeoJsonPoint): Eta => {
  const unavailable = (reason: string): Eta => ({ kind: 'unavailable', reason, straightDistanceM: routeDistanceMeters(entry.from, to) })
  if (!answer.ok) return unavailable(answer.reason)
  const { table } = answer
  if (table.sourceSnapsM[index]! > roadSnapLimitM) return unavailable(noRoadNear(entry.unit.label))
  if (table.destinationSnapsM[0]! > roadSnapLimitM) return unavailable(noRoadNear())
  const durationS = table.durationsSeconds[index]![0]!
  const distanceM = table.distancesM[index]![0]!
  if (durationS === null || distanceM === null) return unavailable(refusal('routing_unavailable', 'ETA unavailable: no route'))
  return { kind: table.basis, seconds: entry.turnout + durationS / entry.speedFactor, distanceM }
}

/**
 * ETAs of units to a point, turnout included. A direct unit flies a straight
 * line at its own speed. Road units share one router table: its travel time
 * divided by the unit's speed factor, labelled `routed`, or `straight-line`
 * when the Run routes in straight lines. Where a send would be refused, the
 * ETA is unavailable with that refusal and the straight distance: the router
 * fails (`routing_unavailable`), finds no route, or either end lies more than
 * 1 km from a road (`no_road_near_point`). There is never a straight-line
 * substitute for a road.
 */
export const etasTo = async (state: EngineState, units: ReadonlyArray<UnitRecord>, to: GeoJsonPoint, routing: TablePort): Promise<ReadonlyMap<string, Eta>> => {
  const etas = new Map<string, Eta>()
  const road: RoadEntry[] = []
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
  const answer = await tableTo(routing, road.map(entry => entry.from), to)
  road.forEach((entry, index) => etas.set(entry.unit.id, roadEta(entry, answer, index, to)))
  return etas
}

/** Seconds to compare ETAs by; a missing ETA sorts last. */
export const etaSeconds = (eta: Eta): number => eta.kind === 'unavailable' ? Number.POSITIVE_INFINITY : eta.seconds
