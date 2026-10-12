import { describe,expect,test } from 'bun:test'
import { worldPacks } from '../src/app-assembly.ts'
import {
  commandEnvelopeSchema,
  nowIso,
  operationalObjectSchema,
  simulationRunEventSchema,
  type CommandEnvelope,
  type SimulationRunEvent,
  type SimulationRunId,
  type ObjectId,
  type IsoTimestamp,
} from '../src/core/model/index.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { roadWeatherImpact,roadWeatherPolicySchema } from '../src/packs/ambulance/road-weather.ts'
import { responseUnitPackDataSchema, patientPackDataSchema } from '../src/packs/ambulance/model.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { weatherItemSchema,weatherPackDataSchema } from '../src/packs/weather/model.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import type { PackRuntimeConnectionConfig, PackRuntimeQuery } from '../src/simulation/protocol.ts'

const routing = createDirectRoutingAdapter()
const source = scenarioDefinitionSchema.parse({
  id: 'test-weather-response', title: 'Weather and Ambulance integration fixture',
  world: { startsAt: '2026-01-01T10:00:00.000Z' },
  view: { map: { center: [11.41, 59.13], zoom: 12 } },
  packs: [{
    id: 'weather', config: { gridResolution: 8, surface: { groundTemperatureC: -2, wetness: .4, standingWater: 0, snow: 0, ice: 0, frost: 0 } },
    items: [{ type: 'weather_area', id: 'weather:halden-front', label: 'Visibility fixture', center: [11.41, 59.13], semiMajorAxisM: 6500, semiMinorAxisM: 4200, falloff: 'uniform', atmosphere: { visibilityM: 700 } }],
  }, {
    id: 'ambulance', config: { roadWeather: { enabled: true } }, items: [
      { type: 'care-site', id: 'care-site:receiving', label: 'Receiving site', position: [11.44, 59.14], capabilities: ['clinical-care'], acceptedUrgencies: ['acute', 'urgent', 'ordinary'], handoverSlots: 1, handoverSeconds: 60, accepting: true },
      { type: 'ambulance', id: 'amb:response', label: 'Response unit', position: [11.41, 59.13], patientCapacity: 1, capabilities: ['clinical-care'], crewReady: true, mobilizationSeconds: 0, sceneSeconds: 30 },
      { type: 'incident', id: 'incident:response', label: 'Response case', position: [11.43, 59.14], summary: 'Synthetic fixture', dispatchUrgency: 'urgent' },
      { type: 'patient', id: 'patient:response', label: 'Patient', incidentId: 'incident:response', summary: 'Synthetic fixture', assessedUrgency: 'urgent', needs: ['clinical-care'] },
    ],
  }],
})
const compiled = await compileScenarioDefinition(source, worldPacks, { routing })
const config = {
  simulationRunId: 'run-weather-integration' as SimulationRunId,
  scenario: {
    scenarioId: compiled.id,
    runtimeIds: ['weather.local', 'ambulance.local'],
    connections: [],
    world: compiled.world,
    initialObjects: compiled.initialObjects,
    runtimeConfigByRuntimeId: {
      'weather.local': source.packs.find((p) => p.id === 'weather')!.config,
      'ambulance.local': source.packs.find((p) => p.id === 'ambulance')!.config,
    },
    runtimeConfig: {},
  },
}
const command = (kind: string, payload: unknown): CommandEnvelope =>
  commandEnvelopeSchema.parse({
    id: 'command:' + crypto.randomUUID(),
    actorId: 'actor:test',
    simulationRunId: config.simulationRunId,
    issuedAt: nowIso(),
    targetObjectIds: [],
    kind,
    payload,
  }) as CommandEnvelope
