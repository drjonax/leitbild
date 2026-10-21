import type { GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { geoJsonPointSchema, geoPointFromLonLat } from '../../../core/model/index.ts'
import { ambulanceItemSchema, type AmbulanceItem } from '../item-schemas.ts'
import { activeAssignmentStop, ambulanceDataOf, ambulancePackId, incidentPackDataSchema, type AmbulanceDomainData } from '../model.ts'
import { ambulanceSimAdapterId } from './constants.ts'

export interface ItemConstructionContext {
  readonly at: IsoTimestamp
  readonly simulationTimeMs: number
  readonly objectById: (id: ObjectId) => OperationalObject | undefined
}

/** A reference captures one existing canonical point, never a spatial binding. */
const capturePoint = (item: Exclude<AmbulanceItem, { type: 'patient' }>, context: ItemConstructionContext): GeoJsonPoint => {
  if (item.position) return geoPointFromLonLat(...item.position)
  const point = item.atObject ? context.objectById(item.atObject)?.spatial.position?.point : undefined
  if (!point) throw new Error(`Location reference ${item.atObject ?? '(missing)'} has no canonical point`)
  return structuredClone(point)
}

export const createAmbulanceItem = (raw: AmbulanceItem, context: ItemConstructionContext): OperationalObject => {
  const item = ambulanceItemSchema.parse(raw)
  if (!Number.isFinite(context.simulationTimeMs) || context.simulationTimeMs < 0) throw new Error('Invalid simulation time')
  if (context.objectById(item.id)) throw new Error(`Object already exists: ${item.id}`)
  const point = item.type === 'patient' ? undefined : capturePoint(item, context)
  const subject = item.type !== 'patient' && item.atObject ? { subjectObjectId: item.atObject } : {}
  let data: AmbulanceDomainData
  if (item.type === 'ambulance' || item.type === 'helicopter') data = {
    type: 'response-unit', unitKind: item.type === 'ambulance' ? 'road-ambulance' : 'helicopter',
    mobility: item.type === 'ambulance' ? { kind: 'road' } : { kind: 'rotary-wing', cruiseSpeedMps: item.cruiseSpeedMps },
    patientCapacity: item.patientCapacity, capabilities: item.capabilities, crewReady: item.crewReady,
    basePoint: geoJsonPointSchema.parse(item.basePosition ? geoPointFromLonLat(...item.basePosition) : point!),
    mobilizationSeconds: item.mobilizationSeconds, sceneSeconds: item.sceneSeconds, busyTimeMs: 0,
  }
  else if (item.type === 'incident') data = { type: item.type, summary: item.summary, dispatchUrgency: item.dispatchUrgency, receivedAtMs: context.simulationTimeMs, observations: [], ...subject }
  else if (item.type === 'care-site') data = { type: item.type, capabilities: item.capabilities, acceptedUrgencies: item.acceptedUrgencies, handoverSlots: item.handoverSlots, handoverSeconds: item.handoverSeconds, accepting: item.accepting, ...subject }
  else {
    const incident = context.objectById(item.incidentId)
    if (!incident || incident.packId !== ambulancePackId || !incidentPackDataSchema.safeParse(incident.packData).success) throw new Error(`Patient requires an existing incident: ${item.incidentId}`)
    data = { type: item.type, incidentId: item.incidentId, summary: item.summary, assessedUrgency: item.assessedUrgency, needs: item.needs, holder: { kind: 'incident', id: item.incidentId }, disposition: 'active', createdAtMs: context.simulationTimeMs }
  }
  const object: OperationalObject = {
    id: item.id,
    kind: item.type === 'ambulance' || item.type === 'helicopter' ? 'mobile_entity' : item.type === 'care-site' ? 'facility' : item.type,
    packId: ambulancePackId as OperationalObject['packId'], label: item.label, lifecycle: 'active', revision: 0,
    spatial: { frame: { kind: 'wgs84' }, ...(point ? { position: { point, observedAt: context.at, ...(item.type === 'ambulance' || item.type === 'helicopter' ? { speedMps: 0 } : {}) } } : {}) },
    operational: { status: item.type === 'ambulance' || item.type === 'helicopter' ? item.crewReady ? 'available' : 'out-of-service' : item.type === 'incident' ? 'open' : item.type === 'patient' ? 'awaiting-response' : item.accepting ? 'accepting' : 'not-accepting', mode: 'simulated' },
    alerts: [], provenance: { source: 'simulator', adapterId: ambulanceSimAdapterId, externalId: item.id },
    timestamps: { createdAt: context.at, updatedAt: context.at }, packData: data,
  }
  return validateAmbulanceObject(object)
}

export const validateAmbulanceObject = (object: OperationalObject): OperationalObject => {
  if (object.packId !== ambulancePackId) throw new Error(`Object ${object.id} is not owned by Ambulance`)
  const data = ambulanceDataOf(object)
  const kind = data.type === 'response-unit' ? 'mobile_entity' : data.type === 'care-site' ? 'facility' : data.type
  if (object.kind !== kind) throw new Error(`${object.id}: ${data.type} requires object kind ${kind}`)
  if (data.type !== 'patient' && !object.spatial.position?.point) throw new Error(`${object.id}: positioned asset requires a canonical point`)
  if (data.type === 'response-unit' && data.assignment) {
    const a = data.assignment
    if (a.activeStopIndex >= a.stops.length) throw new Error(`${object.id}: active stop is outside the response plan`)
    if (new Set(a.patientIds).size !== a.patientIds.length) throw new Error(`${object.id}: duplicate assignment patients`)
    if (a.patientIds.length > data.patientCapacity) throw new Error(`${object.id}: assignment exceeds patient capacity`)
    if (a.phaseStartedAtMs < a.startedAtMs || (a.phaseDueAtMs !== undefined && a.phaseDueAtMs < a.phaseStartedAtMs)) throw new Error(`${object.id}: inconsistent assignment timestamps`)
    if (['mobilizing', 'on-scene', 'handover'].includes(a.phase) && a.phaseDueAtMs === undefined) throw new Error(`${object.id}: timed phase requires deadline`)
    if (['mobilizing', 'responding', 'transporting', 'returning'].includes(a.phase) && !a.leg) throw new Error(`${object.id}: movement phase requires prepared route`)
    if (a.leg && (a.leg.progressMs > a.leg.durationMs || (a.leg.distanceM > 0 && a.leg.durationMs <= 0))) throw new Error(`${object.id}: invalid route progress or duration`)
    const stop = activeAssignmentStop(a)
    if (a.phase === 'returning' ? stop.kind !== 'return-base' || a.patientIds.length > 0 : stop.kind === 'return-base' || a.patientIds.length === 0) throw new Error(`${object.id}: inconsistent assignment purpose`)
    if (['mobilizing', 'responding', 'on-scene'].includes(a.phase) && stop.kind !== 'pickup') throw new Error(`${object.id}: response phase requires a pickup stop`)
    if (['transporting', 'queued', 'handover'].includes(a.phase) && stop.kind !== 'handover') throw new Error(`${object.id}: transport phase requires a handover stop`)
    const plannedPickups = new Set(a.stops.flatMap(entry => entry.kind === 'pickup' ? entry.patientIds : []))
    if (a.patientIds.some(id => !plannedPickups.has(id))) throw new Error(`${object.id}: assigned patient has no pickup stop`)
  }
  if (data.type === 'patient') {
    if (data.disposition === 'delivered' && (data.holder.kind !== 'care-site' || data.completedAtMs === undefined)) throw new Error(`${object.id}: delivered patient requires completed care-site handover`)
    if (data.disposition === 'no-transport' && (data.holder.kind !== 'incident' || !data.dispositionReason || data.completedAtMs === undefined)) throw new Error(`${object.id}: no-transport requires incident custody, reason and completion time`)
    const milestones = [data.createdAtMs, data.assignedAtMs, data.departedAtMs, data.contactedAtMs, data.pickedUpAtMs, data.arrivedAtSiteMs, data.handoverStartedAtMs, data.completedAtMs].filter((value): value is number => value !== undefined)
    if (milestones.some((value, index) => index > 0 && value < milestones[index - 1]!)) throw new Error(`${object.id}: patient milestones must follow simulation-time order`)
  }
  return { ...object, packData: data }
}

export const validateAmbulanceObjects = (objects: readonly OperationalObject[]): void => {
  const index = new Map(objects.filter(object => object.packId === ambulancePackId).map(object => [object.id, validateAmbulanceObject(object).packData as AmbulanceDomainData]))
  const reserved = new Set<string>()
  for (const object of objects) {
    if (object.packId !== ambulancePackId) continue
    const data = index.get(object.id)!
    if (data.type === 'patient') {
      const incident = index.get(data.incidentId)
      if (incident?.type !== 'incident') throw new Error(`${object.id}: incident does not exist`)
      const holder = index.get(data.holder.id)
      if (holder?.type !== data.holder.kind) throw new Error(`${object.id}: invalid patient holder ${data.holder.id}`)
      if (data.holder.kind === 'response-unit') {
        if (holder.type !== 'response-unit' || !holder.assignment?.patientIds.includes(object.id)) throw new Error(`${object.id}: patient custody is not represented by holder assignment`)
      }
    }
    if (data.type !== 'response-unit' || !data.assignment) continue
    const a = data.assignment
    for (const stop of a.stops) {
      if (stop.kind === 'pickup' && index.get(stop.targetId)?.type !== 'incident') throw new Error(`${object.id}: pickup incident does not exist`)
      if (stop.kind === 'handover' && index.get(stop.targetId)?.type !== 'care-site') throw new Error(`${object.id}: handover care site does not exist`)
    }
    const activeStop = activeAssignmentStop(a)
    for (const id of a.patientIds) {
      if (reserved.has(id)) throw new Error(`${id}: patient is reserved by more than one unit`)
      reserved.add(id)
      const patient = index.get(id)
      if (patient?.type !== 'patient') throw new Error(`${object.id}: assignment patient does not exist: ${id}`)
      const pickup = a.stops.find(stop => stop.kind === 'pickup' && stop.patientIds.includes(id))
      if (!pickup || pickup.kind !== 'pickup' || patient.incidentId !== pickup.targetId || patient.disposition !== 'active') throw new Error(`${object.id}: assignment contains a completed or unrelated patient`)
      const shouldBeOnBoard = ['ready-for-transport', 'transporting', 'queued', 'handover'].includes(a.phase)
      const pickupIndex = a.stops.indexOf(pickup)
      const pickupReached = pickupIndex < a.activeStopIndex || pickupIndex === a.activeStopIndex && activeStop.kind === 'pickup' && shouldBeOnBoard
      if (pickupReached ? patient.holder.kind !== 'response-unit' || patient.holder.id !== object.id : patient.holder.kind !== 'incident' || patient.holder.id !== pickup.targetId) throw new Error(`${id}: patient holder disagrees with response plan`)
    }
  }
  // Capacity follows from unique bounded assignment IDs and the bidirectional
  // holder check above; no second fleet × patient scan is needed.
}

/** Deletion cannot strand patients or invalidate an in-flight assignment. */
export const validateAmbulanceDeletion = (objectId: string, objects: readonly OperationalObject[]): void => {
  for (const object of objects) {
    if (object.packId !== ambulancePackId) continue
    const data = ambulanceDataOf(object)
    if (data.type === 'patient' && (data.holder.id === objectId || data.incidentId === objectId)) throw new Error(`Cannot delete ${objectId}: patient ${object.label} still references it; transfer/remove patients first`)
    if (data.type === 'response-unit' && data.assignment && (object.id === objectId || data.assignment.stops.some(stop => stop.kind !== 'return-base' && stop.targetId === objectId) || data.assignment.patientIds.includes(objectId as ObjectId))) throw new Error(`Cannot delete ${objectId}: cancel or complete ${object.label}'s active assignment first`)
  }
}
