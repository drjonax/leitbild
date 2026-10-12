import { z } from 'zod'
import { geoPointFromLonLat, type GeoJsonLineString, type GeoJsonPoint, type OperationalObject } from '../../core/model/index.ts'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { einsatzPackId } from './ids.ts'
import { ordersSchema, type Step } from './steps.ts'

/**
 * The planned path of each unit's job chain, read from the objects in the
 * viewer's picture: presentation only, derived like everything the map
 * shows, never a simulation input. The active leg is the route the unit's
 * object carries (`spatial.route.planned`), which the World map already
 * draws as the unit's route; each queued step adds a straight segment from
 * where the leg ends, or the unit stands, to the step's target. An engage
 * step moves nothing and adds no segment. This module imports no engine, so
 * the Board and the Pack's map presentation run it in the browser.
 */

const unitSchema = z.object({ type: z.literal('unit'), integrity: z.string(), orders: ordersSchema }).loose()

/** One straight segment of the path: towards a queued step's target. */
export interface PlannedSegment {
  readonly stepId: string
  readonly from: GeoJsonPoint
  readonly to: GeoJsonPoint
  /** The label of the target object; absent for a point on open ground. */
  readonly targetLabel?: string
}

export interface PlannedPath {
  readonly unitId: string
  readonly label: string
  /** The route of the active step while the unit travels it. */
  readonly activeLeg?: GeoJsonLineString
  readonly segments: ReadonlyArray<PlannedSegment>
}

const pointOf = (object: OperationalObject): GeoJsonPoint | undefined => object.spatial.position?.point

/** Where a step leads on the map, with the target's label: a task's or site's position, or the point. */
const stepEnd = (step: Step, byId: ReadonlyMap<string, OperationalObject>): { readonly point: GeoJsonPoint; readonly label?: string } | 'none' | 'unseen' => {
  if ('point' in step.target) return { point: step.target.point }
  if ('trackId' in step.target) return 'none'
  const target = byId.get('taskId' in step.target ? step.target.taskId : step.target.siteId)
  const point = target === undefined ? undefined : pointOf(target)
  return target === undefined || point === undefined ? 'unseen' : { point, label: target.label }
}

/**
 * The planned path of every living unit with steps. A target the picture
 * does not hold, which a step of the same side never names once the engine
 * has skipped it, ends that unit's path there: nothing is drawn past a
 * position the picture cannot place.
 */
export const plannedPaths = (objects: ReadonlyArray<OperationalObject>): PlannedPath[] => {
  const byId = new Map(objects.map(object => [object.id as string, object]))
  return objects.flatMap(object => {
    if (object.packId !== einsatzPackId || (object.packData as { readonly type?: unknown } | undefined)?.type !== 'unit') return []
    const unit = unitSchema.parse(object.packData)
    if (unit.integrity === 'destroyed' || unit.orders.length === 0) return []
    const orders = unit.orders
    const head = orders[0]!
    const route = head.state === 'active' ? object.spatial.route?.planned : undefined
    let from = route === undefined ? pointOf(object) : geoPointFromLonLat(...route.coordinates.at(-1)!)
    if (from === undefined) return []
    const segments: PlannedSegment[] = []
    for (const step of head.state === 'active' ? orders.slice(1) : orders) {
      const end = stepEnd(step, byId)
      if (end === 'unseen') break
      if (end === 'none') continue
      segments.push({ stepId: step.id, from, to: end.point, ...(end.label === undefined ? {} : { targetLabel: end.label }) })
      from = end.point
    }
    return [{ unitId: object.id, label: object.label, ...(route === undefined ? {} : { activeLeg: route }), segments }]
  })
}

const pathColor = '#2f6f9f'

/**
 * The queued segments as Pack map features in the routes layer, one per
 * step, keyed by unit and step id, for the units `drawn` keeps: the screen's
 * display filter (a group it chose not to see) hides a unit's path with its
 * icon. The active leg is the unit's own route, which the map draws already.
 */
export const plannedPathFeatures = (objects: ReadonlyArray<OperationalObject>, categoryId: string, drawn: (unitId: string) => boolean): PackMapFeature[] =>
  plannedPaths(objects).filter(path => drawn(path.unitId)).flatMap(path => path.segments.map(segment => ({
    id: `einsatz-plan:${path.unitId}:${segment.stepId}`,
    categoryId,
    geometry: { type: 'LineString' as const, coordinates: [segment.from.coordinates, segment.to.coordinates] },
    color: pathColor,
    lineColor: pathColor,
    lineOpacity: 0.5,
    lineWidth: 2,
    summary: `${path.label} · next: ${segment.targetLabel ?? 'a map point'}`,
    sortKey: 22,
  })))
