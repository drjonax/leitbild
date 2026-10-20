import { z } from 'zod'
import {
  actorIdSchema,
  clientIdSchema,
  geoJsonPointSchema,
  idSchema,
  isoTimestampSchema,
  objectIdSchema,
  type ActorId,
  type ClientId,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
} from '../../core/model/index.ts'

export const dronePackId = 'drone' as const

export const droneVehicleMetadataSourceSchema = z.enum(['runtime', 'payload', 'operator_declared'])
export type DroneVehicleMetadataSource = z.infer<typeof droneVehicleMetadataSourceSchema>

export const droneLinkStateSchema = z.enum(['connecting', 'connected', 'degraded', 'lost'])
export type DroneLinkState = z.infer<typeof droneLinkStateSchema>

export const droneArmingStateSchema = z.enum(['armed', 'disarmed', 'unknown'])
export type DroneArmingState = z.infer<typeof droneArmingStateSchema>

export const droneNavigationKindSchema = z.enum([
  'manual',
  'hold',
  'mission',
  'guided',
  'offboard',
  'land',
  'return_to_launch',
  'takeoff',
  'failsafe',
  'unknown',
])
export type DroneNavigationKind = z.infer<typeof droneNavigationKindSchema>

export const droneHealthStateSchema = z.enum(['nominal', 'degraded', 'critical', 'failed', 'destroyed', 'unknown'])
export type DroneHealthState = z.infer<typeof droneHealthStateSchema>

export const droneMissionExecutionStateSchema = z.enum(['idle', 'uploading', 'ready', 'running', 'paused', 'complete', 'failed', 'unknown'])
export type DroneMissionExecutionState = z.infer<typeof droneMissionExecutionStateSchema>

export const droneFlightModeSchema = droneNavigationKindSchema
export type DroneFlightMode = DroneNavigationKind

export const droneAirframeSchema = z.object({
  kind: z.string().min(1).max(64),
  rotorCount: z.number().int().nonnegative().max(32),
  massKg: z.number().finite().positive().max(500).optional(),
  diagonalSizeM: z.number().finite().positive().max(10).optional(),
}).strict()
export type DroneAirframe = z.infer<typeof droneAirframeSchema>

export const droneSensorSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  rangeM: z.number().finite().positive().max(100_000),
  fovDeg: z.number().finite().positive().max(360).default(90),
  updateIntervalMs: z.number().int().positive().max(60_000).default(1_000),
  source: droneVehicleMetadataSourceSchema.default('operator_declared'),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DroneSensor = z.infer<typeof droneSensorSchema>

export const dronePayloadEffectSchema = z.object({
  kind: z.string().min(1).max(64),
  damage: z.number().finite().min(0).max(1),
  radiusM: z.number().finite().nonnegative().max(5_000).default(0),
  cooldownSeconds: z.number().finite().nonnegative().max(3_600).default(0),
}).strict()
export type DronePayloadEffect = z.infer<typeof dronePayloadEffectSchema>

export const dronePayloadSchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  massKg: z.number().finite().nonnegative().max(500).default(0),
  quantity: z.number().int().nonnegative().max(10_000).default(1),
  rangeM: z.number().finite().positive().max(100_000).optional(),
  effect: dronePayloadEffectSchema.optional(),
  source: droneVehicleMetadataSourceSchema.default('operator_declared'),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DronePayload = z.infer<typeof dronePayloadSchema>

export const droneCapabilitySchema = z.object({
  id: idSchema,
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  level: z.number().finite().min(0).max(10).default(1),
  source: droneVehicleMetadataSourceSchema.default('operator_declared'),
  tags: z.array(z.string().min(1).max(48)).default([]),
}).strict()
export type DroneCapability = z.infer<typeof droneCapabilitySchema>

export const droneVisualProfileSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4669ff'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f8fafc'),
  scale: z.number().finite().positive().max(10).default(1),
  meshRef: z.string().min(1).max(240).optional(),
}).strict()
export type DroneVisualProfile = z.infer<typeof droneVisualProfileSchema>