const dispatchCommand = () => command('world.ambulance.assign', { unitId: 'amb:response', incidentId: 'incident:response', patientIds: ['patient:response'] })
const providerSamples = (request: PackRuntimeQuery, visibilityM = 700) => (request.input as { points: unknown[] }).points.map(point => ({
  point, sample: { state: { atmosphere: { visibilityM }, surface: { wetness: 0, ice: 0, snow: 0 } }, quality: { validAt: compiled.world.startsAt } },
}))
const isolatedConnection = (invoke: (query: PackRuntimeQuery) => Promise<unknown>, enabled = true, extra: Partial<PackRuntimeConnectionConfig> = {}) => createLocalAmbulancePackRuntimeAdapter({ routing }).connect({
  ...config, scenario: { ...config.scenario, runtimeConfig: { roadWeather: { enabled } } },
  runClock: { read: () => ({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true }) },
  queries: { has: () => true, invoke }, ...extra,
})
const weatherCommit = () => simulationRunEventSchema.parse({
  id: 'event:weather-change', seq: 1, simulationRunId: config.simulationRunId, type: 'object.upserted',
  object: compiled.initialObjects.find(object => object.id === 'weather:halden-front')!, at: nowIso(), provenance: { source: 'simulator' },
}) as SimulationRunEvent

describe('Weather ↔ Ambulance integration', () => {
  test('actual engine movement respects wet/ice/visibility policy, including a complete stop', async () => {
    const vehicle = compiled.initialObjects.find((o) => o.kind === 'mobile_entity')!
    const sample = {
      state: { atmosphere: { visibilityM: 100 }, surface: { wetness: 0, ice: 0, snow: 0 } },
      quality: { validAt: compiled.world.startsAt },
    }
    const policy = roadWeatherPolicySchema.parse({ enabled: true, lowVisibilityFactor: 0 })
    const engine = createAmbulanceSimEngine({
      simulationRunId: config.simulationRunId,
      routing,
      objects: compiled.initialObjects.filter((o) => o.packId === 'ambulance'),
      simulationTimeMs: Date.parse(compiled.world.startsAt),
    })
    expect((await engine.handleCommand(dispatchCommand())).result.ok).toBe(true)
    engine.setRoadWeatherImpact(vehicle.id, roadWeatherImpact(policy, sample))
    engine.advanceTo(Date.parse(compiled.world.startsAt) + 1000)
    const stopped = engine.snapshot().objects.find((o) => o.id === vehicle.id)!
    expect(stopped.spatial.position?.point).toEqual(vehicle.spatial.position?.point)
    expect(stopped.spatial.position?.speedMps).toBe(0)
    expect(stopped.spatial.route?.etaSeconds).toBeUndefined()
    operationalObjectSchema.parse(stopped)
    engine.setRoadWeatherImpact(vehicle.id, undefined)
    engine.advanceTo(Date.parse(compiled.world.startsAt) + 2000)
    const moving = engine.snapshot().objects.find((o) => o.id === vehicle.id)!
    expect(moving.spatial.position?.speedMps).toBeGreaterThan(0)
    expect(moving.spatial.position?.point).not.toEqual(stopped.spatial.position?.point)
  })
  test.each(['ambulance-first', 'weather-first'])('typed provider reads and atmospheric deletion are independent of adapter order (%s)', async order => {
    const adapters = [
      createLocalAmbulancePackRuntimeAdapter({ routing }),
      createLocalWeatherPackRuntimeAdapter(),
    ]
    const hub = createRuntimeHub(order === 'ambulance-first' ? adapters : [...adapters].reverse())
    const connection = await hub.connect(config)
    try {
      await connection.setClock({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true })
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      const snapshot = await connection.getSnapshot()
      const vehicle = snapshot.objects.find((o) => o.kind === 'mobile_entity')!
      const initialImpact = vehicle.spatial.route?.impacts?.find(impact => impact.source.kind === 'runtime' && impact.source.id === 'ambulance.road-weather')
      expect(initialImpact?.speedFactor).toBe(0.5)
      const area = snapshot.objects.find((o) => o.id === 'weather:halden-front')!
      const old = weatherPackDataSchema.parse(area.packData)
      const definition = weatherItemSchema.parse({
        ...old.definition,
        center: vehicle.spatial.position!.point.coordinates,
        falloff: 'uniform',
        atmosphere: { visibilityM: 100 },
        keyframes: [],
      })
      expect(
        (
          await connection.sendCommand(
            command('world.weather.update', { item: definition, expectedRevision: area.revision }),
            {},
          )
        ).ok,
      ).toBe(true)
      expect(
        (
          await connection.sendCommand(
            command('world.ambulance.set-road-weather-policy', { enabled: true, lowVisibilityFactor: 0.25 }),
            {},
          )
        ).ok,
      ).toBe(true)
      const impacted = (await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!
      expect(impacted.spatial.route?.impacts?.[0]?.speedFactor).toBe(0.25)
      expect(impacted.spatial.route?.impacts?.[0]?.source).toEqual({ kind: 'runtime', id: 'ambulance.road-weather' })
      await connection.observeCommittedEvents([
        {
          type: 'object.deleted',
          objectId: area.id,
          simulationRunId: config.simulationRunId,
          id: 'event:delete',
          seq: 1,
          at: nowIso(),
          provenance: { source: 'operator' },
        } as SimulationRunEvent,
      ])
      const cleared = (await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!
      // Preset ground is still wet: removing the area is not a magic ground reset.
      expect(cleared.spatial.route?.impacts?.[0]?.speedFactor).toBeCloseTo(0.92)
      expect(
        (await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: false }), {})).ok,
      ).toBe(true)
      expect((await connection.getSnapshot()).objects.find((o) => o.id === vehicle.id)!.spatial.route?.impacts).toEqual(
        [],
      )
      expect(connection.health?.().every((h) => h.state === 'ready')).toBe(true)
    } finally {
      await connection.close()
    }
  })
  test('standalone Ambulance works; an explicitly enabled missing provider rejects', async () => {
    const adapter = createLocalAmbulancePackRuntimeAdapter({ routing })
    const independent = {
      ...config,
      scenario: { ...config.scenario, runtimeIds: ['ambulance.local'], runtimeConfig: {} },
    }
    const connection = await adapter.connect(independent)
    await connection.close()
    await expect(
      adapter.connect({
        ...independent,
        scenario: { ...independent.scenario, runtimeConfig: { roadWeather: { enabled: true } } },
      }),
    ).rejects.toThrow('requires')
  })
})

