import { z } from 'zod'
import type { CommandEnvelope, CommandResult, IsoTimestamp, OperationalObject, PackRuntimeRecordingBatch, RouteImpact } from '../../../core/model/index.ts'
import { commandResultSchema, nowIso } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../../simulation/capabilities.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEvent, PackRuntimeEventHandler, PackRuntimeHealth } from '../../../simulation/protocol.ts'
import { ambulanceCommandSchemas } from '../commands.ts'
import { ambulancePackId, responseUnitPackDataSchema } from '../model.ts'
import { ambulanceQueryCapabilities, answerAmbulanceQuery } from '../query.ts'
import { createAmbulanceRecordingPlan } from '../recording.ts'
import { ambulancePackConfigSchema, roadWeatherCapability, roadWeatherImpact, roadWeatherPolicySchema, roadWeatherSamplesSchema, setRoadWeatherPolicyCapability, type RoadWeatherPolicy } from '../road-weather.ts'
import { ambulanceSimRuntimeId } from './constants.ts'
import { createAmbulanceSimEngine } from './engine.ts'
import { validateAmbulanceObject, validateAmbulanceDeletion } from './object-state.ts'

const commandDescriptions: Record<keyof typeof ambulanceCommandSchemas, { title: string; description: string; idempotent: boolean }> = {
  'world.ambulance.create-item': { title: 'Create response item', description: 'Create an ambulance, incident, patient or care site using the same schema and constructor as Scenario authoring. A point may reference an existing asset; the incident/site retains its own fixed location.', idempotent: false },
  'world.ambulance.assign': { title: 'Assign response unit', description: 'Create an ordered response plan beginning with one incident pickup and explicit patients. The unit starts immediately; eligibility is rechecked after road-route preparation.', idempotent: false },
  'world.ambulance.append-stop': { title: 'Append response stop', description: 'Append an incident pickup or compatible care-site handover to an active unit plan. Routes are prepared from the current plan tail, patient custody and capacity are validated, and concurrent plan changes are rejected.', idempotent: false },
  'world.ambulance.cancel': { title: 'Cancel response', description: 'Cancel a response or return journey when safe. Does not discard carried patients or falsely release an occupied unit.', idempotent: true },
  'world.ambulance.return-to-base': { title: 'Return unit to base', description: 'Prepare the road route to the unit’s authored base. An empty returning unit may be redispatched from its current position.', idempotent: false },
  'world.ambulance.set-unit-readiness': { title: 'Set crew readiness', description: 'Set whether this unit has a ready crew. Does not cancel an existing assignment.', idempotent: true },
  'world.ambulance.set-care-site': { title: 'Configure receiving site', description: 'Change acceptance, supported care needs, urgency, handover slots or duration. Does not invent clinical bed capacity or discard patients already waiting.', idempotent: true },
  'world.ambulance.set-patient-assessment': { title: 'Update patient assessment', description: 'Record assessed urgency and required care tags independently of the incident dispatch priority. This operational model does not infer vital signs, diagnoses or treatment efficacy.', idempotent: true },
  'world.ambulance.set-patient-disposition': { title: 'Record no-transport decision', description: 'Explicitly close an eligible patient’s transport need with a recorded reason. Does not silently remove a patient from an ambulance.', idempotent: true },
}
const commandCapabilities = Object.entries(ambulanceCommandSchemas).map(([key, input]) => {
  const id = key as keyof typeof ambulanceCommandSchemas
  return defineSimulationCommandCapability({
    id, ...commandDescriptions[id], input, output: commandResultSchema, schedulable: true,
    buildCommand: raw => {
      const payload = input.parse(raw)
      const targetId = 'unitId' in payload ? payload.unitId : 'careSiteId' in payload ? payload.careSiteId : 'patientId' in payload ? payload.patientId : undefined
      return { targetObjectIds: targetId ? [targetId] : [], payload }
    },
  })
})
const emit = (handlers: ReadonlySet<PackRuntimeEventHandler>, events: readonly PackRuntimeEvent[], recording?: PackRuntimeRecordingBatch): void => {
  if (!events.length && recording === undefined) return
  for (const handler of handlers) handler({
    type: 'event.emission', events, ...(recording === undefined ? {} : { recording }),
    emittedAt: events[0]?.at ?? nowIso(), runtimeId: ambulanceSimRuntimeId,
  })
}
const initialObjectsFor = (config: PackRuntimeConnectionConfig): readonly OperationalObject[] =>
  (config.initialObjects ?? config.scenario.initialObjects).filter(object => object.packId === ambulancePackId).map(validateAmbulanceObject)
