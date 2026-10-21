import type { CommandEnvelope,CommandResult,GeoJsonPoint,GeoJsonPolygon,IsoTimestamp,OperationalObject,SimulationClockState,SimulationRunEvent } from '../../../core/model/index.ts'
import { commandResultSchema,geoJsonPointSchema,geoJsonPolygonSchema,nowIso,objectIdSchema } from '../../../core/model/index.ts'
import { z } from 'zod'
import { createSimulationClock } from '../../../core/model/time.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import type { PackRuntimeAdapter,PackRuntimeConnection,PackRuntimeEmission,PackRuntimeEvent,PackRuntimeEventHandler,PackRuntimeQuery,PackRuntimeRealtimeMessage,PackRuntimeSnapshot } from '../../../simulation/protocol.ts'
import {
  armDroneCommandKind,
  armDronePayloadSchema,
  attackCommandKind,
  attackPayloadSchema,
  observeTargetCommandKind,
  observeTargetPayloadSchema,
  clearDroneGeofenceCommandKind,
  clearDroneMissionCommandKind,
  configureDroneVehicleModelCommandKind,
  configureDroneVehicleModelPayloadSchema,
  createDroneCommandKind,
  createDronePayloadSchema,holdDroneCommandKind,
  landDroneCommandKind,
  manualControlCommandKind,
  manualControlPayloadSchema,
  navigateDroneCommandKind,
  navigateDronePayloadSchema,
  pauseDroneMissionCommandKind,
  returnToLaunchDroneCommandKind,
  setDroneGimbalCommandKind,
  setDroneGimbalPayloadSchema,setDroneSwarmCommandKind,setDroneSwarmPayloadSchema,singleDronePayloadSchema,
  startDroneMissionCommandKind,
  swarmCommandKind,
  swarmCommandPayloadSchema,
  takeoffDroneCommandKind,
  takeoffDronePayloadSchema,
  uploadDroneGeofenceCommandKind,
  uploadDroneGeofencePayloadSchema,
  uploadDroneMissionCommandKind,
  uploadDroneMissionPayloadSchema,
  droneMissionItemSchema,
} from '../commands.ts'
import { droneManualControlReadiness } from '../control-readiness.ts'
import { droneAttackSignal, droneObservationSignal } from '../interactions.ts'
import { droneHasCapability,dronePackId,requireDroneVehicleModel,type DroneGuidedTarget,type DronePackData,type DroneVehicleModel } from '../model.ts'
import { answerDroneQuery,droneQueryCapabilities } from '../query.ts'
import {
  droneManualIntentPayloadSchema,
  droneManualIntentRealtimeInputType,
  droneMotionFramesRealtimeMessage,
  type DroneManualIntentPayload,
  type DroneMotionFrame,
} from '../realtime.ts'
import { horizontalDistanceM,movePointByMeters } from '../spatial.ts'
import { parseDroneNativeRuntimeConfig } from './config.ts'
import { droneNativeAdapterId,droneNativeRuntimeId } from './constants.ts'
import { createDroneFixedStepScheduler } from './fixed-step.ts'
import { missionTarget,nativeGuidedTarget,setDroneNavigation,stepDroneObject,targetInsideGeofence,type NativeMissionPlan } from './flight-loop.ts'
import { createScenarioDroneObject,parseDroneObject,withDronePackData } from './object-state.ts'

const commandAccepted = (command: CommandEnvelope, acceptedAt: IsoTimestamp): CommandResult => ({
  ok: true,
  commandId: command.id,
  acceptedAt,
})

const commandRejected = (command: CommandEnvelope, rejectedAt: IsoTimestamp, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt,
  reason,
})

const slugObjectId = (prefix: string, label: string): OperationalObject['id'] => {
  const slug = label.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'vehicle'
  return objectIdSchema.parse(`${prefix}:${slug}`)
}

interface DroneRuntimeRecord {
  readonly object: OperationalObject
  readonly data: DronePackData
}

const maxRuntimeCatchUpSteps = 5

const droneRuntimeCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  homePoints: z.record(z.string(), geoJsonPointSchema),
  missionPlans: z.record(z.string(), z.object({
    planId: z.string().min(1).max(128).optional(),
    items: z.array(droneMissionItemSchema),
    currentIndex: z.number().int().nonnegative(),
    holdUntilMs: z.number().finite().optional(),
  }).strict()),
  geofences: z.record(z.string(), z.array(geoJsonPolygonSchema)),
  motionFrameSequence: z.number().int().nonnegative(),
}).strict()

