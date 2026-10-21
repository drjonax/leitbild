import {
  metersSchema,
  type AdapterId,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type TelemetryState,
} from '../../../core/model/index.ts'
import {
  droneHorizontalSpeedMps,
  dronePackDataSchema,
  dronePackId,
  droneVehicleModelSchema,
  type DronePackData,
  type DroneSwarmMembership,
  type DroneVehicleModel,
} from '../model.ts'
import { droneNativeAdapterId } from './constants.ts'

export const droneTelemetry = (data: DronePackData, at: IsoTimestamp): TelemetryState => {
  const signal = (
    signalId: string,
    label: string,
    unit: string,
    value: number,
    severity: 'normal' | 'warning' | 'critical' = 'normal',
  ) => ({
    signalId,
    label,
    unit,
    latest: value,
    samples: [{ at, value }],
    severity,
  })
  const batteryPercent = data.battery.remainingPercent ?? Number.NaN
  return {
    signals: {
      altitude: signal('altitude', 'Altitude', 'm', data.pose.altitudeM),
      speed: signal('speed', 'Ground speed', 'm/s', droneHorizontalSpeedMps(data.velocity)),
      verticalSpeed: signal('verticalSpeed', 'Vertical speed', 'm/s', data.velocity.verticalSpeedMps),
      roll: signal('roll', 'Roll', 'deg', data.attitude.rollDeg),
      pitch: signal('pitch', 'Pitch', 'deg', data.attitude.pitchDeg),
      heading: signal('heading', 'Heading', 'deg', data.pose.headingDeg),
      ...(Number.isFinite(batteryPercent)
        ? {
            battery: signal(
              'battery',
              'Battery',
              '%',
              batteryPercent,
              batteryPercent < 15 ? 'critical' : batteryPercent < 30 ? 'warning' : 'normal',
            ),
          }
        : {}),
    },
  }
}

export const droneOperationalStatus = (data: DronePackData): OperationalObject['operational'] => {
  if (data.health.state === 'destroyed') return { status: 'destroyed', priority: 'critical', mode: 'simulated' }
  if (data.link.state === 'lost') return { status: 'link_lost', priority: 'critical', intent: data.navigation.kind, mode: 'simulated' }
  if (data.link.state === 'degraded') return { status: 'link_degraded', priority: 'high', intent: data.navigation.kind, mode: 'simulated' }
  if (data.health.state === 'critical' || data.health.state === 'failed') {
    return { status: data.health.state, priority: 'critical', intent: data.navigation.kind, mode: 'simulated' }
  }
  if (data.arming.armed) {
    return { status: data.navigation.kind, priority: data.health.state === 'degraded' ? 'high' : 'normal', intent: data.navigation.mode, mode: 'simulated' }
  }
  return { status: 'disarmed', priority: 'normal', intent: data.navigation.mode, mode: 'simulated' }
}

export const parseDroneObject = (object: OperationalObject): DronePackData | null => {
  if (object.packId !== dronePackId) return null
  const parsed = dronePackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

export const withDronePackData = (
  object: OperationalObject,
  data: DronePackData,
  at: IsoTimestamp,
  adapterId: AdapterId = droneNativeAdapterId,
): OperationalObject => ({
  ...object,
  revision: object.revision + 1,
  lifecycle: data.health.state === 'destroyed' ? 'inactive' : object.lifecycle,
  spatial: {
    ...object.spatial,
    position: {
      point: data.pose.point,
      headingDeg: data.pose.headingDeg,
      speedMps: droneHorizontalSpeedMps(data.velocity),
      ...(data.pose.accuracyM === undefined ? {} : { accuracyM: metersSchema.parse(data.pose.accuracyM) }),
      observedAt: data.pose.observedAt,
      staleAfterMs: data.link.state === 'connected' ? 2_000 : 750,
    },
  },
  operational: droneOperationalStatus(data),
  telemetry: droneTelemetry(data, at),
  communication: {
    state: data.link.state === 'connected'
      ? 'connected'
      : data.link.state === 'lost'
        ? 'lost'
        : data.link.state === 'degraded'
          ? 'degraded'
          : 'unknown',
    ...(data.link.lastMessageAt === undefined ? {} : { lastContactAt: data.link.lastMessageAt }),
  },
  provenance: {
    source: 'simulator',
    adapterId,
    externalId: object.id,
  },
  timestamps: {
    ...object.timestamps,
    updatedAt: at,
  },
  packData: data,
})

export const createDronePackData = (config: {
  readonly model: DroneVehicleModel
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly headingDeg: number
  readonly at: IsoTimestamp
  readonly swarm?: DroneSwarmMembership
}): DronePackData => {
  const model = droneVehicleModelSchema.parse(config.model)
  return dronePackDataSchema.parse({
    type: 'drone',
    schemaVersion: 2,
    vehicle: {
      modelId: model.id,
      modelLabel: model.label,
      nominalEnduranceMinutes: model.nominalEnduranceMinutes,
      airframe: model.airframe,
      flightEnvelope: model.flightEnvelope,
      capabilities: model.capabilities,
      sensors: model.sensors,
      payloads: model.payloads,
      visual: model.visual,
    },
    link: {
      state: 'connected',
      lastHeartbeatAt: config.at,
      lastMessageAt: config.at,
    },
    arming: {
      state: 'disarmed',
      armed: false,
      updatedAt: config.at,
    },
    navigation: {
      kind: 'hold',
      mode: 'hold',
      updatedAt: config.at,
    },
    pose: {
      point: config.point,
      altitudeM: config.altitudeM,
      relativeAltitudeM: config.altitudeM,
      headingDeg: config.headingDeg,
      observedAt: config.at,
    },
    attitude: {
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: config.headingDeg,
    },
    battery: {
      remainingPercent: 100,
    },
    health: {
      state: 'nominal',
      damage: [],
    },
    mission: {
      state: 'idle',
      updatedAt: config.at,
    },
    geofence: {
      loaded: false,
      breachStatus: 'clear',
      updatedAt: config.at,
    },
    ...(config.swarm === undefined ? {} : { swarm: config.swarm }),
  })
}

export const createScenarioDroneObject = (config: {
  readonly id: ObjectId
  readonly label: string
  readonly model: DroneVehicleModel
  readonly point: GeoJsonPoint
  readonly altitudeM: number
  readonly headingDeg: number
  readonly at: IsoTimestamp
  readonly swarm?: DroneSwarmMembership
}): OperationalObject => {
  const data = createDronePackData(config)
  return {
    id: config.id,
    kind: 'mobile_entity',
    packId: dronePackId as OperationalObject['packId'],
    label: config.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: config.point,
        headingDeg: config.headingDeg,
        speedMps: 0,
        accuracyM: metersSchema.parse(1),
        observedAt: config.at,
        staleAfterMs: 2_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: droneOperationalStatus(data),
    telemetry: droneTelemetry(data, config.at),
    alerts: [],
    communication: { state: 'connected', lastContactAt: config.at },
    provenance: {
      source: 'simulator',
      adapterId: droneNativeAdapterId,
      externalId: config.id,
    },
    timestamps: {
      createdAt: config.at,
      updatedAt: config.at,
    },
    packData: data,
  }
}
