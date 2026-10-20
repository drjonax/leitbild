import { z } from 'zod'
import { geoJsonPointSchema, geoJsonPolygonSchema, isoTimestampSchema, objectIdSchema, type GeoJsonPoint, type IsoTimestamp, type OperationalObject } from '../../core/model/index.ts'
import { packMapFeatureSchema, type PackMapFeature } from '../../core/packs/protocol.ts'
import type { PackRuntimeQuery, SimulationCapability } from '../../simulation/protocol.ts'
import { defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import {
  defaultDroneVehicleModels,
  dronePackDataSchema,
  droneVehicleModelSchema,
  type DroneControllerBinding,
  type DroneSceneObject,
  type DroneSensorContact,
  type DroneVehicleModel,
} from './model.ts'
import { bearingDeg, horizontalDistanceM, movePointByMeters } from './spatial.ts'

export const droneSceneQueryKind = 'world.drone.scene'
export const droneControllerBindingsQueryKind = 'world.drone.controller-bindings'
export const droneVehicleModelsQueryKind = 'world.drone.vehicle-models'
export const droneMapFeaturesQueryKind = 'world.drone.map-features'
export const droneSensorContactsQueryKind = 'world.drone.sensor-contacts'

export const droneQueryKinds = [
  droneSceneQueryKind,
  droneControllerBindingsQueryKind,
  droneVehicleModelsQueryKind,
  droneMapFeaturesQueryKind,
  droneSensorContactsQueryKind,
] as const

const mapFeaturesPayloadSchema = z.object({
  viewport: geoJsonPolygonSchema.optional(),
  zoom: z.number().finite().min(0).max(24).optional(),
  layers: z.array(z.enum(['sensor-footprints', 'effect-ranges', 'swarm-envelopes'])).default(['sensor-footprints', 'effect-ranges', 'swarm-envelopes']),
}).strict().default({
  layers: ['sensor-footprints', 'effect-ranges', 'swarm-envelopes'],
})

const droneSceneObjectSchema = z.object({
  id: objectIdSchema,
  label: z.string(),
  point: geoJsonPointSchema,
  altitudeM: z.number().finite(),
  headingDeg: z.number().finite(),
  mode: z.string(),
  health: z.string(),
  modelId: z.string(),
  color: z.string(),
  link: z.string(),
  armed: z.boolean(),
  swarmId: z.string().optional(),
}).strict()
const controllerBindingSchema = z.object({
  droneId: objectIdSchema,
  actorId: z.string().optional(),
  clientId: z.string().optional(),
  inputKind: z.string().optional(),
  label: z.string().optional(),
  inputExpiresAt: isoTimestampSchema.optional(),
}).strict()
const sensorContactSchema = z.object({
  droneId: objectIdSchema,
  sensorId: z.string(),
  targetId: objectIdSchema,
  targetLabel: z.string(),
  distanceM: z.number().finite().nonnegative(),
  bearingDeg: z.number().finite(),
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(['runtime', 'payload']),
}).strict()
const sensorContactsInputSchema = z.object({ droneId: objectIdSchema.optional() }).strict()

export const droneQueryCapabilities: ReadonlyArray<SimulationCapability> = [
  defineSimulationQueryCapability({ id: droneSceneQueryKind, title: 'Read drone scene', description: 'Returns bounded current render and status data for active drones.', input: z.object({}).strict(), output: z.object({ drones: z.array(droneSceneObjectSchema) }).strict() }),
  defineSimulationQueryCapability({ id: droneControllerBindingsQueryKind, title: 'Read drone controller bindings', description: 'Returns current operator and client input bindings for active drones.', input: z.object({}).strict(), output: z.object({ bindings: z.array(controllerBindingSchema) }).strict() }),
  defineSimulationQueryCapability({ id: droneVehicleModelsQueryKind, title: 'List drone vehicle models', description: 'Lists the validated vehicle models available to the Drone runtime.', input: z.object({}).strict(), output: z.object({ models: z.array(droneVehicleModelSchema) }).strict() }),
  defineSimulationQueryCapability({ id: droneMapFeaturesQueryKind, title: 'Read drone map features', description: 'Projects current sensor, effect, and swarm envelopes into map features.', input: mapFeaturesPayloadSchema, output: z.object({ features: z.array(packMapFeatureSchema) }).strict() }),
  defineSimulationQueryCapability({ id: droneSensorContactsQueryKind, title: 'Read drone sensor contacts', description: 'Returns bounded, currently detectable positioned objects for all drones or one selected drone, based on each configured sensor range and target tags.', input: sensorContactsInputSchema, output: z.object({ contacts: z.array(sensorContactSchema) }).strict(), inspectObjectIds: raw => { const input = sensorContactsInputSchema.parse(raw); return input.droneId ? [input.droneId] : [] } }),
]

const fail = (reason: string): never => { throw new Error(reason) }

const droneDataFor = (object: OperationalObject) => {
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const droneSceneObjects = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<DroneSceneObject> =>
  objects.flatMap(object => {
    const data = droneDataFor(object)
    if (!data) return []
    return [{
      id: object.id,
      label: object.label,
      point: data.pose.point,
      altitudeM: data.pose.altitudeM,
      headingDeg: data.pose.headingDeg,
      mode: data.navigation.kind,
      health: data.health.state,
      modelId: data.vehicle.modelId,
      color: data.vehicle.visual.color,
      link: data.link.state,
      armed: data.arming.armed,
      ...(data.swarm?.swarmId === undefined ? {} : { swarmId: data.swarm.swarmId }),
    }]
  })

export const droneControllerBindings = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<DroneControllerBinding> =>
  objects.flatMap(object => {
    const data = droneDataFor(object)
    if (!data) return []
    return [{
      droneId: object.id,
      ...(data.control.pilotActorId === undefined ? {} : { actorId: data.control.pilotActorId }),
      ...(data.control.inputSource?.clientId === undefined ? {} : { clientId: data.control.inputSource.clientId }),
      ...(data.control.inputSource?.kind === undefined ? {} : { inputKind: data.control.inputSource.kind }),
      ...(data.control.inputSource?.label === undefined ? {} : { label: data.control.inputSource.label }),
      ...(data.control.inputExpiresAt === undefined ? {} : { inputExpiresAt: data.control.inputExpiresAt }),
    }]
  })

export const droneSensorContacts = (objects: ReadonlyArray<OperationalObject>, droneId?: string): ReadonlyArray<DroneSensorContact> => {
  const contacts: DroneSensorContact[] = []
  for (const drone of objects) {
    const data = droneDataFor(drone)
    if (droneId !== undefined && drone.id !== droneId) continue
    if (!data || data.health.state === 'destroyed' || data.link.state === 'lost') continue
    for (const target of objects) {
      if (target.id === drone.id || target.lifecycle !== 'active') continue
      const point = target.spatial.position?.point ?? (target.spatial.geometry?.type === 'Point' ? target.spatial.geometry : undefined)
      if (!point) continue
      const eligibleSensors = data.vehicle.sensors.filter(sensor => !sensor.tags.includes('incident') || target.kind === 'incident')
      const distanceM = horizontalDistanceM(data.pose.point, point)
      const sensor = eligibleSensors.filter(candidate => distanceM <= candidate.rangeM).sort((left, right) => right.rangeM - left.rangeM)[0]
      if (!sensor) continue
      contacts.push({
        droneId: drone.id,
        sensorId: sensor.id,
        targetId: target.id,
        targetLabel: target.label,
        distanceM,
        bearingDeg: bearingDeg(data.pose.point, point),
        confidence: Math.max(0.2, Math.min(1, 1 - distanceM / sensor.rangeM * 0.65)),
        source: sensor.source === 'runtime' ? 'runtime' : 'payload',
      })
      if (contacts.length >= 500) return contacts
    }
  }
  return contacts
}

const circlePolygon = (
  center: GeoJsonPoint,
  radiusM: number,
  vertices = 40,
): PackMapFeature['geometry'] => {
  const coordinates: GeoJsonPoint['coordinates'][] = []
  for (let index = 0; index < vertices; index += 1) {
    const angle = index / vertices * Math.PI * 2
    coordinates.push(movePointByMeters(center, {
      eastM: Math.sin(angle) * radiusM,
      northM: Math.cos(angle) * radiusM,
    }).coordinates)
  }
  coordinates.push(coordinates[0]!)
  return {
    type: 'Polygon',
    coordinates: [coordinates],
  }
}

const mapFeatures = (
  objects: ReadonlyArray<OperationalObject>,
  layers: ReadonlyArray<'sensor-footprints' | 'effect-ranges' | 'swarm-envelopes'>,
): ReadonlyArray<PackMapFeature> => {
  const enabled = new Set(layers)
  const features: PackMapFeature[] = []
  for (const object of objects) {
    const data = droneDataFor(object)
    if (!data) continue
    const point = data.pose.point
    if (enabled.has('sensor-footprints')) {
      const longestSensorRange = Math.max(0, ...data.vehicle.sensors.map(sensor => sensor.rangeM))
      if (longestSensorRange > 0) {
        features.push({
          id: `${object.id}:sensor-footprint`,
          categoryId: 'drone-sensor-footprints',
          geometry: circlePolygon(point, longestSensorRange),
          anchorPoint: point,
          color: data.vehicle.visual.color,
          opacity: 0.08,
          lineColor: data.vehicle.visual.color,
          lineOpacity: 0.28,
          lineWidth: 1,
          summary: `${object.label} sensor footprint`,
          sortKey: 40,
        })
      }
    }
    if (enabled.has('effect-ranges')) {
      const longestEffectRange = Math.max(0, ...data.vehicle.payloads.flatMap(payload => payload.effect && payload.rangeM ? [payload.rangeM] : []))
      if (longestEffectRange > 0) {
        features.push({
          id: `${object.id}:effect-range`,
          categoryId: 'drone-effect-ranges',
          geometry: circlePolygon(point, longestEffectRange),
          anchorPoint: point,
          color: '#c36469',
          opacity: 0.05,
          lineColor: '#c36469',
          lineOpacity: 0.35,
          lineWidth: 1.2,
          summary: `${object.label} effect range`,
          sortKey: 60,
        })
      }
    }
    if (enabled.has('swarm-envelopes') && data.swarm) {
      features.push({
        id: `${object.id}:swarm-envelope`,
        categoryId: 'drone-swarm-envelopes',
        geometry: circlePolygon(point, data.swarm.separationRadiusM),
        anchorPoint: point,
        color: '#9a7b5f',
        opacity: 0.04,
        lineColor: '#9a7b5f',
        lineOpacity: 0.28,
        lineWidth: 1,
        summary: `${object.label} swarm spacing`,
        sortKey: 50,
      })
    }
  }
  return features
}

export const answerDroneQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly objects: ReadonlyArray<OperationalObject>
  readonly at?: IsoTimestamp
  readonly models?: ReadonlyArray<DroneVehicleModel>
}): unknown => {
  try {
    if (config.request.capabilityId === droneSceneQueryKind) {
      return { drones: droneSceneObjects(config.objects) }
    }
    if (config.request.capabilityId === droneControllerBindingsQueryKind) {
      return { bindings: droneControllerBindings(config.objects) }
    }
    if (config.request.capabilityId === droneVehicleModelsQueryKind) {
      return { models: config.models ?? defaultDroneVehicleModels }
    }
    if (config.request.capabilityId === droneSensorContactsQueryKind) {
      const payload = sensorContactsInputSchema.parse(config.request.input)
      return { contacts: droneSensorContacts(config.objects, payload.droneId) }
    }
    if (config.request.capabilityId === droneMapFeaturesQueryKind) {
      const payload = mapFeaturesPayloadSchema.parse(config.request.input)
      return { features: mapFeatures(config.objects, payload.layers) }
    }
    return fail(`unsupported Drone query Capability: ${config.request.capabilityId}`)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
