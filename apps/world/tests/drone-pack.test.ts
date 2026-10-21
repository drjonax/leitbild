import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, SimulationRunId, GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject, PackId } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  armDroneCommandKind,
  createDroneCommandKind,
  holdDroneCommandKind,
  manualControlCommandKind,
  navigateDroneCommandKind,
  takeoffDroneCommandKind,
} from '../src/packs/drone/commands.ts'
import { droneManualControlReadiness } from '../src/packs/drone/control-readiness.ts'
import { createDroneAttackInteractionHandler, droneAttackSignal } from '../src/packs/drone/interactions.ts'
import {
  defaultDroneVehicleModels,
  dronePackDataSchema,
  dronePackId,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneVehicleModel,
} from '../src/packs/drone/model.ts'
import { createDroneNativePackRuntimeAdapter } from '../src/packs/drone/native/adapter.ts'
import { parseDroneNativeRuntimeConfig } from '../src/packs/drone/native/config.ts'
import { droneNativeRuntimeId } from '../src/packs/drone/native/constants.ts'
import { createScenarioDroneObject, withDronePackData } from '../src/packs/drone/native/object-state.ts'
import { dronePack } from '../src/packs/drone/pack.ts'
import { droneManualIntentRealtimeInputType, parseDroneMotionFramesRealtimeMessage, type DroneMotionFrame } from '../src/packs/drone/realtime.ts'
import {
  answerDroneQuery,
  droneControllerBindings,
  droneControllerBindingsQueryKind,
  droneMapFeaturesQueryKind,
  droneSceneObjects,
  droneSceneQueryKind,
  droneSensorContacts,
  droneVehicleModelsQueryKind,
} from '../src/packs/drone/query.ts'
import { droneScenarioSupport } from '../src/packs/drone/scenario.ts'
import { babylonYawRadForHeadingDeg, bodyVelocityInBabylonFrame, horizontalVelocityFromBabylonBodyFrame } from '../src/packs/drone/spatial.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { loadDroneWorldTerrainStatus, localPointFromLonLat } from '../src/ui/drone/drone-map-world.ts'
import { createTestScenarioRuntimeResolver, testRuntimeConnectionConfig, waitForCondition } from './helpers.ts'
import { scenarios } from './fixtures/scenarios.ts'

const simulationRunId = 'run-test-drone-control' as SimulationRunId
const actorId = 'actor:test-pilot' as ActorId
const at = '2026-06-07T10:00:00.000Z' as IsoTimestamp

const point = (lon: number, lat: number): GeoJsonPoint => geoPointFromLonLat(lon, lat)

const effectModel = (): DroneVehicleModel => droneVehicleModelSchema.parse({
  id: 'native-effect-test',
  label: 'Native Effect Test',
  description: 'Native test vehicle with declared surveillance and effect payloads.',
  nominalEnduranceMinutes: 30,
  airframe: { kind: 'quadrotor', rotorCount: 4, massKg: 2.8, diagonalSizeM: 0.5 },
  flightEnvelope: {
    cruiseSpeedMps: 22,
    maxHorizontalSpeedMps: 44,
    maxVerticalSpeedMps: 10,
    maxAccelerationMps2: 16,
    maxYawRateDegPerSec: 160,
    arrivalRadiusM: 4,
  },
  capabilities: [
    { id: 'manual-control', kind: 'manual_control', label: 'Manual control', source: 'runtime' },
    { id: 'guided-navigation', kind: 'guided_navigation', label: 'Guided navigation', source: 'runtime' },
    { id: 'effect', kind: 'effect_payload', label: 'Effect payload', source: 'payload' },
  ],
  sensors: [
    { id: 'eo-test-camera', kind: 'electro_optical', label: 'EO test camera', rangeM: 900, fovDeg: 70, updateIntervalMs: 100, source: 'payload' },
  ],
  payloads: [
    {
      id: 'training-effect',
      kind: 'training_effect',
      label: 'Training effect',
      quantity: 2,
      rangeM: 600,
      source: 'payload',
      effect: { kind: 'training', damage: 0.45, radiusM: 3, cooldownSeconds: 0 },
    },
  ],
  visual: { color: '#991b1b', accentColor: '#fee2e2', scale: 1.12 },
})