describe('Ambulance weather preparation boundaries', () => {
  test('provider failure after dispatch preserves the accepted assignment and stops further advancement', async () => {
    const connection = await isolatedConnection(async () => { throw new Error('Weather provider failed') })
    try {
      const result = await connection.sendCommand(dispatchCommand(), {})
      expect(result.ok).toBe(true)
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects.find(object => object.id === 'amb:response')!.operational.status).not.toBe('available')
      expect(connection.health?.()[0]).toMatchObject({ state: 'failed', failureCount: 1, lastFailure: { operation: 'post-command-road-weather' } })
      expect((await connection.sendCommand(command('world.ambulance.cancel', { unitId: 'amb:response' }), {})).ok).toBe(false)
      expect((await connection.getSnapshot()).objects).toEqual(snapshot.objects)
    } finally { await connection.close() }
  })

  test('failed candidate policy preparation leaves both the active and persisted policy unchanged', async () => {
    const persisted: unknown[] = []
    const connection = await isolatedConnection(async () => { throw new Error('No sample available') }, false, {
      runtimeStateStore: { load: async () => null, save: async value => { persisted.push(structuredClone(value)) } },
    })
    try {
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      expect((await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: true }), {})).ok).toBe(false)
      expect(await connection.invokeQuery({ capabilityId: 'world.ambulance.road-weather-policy', input: {} })).toMatchObject({ enabled: false })
      expect(persisted).toEqual([])
      expect(connection.health?.()[0]?.state).toBe('ready')
    } finally { await connection.close() }
  })

  test.each(['succeeds', 'fails'])('policy reconciles once after a concurrent read during persistence, preserving acknowledgement (refresh %s)', async refreshOutcome => {
    const failRefresh = refreshOutcome === 'fails'
    let saving = false
    let released = false
    let release!: () => void
    let began!: () => void
    const gate = new Promise<void>(resolve => { release = () => { released = true; resolve() } })
    const persisted = new Promise<void>(resolve => { began = resolve })
    let refreshCalls = 0
    const connection = await isolatedConnection(async request => {
      if (released) {
        refreshCalls++
        if (failRefresh) throw new Error('Current weather unavailable after policy commit')
      }
      return providerSamples(request)
    }, true, { runtimeStateStore: { load: async () => null, save: async () => {
      if (saving) { began(); await gate }
    } } })
    try {
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      saving = true
      const update = connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: true, lowVisibilityFactor: .2 }), {})
      await persisted
      await connection.afterCommittedEvents!([weatherCommit()])
      release()
      expect((await update).ok).toBe(true)
      expect(refreshCalls).toBe(1)
      expect(await connection.invokeQuery({ capabilityId: 'world.ambulance.road-weather-policy', input: {} })).toMatchObject({ lowVisibilityFactor: .2 })
      if (failRefresh) expect(connection.health?.()[0]).toMatchObject({ state: 'failed', lastFailure: { operation: 'apply-road-weather-policy' } })
      else expect((await connection.getSnapshot()).objects.find(object => object.id === 'amb:response')!.spatial.route?.impacts?.[0]?.speedFactor).toBe(.2)
    } finally { release(); await connection.close() }
  })

  test.each(['route', 'position', 'policy', 'sample', 'deleted', 'closed'])('late samples cannot change a newer %s', async changed => {
    let delayed = false
    let release!: () => void
    let began!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { began = resolve })
    const connection = await isolatedConnection(async request => {
      if (!delayed) return providerSamples(request)
      delayed = false
      began()
      await gate
      return providerSamples(request, 10_000) // stale clear weather must not remove a newer constraint
    })
    let closed = false
    try {
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      delayed = true
      const pending = connection.afterCommittedEvents!([weatherCommit()])
      await requested
      if (changed === 'route') {
        expect((await connection.sendCommand(command('world.ambulance.cancel', { unitId: 'amb:response' }), {})).ok).toBe(true)
        expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      } else if (changed === 'policy') {
        expect((await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: true, lowVisibilityFactor: .2 }), {})).ok).toBe(true)
      } else if (changed === 'sample') {
        await connection.afterCommittedEvents!([weatherCommit()])
      } else if (changed === 'position') {
        const unit = (await connection.getSnapshot()).objects.find(object => object.id === 'amb:response')!
        await connection.observeCommittedEvents([simulationRunEventSchema.parse({
          ...weatherCommit(), id: 'event:unit-position', object: { ...unit, revision: unit.revision + 1,
            spatial: { ...unit.spatial, position: { ...unit.spatial.position!, point: { type: 'Point', coordinates: [11.411, 59.13] } } } },
        }) as SimulationRunEvent])
      } else if (changed === 'deleted') {
        await connection.observeCommittedEvents([simulationRunEventSchema.parse({
          id: 'event:unit-deleted', seq: 2, simulationRunId: config.simulationRunId, type: 'object.deleted', objectId: 'amb:response', at: nowIso(), provenance: { source: 'operator' },
        }) as SimulationRunEvent])
      } else { await connection.close(); closed = true }
      const before = (await connection.getSnapshot()).objects
      release()
      await pending
      expect((await connection.getSnapshot()).objects).toEqual(before)
    } finally { release(); if (!closed) await connection.close() }
  })

  test('a failed post-commit provider stops the runtime and keeps its previous complete effects', async () => {
    let reject = false
    const connection = await isolatedConnection(async request => {
      if (reject) throw new Error('Provider became unavailable')
      return providerSamples(request)
    })
    try {
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      const before = (await connection.getSnapshot()).objects
      reject = true
      await expect(connection.afterCommittedEvents!([weatherCommit()])).rejects.toThrow('Provider became unavailable')
      expect((await connection.getSnapshot()).objects).toEqual(before)
      expect(connection.health?.()[0]).toMatchObject({ state: 'failed', lastFailure: { operation: 'after-committed-events' } })
    } finally { await connection.close() }
  })

  test('a failure in a later weather batch does not partially mutate the fleet', async () => {
    const original = await isolatedConnection(async request => providerSamples(request))
    expect((await original.sendCommand(dispatchCommand(), {})).ok).toBe(true)
    const snapshot = (await original.getSnapshot()).objects
    await original.close()
    const unit = snapshot.find(object => object.id === 'amb:response')!
    const patient = snapshot.find(object => object.id === 'patient:response')!
    const data = responseUnitPackDataSchema.parse(unit.packData)
    const fleet = snapshot.filter(object => object.id !== unit.id && object.id !== patient.id)
    for (let index = 0; index < 513; index++) {
      const patientId = `patient:batch-${index}` as ObjectId
      fleet.push({ ...unit, id: `amb:batch-${index}` as ObjectId, packData: { ...data, assignment: { ...data.assignment!, patientIds: [patientId], stops: data.assignment!.stops.map(stop => stop.kind === 'pickup' ? { ...stop, patientIds: [patientId] } : stop) } } }, { ...patient, id: patientId, packData: { ...patientPackDataSchema.parse(patient.packData), holder: { kind: 'incident', id: 'incident:response' } } })
    }
    let calls = 0
    const connection = await isolatedConnection(async request => {
      if (++calls === 2) throw new Error('Second batch unavailable')
      return providerSamples(request, 10_000)
    }, true, { initialObjects: fleet })
    try {
      const before = (await connection.getSnapshot()).objects
      await expect(connection.afterCommittedEvents!([weatherCommit()])).rejects.toThrow('Second batch unavailable')
      expect(calls).toBe(2)
      expect((await connection.getSnapshot()).objects).toEqual(before)
    } finally { await connection.close() }
  })

  test.each(['command', 'clock', 'timer'])('all advancement paths stop on provider failure (%s)', async path => {
    let currentTime = compiled.world.startsAt
    let reject = false
    const connection = await isolatedConnection(async request => {
      if (reject) throw new Error('Advance provider failed')
      return providerSamples(request)
    }, true, { runClock: { read: () => ({ currentTime, updatedAt: nowIso(), paused: false }) } })
    try {
      expect((await connection.sendCommand(dispatchCommand(), {})).ok).toBe(true)
      const before = (await connection.getSnapshot()).objects
      currentTime = new Date(Date.parse(currentTime) + 1_000).toISOString() as IsoTimestamp
      reject = true
      if (path === 'command') expect((await connection.sendCommand(command('world.ambulance.cancel', { unitId: 'amb:response' }), {})).ok).toBe(false)
      else if (path === 'clock') await expect(connection.setClock({ currentTime, updatedAt: nowIso(), paused: true })).rejects.toThrow('Advance provider failed')
      else {
        const deadline = Date.now() + 2_000
        while (connection.health?.()[0]?.state !== 'failed' && Date.now() < deadline) await Bun.sleep(20)
      }
      expect(connection.health?.()[0]).toMatchObject({ state: 'failed', failureCount: 1, lastFailure: { operation: 'advance' } })
      expect((await connection.getSnapshot()).objects).toEqual(before)
    } finally { await connection.close() }
  })
})