export const droneFlightEnvelopeSchema = z.object({
  cruiseSpeedMps: z.number().finite().positive().max(160).default(18),
  maxHorizontalSpeedMps: z.number().finite().positive().max(220).default(36),
  maxVerticalSpeedMps: z.number().finite().positive().max(80).default(8),
  maxAccelerationMps2: z.number().finite().positive().max(80).default(12),
  maxYawRateDegPerSec: z.number().finite().positive().max(720).default(140),
  arrivalRadiusM: z.number().finite().positive().max(200).default(4),
}).strict()
export type DroneFlightEnvelope = z.infer<typeof droneFlightEnvelopeSchema>

export const droneVehicleModelSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(96),
  description: z.string().min(1).max(500).optional(),
  nominalEnduranceMinutes: z.number().finite().min(5).max(1_440),
  airframe: droneAirframeSchema,
  flightEnvelope: droneFlightEnvelopeSchema.default({
    cruiseSpeedMps: 18,
    maxHorizontalSpeedMps: 36,
    maxVerticalSpeedMps: 8,
    maxAccelerationMps2: 12,
    maxYawRateDegPerSec: 140,
    arrivalRadiusM: 4,
  }),
  capabilities: z.array(droneCapabilitySchema).default([]),
  sensors: z.array(droneSensorSchema).default([]),
  payloads: z.array(dronePayloadSchema).default([]),
  visual: droneVisualProfileSchema.default({
    color: '#4669ff',
    accentColor: '#f8fafc',
    scale: 1,
  }),
}).strict()
export type DroneVehicleModel = z.infer<typeof droneVehicleModelSchema>

export const droneProfileSchema = droneVehicleModelSchema
export type DroneProfile = DroneVehicleModel

export const dronePoseSchema = z.object({
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(-1_000).max(100_000),
  relativeAltitudeM: z.number().finite().min(-1_000).max(100_000).optional(),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  accuracyM: z.number().finite().nonnegative().max(100_000).optional(),
  observedAt: isoTimestampSchema,
}).strict()
export type DronePose = z.infer<typeof dronePoseSchema>

export const droneVelocitySchema = z.object({
  eastMps: z.number().finite().min(-500).max(500).default(0),
  northMps: z.number().finite().min(-500).max(500).default(0),
  downMps: z.number().finite().min(-500).max(500).default(0),
  groundSpeedMps: z.number().finite().nonnegative().max(500).default(0),
  verticalSpeedMps: z.number().finite().min(-500).max(500).default(0),
}).strict()
export type DroneVelocity = z.infer<typeof droneVelocitySchema>

export const droneAttitudeSchema = z.object({
  rollDeg: z.number().finite().min(-180).max(180).default(0),
  pitchDeg: z.number().finite().min(-180).max(180).default(0),
  yawDeg: z.number().finite().min(0).max(360).default(0),
  rollRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
  pitchRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
  yawRateDegPerSec: z.number().finite().min(-1_500).max(1_500).optional(),
}).strict()
export type DroneAttitude = z.infer<typeof droneAttitudeSchema>

export const droneBatteryStateSchema = z.object({
  remainingPercent: z.number().finite().min(0).max(100).optional(),
  voltageV: z.number().finite().nonnegative().max(1_000).optional(),
  currentA: z.number().finite().min(-1_000).max(1_000).optional(),
  consumedMah: z.number().finite().nonnegative().max(10_000_000).optional(),
}).strict()
export type DroneBatteryState = z.infer<typeof droneBatteryStateSchema>

export const droneManualAxesSchema = z.object({
  forward: z.number().finite().min(-1).max(1).default(0),
  right: z.number().finite().min(-1).max(1).default(0),
  vertical: z.number().finite().min(-1).max(1).default(0),
  yaw: z.number().finite().min(-1).max(1).default(0),
}).strict()
export type DroneManualAxes = z.infer<typeof droneManualAxesSchema>