const drone = (config: {
  readonly id: string
  readonly label?: string
  readonly model?: DroneVehicleModel
  readonly modelId?: string
  readonly point?: GeoJsonPoint
  readonly altitudeM?: number
  readonly headingDeg?: number
}): OperationalObject => {
  const model = config.model ?? requireDroneVehicleModel(config.modelId ?? 'native-survey-quad', defaultDroneVehicleModels)
  return createScenarioDroneObject({
    id: config.id as ObjectId,
    label: config.label ?? config.id,
    model,
    point: config.point ?? point(10.75, 59.91),
    altitudeM: config.altitudeM ?? 40,
    headingDeg: config.headingDeg ?? 0,
    at,
    simAt: at,
  })
}

const genericTarget = (config: {
  readonly id: string
  readonly point?: GeoJsonPoint
}): OperationalObject => ({
  id: config.id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: 'Target unit',
  lifecycle: 'active',
  revision: 0,
  spatial: {
    position: {
      point: config.point ?? point(10.7501, 59.91),
      observedAt: at,
    },
    frame: { kind: 'wgs84' },
  },
  operational: {
    status: 'available',
    priority: 'normal',
    mode: 'simulated',
  },
  alerts: [],
  communication: { state: 'connected' },
  provenance: { source: 'simulator', externalId: config.id },
  timestamps: { createdAt: at, updatedAt: at },
})

let commandSequence = 0

const command = (
  kind: string,
  payload: unknown,
  targetObjectIds: ReadonlyArray<ObjectId> = [],
): CommandEnvelope => {
  commandSequence += 1
  return {
    id: `command:drone-test-${commandSequence}` as CommandEnvelope['id'],
    simulationRunId,
    actorId,
    kind,
    targetObjectIds,
    payload,
    issuedAt: at,
  }
}

const droneData = (object: OperationalObject) => {
  const parsed = dronePackDataSchema.safeParse(object.packData)
  if (!parsed.success) throw new Error(`invalid drone data for ${object.id}`)
  return parsed.data
}

const horizontalDistanceM = (
  from: DroneMotionFrame,
  to: DroneMotionFrame,
): number => {
  const midLatRad = (from.lat + to.lat) * Math.PI / 360
  const eastM = (to.lon - from.lon) * 111_320 * Math.cos(midLatRad)
  const northM = (to.lat - from.lat) * 110_540
  return Math.hypot(eastM, northM)
}

/** A motion frame and the main thread's CPU milliseconds when it arrived. */
interface ArrivedMotionFrame {
  readonly frame: DroneMotionFrame
  readonly cpuMs: number
}

const threadCpuNowMs = (): number => {
  const used = process.threadCpuUsage()
  return (used.user + used.system) / 1_000
}

/** The longest the event loop went without running a probe timer, within [fromMs, toMs]. */
const longestLoopSilenceMs = (probeTicksMs: ReadonlyArray<number>, fromMs: number, toMs: number): number => {
  let longest = 0
  for (let index = 1; index < probeTicksMs.length; index += 1) {
    longest = Math.max(longest, Math.min(probeTicksMs[index]!, toMs) - Math.max(probeTicksMs[index - 1]!, fromMs))
  }
  return longest
}