test('combined restart preserves Weather ground and the configured vehicle policy', async () => {
  const saved = new Map<string, unknown>()
  const stores = Object.fromEntries(['weather.local', 'ambulance.local'].map(id => [id, {
    load: async () => saved.get(id) ?? null,
    save: async (value: unknown) => { saved.set(id, structuredClone(value)) },
  }]))
  const hub = createRuntimeHub([createLocalAmbulancePackRuntimeAdapter({ routing }), createLocalWeatherPackRuntimeAdapter()])
  const connection = await hub.connect({ ...config, runtimeStateStores: stores })
  await connection.setClock({ currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: true })
  expect((await connection.sendCommand(command('world.ambulance.set-road-weather-policy', { enabled: true, iceFactor: .11 }), {})).ok).toBe(true)
  const point = { type: 'Point', coordinates: [11.41, 59.13] }
  const sample = await connection.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })
  const snapshot = await connection.getSnapshot()
  await connection.close()
  const restored = await hub.connect({ ...config, initialObjects: snapshot.objects, runtimeStateStores: stores })
  try {
    expect(await restored.invokeQuery({ capabilityId: 'world.weather.sample-at-point', input: { point } })).toEqual(sample)
    expect(await restored.invokeQuery({ capabilityId: 'world.ambulance.road-weather-policy', input: {} })).toMatchObject({ enabled: true, iceFactor: .11 })
  } finally { await restored.close() }
})