export const droneInputSourceSchema = z.object({
  kind: z.enum(['keyboard', 'mouse', 'gamepad', 'map', 'scenario', 'ai', 'operator']),
  label: z.string().min(1).max(120).optional(),
  gamepadIndex: z.number().int().nonnegative().max(16).optional(),
  clientId: clientIdSchema.optional(),
}).strict()
export type DroneInputSource = z.infer<typeof droneInputSourceSchema>

export const droneGuidedTargetSchema = z.object({
  point: geoJsonPointSchema,
  altitudeM: z.number().finite().min(-1_000).max(100_000),
  speedMps: z.number().finite().positive().max(160).optional(),
  targetObjectId: objectIdSchema.optional(),
}).strict()
export type DroneGuidedTarget = z.infer<typeof droneGuidedTargetSchema>

export const droneControlStateSchema = z.object({
  pilotActorId: actorIdSchema.optional(),
  inputSource: droneInputSourceSchema.optional(),
  manualAxes: droneManualAxesSchema.optional(),
  guidedTarget: droneGuidedTargetSchema.optional(),
  lastCommandAt: isoTimestampSchema.optional(),
  inputExpiresAt: isoTimestampSchema.optional(),
}).strict()
export type DroneControlState = z.infer<typeof droneControlStateSchema>

export const droneDamageRecordSchema = z.object({
  id: idSchema,
  sourceObjectId: objectIdSchema.optional(),
  kind: z.string().min(1).max(64),
  severity: z.number().finite().min(0).max(1),
  occurredAt: isoTimestampSchema,
  description: z.string().min(1).max(240),
}).strict()
export type DroneDamageRecord = z.infer<typeof droneDamageRecordSchema>

export const droneAutopilotHealthSchema = z.object({
  state: droneHealthStateSchema,
  ekfOk: z.boolean().optional(),
  gpsOk: z.boolean().optional(),
  batteryOk: z.boolean().optional(),
  localPositionOk: z.boolean().optional(),
  globalPositionOk: z.boolean().optional(),
  lastStatusText: z.string().min(1).max(240).optional(),
  damage: z.array(droneDamageRecordSchema).default([]),
}).strict()
export type DroneAutopilotHealth = z.infer<typeof droneAutopilotHealthSchema>

export const droneSwarmMembershipSchema = z.object({
  swarmId: idSchema,
  role: z.string().min(1).max(64).default('member'),
  slot: z.tuple([
    z.number().finite().min(-10_000).max(10_000),
    z.number().finite().min(-10_000).max(10_000),
    z.number().finite().min(-5_000).max(5_000),
  ]).default([0, 0, 0]),
  separationRadiusM: z.number().finite().positive().max(1_000).default(8),
}).strict()
export type DroneSwarmMembership = z.infer<typeof droneSwarmMembershipSchema>

export const droneMissionStateSchema = z.object({
  state: droneMissionExecutionStateSchema,
  currentSeq: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  planId: idSchema.optional(),
  updatedAt: isoTimestampSchema.optional(),
}).strict()
export type DroneMissionState = z.infer<typeof droneMissionStateSchema>

export const droneGeofenceStateSchema = z.object({
  loaded: z.boolean().default(false),
  breachStatus: z.enum(['clear', 'breached', 'unknown']).default('unknown'),
  updatedAt: isoTimestampSchema.optional(),
}).strict()
export type DroneGeofenceState = z.infer<typeof droneGeofenceStateSchema>

export const dronePayloadRuntimeStateSchema = z.object({
  gimbalPitchDeg: z.number().finite().min(-180).max(180).optional(),
  gimbalYawDeg: z.number().finite().min(-180).max(180).optional(),
  cameraMode: z.string().min(1).max(64).optional(),
  activeSensorId: idSchema.optional(),
}).strict()
export type DronePayloadRuntimeState = z.infer<typeof dronePayloadRuntimeStateSchema>