const assertSmoothMotionFrames = (
  frames: ReadonlyArray<ArrivedMotionFrame>,
  probeTicksMs: ReadonlyArray<number>,
): void => {
  expect(frames.length).toBeGreaterThan(8)
  for (let index = 1; index < frames.length; index += 1) {
    const { frame: previous, cpuMs: previousCpuMs } = frames[index - 1]!
    const { frame: current, cpuMs } = frames[index]!
    const fromMs = Date.parse(previous.observedAt)
    const toMs = Date.parse(current.observedAt)
    const dtMs = toMs - fromMs
    const dtSeconds = Math.max(0.001, dtMs / 1_000)
    expect(current.sequence).toBeGreaterThan(previous.sequence)
    // A loaded machine that starves the whole process delays frames through no
    // fault of the runtime, and silences the probe timer alike (266 ms at load 150).
    expect(dtMs - longestLoopSilenceMs(probeTicksMs, fromMs, toMs)).toBeLessThanOrEqual(250)
    // Work that blocks the event loop silences the probe too, but spends the thread's CPU time.
    expect(cpuMs - previousCpuMs).toBeLessThanOrEqual(250)
    expect(horizontalDistanceM(previous, current)).toBeLessThanOrEqual(85 * dtSeconds + 1.5)
    expect(Math.abs(current.altitudeM - previous.altitudeM)).toBeLessThanOrEqual(24 * dtSeconds + 1.2)
  }
}

