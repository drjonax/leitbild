import { describe, expect, test } from 'bun:test'
import { commandEnvelopeSchema, geoPointFromLonLat, meters, nowIso, operationalObjectSchema, simulationRunEventSchema, type CommandEnvelope, type ObjectId, type OperationalObject, type SimulationRunEvent, type SimulationRunId } from '../src/core/model/index.ts'
import { assignCommandKind, cancelCommandKind, createItemCommandKind } from '../src/packs/ambulance/commands.ts'
import { responseUnitPackDataSchema, careSitePackDataSchema, patientPackDataSchema } from '../src/packs/ambulance/model.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { RoutingAdapter } from '../src/routing/protocol.ts'
import { responseScenario, testScenarioRuntimeConfig } from './ambulance-fixtures.ts'

const simulationRunId = 'run-test' as SimulationRunId
const epoch = Date.parse(responseScenario.world.startsAt)
const unitId = 'amb:a12' as ObjectId
const incidentId = 'incident:gronland-unattended' as ObjectId
const patientId = 'patient:gronland-unattended:1' as ObjectId
const objects = (): OperationalObject[] => structuredClone(responseScenario.initialObjects.filter(object => object.packId === 'ambulance'))
const command = (kind: string, payload: unknown): CommandEnvelope => commandEnvelopeSchema.parse({
  id: 'command:' + crypto.randomUUID(), simulationRunId, actorId: 'actor:test', issuedAt: nowIso(), kind, targetObjectIds: [], payload,
}) as CommandEnvelope
const dispatch = () => command(assignCommandKind, { unitId, incidentId, patientIds: [patientId] })
const unit = (engine: ReturnType<typeof createAmbulanceSimEngine>) => engine.snapshot().objects.find(object => object.id === unitId)!
const engineWith = (routing: RoutingAdapter = createDirectRoutingAdapter(), initial = objects()) => createAmbulanceSimEngine({ simulationRunId, objects: initial, routing, simulationTimeMs: epoch })
const fastUnitObjects = () => objects().map(object => object.id === unitId ? {
  ...object, packData: { ...responseUnitPackDataSchema.parse(object.packData), mobilizationSeconds: 0, sceneSeconds: 10 },
} : object)