export const droneVehicleIdentitySchema = z.object({
  modelId: idSchema,
  modelLabel: z.string().min(1).max(96),
  nominalEnduranceMinutes: z.number().finite().min(5).max(1_440),
  airframe: droneAirframeSchema,
  flightEnvelope: droneFlightEnvelopeSchema,
  capabilities: z.array(droneCapabilitySchema).default([]),
  sensors: z.array(droneSensorSchema).default([]),
  payloads: z.array(dronePayloadSchema).default([]),
  visual: droneVisualProfileSchema.default({
    color: '#4669ff',
    accentColor: '#f8fafc',
    scale: 1,
  }),
}).strict()
export type DroneVehicleIdentity = z.infer<typeof droneVehicleIdentitySchema>

export const dronePackDataSchema = z.object({
  type: z.literal('drone'),
  schemaVersion: z.literal(2),
  vehicle: droneVehicleIdentitySchema,
  link: z.object({
    state: droneLinkStateSchema,
    lastHeartbeatAt: isoTimestampSchema.optional(),
    lastMessageAt: isoTimestampSchema.optional(),
  }).strict(),
  arming: z.object({
    state: droneArmingStateSchema,
    armed: z.boolean(),
    updatedAt: isoTimestampSchema.optional(),
  }).strict(),
  navigation: z.object({
    kind: droneNavigationKindSchema,
    mode: z.string().min(1).max(96),
    customMode: z.number().int().nonnegative().optional(),
    updatedAt: isoTimestampSchema.optional(),
  }).strict(),
  pose: dronePoseSchema,
  velocity: droneVelocitySchema.default({
    eastMps: 0,
    northMps: 0,
    downMps: 0,
    groundSpeedMps: 0,
    verticalSpeedMps: 0,
  }),
  attitude: droneAttitudeSchema.default({
    rollDeg: 0,
    pitchDeg: 0,
    yawDeg: 0,
  }),
  battery: droneBatteryStateSchema.default({}),
  health: droneAutopilotHealthSchema,
  control: droneControlStateSchema.default({}),
  mission: droneMissionStateSchema.default({ state: 'unknown' }),
  geofence: droneGeofenceStateSchema.default({ loaded: false, breachStatus: 'unknown' }),
  payload: dronePayloadRuntimeStateSchema.default({}),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()
export type DronePackData = z.infer<typeof dronePackDataSchema>

export const droneVehicleModelCatalogSchema = z.object({
  models: z.array(droneVehicleModelSchema).default([]),
}).strict()
export type DroneVehicleModelCatalog = z.infer<typeof droneVehicleModelCatalogSchema>

export const droneProfileCatalogSchema = z.object({
  profiles: z.array(droneVehicleModelSchema).default([]),
}).strict()
export type DroneProfileCatalog = z.infer<typeof droneProfileCatalogSchema>

export const defaultDroneVehicleModels: ReadonlyArray<DroneVehicleModel> = [
  droneVehicleModelSchema.parse({
    id: 'native-survey-quad',
    label: 'Survey Quad',
    description: 'Native Leitbild quadrotor tuned for smooth survey flight.',
    nominalEnduranceMinutes: 40,
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.4, diagonalSizeM: 0.46 },
    flightEnvelope: {
      cruiseSpeedMps: 18,
      maxHorizontalSpeedMps: 34,
      maxVerticalSpeedMps: 7,
      maxAccelerationMps2: 11,
      maxYawRateDegPerSec: 140,
      arrivalRadiusM: 4,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'runtime' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
      { id: 'mission', kind: 'mission', label: 'Mission execution', source: 'runtime' },
      { id: 'geofence', kind: 'geofence', label: 'Geofence', source: 'runtime' },
      { id: 'wide-camera', kind: 'electro_optical', label: 'Wide camera', source: 'payload' },
    ],
    sensors: [
      { id: 'wide-camera', kind: 'electro_optical', label: 'Wide camera', rangeM: 650, fovDeg: 95, updateIntervalMs: 200, source: 'payload' },
    ],
    visual: { color: '#4669ff', accentColor: '#f8fafc', scale: 1 },
  }),
  droneVehicleModelSchema.parse({
    id: 'native-gimbal-quad',
    label: 'Gimbal Quad',
    description: 'Native Leitbild quadrotor with a camera gimbal payload.',
    nominalEnduranceMinutes: 32,
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.7, diagonalSizeM: 0.5 },
    flightEnvelope: {
      cruiseSpeedMps: 16,
      maxHorizontalSpeedMps: 30,
      maxVerticalSpeedMps: 6,
      maxAccelerationMps2: 9,
      maxYawRateDegPerSec: 120,
      arrivalRadiusM: 4,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'runtime' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
      { id: 'mission', kind: 'mission', label: 'Mission execution', source: 'runtime' },
      { id: 'camera-gimbal', kind: 'camera_gimbal', label: 'Camera gimbal', source: 'payload' },
    ],
    sensors: [
      { id: 'eo-gimbal-camera', kind: 'electro_optical', label: 'EO gimbal camera', rangeM: 1_200, fovDeg: 60, updateIntervalMs: 100, source: 'payload' },
    ],
    payloads: [
      { id: 'eo-gimbal', kind: 'camera_gimbal', label: 'EO gimbal', quantity: 1, source: 'payload' },
    ],
    visual: { color: '#00878c', accentColor: '#ecfeff', scale: 1.08 },
  }),
  droneVehicleModelSchema.parse({
    id: 'native-interceptor-quad',
    label: 'Interceptor Quad',
    description: 'Native Leitbild quadrotor tuned for fast response and training effects.',
    nominalEnduranceMinutes: 24,
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 3.2, diagonalSizeM: 0.55 },
    flightEnvelope: {
      cruiseSpeedMps: 26,
      maxHorizontalSpeedMps: 52,
      maxVerticalSpeedMps: 12,
      maxAccelerationMps2: 18,
      maxYawRateDegPerSec: 180,
      arrivalRadiusM: 5,
    },
    capabilities: [
      { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'runtime' },
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
      { id: 'mission', kind: 'mission', label: 'Mission execution', source: 'runtime' },
      { id: 'geofence', kind: 'geofence', label: 'Geofence', source: 'runtime' },
      { id: 'effect-delivery', kind: 'effect_delivery', label: 'Effect delivery', source: 'payload' },
    ],
    sensors: [
      { id: 'tracking-camera', kind: 'tracking_camera', label: 'Tracking camera', rangeM: 900, fovDeg: 50, updateIntervalMs: 150, source: 'payload' },
    ],
    payloads: [
      {
        id: 'training-effect',
        kind: 'training_effect',
        label: 'Training effect',
        massKg: 0.7,
        quantity: 1,
        rangeM: 75,
        effect: { kind: 'training-effect', damage: 0.65, radiusM: 3, cooldownSeconds: 8 },
        source: 'operator_declared',
      },
    ],
    visual: { color: '#b41e46', accentColor: '#fee2e2', scale: 1.05 },
  }),
  droneVehicleModelSchema.parse({
    id: 'incident-response-fixed-wing',
    label: 'Incident Search Fixed Wing',
    description: 'Long-endurance reconnaissance aircraft for broad-area search and loitering; deliberately slower than the incident-response quadcopter.',
    nominalEnduranceMinutes: 180,
    airframe: { kind: 'fixed-wing', rotorCount: 0, massKg: 5.8 },
    flightEnvelope: { cruiseSpeedMps: 17, maxHorizontalSpeedMps: 23, maxVerticalSpeedMps: 5, maxAccelerationMps2: 5, maxYawRateDegPerSec: 45, arrivalRadiusM: 18 },
    capabilities: [
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
      { id: 'mission', kind: 'mission', label: 'Mission execution', source: 'runtime' },
      { id: 'incident-search', kind: 'reconnaissance', label: 'Broad-area incident search', level: 7, source: 'payload', tags: ['incident', 'search', 'casualty'] },
    ],
    sensors: [{ id: 'wide-area-eo', kind: 'electro_optical', label: 'Wide-area EO sensor', rangeM: 3_500, fovDeg: 110, updateIntervalMs: 1_000, source: 'payload', tags: ['incident', 'search'] }],
    visual: { color: '#6e788c', accentColor: '#e7f0fb', scale: 1.15 },
  }),
  droneVehicleModelSchema.parse({
    id: 'incident-response-quadcopter',
    label: 'Incident Response Quadcopter',
    description: 'Fast short-endurance aircraft for close incident inspection and detailed casualty observation.',
    nominalEnduranceMinutes: 28,
    airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 3.1, diagonalSizeM: 0.58 },
    flightEnvelope: { cruiseSpeedMps: 24, maxHorizontalSpeedMps: 42, maxVerticalSpeedMps: 10, maxAccelerationMps2: 15, maxYawRateDegPerSec: 170, arrivalRadiusM: 4 },
    capabilities: [
      { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
      { id: 'mission', kind: 'mission', label: 'Mission execution', source: 'runtime' },
      { id: 'incident-observation', kind: 'reconnaissance', label: 'Detailed incident observation', level: 9, source: 'payload', tags: ['incident', 'casualty', 'close-inspection'] },
    ],
    sensors: [{ id: 'incident-eo-ir', kind: 'electro_optical', label: 'EO/IR incident camera', rangeM: 900, fovDeg: 70, updateIntervalMs: 200, source: 'payload', tags: ['incident', 'casualty', 'detail'] }],
    payloads: [{ id: 'incident-camera', kind: 'camera_gimbal', label: 'Incident camera', quantity: 1, source: 'payload', tags: ['reconnaissance'] }],
    visual: { color: '#af7350', accentColor: '#fff3e8', scale: 1.08 },
  }),
]