const sameRoadWeatherTarget = (object: OperationalObject, current: OperationalObject | undefined): boolean =>
  current !== undefined && object.spatial.route?.planned === current.spatial.route?.planned &&
  object.spatial.position?.point.coordinates[0] === current.spatial.position?.point.coordinates[0] &&
  object.spatial.position?.point.coordinates[1] === current.spatial.position?.point.coordinates[1]
// Canonical objects carry complete response plans and road geometry. Publishing
// them faster than this adds browser and network work without a material visual
// benefit at the map scale used for response coordination.
export const ambulanceProjectionIntervalMs = 1_000

export const createLocalAmbulancePackRuntimeAdapter = (adapterConfig: { readonly routing: Pick<RoutingAdapter, 'id' | 'route'> }): PackRuntimeAdapter => ({
  id: ambulanceSimRuntimeId, version: '1.0.0', packId: ambulancePackId, clock: 'simulation',
  capabilities: [
    ...commandCapabilities,
    defineSimulationCommandCapability({
      id: setRoadWeatherPolicyCapability, title: 'Set road-weather policy',
      description: 'Configure the local mobility response to ground wetness, ice, snow and visibility. Requires an active Weather provider when enabled. Does not re-route vehicles.',
      input: roadWeatherPolicySchema, output: commandResultSchema, idempotent: true, schedulable: true,
      buildCommand: input => ({ targetObjectIds: [], payload: roadWeatherPolicySchema.parse(input) }),
    }),
    defineSimulationQueryCapability({
      id: 'world.ambulance.road-weather-policy', title: 'Inspect road-weather policy',
      description: 'Current heuristic speed factors, applied at each moving vehicle’s position. Not a clinical, tire-friction or whole-route forecast model.',
      input: z.object({}).strict(), output: roadWeatherPolicySchema,
    }),
    ...ambulanceQueryCapabilities,
  ],
  requiredQueries: runtimeConfig => ambulancePackConfigSchema.parse(runtimeConfig).roadWeather.enabled ? [roadWeatherCapability] : [],
  connect: async (config): Promise<PackRuntimeConnection> => {
    const settings = ambulancePackConfigSchema.parse(config.scenario.runtimeConfig)
    const saved = await config.runtimeStateStore?.load()
    let policy = saved == null ? settings.roadWeather : roadWeatherPolicySchema.parse(saved)
    const assertProvider = (enabled: boolean): void => {
      if (enabled && !config.queries?.has(roadWeatherCapability)) throw new Error('Ambulance road-weather policy requires an active Weather sample-points provider')
    }
    assertProvider(policy.enabled)
    const localClock = config.runClock ? null : createSimulationClock({ currentTime: config.scenario.world.startsAt, updatedAt: nowIso(), paused: false })
    const runClock = config.runClock ?? localClock!
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId, objects: initialObjectsFor(config), routing: adapterConfig.routing,
      simulationTimeMs: Date.parse(runClock.read().currentTime),
      ...(config.objectById ? { objectById: config.objectById } : {}),
    })
    const handlers = new Set<PackRuntimeEventHandler>()
    const recordingPlan = config.recording === undefined ? null : createAmbulanceRecordingPlan(config.recording)
    const startsAtMs = Date.parse(config.scenario.world.startsAt)
    let nextRecordingMs = recordingPlan ? engine.checkpoint().simulationTimeMs + recordingPlan.intervalMs : Infinity
    let closed = false
    let queue: Promise<unknown> = Promise.resolve()
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const next = queue.then(work)
      // Each caller observes its own rejection; a rejected command must not poison later commands.
      queue = next.then(() => undefined, () => undefined)
      return next
    }
    let health: PackRuntimeHealth = { runtimeId: ambulanceSimRuntimeId, state: 'ready', failureCount: 0, lastSuccessfulInteractionAt: nowIso() }
    let weatherReadGeneration = 0
    const unavailable = (): boolean => closed || health.state === 'failed'
    const fail = (operation: string, error: unknown): void => {
      if (closed || health.state === 'failed') return
      health = { ...health, state: 'failed', failureCount: health.failureCount + 1,
        lastFailure: { at: nowIso(), operation, message: error instanceof Error ? error.message : String(error) } }
    }
    const roadWeatherVehicles = () => engine.snapshot().objects.filter(object => {
      const unit = responseUnitPackDataSchema.safeParse(object.packData)
      return unit.success && unit.data.mobility.kind === 'road' && object.spatial.route?.planned && object.spatial.position?.point
    })
    const prepareRoadWeather = async (candidate: RoadWeatherPolicy) => {
      const generation = ++weatherReadGeneration
      const vehicles = roadWeatherVehicles()
      const effects: Array<{ object: OperationalObject; impact: RouteImpact | undefined }> = []
      for (let offset = 0; offset < vehicles.length; offset += 512) {
        if (unavailable()) break
        const batch = vehicles.slice(offset, offset + 512)
        const samples = candidate.enabled ? roadWeatherSamplesSchema.parse(await config.queries!.invoke({
          capabilityId: roadWeatherCapability, input: { points: batch.map(object => object.spatial.position!.point) },
        })) : []
        if (candidate.enabled && samples.length !== batch.length) throw new Error('Weather sample count does not match requested vehicles')
        batch.forEach((object, index) => {
          const sampled = samples[index]
          if (sampled && JSON.stringify(sampled.point) !== JSON.stringify(object.spatial.position!.point)) throw new Error('Weather sample position mismatch')
          effects.push({ object, impact: sampled ? roadWeatherImpact(candidate, sampled.sample) : undefined })
        })
      }
      return { policy: candidate, generation, effects }
    }
    const applyRoadWeather = (prepared: Awaited<ReturnType<typeof prepareRoadWeather>>): PackRuntimeEvent[] => {
      if (unavailable() || prepared.policy !== policy || prepared.generation !== weatherReadGeneration) return []
      const current = new Map(engine.snapshot().objects.map(object => [object.id, object]))
      const events: PackRuntimeEvent[] = []
      for (const { object, impact } of prepared.effects) {
        const latest = current.get(object.id)
        // Async provider reads must not attach an old sample to a replaced
        // route or a vehicle that has moved. Unrelated object revisions are OK.
        if (!sameRoadWeatherTarget(object, latest)) continue
        const event = engine.setRoadWeatherImpact(object.id, impact)
        if (event) events.push(event)
      }
      return events
    }
    const refreshRoadWeather = async (): Promise<PackRuntimeEvent[]> => applyRoadWeather(await prepareRoadWeather(policy))
    const advance = async (targetMs = Date.parse(runClock.read().currentTime)): Promise<void> => {
      if (unavailable()) return
      if (targetMs <= engine.checkpoint().simulationTimeMs) return
      try {
        const roadEvents = await refreshRoadWeather()
        if (unavailable()) return
        emit(handlers, roadEvents)
        const events = engine.advanceTo(targetMs)
        const simulationMs = engine.checkpoint().simulationTimeMs
        const recording = recordingPlan && simulationMs >= nextRecordingMs ? recordingPlan.sample({
          objects: engine.snapshot().objects, observedAt: nowIso(),
          simulationTime: new Date(simulationMs).toISOString() as IsoTimestamp, elapsedMs: simulationMs - startsAtMs,
        }) : undefined
        if (recording) nextRecordingMs = simulationMs + recordingPlan!.intervalMs
        emit(handlers, events, recording)
        health = { ...health, lastSuccessfulInteractionAt: nowIso() }
      } catch (error) { fail('advance', error); throw error }
    }
    let tickPending = false
    const interval = setInterval(() => {
      if (closed || tickPending || health.state === 'failed') return
      tickPending = true
      void serialize(advance).catch(error => { fail('advance', error) }).finally(() => { tickPending = false })
    }, ambulanceProjectionIntervalMs)
    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const rejected = (error: unknown): CommandResult => ({ ok: false, commandId: command.id, rejectedAt: nowIso(), reason: error instanceof Error ? error.message : String(error) })
      if (unavailable()) return rejected('Ambulance runtime is unavailable; inspect runtime health')
      try { await advance() } catch (error) { return rejected(error) }
      if (unavailable()) return rejected('Ambulance runtime is unavailable; inspect runtime health')
      if (command.kind === setRoadWeatherPolicyCapability) {
        let prepared: Awaited<ReturnType<typeof prepareRoadWeather>>
        try {
          const candidate = roadWeatherPolicySchema.parse(command.payload)
          assertProvider(candidate.enabled)
          prepared = await prepareRoadWeather(candidate)
          if (unavailable()) return rejected('Ambulance runtime is unavailable; inspect runtime health')
          await config.runtimeStateStore?.save(candidate)
          policy = candidate
        } catch (error) { return rejected(error) }
        try {
          const current = new Map(roadWeatherVehicles().map(object => [object.id, object]))
          const invalidated = prepared.generation !== weatherReadGeneration || current.size !== prepared.effects.length ||
            prepared.effects.some(({ object }) => !sameRoadWeatherTarget(object, current.get(object.id)))
          // Persistence can overlap a peer commit. Reconcile the accepted policy
          // once against current state; never retry indefinitely or reject it now.
          emit(handlers, invalidated ? await refreshRoadWeather() : applyRoadWeather(prepared))
        } catch (error) { fail('apply-road-weather-policy', error) }
        return { ok: true, commandId: command.id, acceptedAt: nowIso() }
      }
      const outcome = await engine.handleCommand(command)
      emit(handlers, outcome.events)
      if (outcome.result.ok) {
        try { emit(handlers, await refreshRoadWeather()) }
        catch (error) { fail('post-command-road-weather', error) }
      }
      return outcome.result
    }
    return {
      getSnapshot: async () => engine.snapshot(),
      subscribe: handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
      invokeQuery: async request => request.capabilityId === 'world.ambulance.road-weather-policy'
        ? structuredClone(policy)
        : answerAmbulanceQuery({ request, objects: engine.snapshot().objects, at: nowIso(), simulationTimeMs: engine.checkpoint().simulationTimeMs }),
      validateObjectDeletion: validateAmbulanceDeletion,
      observeCommittedEvents: async events => { engine.observeCommittedEvents(events) },
      afterCommittedEvents: async events => {
        // Road-weather is an explicit optional dependency. Changes must also
        // appear while paused, without resampling on unrelated Pack telemetry.
        if (unavailable()) return
        if (events.some(event => event.type === 'object.deleted' || (event.type === 'object.upserted' && event.object.packId === 'weather'))) {
          try { emit(handlers, await refreshRoadWeather()) }
          catch (error) { fail('after-committed-events', error); throw error }
        }
      },
      setClock: nextClock => serialize(async () => {
        // Drain the old reading before accepting a new speed/pause state.
        await advance()
        localClock?.set(nextClock)
      }),
      advanceTo: nextClock => serialize(async () => {
        await advance(Date.parse(nextClock.currentTime))
        localClock?.set(nextClock)
      }),
      checkpoint: async () => { await config.runtimeStateStore?.save(policy) },
      health: () => [health],
      sendCommand: command => serialize(() => sendCommand(command)),
      close: async () => {
        closed = true
        clearInterval(interval)
        await queue
        handlers.clear()
        await config.runtimeStateStore?.save(policy)
      },
    }
  },
})
