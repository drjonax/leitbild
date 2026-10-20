import { geoPointFromLonLat, type GeoJsonPoint, type OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import { createWorldPackDescriptor, type PackMapAssignmentTarget, type PackMapFeature, type PackObjectPresentation, type PackTargetContext, type WorldPackView } from '../../core/packs/protocol.ts'
import { appendStopCommandKind, assignCommandKind } from './commands.ts'
import { activeAssignmentStop, ambulanceDataOf, ambulancePackId, appendHandoverEligibility, appendPickupEligibility, assignmentWarnings, dispatchEligibility, incidentPackDataSchema, patientObjects, patientPackDataSchema, responseUnitPackDataSchema, unitPatients } from './model.ts'
import { ambulanceSimRuntimeId } from './sim/constants.ts'

// Urgency is a word and a sort order, never a colour: alert hues are kept for alerts (plan v3.1 §2.7, D9).
const incidentColor = '#3c8cab'
const labelFor = (id: string, objects: ReadonlyArray<OperationalObject>) => objects.find(object => object.id === id)?.label ?? id
const join = (values: ReadonlyArray<string>) => values.length ? values.join(', ') : 'None configured'
const coLocatedWithSubject = (object: OperationalObject, subjectId: string | undefined, objects: ReadonlyArray<OperationalObject>): boolean => {
  if (!subjectId) return false
  const point = object.spatial.position?.point.coordinates
  const subjectPoint = objects.find(candidate => candidate.id === subjectId)?.spatial.position?.point.coordinates
  return !!point && !!subjectPoint && point[0] === subjectPoint[0] && point[1] === subjectPoint[1]
}
const typeOf = (object: OperationalObject) => object.packId === ambulancePackId ? ambulanceDataOf(object).type : null
const subjects = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>) => objects.flatMap(candidate => {
  if (candidate.packId !== ambulancePackId) return []
  const data = ambulanceDataOf(candidate)
  return (data.type === 'incident' || data.type === 'care-site') && data.subjectObjectId === object.id ? [{ object: candidate, data }] : []
})
const pointOf = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (!point) throw new Error(`${object.id} has no map position`)
  return point
}
const routeEnd = (object: OperationalObject): GeoJsonPoint => {
  const data = responseUnitPackDataSchema.parse(object.packData)
  const stop = data.assignment?.stops.at(-1)
  if (!stop) return pointOf(object)
  return geoPointFromLonLat(...stop.route.geometry.coordinates.at(-1)!)
}
const targetObjectFor = (candidate: OperationalObject, context: PackTargetContext): OperationalObject | null => {
  if (candidate.packId === ambulancePackId) {
    const data = ambulanceDataOf(candidate)
    if (data.type === 'incident' || data.type === 'care-site') return candidate
  }
  const attached = context.objects.filter(object => {
    if (object.packId !== ambulancePackId) return false
    const data = ambulanceDataOf(object)
    return (data.type === 'incident' || data.type === 'care-site') && data.subjectObjectId === candidate.id
  })
  return attached.length === 1 ? attached[0]! : null
}
const incidentTarget = (controller: OperationalObject, incident: OperationalObject, mode: 'start' | 'append', context: PackTargetContext): PackMapAssignmentTarget | null => {
  if (!incidentPackDataSchema.safeParse(incident.packData).success) return null
  const candidates = patientObjects(context.objects).filter(object => {
    const data = patientPackDataSchema.parse(object.packData)
    return data.incidentId === incident.id && data.disposition === 'active' && data.holder.kind === 'incident'
  })
  const choices = candidates.map(patient => {
    const data = patientPackDataSchema.parse(patient.packData)
    const reasons = mode === 'start'
      ? dispatchEligibility(controller, incident, [patient], context.objects)
      : appendPickupEligibility(controller, incident, [patient], context.objects)
    return {
      id: patient.id,
      label: patient.label,
      summary: `${data.assessedUrgency} · ${data.summary}${data.needs.length ? ` · needs ${data.needs.join(', ')}` : ''}`,
      ...(reasons.length ? { disabledReason: reasons.join('; ') } : {}),
    }
  })
  const available = choices.filter(choice => !choice.disabledReason)
  if (available.length === 0) return null
  const unit = responseUnitPackDataSchema.parse(controller.packData)
  const remainingCapacity = unit.patientCapacity - (mode === 'append' ? unit.assignment?.patientIds.length ?? 0 : 0)
  return {
    id: incident.id,
    label: incident.label,
    choices,
    minimumChoices: 1,
    maximumChoices: remainingCapacity,
    buildCommand: choiceIds => ({
      kind: mode === 'start' ? assignCommandKind : appendStopCommandKind,
      targetObjectIds: [controller.id],
      payload: mode === 'start'
        ? { unitId: controller.id, incidentId: incident.id, patientIds: choiceIds }
        : { kind: 'pickup', unitId: controller.id, incidentId: incident.id, patientIds: choiceIds },
    }),
  }
}
const careSiteTarget = (controller: OperationalObject, site: OperationalObject, context: PackTargetContext): PackMapAssignmentTarget | null => {
  const unit = responseUnitPackDataSchema.parse(controller.packData)
  const assignment = unit.assignment
  if (!assignment) return null
  const handedOver = new Set(assignment.stops.flatMap(stop => stop.kind === 'handover' ? stop.patientIds : []))
  const patientIds = assignment.patientIds.filter(id => !handedOver.has(id))
  if (appendHandoverEligibility(controller, site, patientIds, context.objects).length > 0) return null
  return {
    id: site.id,
    label: site.label,
    choices: [],
    minimumChoices: 0,
    maximumChoices: 0,
    buildCommand: () => ({ kind: appendStopCommandKind, targetObjectIds: [controller.id], payload: { kind: 'handover', unitId: controller.id, careSiteId: site.id, patientIds } }),
  }
}
const assignmentMapFeatures = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<PackMapFeature> => objects.flatMap(object => {
  if (object.packId !== ambulancePackId) return []
  const data = ambulanceDataOf(object)
  if (data.type !== 'response-unit' || !data.assignment || data.assignment.phase === 'returning') return []
  const result: PackMapFeature[] = []
  let from = pointOf(object)
  for (let index = data.assignment.activeStopIndex; index < data.assignment.stops.length; index += 1) {
    const stop = data.assignment.stops[index]!
    const to = geoPointFromLonLat(...stop.route.geometry.coordinates.at(-1)!)
    result.push({ id: `ambulance-plan-link:${object.id}:${index}`, categoryId: 'ambulances', geometry: { type: 'LineString', coordinates: [from.coordinates, to.coordinates] }, color: '#0078f0', lineColor: '#0078f0', lineOpacity: 0.42, lineWidth: 1.5, summary: `${object.label} assignment link`, sortKey: 22 })
    if (index > data.assignment.activeStopIndex) result.push({ id: `ambulance-plan-route:${object.id}:${index}`, categoryId: 'ambulances', geometry: stop.route.geometry, color: '#0078f0', lineColor: '#0078f0', lineOpacity: 0.82, lineWidth: 3, summary: `${object.label} planned route`, sortKey: 24 })
    from = to
  }
  return result
})