export const createDroneNativePackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: droneNativeRuntimeId,
  version: '1.0.0',
  packId: dronePackId,
  clock: 'simulation',
  capabilities: [
    defineSimulationCommandCapability({ id: setDroneSwarmCommandKind, title: 'Set drone swarm membership', description: 'Sets or clears membership on the live drone without replacing its vehicle or flight state.', input: setDroneSwarmPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [setDroneSwarmPayloadSchema.parse(input).droneId], payload: setDroneSwarmPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: createDroneCommandKind, title: 'Create drone', description: 'Creates a Drone Pack vehicle from a validated vehicle model.', input: createDronePayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [], payload: createDronePayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: armDroneCommandKind, title: 'Set drone arming', description: 'Arms or disarms one drone after validating its current readiness.', input: armDronePayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [armDronePayloadSchema.parse(input).droneId], payload: armDronePayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: manualControlCommandKind, title: 'Apply drone manual control', description: 'Applies a short-lived validated manual-control sample to one drone.', input: manualControlPayloadSchema, output: commandResultSchema, idempotent: false, buildCommand: input => ({ targetObjectIds: [manualControlPayloadSchema.parse(input).droneId], payload: manualControlPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: navigateDroneCommandKind, title: 'Navigate drone', description: 'Commands one drone to navigate to a validated guided target.', input: navigateDronePayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [navigateDronePayloadSchema.parse(input).droneId], payload: navigateDronePayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: takeoffDroneCommandKind, title: 'Take off drone', description: 'Commands one armed drone to take off to an explicit altitude.', input: takeoffDronePayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [takeoffDronePayloadSchema.parse(input).droneId], payload: takeoffDronePayloadSchema.parse(input) }) }),
    ...[
      [landDroneCommandKind, 'Land drone', 'Commands one drone to land.'],
      [returnToLaunchDroneCommandKind, 'Return drone to launch', 'Commands one drone to return to its launch point.'],
      [holdDroneCommandKind, 'Hold drone', 'Commands one drone to hold its current position.'],
      [startDroneMissionCommandKind, 'Start drone mission', 'Starts the uploaded mission for one drone.'],
      [pauseDroneMissionCommandKind, 'Pause drone mission', 'Pauses the current mission for one drone.'],
      [clearDroneMissionCommandKind, 'Clear drone mission', 'Clears the uploaded mission for one drone.'],
      [clearDroneGeofenceCommandKind, 'Clear drone geofence', 'Clears the configured geofence for one drone.'],
    ].map(([id, title, description]) => defineSimulationCommandCapability({ id: id!, title: title!, description: description!, input: singleDronePayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [singleDronePayloadSchema.parse(input).droneId], payload: singleDronePayloadSchema.parse(input) }) })),
    defineSimulationCommandCapability({ id: uploadDroneMissionCommandKind, title: 'Upload drone mission', description: 'Uploads a validated ordered mission plan to one drone.', input: uploadDroneMissionPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [uploadDroneMissionPayloadSchema.parse(input).droneId], payload: uploadDroneMissionPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: uploadDroneGeofenceCommandKind, title: 'Upload drone geofence', description: 'Sets validated geofence polygons for one drone.', input: uploadDroneGeofencePayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [uploadDroneGeofencePayloadSchema.parse(input).droneId], payload: uploadDroneGeofencePayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: setDroneGimbalCommandKind, title: 'Set drone gimbal', description: 'Sets the gimbal pitch and yaw of one drone.', input: setDroneGimbalPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [setDroneGimbalPayloadSchema.parse(input).droneId], payload: setDroneGimbalPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: configureDroneVehicleModelCommandKind, title: 'Configure drone vehicle model', description: 'Replaces one drone vehicle model with a validated model definition.', input: configureDroneVehicleModelPayloadSchema, output: commandResultSchema, idempotent: true, schedulable: true, buildCommand: input => ({ targetObjectIds: [configureDroneVehicleModelPayloadSchema.parse(input).droneId], payload: configureDroneVehicleModelPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: swarmCommandKind, title: 'Command drone swarm', description: 'Applies a validated formation or navigation command to an explicit swarm or drone set.', input: swarmCommandPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: swarmCommandPayloadSchema.parse(input).droneIds, payload: swarmCommandPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: attackCommandKind, title: 'Apply drone payload effect', description: 'Invokes one validated drone payload effect against an explicit target object.', input: attackPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [attackPayloadSchema.parse(input).attackerId], payload: attackPayloadSchema.parse(input) }) }),
    defineSimulationCommandCapability({ id: observeTargetCommandKind, title: 'Observe target with drone', description: 'Uses a reconnaissance-capable on-board sensor to observe an explicit in-range target. The target Pack decides which domain facts the observation reveals.', input: observeTargetPayloadSchema, output: commandResultSchema, idempotent: false, schedulable: true, buildCommand: input => ({ targetObjectIds: [observeTargetPayloadSchema.parse(input).droneId], payload: observeTargetPayloadSchema.parse(input) }) }),
    ...droneQueryCapabilities,
  ],
  realtimeInputTypes: [droneManualIntentRealtimeInputType],
  commandEventHistory: {
    [manualControlCommandKind]: 'snapshot-only',
  },
  connect: async (config): Promise<PackRuntimeConnection> => {
    const runtimeConfig = parseDroneNativeRuntimeConfig(config.scenario.runtimeConfig)
    const objects = new Map<string, OperationalObject>()
    const worldObjects = new Map<string, OperationalObject>()
    const homePoints = new Map<string, GeoJsonPoint>()
    const missionPlans = new Map<string, NativeMissionPlan>()
    const geofences = new Map<string, ReadonlyArray<GeoJsonPolygon>>()
    const droneRecords = new Map<string, DroneRuntimeRecord>()
    const rawCheckpoint = await config.runtimeStateStore?.load() ?? null
    if (config.initialObjects && config.runtimeStateStore && rawCheckpoint === null) {
      throw new Error('Drone runtime checkpoint is missing; private mission and geofence state cannot be reconstructed')
    }
    const restoredCheckpoint = rawCheckpoint === null ? null : droneRuntimeCheckpointSchema.parse(rawCheckpoint)

    const setRuntimeDrone = (
      object: OperationalObject,
      data: DronePackData,
    ): DroneRuntimeRecord => {
      const record = { object, data }
      objects.set(object.id, object)
      worldObjects.set(object.id, object)
      droneRecords.set(object.id, record)
      return record
    }

    const upsertRuntimeObject = (
      object: OperationalObject,
    ): DroneRuntimeRecord | null => {
      worldObjects.set(object.id, object)
      const data = parseDroneObject(object)
      if (!data) {
        droneRecords.delete(object.id)
        return null
      }
      return setRuntimeDrone(object, data)
    }

    const deleteRuntimeDrone = (objectId: string): void => {
      objects.delete(objectId)
      worldObjects.delete(objectId)
      droneRecords.delete(objectId)
      homePoints.delete(objectId)
      missionPlans.delete(objectId)
      geofences.delete(objectId)
    }

    const droneRecord = (droneId: string): DroneRuntimeRecord => {
      const record = droneRecords.get(droneId)
      if (!record) throw new Error(`unknown drone object: ${droneId}`)
      return record
    }

    for (const object of config.initialWorldObjects ?? config.scenario.initialObjects) {
      worldObjects.set(object.id, object)
    }
    for (const object of config.initialObjects ?? config.scenario.initialObjects) {
      const record = upsertRuntimeObject(object)
      if (record) homePoints.set(object.id, record.data.pose.point)
    }

    if (restoredCheckpoint) {
      for (const [id, point] of Object.entries(restoredCheckpoint.homePoints)) homePoints.set(id, point)
      for (const [id, mission] of Object.entries(restoredCheckpoint.missionPlans)) missionPlans.set(id, {
        items: mission.items,
        currentIndex: mission.currentIndex,
        ...(mission.planId === undefined ? {} : { planId: mission.planId }),
        ...(mission.holdUntilMs === undefined ? {} : { holdUntilMs: mission.holdUntilMs }),
      })
      for (const [id, polygons] of Object.entries(restoredCheckpoint.geofences)) geofences.set(id, polygons)
    }

    const handlers = new Set<PackRuntimeEventHandler>()
    let closed = false
    let clock: SimulationClockState = {
      currentTime: config.scenario.world.startsAt,
      updatedAt: nowIso(),
      paused: false,
    }
    clock = config.runClock?.read() ?? clock
    const localClock = config.runClock ? null : createSimulationClock(clock)
    const runClock = config.runClock ?? localClock!
    let clockInitialized = false
    const currentSimulationMs = (): number => Date.parse(runClock.read().currentTime)
    const fixedStepScheduler = createDroneFixedStepScheduler({
      stepMs: runtimeConfig.stepIntervalMs,
      maxCatchUpSteps: maxRuntimeCatchUpSteps,
      initialSimulationMs: currentSimulationMs(),
    })
    let lastProjectionMs = 0
    let lastMotionFrameMs = 0
    let motionFrameSequence = restoredCheckpoint?.motionFrameSequence ?? 0

    const checkpoint = async (requireNoManualControl = true): Promise<void> => {
      if (requireNoManualControl && [...droneRecords.values()].some(({ data }) => data.control.manualAxes !== undefined)) {
        throw new Error('Release active drone manual controls before copying the Simulation Run')
      }
      await config.runtimeStateStore?.save(droneRuntimeCheckpointSchema.parse({
        schemaVersion: 1,
        homePoints: Object.fromEntries(homePoints),
        missionPlans: Object.fromEntries(missionPlans),
        geofences: Object.fromEntries(geofences),
        motionFrameSequence,
      }))
    }

    const emit = (
      events: ReadonlyArray<PackRuntimeEvent>,
      realtimeMessages: ReadonlyArray<PackRuntimeRealtimeMessage> = [],
    ): void => {
      if ((events.length === 0 && realtimeMessages.length === 0) || closed) return
      const emission: PackRuntimeEmission = {
        type: 'event.emission',
        runtimeId: droneNativeRuntimeId,
        emittedAt: nowIso(),
        events,
        ...(realtimeMessages.length === 0 ? {} : { realtimeMessages }),
      }
      for (const handler of handlers) handler(emission)
    }

    const liveDroneRecords = (): ReadonlyArray<DroneRuntimeRecord> =>
      [...droneRecords.values()].filter(record => record.data.health.state !== 'destroyed')

    const motionFrameFor = (object: OperationalObject, data: DronePackData): DroneMotionFrame => ({
      objectId: object.id,
      sequence: motionFrameSequence++,
      observedAt: data.pose.observedAt,
      lon: data.pose.point.coordinates[0],
      lat: data.pose.point.coordinates[1],
      altitudeM: data.pose.altitudeM,
      headingDeg: data.pose.headingDeg,
      pitchDeg: data.attitude.pitchDeg,
      rollDeg: data.attitude.rollDeg,
      yawRateDegPerSec: data.attitude.yawRateDegPerSec ?? 0,
      eastMps: data.velocity.eastMps,
      northMps: data.velocity.northMps,
      verticalSpeedMps: data.velocity.verticalSpeedMps,
    })

    const emitMotionFrames = (at: IsoTimestamp, nowMs: number): void => {
      if (nowMs - lastMotionFrameMs < runtimeConfig.motionFrameIntervalMs) return
      lastMotionFrameMs = nowMs
      const frames = liveDroneRecords().map(record => motionFrameFor(record.object, record.data))
      if (frames.length === 0) return
      emit([], [droneMotionFramesRealtimeMessage({ at, frames })])
    }

    const emitObjectUpsert = (
      object: OperationalObject,
      at: IsoTimestamp,
      history: 'record' | 'snapshot-only',
      command?: CommandEnvelope,
    ): void => {
      emit([{
        type: 'object.upserted',
        object,
        at,
        history,
        provenance: {
          source: command ? 'operator' : 'simulator',
          adapterId: droneNativeAdapterId,
          externalId: object.id,
          ...(command === undefined ? {} : { causedByCommandId: command.id }),
        },
      }])
    }

    const updateObject = (
      object: OperationalObject,
      data: DronePackData,
      at: IsoTimestamp,
      history: 'record' | 'snapshot-only',
      command?: CommandEnvelope,
    ): OperationalObject => {
      const next = withDronePackData(object, data, at)
      setRuntimeDrone(next, data)
      emitObjectUpsert(next, at, history, command)
      return next
    }

    const assertTargetAllowed = (droneId: string, target: GeoJsonPoint): void => {
      if (!targetInsideGeofence(target, geofences.get(droneId))) throw new Error(`target is outside loaded geofence for ${droneId}`)
    }

    let backlogMs = 0
    let lastStepAt = nowIso()
    let backlogEpisodes = 0
    let wasBehind = false
    const stepAll = (nowMs = currentSimulationMs(), synchronize = false): void => {
      if (closed || (clock.paused && !synchronize)) return
      const stepPlan = fixedStepScheduler.advance(nowMs)
      backlogMs = stepPlan.accumulatedMs
      const behind = backlogMs >= runtimeConfig.stepIntervalMs * maxRuntimeCatchUpSteps
      if (behind && !wasBehind) backlogEpisodes++
      wasBehind = behind
      lastStepAt = nowIso()
      if (stepPlan.steps.length === 0) return
      for (const step of stepPlan.steps) {
        const at = nowIso()
        for (const { object, data } of liveDroneRecords()) {
          const next = stepDroneObject({
            object,
            data,
            nowMs: step.nowMs,
            dtSeconds: step.dtSeconds,
            at,
            runtimeConfig,
            missionPlans,
            geofences,
          })
          upsertRuntimeObject(next)
        }
      }
      const at = nowIso()
      emitMotionFrames(at, nowMs)
      if (nowMs - lastProjectionMs < runtimeConfig.projectionIntervalMs) return
      lastProjectionMs = nowMs
      const projectedRecords = liveDroneRecords()
      emit(projectedRecords.map(({ object }) => ({
        type: 'object.upserted' as const,
        object,
        at,
        history: 'snapshot-only' as const,
        provenance: {
          source: 'simulator' as const,
          adapterId: droneNativeAdapterId,
          externalId: object.id,
        },
      })))
    }

    const interval = setInterval(() => stepAll(), runtimeConfig.stepIntervalMs)
    stepAll()

    const createGuidedTarget = (
      data: DronePackData,
      target: DroneGuidedTarget,
      at: IsoTimestamp,
    ): DronePackData => ({
      ...setDroneNavigation(data, 'guided', 'guided', at),
      control: {
        ...data.control,
        guidedTarget: target,
        lastCommandAt: at,
      },
    })

    const applyManualIntent = (input: {
      readonly payload: DroneManualIntentPayload
      readonly at: IsoTimestamp
      readonly actorId?: CommandEnvelope['actorId']
      readonly clientId?: CommandEnvelope['clientId']
      readonly command?: CommandEnvelope
      readonly emitProjectedObject: boolean
    }): void => {
      const { payload, at } = input
      const { object, data } = droneRecord(payload.droneId)
      const readiness = droneManualControlReadiness(data)
      if (!readiness.ready) throw new Error(readiness.reason ?? 'manual flight is not ready')
      const expiresAtMs = Date.now() + payload.commandTtlMs
      const next = {
        ...setDroneNavigation(data, 'manual', 'manual', at),
        control: {
          ...data.control,
          ...(input.actorId === undefined ? {} : { pilotActorId: input.actorId }),
          manualAxes: payload.axes,
          inputSource: {
            ...payload.inputSource,
            ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          },
          lastCommandAt: at,
          inputExpiresAt: new Date(expiresAtMs).toISOString() as IsoTimestamp,
        },
      }
      if (input.emitProjectedObject) {
        updateObject(object, next, at, 'snapshot-only', input.command)
        return
      }
      const updated = withDronePackData(object, next, at)
      setRuntimeDrone(updated, next)
    }

    const handleCommand = async (command: CommandEnvelope): Promise<void> => {
      if (command.kind === createDroneCommandKind) {
        const payload = createDronePayloadSchema.parse(command.payload)
        if (droneRecords.size >= runtimeConfig.maxDrones) {
          throw new Error(`native drone runtime is limited to ${runtimeConfig.maxDrones} drones`)
        }
        const model = requireDroneVehicleModel(payload.modelId, runtimeConfig.models)
        const createdAt = nowIso()
        const object = createScenarioDroneObject({
          id: slugObjectId('drone', payload.label),
          label: payload.label,
          model,
          point: payload.point,
          altitudeM: payload.altitudeM,
          headingDeg: payload.headingDeg,
          at: createdAt,
        })
        const record = upsertRuntimeObject(object)
        if (!record) throw new Error(`created object is not a valid native drone: ${object.id}`)
        homePoints.set(object.id, payload.point)
        emitObjectUpsert(object, createdAt, 'record', command)
        return
      }

      if (command.kind === armDroneCommandKind) {
        const payload = armDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const at = nowIso()
        const next = {
          ...data,
          arming: {
            state: payload.armed ? 'armed' as const : 'disarmed' as const,
            armed: payload.armed,
            updatedAt: at,
          },
          navigation: payload.armed
            ? data.navigation
            : { kind: 'hold' as const, mode: 'disarmed', updatedAt: at },
          velocity: payload.armed
            ? data.velocity
            : { eastMps: 0, northMps: 0, downMps: 0, groundSpeedMps: 0, verticalSpeedMps: 0 },
        }
        updateObject(object, next, at, 'record', command)
        return
      }

      if (command.kind === manualControlCommandKind) {
        const payload = manualControlPayloadSchema.parse(command.payload)
        applyManualIntent({
          payload,
          at: nowIso(),
          actorId: command.actorId,
          ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
          command,
          emitProjectedObject: true,
        })
        return
      }

      if (command.kind === navigateDroneCommandKind) {
        const payload = navigateDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        assertTargetAllowed(payload.droneId, payload.target.point)
        if (!data.arming.armed) throw new Error('goto requires an armed drone')
        const at = nowIso()
        updateObject(object, createGuidedTarget(data, payload.target, at), at, 'record', command)
        return
      }

      if (command.kind === takeoffDroneCommandKind) {
        const payload = takeoffDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        if (!data.arming.armed) throw new Error('takeoff requires an armed drone')
        const at = nowIso()
        updateObject(object, {
          ...setDroneNavigation(data, 'takeoff', 'takeoff', at),
          control: {
            ...data.control,
            guidedTarget: {
              point: data.pose.point,
              altitudeM: Math.max(payload.altitudeM, data.pose.altitudeM),
              speedMps: Math.min(data.vehicle.flightEnvelope.cruiseSpeedMps, data.vehicle.flightEnvelope.maxHorizontalSpeedMps),
            },
            lastCommandAt: at,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === landDroneCommandKind || command.kind === returnToLaunchDroneCommandKind || command.kind === holdDroneCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const at = nowIso()
        if (command.kind === holdDroneCommandKind) {
          missionPlans.delete(payload.droneId)
          updateObject(object, {
            ...setDroneNavigation(data, 'hold', 'hold', at),
            control: { ...data.control, guidedTarget: undefined, manualAxes: undefined, inputExpiresAt: at },
            velocity: { eastMps: 0, northMps: 0, downMps: 0, groundSpeedMps: 0, verticalSpeedMps: 0 },
          }, at, 'record', command)
          return
        }
        const targetPoint = command.kind === returnToLaunchDroneCommandKind
          ? homePoints.get(payload.droneId) ?? data.pose.point
          : data.pose.point
        assertTargetAllowed(payload.droneId, targetPoint)
        updateObject(object, {
          ...setDroneNavigation(data, command.kind === landDroneCommandKind ? 'land' : 'return_to_launch', command.kind === landDroneCommandKind ? 'land' : 'return to launch', at),
          control: {
            ...data.control,
            guidedTarget: nativeGuidedTarget({
              point: targetPoint,
              altitudeM: command.kind === landDroneCommandKind ? 0 : Math.max(data.pose.altitudeM, 15),
              speedMps: data.vehicle.flightEnvelope.cruiseSpeedMps,
            }),
            lastCommandAt: at,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === uploadDroneMissionCommandKind) {
        const payload = uploadDroneMissionPayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        for (const item of payload.items) assertTargetAllowed(payload.droneId, item.point)
        missionPlans.set(payload.droneId, { planId: payload.planId, items: payload.items, currentIndex: 0 })
        const at = nowIso()
        updateObject(object, {
          ...data,
          mission: {
            state: 'ready',
            total: payload.items.length,
            currentSeq: payload.items[0]?.seq,
            planId: payload.planId,
            updatedAt: at,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === startDroneMissionCommandKind || command.kind === pauseDroneMissionCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const mission = missionPlans.get(payload.droneId)
        if (!mission) throw new Error(`no mission loaded for ${payload.droneId}`)
        const at = nowIso()
        if (command.kind === pauseDroneMissionCommandKind) {
          updateObject(object, {
            ...setDroneNavigation(data, 'hold', 'mission paused', at),
            mission: { ...data.mission, state: 'paused', updatedAt: at },
          }, at, 'record', command)
          return
        }
        const item = mission.items[mission.currentIndex]
        if (!item) throw new Error(`mission has no waypoint for ${payload.droneId}`)
        updateObject(object, {
          ...setDroneNavigation(data, 'mission', 'mission', at),
          control: { ...data.control, guidedTarget: missionTarget(item), lastCommandAt: at },
          mission: {
            state: 'running',
            currentSeq: item.seq,
            total: mission.items.length,
            planId: mission.planId,
            updatedAt: at,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === clearDroneMissionCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        missionPlans.delete(payload.droneId)
        const at = nowIso()
        updateObject(object, {
          ...setDroneNavigation(data, 'hold', 'hold', at),
          mission: { state: 'idle', updatedAt: at },
          control: { ...data.control, guidedTarget: undefined },
        }, at, 'record', command)
        return
      }

      if (command.kind === uploadDroneGeofenceCommandKind) {
        const payload = uploadDroneGeofencePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        geofences.set(payload.droneId, payload.polygons)
        const at = nowIso()
        updateObject(object, {
          ...data,
          geofence: {
            loaded: true,
            breachStatus: targetInsideGeofence(data.pose.point, payload.polygons) ? 'clear' : 'breached',
            updatedAt: at,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === clearDroneGeofenceCommandKind) {
        const payload = singleDronePayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        geofences.delete(payload.droneId)
        const at = nowIso()
        updateObject(object, {
          ...data,
          geofence: { loaded: false, breachStatus: 'clear', updatedAt: at },
        }, at, 'record', command)
        return
      }

      if (command.kind === setDroneGimbalCommandKind) {
        const payload = setDroneGimbalPayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const at = nowIso()
        updateObject(object, {
          ...data,
          payload: {
            ...data.payload,
            gimbalPitchDeg: payload.pitchDeg,
            gimbalYawDeg: payload.yawDeg,
          },
        }, at, 'record', command)
        return
      }

      if (command.kind === setDroneSwarmCommandKind) {
        const payload = setDroneSwarmPayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const { swarm: _swarm, ...base } = data
        updateObject(object, payload.swarm === null ? base : { ...base, swarm: payload.swarm }, nowIso(), 'record', command)
        return
      }
      if (command.kind === configureDroneVehicleModelCommandKind) {
        const payload = configureDroneVehicleModelPayloadSchema.parse(command.payload)
        const { object, data } = droneRecord(payload.droneId)
        const model: DroneVehicleModel = payload.model
        const at = nowIso()
        updateObject(object, {
          ...data,
          vehicle: {
            ...data.vehicle,
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
        }, at, 'record', command)
        return
      }

      if (command.kind === swarmCommandKind) {
        const payload = swarmCommandPayloadSchema.parse(command.payload)
        const targets = [...droneRecords.values()].filter(({ object, data }) =>
          payload.droneIds.includes(object.id) || (payload.swarmId !== undefined && data.swarm?.swarmId === payload.swarmId))
        const at = nowIso()
        targets.forEach(({ object, data }, index) => {
          if (payload.command.kind === 'hold') {
            updateObject(object, setDroneNavigation(data, 'hold', 'hold', at), at, 'record', command)
            return
          }
          if (payload.command.kind === 'land') {
            updateObject(object, {
              ...setDroneNavigation(data, 'land', 'land', at),
              control: {
                ...data.control,
                guidedTarget: nativeGuidedTarget({ point: data.pose.point, altitudeM: 0, speedMps: data.vehicle.flightEnvelope.cruiseSpeedMps }),
                lastCommandAt: at,
              },
            }, at, 'record', command)
            return
          }
          if (payload.command.kind === 'navigate') {
            const spacing = payload.command.formation.spacingM
            const column = index % Math.max(1, Math.ceil(Math.sqrt(targets.length)))
            const row = Math.floor(index / Math.max(1, Math.ceil(Math.sqrt(targets.length))))
            const targetPoint = movePointByMeters(payload.command.target.point, { eastM: column * spacing, northM: row * spacing })
            assertTargetAllowed(object.id, targetPoint)
            updateObject(object, createGuidedTarget(data, nativeGuidedTarget({
              ...payload.command.target,
              point: targetPoint,
              altitudeM: payload.command.target.altitudeM + row * payload.command.formation.altitudeStepM,
              }), at), at, 'record', command)
            return
          }
          if (payload.command.kind === 'search_area') {
            const angle = targets.length <= 1 ? 0 : index / targets.length * Math.PI * 2
            const targetPoint = movePointByMeters(payload.command.center, {
              eastM: Math.sin(angle) * payload.command.radiusM * 0.7,
              northM: Math.cos(angle) * payload.command.radiusM * 0.7,
            })
            assertTargetAllowed(object.id, targetPoint)
            updateObject(object, createGuidedTarget(data, nativeGuidedTarget({
              point: targetPoint,
              altitudeM: payload.command.altitudeM + index * payload.command.formation.altitudeStepM,
              speedMps: data.vehicle.flightEnvelope.cruiseSpeedMps,
            }), at), at, 'record', command)
            return
          }
          if (payload.command.kind === 'disperse') {
            const angle = targets.length <= 1 ? 0 : index / targets.length * Math.PI * 2
            const targetPoint = movePointByMeters(data.pose.point, {
              eastM: Math.sin(angle) * payload.command.radiusM,
              northM: Math.cos(angle) * payload.command.radiusM,
            })
            assertTargetAllowed(object.id, targetPoint)
            updateObject(object, createGuidedTarget(data, nativeGuidedTarget({
              point: targetPoint,
              altitudeM: data.pose.altitudeM,
              speedMps: data.vehicle.flightEnvelope.cruiseSpeedMps,
            }), at), at, 'record', command)
          }
        })
        return
      }

      if (command.kind === attackCommandKind) {
        const payload = attackPayloadSchema.parse(command.payload)
        const at = nowIso()
        emit([{
          type: 'interaction.signal',
          signal: droneAttackSignal({
            simulationRunId: command.simulationRunId,
            at,
            attackerId: payload.attackerId,
            targetId: payload.targetId,
            ...(payload.payloadId === undefined ? {} : { payloadId: payload.payloadId }),
            causationId: command.id,
          }),
          at,
          provenance: { source: 'operator', adapterId: droneNativeAdapterId, causedByCommandId: command.id },
        }])
        return
      }

      if (command.kind === observeTargetCommandKind) {
        const payload = observeTargetPayloadSchema.parse(command.payload)
        const { object: observer, data } = droneRecord(payload.droneId)
        if (!droneHasCapability(data.vehicle, 'reconnaissance')) throw new Error(`${observer.label} has no reconnaissance capability`)
        const target = worldObjects.get(payload.targetId)
        if (!target) throw new Error(`unknown observation target: ${payload.targetId}`)
        const targetPoint = target.spatial.position?.point ?? (target.spatial.geometry?.type === 'Point' ? target.spatial.geometry : undefined)
        if (!targetPoint) throw new Error(`${target.label} has no point position`)
        const sensor = payload.sensorId === undefined
          ? data.vehicle.sensors.find(candidate => candidate.tags.includes('incident') || candidate.tags.includes('reconnaissance')) ?? data.vehicle.sensors[0]
          : data.vehicle.sensors.find(candidate => candidate.id === payload.sensorId)
        if (!sensor) throw new Error(payload.sensorId ? `unknown sensor ${payload.sensorId} on ${observer.label}` : `${observer.label} has no sensor`)
        const distanceM = horizontalDistanceM(data.pose.point, targetPoint)
        if (distanceM > sensor.rangeM) throw new Error(`${target.label} is ${Math.round(distanceM)} m away; ${sensor.label} range is ${Math.round(sensor.rangeM)} m`)
        const at = nowIso()
        emit([{
          type: 'interaction.signal',
          signal: droneObservationSignal({ simulationRunId: command.simulationRunId, at, observedAtMs: currentSimulationMs(), observerId: observer.id, targetId: target.id, sensorId: sensor.id, causationId: command.id }),
          at,
          provenance: { source: 'operator', adapterId: droneNativeAdapterId, causedByCommandId: command.id },
        }])
        return
      }

      throw new Error(`unsupported drone command kind: ${command.kind}`)
    }

    return {
      getSnapshot: async (): Promise<PackRuntimeSnapshot> => ({
        simulationRunId: config.simulationRunId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        const at = nowIso()
        try {
          await handleCommand(command)
          return commandAccepted(command, at)
        } catch (err) {
          return commandRejected(command, nowIso(), err instanceof Error ? err.message : String(err))
        }
      },
      receiveRealtimeInput: async (input): Promise<void> => {
        if (input.type !== droneManualIntentRealtimeInputType) throw new Error(`unsupported drone realtime input type: ${input.type}`)
        applyManualIntent({
          payload: droneManualIntentPayloadSchema.parse(input.payload),
          at: input.at,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          emitProjectedObject: false,
        })
      },
      invokeQuery: async (request: PackRuntimeQuery): Promise<unknown> =>
        answerDroneQuery({ request, objects: [...worldObjects.values()], models: runtimeConfig.models }),
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        for (const event of events) {
          if (event.simulationRunId !== config.simulationRunId) continue
          if (event.type === 'object.upserted') {
            const record = upsertRuntimeObject(event.object)
            if (record && !homePoints.has(event.object.id)) homePoints.set(event.object.id, record.data.pose.point)
          }
          if (event.type === 'object.deleted') {
            deleteRuntimeDrone(event.objectId)
          }
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        const targetMs = Date.parse(nextClock.currentTime)
        if (clockInitialized) {
          stepAll(targetMs, true)
          while (backlogMs >= runtimeConfig.stepIntervalMs) {
            await new Promise(resolve => setTimeout(resolve, 0))
            stepAll(targetMs, true)
          }
        } else fixedStepScheduler.reset(targetMs)
        clockInitialized = true
        clock = nextClock
        localClock?.set(nextClock)
        const simulationMs = currentSimulationMs()
        lastProjectionMs = simulationMs
        lastMotionFrameMs = simulationMs
      },
      advanceTo: async (nextClock: SimulationClockState): Promise<void> => {
        const targetMs = Date.parse(nextClock.currentTime)
        stepAll(targetMs, true)
        while (backlogMs >= runtimeConfig.stepIntervalMs) {
          await new Promise(resolve => setTimeout(resolve, 0))
          stepAll(targetMs, true)
        }
        clock = nextClock
        localClock?.set(nextClock)
      },
      checkpoint,
      health: () => [{ runtimeId: droneNativeRuntimeId, state: wasBehind ? 'degraded' : 'ready', failureCount: backlogEpisodes, lastSuccessfulInteractionAt: lastStepAt, ...(wasBehind ? { lastFailure: { at: lastStepAt, operation: 'simulation-backlog', message: `Drone solver is ${Math.round(backlogMs)} simulation milliseconds behind the Run clock; elapsed time is retained, not skipped.` } } : {}) }],
      close: async (): Promise<void> => {
        closed = true
        clearInterval(interval)
        await checkpoint(false)
        handlers.clear()
      },
    }
  },
})