describe('drone pack native runtime', () => {
  test('expands scenario drones into native vehicle state', async () => {
    const contribution = await droneScenarioSupport.expandItem({
      pack: 'drone',
      type: 'drone',
      id: 'drone:scenario-native',
      label: 'Scenario Native',
      position: [10.75, 59.91],
      modelId: 'native-survey-quad',
      altitudeM: 55,
      headingDeg: 35,
    }, {
      at,
      objects: [],
      objectById: () => undefined,
      routing: createDirectRoutingAdapter(),
      packConfigs: { drone: { maxDrones: 10 } },
      sides: [],
    })

    const object = contribution.objects[0]!
    const data = droneData(object)
    expect(object.packId).toBe(dronePackId as PackId)
    expect(data.vehicle.modelId).toBe('native-survey-quad')
    expect(data.link.state).toBe('connected')
    expect(data.health.state).toBe('nominal')
    expect(data.vehicle.flightEnvelope.maxHorizontalSpeedMps).toBeGreaterThan(0)
  })

  test('native runtime parser merges model catalog overrides', () => {
    const defaults = parseDroneNativeRuntimeConfig({})
    expect(defaults.stepIntervalMs).toBe(20)
    expect(defaults.projectionIntervalMs).toBe(1_000)
    expect(defaults.motionFrameIntervalMs).toBe(100)

    const model = effectModel()
    const parsed = parseDroneNativeRuntimeConfig({
      maxDrones: 4,
      stepIntervalMs: 10,
      projectionIntervalMs: 20,
      models: [model],
    })
    expect(parsed.maxDrones).toBe(4)
    expect(parsed.stepIntervalMs).toBe(10)
    expect(parsed.models.some(candidate => candidate.id === model.id)).toBe(true)
  })

  test('native manual flight uses the same body frame as the Babylon drone mesh', () => {
    expect(babylonYawRadForHeadingDeg(0)).toBeCloseTo(Math.PI)
    expect(babylonYawRadForHeadingDeg(90)).toBeCloseTo(Math.PI / 2)

    const northForward = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 0, forwardMps: 12, rightMps: 0 })
    expect(northForward.eastMps).toBeCloseTo(0)
    expect(northForward.northMps).toBeCloseTo(12)

    const eastForward = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 90, forwardMps: 12, rightMps: 0 })
    expect(eastForward.eastMps).toBeCloseTo(12)
    expect(eastForward.northMps).toBeCloseTo(0)

    const eastRight = horizontalVelocityFromBabylonBodyFrame({ headingDeg: 90, forwardMps: 0, rightMps: 12 })
    expect(eastRight.eastMps).toBeCloseTo(0)
    expect(eastRight.northMps).toBeCloseTo(-12)

    const body = bodyVelocityInBabylonFrame({ headingDeg: 90, eastMps: 12, northMps: 0 })
    expect(body.forwardMps).toBeCloseTo(12)
    expect(body.rightMps).toBeCloseTo(0)
  })

  test('native runtime accepts manual flight without explicit arm or takeoff', async () => {
    const initial = drone({ id: 'drone:native-manual-simple', altitudeM: 0, headingDeg: 90 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-manual-simple',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect(droneManualControlReadiness(droneData(initial)).ready).toBe(true)
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 1, right: 0, vertical: 1, yaw: 0 },
        inputSource: { kind: 'keyboard', label: 'Keyboard' },
        commandTtlMs: 500,
      }, [initial.id]), {})).ok).toBe(true)
      await waitForCondition('manual flight moves and climbs from rest', () => {
        const current = seen.get(initial.id)
        if (!current) return false
        const data = droneData(current)
        return data.pose.altitudeM > 0.2
          && data.pose.point.coordinates[0] > initial.spatial.position!.point.coordinates[0]
          && data.control.inputSource?.kind === 'keyboard'
      }, { intervalMs: 20 })
      const data = droneData(seen.get(initial.id)!)
      expect(data.attitude.pitchDeg).toBeLessThan(-0.1)
      expect(Math.abs(data.attitude.rollDeg)).toBeLessThan(4)
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native manual yaw follows user-facing right turn intent', async () => {
    const initial = drone({ id: 'drone:native-manual-yaw', altitudeM: 12, headingDeg: 0 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-manual-yaw',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 0, right: 0, vertical: 0, yaw: 1 },
        inputSource: { kind: 'keyboard', label: 'Keyboard E' },
        commandTtlMs: 500,
      }, [initial.id]), {})).ok).toBe(true)
      await waitForCondition('positive manual yaw increases geospatial heading', () => {
        const current = seen.get(initial.id)
        if (!current) return false
        const data = droneData(current)
        return data.pose.headingDeg > 1 && data.pose.headingDeg < 40 && (data.attitude.yawRateDegPerSec ?? 0) > 1
      }, { intervalMs: 20 })
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native runtime emits compact realtime motion frames outside canonical object events', async () => {
    const initial = drone({ id: 'drone:native-motion-frame', altitudeM: 18, headingDeg: 45 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-motion-frame',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 200, motionFrameIntervalMs: 10 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 200, motionFrameIntervalMs: 10 },
      },
    })
    const frames: DroneMotionFrame[] = []
    const eventCounts: number[] = []
    const unsubscribe = connection.subscribe(emission => {
      eventCounts.push(emission.events.length)
      for (const message of emission.realtimeMessages ?? []) {
        const parsed = parseDroneMotionFramesRealtimeMessage(message)
        if (parsed) frames.push(...parsed.payload.frames)
      }
    })

    try {
      await waitForCondition('native runtime emits compact motion frames', () => frames.length > 0, { intervalMs: 10 })
      const first = frames[0]
      expect(first?.objectId).toBe(initial.id)
      expect(first?.altitudeM).toBeGreaterThan(17)
      expect(first?.headingDeg).toBeCloseTo(45)
      expect(eventCounts.some(count => count === 0)).toBe(true)
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native runtime applies manual realtime intent without command upsert churn', async () => {
    const initial = drone({ id: 'drone:native-manual-intent', altitudeM: 18, headingDeg: 90 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-manual-intent',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 250, motionFrameIntervalMs: 10 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 250, motionFrameIntervalMs: 10 },
      },
    })
    const frames: DroneMotionFrame[] = []
    const projectedEvents: OperationalObject[] = []
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') projectedEvents.push(event.object)
      }
      for (const message of emission.realtimeMessages ?? []) {
        const parsed = parseDroneMotionFramesRealtimeMessage(message)
        if (parsed) frames.push(...parsed.payload.frames)
      }
    })

    try {
      if (!connection.receiveRealtimeInput) throw new Error('runtime does not accept realtime input')
      const projectedBeforeInput = projectedEvents.length
      await connection.receiveRealtimeInput({
        type: droneManualIntentRealtimeInputType,
        at,
        payload: {
          droneId: initial.id,
          axes: { forward: 1, right: 0, vertical: 1, yaw: 0 },
          inputSource: { kind: 'keyboard', label: 'Keyboard' },
          commandTtlMs: 500,
          sampledAtMs: 0,
          sequence: 1,
        },
      })
      expect(projectedEvents).toHaveLength(projectedBeforeInput)
      await waitForCondition('manual realtime intent moves motion frames', () => {
        const latest = frames.filter(frame => frame.objectId === initial.id).at(-1)
        return latest !== undefined
          && latest.altitudeM > droneData(initial).pose.altitudeM
          && latest.eastMps > 0
      }, { intervalMs: 10 })
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native realtime manual loop keeps motion frames smooth under bursty fleet input', async () => {
    const fleet = Array.from({ length: 8 }, (_, index) => drone({
      id: `drone:native-stress-${index}`,
      point: point(10.75 + index * 0.00003, 59.91 + index * 0.00002),
      altitudeM: 24 + index,
      headingDeg: 90,
    }))
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: fleet,
      scenario: {
        scenarioId: 'scenario:native-manual-stress',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: fleet,
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { maxDrones: 10, stepIntervalMs: 10, projectionIntervalMs: 250, motionFrameIntervalMs: 10 } },
        runtimeConfig: { maxDrones: 10, stepIntervalMs: 10, projectionIntervalMs: 250, motionFrameIntervalMs: 10 },
      },
    })
    const probeTicksMs = [Date.now()]
    const probe = setInterval(() => { probeTicksMs.push(Date.now()) }, 5)
    const framesByDrone = new Map<string, ArrivedMotionFrame[]>()
    const unsubscribe = connection.subscribe(emission => {
      const cpuMs = threadCpuNowMs()
      for (const message of emission.realtimeMessages ?? []) {
        const parsed = parseDroneMotionFramesRealtimeMessage(message)
        if (!parsed) continue
        for (const frame of parsed.payload.frames) {
          const frames = framesByDrone.get(frame.objectId) ?? []
          frames.push({ frame, cpuMs })
          framesByDrone.set(frame.objectId, frames)
        }
      }
    })

    try {
      if (!connection.receiveRealtimeInput) throw new Error('runtime does not accept realtime input')
      for (let sequence = 0; sequence < 48; sequence += 1) {
        const target = fleet[sequence % fleet.length]!
        await connection.receiveRealtimeInput({
          type: droneManualIntentRealtimeInputType,
          at,
          payload: {
            droneId: target.id,
            axes: { forward: 1, right: sequence % 2 === 0 ? 0.25 : -0.25, vertical: 0.35, yaw: sequence % 3 === 0 ? 0.18 : 0 },
            inputSource: { kind: 'keyboard', label: 'Keyboard stress test' },
            commandTtlMs: 350,
            sampledAtMs: sequence * 8,
            sequence,
          },
        })
        await Bun.sleep(4)
      }

      await waitForCondition('bursty manual fleet input emits moving frames for every drone', () =>
        fleet.every(object => {
          const frames = framesByDrone.get(object.id) ?? []
          const latest = frames.at(-1)?.frame
          return frames.length > 8
            && latest !== undefined
            && latest.eastMps > 0.2
            && latest.verticalSpeedMps > 0.05
        }), { intervalMs: 20 })

      unsubscribe()
      clearInterval(probe)
      probeTicksMs.push(Date.now())
      for (const object of fleet) {
        assertSmoothMotionFrames(framesByDrone.get(object.id) ?? [], probeTicksMs)
      }
    } finally {
      unsubscribe()
      clearInterval(probe)
      await connection.close()
    }
  })

  test('native runtime executes arm, takeoff, goto, and manual control without external processes', async () => {
    const initial = drone({ id: 'drone:native-loop', altitudeM: 0, headingDeg: 0 })
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect({
      simulationRunId,
      initialObjects: [initial],
      scenario: {
        scenarioId: 'scenario:native-test',
        runtimeIds: [droneNativeRuntimeId],
        connections: [],
        world: { startsAt: at, environment: {} },
        initialObjects: [initial],
        runtimeConfigByRuntimeId: { [droneNativeRuntimeId]: { stepIntervalMs: 10, projectionIntervalMs: 20 } },
        runtimeConfig: { stepIntervalMs: 10, projectionIntervalMs: 20 },
      },
    })
    const seen = new Map<string, OperationalObject>()
    const unsubscribe = connection.subscribe(emission => {
      for (const event of emission.events) {
        if (event.type === 'object.upserted') seen.set(event.object.id, event.object)
      }
    })

    try {
      expect((await connection.sendCommand(command(armDroneCommandKind, { droneId: initial.id, armed: true }, [initial.id]), {})).ok).toBe(true)
      expect((await connection.sendCommand(command(takeoffDroneCommandKind, { droneId: initial.id, altitudeM: 20 }, [initial.id]), {})).ok).toBe(true)
      await waitForCondition('native takeoff climbs', () => (droneData(seen.get(initial.id) ?? initial).pose.altitudeM > 1), { intervalMs: 20 })

      expect((await connection.sendCommand(command(navigateDroneCommandKind, {
        droneId: initial.id,
        target: {
          point: point(10.751, 59.91),
          altitudeM: 20,
          speedMps: 20,
        },
      }, [initial.id]), {})).ok).toBe(true)
      await waitForCondition('native goto moves east', () => {
        const current = seen.get(initial.id)
        return current !== undefined && droneData(current).pose.point.coordinates[0] > initial.spatial.position!.point.coordinates[0]
      }, { intervalMs: 20 })

      const current = seen.get(initial.id)
      expect(current).toBeDefined()
      const currentData = droneData(current!)
      expect(droneManualControlReadiness(currentData).ready).toBe(true)
      expect((await connection.sendCommand(command(manualControlCommandKind, {
        droneId: initial.id,
        axes: { forward: 1, right: 0, vertical: 0, yaw: 0 },
        inputSource: { kind: 'keyboard', label: 'Keyboard' },
        commandTtlMs: 300,
      }, [initial.id]), {})).ok).toBe(true)
      await waitForCondition('manual control records controller binding', () => {
        const object = seen.get(initial.id)
        return object !== undefined && droneData(object).control.inputSource?.kind === 'keyboard'
      }, { intervalMs: 20 })
    } finally {
      unsubscribe()
      await connection.close()
    }
  })

  test('native create command does not require telemetry', async () => {
    const adapter = createDroneNativePackRuntimeAdapter()
    const connection = await adapter.connect(testRuntimeConnectionConfig({ simulationRunId, runtimeIds: [adapter.id], initialObjects: [] }))
    try {
      const result = await connection.sendCommand(command(createDroneCommandKind, {
        objectType: 'drone',
        label: 'Created Native',
        point: point(10.75, 59.91),
        modelId: 'native-survey-quad',
        altitudeM: 35,
      }), {})
      expect(result.ok).toBe(true)
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects.some(object => object.id === 'drone:created-native')).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('queries expose scene, bindings, map features, and model catalog', () => {
    const model = effectModel()
    const object = withDronePackData(
      drone({ id: 'drone:effect', model, altitudeM: 35 }),
      {
        ...droneData(drone({ id: 'drone:effect-source', model, altitudeM: 35 })),
        control: {
          inputSource: { kind: 'keyboard', label: 'Keyboard' },
          inputExpiresAt: at,
        },
      },
      at,
      at,
    )
    const contactTarget = { ...genericTarget({ id: 'incident:visible' }), kind: 'incident' as const }
    const objects = [object, contactTarget]

    expect(droneSceneObjects(objects)[0]?.modelId).toBe(model.id)
    expect(droneControllerBindings(objects)[0]?.inputKind).toBe('keyboard')
    expect(droneSensorContacts(objects)).toEqual([expect.objectContaining({ droneId: object.id, sensorId: 'eo-test-camera', targetId: contactTarget.id })])

    const scene = answerDroneQuery({ request: { capabilityId: droneSceneQueryKind, input: {} }, objects }) as { drones: ReadonlyArray<unknown> }
    const models = answerDroneQuery({ request: { capabilityId: droneVehicleModelsQueryKind, input: {} }, objects, models: [model] }) as { models: ReadonlyArray<DroneVehicleModel> }
    const features = answerDroneQuery({ request: { capabilityId: droneMapFeaturesQueryKind, input: {} }, objects }) as { features: ReadonlyArray<unknown> }
    const bindings = answerDroneQuery({ request: { capabilityId: droneControllerBindingsQueryKind, input: {} }, objects }) as { bindings: ReadonlyArray<unknown> }

    expect(scene.drones).toHaveLength(1)
    expect(models.models[0]?.id).toBe(model.id)
    expect(features.features.length).toBeGreaterThan(0)
    expect(bindings.bindings).toHaveLength(1)
  })

  test('attack interaction handler applies drone effects through interaction signals', async () => {
    const attacker = drone({ id: 'drone:attacker', model: effectModel() })
    const target = genericTarget({ id: 'unit:target' })
    const handler = createDroneAttackInteractionHandler()
    const effects = await handler.handle({
      signal: droneAttackSignal({
        simulationRunId,
        at,
        attackerId: attacker.id,
        targetId: target.id,
        payloadId: 'training-effect',
      }),
      snapshot: {
        objects: [attacker, target],
        seq: 1,
      },
      provenance: { source: 'operator' },
    })
    expect(effects.some(effect => effect.type === 'object.upsert')).toBe(true)
    expect(effects.some(effect => effect.type === 'notification.emit')).toBe(true)
  })

  test('drone pack presentation and creation commands expose native vehicle concepts', () => {
    const object = drone({ id: 'drone:presentation', modelId: 'native-gimbal-quad' })
    const presentation = dronePack.presentation.presentObject(object, { objects: [object] })
    const fieldsByKey = new Map(presentation.fields.map(field => [field.key, field.value]))

    expect(fieldsByKey.get('model')).toBe('Gimbal Quad')
    expect(fieldsByKey.get('link')).toBe('connected')
    expect(presentation.summary).toContain('Gimbal Quad')

    const commandRequest = dronePack.creation!.buildCreateObjectCommand('drone', 'New native drone', {
      kind: 'point',
      point: point(10.7, 59.9),
    }, {
      modelId: 'native-survey-quad',
      altitudeM: 45,
    })
    expect(commandRequest.kind).toBe(createDroneCommandKind)
    expect(commandRequest.payload).toMatchObject({
      objectType: 'drone',
      label: 'New native drone',
      modelId: 'native-survey-quad',
      altitudeM: 45,
    })
  })

  test('built-in drone scenario resolves through native runtime', () => {
    const catalog = createTestScenarioRuntimeResolver()
    const scenario = catalog.resolve(scenarios.find(candidate => candidate.id === 'test-drone')!)
    expect(scenario?.runtimes.some(runtime => runtime.runtimeId === droneNativeRuntimeId)).toBe(true)
    expect(scenario?.initialObjects.some(object => object.packId === dronePackId)).toBe(true)
  })

  test('drone terrain helpers keep lon lat origin stable for scene renderer', async () => {
    const status = await loadDroneWorldTerrainStatus()
    expect(status.status).toBe('unavailable')
    const local = localPointFromLonLat(10.751, 59.91, { lon: 10.75, lat: 59.91 })
    expect(local.x).toBeGreaterThan(0)
    expect(Math.abs(local.z)).toBeLessThan(0.000001)
  })

  test('hold command is part of the native runtime command surface', () => {
    expect(dronePack.targeting!.buildCancelTargetCommand(drone({ id: 'drone:cancel' }), { objects: [] }).kind).toBe(holdDroneCommandKind)
  })
})