export const presentAmbulanceObject = (object: OperationalObject, objects: ReadonlyArray<OperationalObject>): PackObjectPresentation => {
  const data = ambulanceDataOf(object)
  if (data.type === 'response-unit') return {
    categoryId: data.unitKind === 'helicopter' ? 'helicopters' : 'ambulances', icon: data.unitKind === 'helicopter' ? 'helicopter' : 'ambulance', color: data.unitKind === 'helicopter' ? '#643c9b' : '#0f915f',
    summary: data.assignment?.phase ?? (data.crewReady ? 'Available' : 'Crew unavailable'),
    status: packStatus(data.assignment ? 'working' : data.crewReady ? 'ready' : 'error', data.assignment?.phase ?? (data.crewReady ? 'Available' : 'Out of service')),
    fields: [
      packField('capacity', 'Transport capacity', String(data.patientCapacity)),
      packField('mobility', 'Mobility', data.mobility.kind === 'road' ? 'Road' : `Rotary wing · ${Math.round(data.mobility.cruiseSpeedMps)} m/s cruise`),
      packField('on-board', 'Patients on board', String(unitPatients(object.id, objects).length)),
      packField('patients', 'Assigned patients', (data.assignment?.patientIds ?? []).map(id => labelFor(id, objects)).join(', ') || 'None'),
      packField('capabilities', 'Capabilities', join(data.capabilities)),
      packField('mobilization', 'Configured mobilization', data.mobilizationSeconds + ' s'),
      packField('scene', 'Configured scene service', data.sceneSeconds + ' s'),
      packField('map-action', 'Map action', data.assignment && data.assignment.phase !== 'returning' ? 'Use the connector to add a stop' : 'Hold the marker to assign'),
      ...(data.assignment ? [packField('plan', 'Remaining stops', data.assignment.stops.slice(data.assignment.activeStopIndex).map(stop => stop.kind === 'return-base' ? 'Return to base' : labelFor(stop.targetId, objects)).join(' → '))] : []),
      ...(object.spatial.route?.etaSeconds !== undefined ? [packField('eta', 'Route ETA', Math.ceil(object.spatial.route.etaSeconds) + ' simulated seconds')] : []),
      ...assignmentWarnings(object, objects).map((reason, index) => packField('warning-' + index, 'Review assignment', reason)),
    ],
  }
  if (data.type === 'incident') {
    const patients = patientObjects(objects).filter(patient => patientPackDataSchema.parse(patient.packData).incidentId === object.id)
    const active = patients.filter(patient => patientPackDataSchema.parse(patient.packData).disposition === 'active').length
    return {
      categoryId: 'incidents', icon: 'triangle-alert', color: incidentColor,
      summary: data.summary, status: packStatus(data.closedAtMs !== undefined ? 'idle' : data.firstArrivalAtMs !== undefined ? 'working' : 'error', data.closedAtMs !== undefined ? 'Resolved' : data.firstArrivalAtMs !== undefined ? 'Response arrived' : 'Awaiting first response'),
      mapIconVisible: !coLocatedWithSubject(object, data.subjectObjectId, objects), muted: data.closedAtMs !== undefined, noteworthyUpdates: true,
      fields: [packField('urgency', 'Dispatch urgency', data.dispatchUrgency), packField('patients', 'Active / all patients', active + ' / ' + patients.length),
        ...(data.observations.length ? [packField('latest-observation', 'Latest reconnaissance', (() => { const observation = data.observations.at(-1)!; return `${observation.casualtyCount} casualties observed by ${labelFor(observation.observerId, objects)}` })())] : []),
        ...(data.subjectObjectId ? [packField('subject', 'At asset', labelFor(data.subjectObjectId, objects))] : []),
        ...(data.firstArrivalAtMs !== undefined ? [packField('response', 'First response interval', ((data.firstArrivalAtMs - data.receivedAtMs) / 1000).toFixed(0) + ' s')] : []),
      ],
    }
  }
  if (data.type === 'patient') return {
    categoryId: 'patients', icon: 'plus', color: incidentColor, summary: data.summary,
    status: packStatus(data.disposition === 'active' ? 'working' : 'idle', data.disposition === 'active' ? data.holder.kind : data.disposition),
    mapIconVisible: false, muted: data.disposition !== 'active', noteworthyUpdates: true,
    fields: [packField('urgency', 'Assessed urgency', data.assessedUrgency), packField('needs', 'Required capabilities', join(data.needs)), packField('incident', 'Incident', labelFor(data.incidentId, objects)), packField('holder', 'Currently with', labelFor(data.holder.id, objects)), ...(data.dispositionReason ? [packField('reason', 'Disposition reason', data.dispositionReason)] : [])],
  }
  const serving = objects.filter(candidate => {
    if (candidate.packId !== ambulancePackId) return false
    const other = ambulanceDataOf(candidate)
    if (other.type !== 'response-unit' || other.assignment?.phase !== 'handover') return false
    const stop = activeAssignmentStop(other.assignment)
    return stop.kind === 'handover' && stop.targetId === object.id
  }).length
  return {
    categoryId: 'care-sites', icon: 'plus', color: '#2d82b9', summary: data.accepting ? 'Accepting: ' + data.acceptedUrgencies.join(', ') : 'Not accepting arrivals',
    status: packStatus(!data.accepting ? 'error' : serving >= data.handoverSlots ? 'working' : 'ready', !data.accepting ? 'Closed to arrivals' : `${serving}/${data.handoverSlots} handover slots occupied`),
    mapIconVisible: !coLocatedWithSubject(object, data.subjectObjectId, objects), noteworthyUpdates: true,
    fields: [packField('capabilities', 'Capabilities', join(data.capabilities)), packField('urgencies', 'Accepted urgency', data.acceptedUrgencies.join(', ')), packField('slots', 'Handover slots', String(data.handoverSlots)), packField('duration', 'Configured handover', data.handoverSeconds + ' s'), ...(data.subjectObjectId ? [packField('subject', 'At asset', labelFor(data.subjectObjectId, objects))] : [])],
  }
}