describe('Ambulance runtime integration and route restoration', () => {
  test('starts with explicit units, care sites, incidents and individual patients', async () => {
    const connection = await createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }).connect({ simulationRunId, scenario: testScenarioRuntimeConfig() })
    try {
      const initial = await connection.getSnapshot()
      expect(initial.objects.filter(object => object.kind === 'mobile_entity')).toHaveLength(3)
      expect(initial.objects.filter(object => object.kind === 'incident')).toHaveLength(3)
      expect(initial.objects.filter(object => object.kind === 'facility')).toHaveLength(3)
      expect(initial.objects.filter(object => object.kind === 'patient')).toHaveLength(4)
      const ambulance = initial.objects.find(object => object.id === unitId)!
      const careSite = initial.objects.find(object => object.id === 'facility:ous')!
      expect(ambulance.spatial.position?.point).toEqual(careSite.spatial.position?.point)
      expect(responseUnitPackDataSchema.parse(ambulance.packData).capabilities).toContain('advanced_life_support')
      expect(careSitePackDataSchema.parse(careSite.packData).handoverSlots).toBe(2)
      for (const object of initial.objects) operationalObjectSchema.parse(object)
    } finally { await connection.close() }
  })

  test('idle advancement does not invent incident facts or change care-site capacity', () => {
    const engine = engineWith()
    const before = engine.snapshot().objects
    engine.advanceTo(epoch + 20_000)
    const after = engine.snapshot().objects
    for (const object of before.filter(object => object.kind === 'patient' || object.kind === 'facility')) {
      expect(after.find(candidate => candidate.id === object.id)!.packData).toEqual(object.packData)
    }
  })

  test('committed projections stay Pack-scoped and stale echoes cannot rewind a unit', async () => {
    const engine = engineWith()
    const initialUnit = structuredClone(unit(engine))
    const foreign = responseScenario.initialObjects.find(object => object.packId === 'weather')!
    const event = (object: OperationalObject, seq: number) => simulationRunEventSchema.parse({
      id: `event:commit-${seq}`, seq, simulationRunId, type: 'object.upserted', object, at: nowIso(), provenance: object.provenance,
    }) as SimulationRunEvent
    engine.observeCommittedEvents([event(foreign, 1)])
    expect(engine.snapshot().objects.some(object => object.id === foreign.id)).toBe(false)
    expect((await engine.handleCommand(dispatch())).result.ok).toBe(true)
    const dispatched = structuredClone(unit(engine))
    engine.observeCommittedEvents([event(initialUnit, 2)])
    expect(unit(engine)).toEqual(dispatched)
  })

  test('dispatch persists provider route and an explicit patient reservation', async () => {
    const engine = engineWith()
    const response = await engine.handleCommand(dispatch())
    expect(response.result.ok).toBe(true)
    expect(response.events.length).toBeGreaterThan(0)
    const assignment = responseUnitPackDataSchema.parse(unit(engine).packData).assignment!
    expect(assignment.phase).toBe('mobilizing')
    expect(assignment.patientIds).toEqual([patientId])
    expect(assignment.leg?.provider).toBe('direct')
    expect(assignment.leg?.durationMs).toBeGreaterThan(0)
    expect(patientPackDataSchema.parse(engine.snapshot().objects.find(object => object.id === patientId)!.packData).holder).toEqual({ kind: 'incident', id: incidentId })
  })

  test('continues shaped route from exact persisted progress without routing again', async () => {
    const start = geoPointFromLonLat(11, 59)
    const finish = geoPointFromLonLat(11.01, 59.01)
    const initial = fastUnitObjects().map(object => object.id === unitId || object.id === incidentId ? {
      ...object, spatial: { ...object.spatial, position: { ...object.spatial.position!, point: object.id === unitId ? start : finish } },
    } : object)
    let calls = 0
    const routing: RoutingAdapter = { id: 'test-shaped', route: async () => {
      calls++
      return { geometry: { type: 'LineString', coordinates: [start.coordinates, geoPointFromLonLat(11.01, 59).coordinates, finish.coordinates] }, distanceM: meters(1500), durationSeconds: 100, provider: 'test-shaped' }
    } }
    const original = engineWith(routing, initial)
    expect((await original.handleCommand(dispatch())).result.ok).toBe(true)
    original.advanceTo(epoch + 25_000)
    expect(Number(unit(original).spatial.position!.point.coordinates[1])).toBe(59)
    const restored = createAmbulanceSimEngine({ simulationRunId, objects: structuredClone(original.snapshot().objects), simulationTimeMs: original.checkpoint().simulationTimeMs, routing: {
      id: 'test-no-routing-on-restore', route: async () => { throw new Error('Restore must not request a new route') },
    } })
    expect(unit(restored).packData).toEqual(unit(original).packData)
    original.advanceTo(epoch + 45_000)
    restored.advanceTo(epoch + 45_000)
    expect(unit(restored).spatial.position!.point).toEqual(unit(original).spatial.position!.point)
    expect(responseUnitPackDataSchema.parse(unit(restored).packData).assignment).toEqual(responseUnitPackDataSchema.parse(unit(original).packData).assignment)
    expect(calls).toBe(1)
  })

  test('consumes dense route geometry using provider travel time', async () => {
    const start = geoPointFromLonLat(11, 59)
    const finish = geoPointFromLonLat(11.001, 59)
    const initial = fastUnitObjects().map(object => object.id === unitId || object.id === incidentId ? {
      ...object, spatial: { ...object.spatial, position: { ...object.spatial.position!, point: object.id === unitId ? start : finish } },
    } : object)
    const engine = engineWith({ id: 'test-dense', route: async () => ({
      geometry: { type: 'LineString', coordinates: Array.from({ length: 101 }, (_, index) => geoPointFromLonLat(11 + index * 0.00001, 59).coordinates) },
      distanceM: meters(57), durationSeconds: 10, provider: 'test-dense',
    }) }, initial)
    expect((await engine.handleCommand(dispatch())).result.ok).toBe(true)
    engine.advanceTo(epoch + 5_000)
    expect(unit(engine).spatial.position!.point.coordinates[0]).toBeCloseTo(11.0005, 7)
    engine.advanceTo(epoch + 10_000)
    expect(unit(engine).spatial.position!.point).toEqual(finish)
    expect(responseUnitPackDataSchema.parse(unit(engine).packData).assignment?.phase).toBe('on-scene')
  })

  test('routing failure does not commit an assignment or reserve a patient', async () => {
    const engine = engineWith({ id: 'test-failing', route: async () => { throw new DOMException('Routing cancelled', 'AbortError') } })
    const before = structuredClone(engine.snapshot().objects)
    expect((await engine.handleCommand(dispatch())).result.ok).toBe(false)
    expect(engine.snapshot().objects).toEqual(before)
  })

  test('cancels a response without erasing or transferring patients', async () => {
    const engine = engineWith()
    expect((await engine.handleCommand(dispatch())).result.ok).toBe(true)
    expect((await engine.handleCommand(command(cancelCommandKind, { unitId }))).result.ok).toBe(true)
    expect(responseUnitPackDataSchema.parse(unit(engine).packData).assignment).toBeUndefined()
    expect(patientPackDataSchema.parse(engine.snapshot().objects.find(object => object.id === patientId)!.packData).holder).toEqual({ kind: 'incident', id: incidentId })
  })

  test('creates explicit care sites and rejects duplicate identities', async () => {
    const engine = engineWith()
    const create = () => command(createItemCommandKind, { item: {
      type: 'care-site', id: 'care-site:temporary', label: 'Municipal reception', position: [11.4, 59.1], capabilities: ['advanced_life_support'], acceptedUrgencies: ['urgent', 'ordinary'], handoverSlots: 1, handoverSeconds: 60, accepting: true,
    } })
    expect((await engine.handleCommand(create())).result.ok).toBe(true)
    expect((await engine.handleCommand(create())).result.ok).toBe(false)
    expect(engine.snapshot().objects.filter(object => object.id === 'care-site:temporary')).toHaveLength(1)
  })
})