export const defaultDroneProfiles = defaultDroneVehicleModels

export const droneVehicleModelMap = (
  models: ReadonlyArray<DroneVehicleModel> = defaultDroneVehicleModels,
): ReadonlyMap<string, DroneVehicleModel> =>
  new Map(models.map(model => [model.id, model]))

export const requireDroneVehicleModel = (
  modelId: string,
  models: ReadonlyArray<DroneVehicleModel> = defaultDroneVehicleModels,
): DroneVehicleModel => {
  const model = droneVehicleModelMap(models).get(modelId)
  if (!model) throw new Error(`unknown drone vehicle model: ${modelId}`)
  return model
}

export const requireDroneProfile = requireDroneVehicleModel

export const isDronePackData = (value: unknown): value is DronePackData =>
  dronePackDataSchema.safeParse(value).success

export const droneHasCapability = (
  model: {
    readonly capabilities: ReadonlyArray<DroneCapability>
  },
  kind: string,
): boolean =>
  model.capabilities.some(capability => capability.kind === kind)

export const droneHorizontalSpeedMps = (velocity: DroneVelocity): number =>
  Math.hypot(velocity.eastMps, velocity.northMps)

export interface DroneSceneObject {
  readonly id: ObjectId
  readonly label: string
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly headingDeg: number
  readonly mode: DroneNavigationKind
  readonly health: DroneHealthState
  readonly modelId: string
  readonly color: string
  readonly link: DroneLinkState
  readonly armed: boolean
  readonly swarmId?: string
}

export interface DroneControllerBinding {
  readonly droneId: ObjectId
  readonly actorId?: ActorId
  readonly clientId?: ClientId
  readonly inputKind?: DroneInputSource['kind']
  readonly label?: string
  readonly inputExpiresAt?: IsoTimestamp
}

export interface DroneSensorContact {
  readonly droneId: ObjectId
  readonly sensorId: string
  readonly targetId: ObjectId
  readonly targetLabel: string
  readonly distanceM: number
  readonly bearingDeg: number
  readonly confidence: number
  readonly source: 'runtime' | 'payload'
}