export const ambulancePackView = {
  descriptor: createWorldPackDescriptor({ id: ambulancePackId, version: '1.0.0', name: 'Ambulance Dispatch', description: 'Configurable road and rotary-wing response units, incidents, individual patient custody, flexible care sites and dispatch/handover workflows. Operational research model; not patient physiology.', contributions: ['runtime', 'recording', 'scenario', 'presentation', 'map-assignment', 'interactions'] }),
  runtime: { runtimes: [{ id: ambulanceSimRuntimeId, version: '1.0.0', label: 'Local ambulance runtime', kind: 'local', clock: 'simulation' }], defaultRuntimeId: ambulanceSimRuntimeId },
  presentation: {
    categories: [
      { id: 'ambulances', label: 'Ambulances', emptyLabel: 'No ambulances', matches: object => { const data = object.packId === ambulancePackId ? ambulanceDataOf(object) : null; return data?.type === 'response-unit' && data.unitKind === 'road-ambulance' } },
      { id: 'helicopters', label: 'Helicopters', emptyLabel: 'No helicopters', matches: object => { const data = object.packId === ambulancePackId ? ambulanceDataOf(object) : null; return data?.type === 'response-unit' && data.unitKind === 'helicopter' } },
      ...(['incident', 'patient', 'care-site'] as const).map(type => ({
        id: ({ incident: 'incidents', patient: 'patients', 'care-site': 'care-sites' } as const)[type],
        label: ({ incident: 'Incidents', patient: 'Patients', 'care-site': 'Care sites' } as const)[type],
        emptyLabel: 'No ' + ({ incident: 'incidents', patient: 'patients', 'care-site': 'care sites' } as const)[type], matches: (object: OperationalObject) => typeOf(object) === type,
      })),
    ],
    presentObject: (object, context) => presentAmbulanceObject(object, context.objects),
    mapFeatures: context => assignmentMapFeatures(context.objects),
    mapFeatureLayers: ['routes'],
    mapFeatureSourcePackIds: [ambulancePackId],
    contextualFields: (object, context) => subjects(object, context.objects).map(entry => packField('ambulance:' + entry.object.id, entry.data.type === 'incident' ? 'Incident at this asset' : 'Care site at this asset', entry.object.label + ' · ' + entry.object.operational.status)),
  },
  mapAssignment: {
    canStart: (controller, context): boolean => {
      if (controller.packId !== ambulancePackId) return false
      const parsed = responseUnitPackDataSchema.safeParse(controller.packData)
      return parsed.success && parsed.data.crewReady && (!parsed.data.assignment || parsed.data.assignment.phase === 'returning') && unitPatients(controller.id, context.objects).length === 0
    },
    anchorFor: (controller, mode): GeoJsonPoint => mode === 'append' ? routeEnd(controller) : pointOf(controller),
    handles: context => context.objects.flatMap(object => {
      if (object.packId !== ambulancePackId) return []
      const parsed = responseUnitPackDataSchema.safeParse(object.packData)
      return parsed.success && parsed.data.assignment && parsed.data.assignment.phase !== 'returning'
        ? [{ id: `ambulance-append:${object.id}`, controllerId: object.id, point: pointOf(object) }]
        : []
    }),
    targetFor: (controller, candidate, mode, context) => {
      const target = targetObjectFor(candidate, context)
      if (!target) return null
      const data = ambulanceDataOf(target)
      if (data.type === 'incident') return incidentTarget(controller, target, mode, context)
      return mode === 'append' ? careSiteTarget(controller, target, context) : null
    },
  },
} satisfies WorldPackView
