import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, meters, type CommandEnvelope, type ObjectId, type OperationalObject, type SimulationRunId } from '../../../core/model/index.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { ambulanceItemSchema } from '../item-schemas.ts'
import { responseUnitPackDataSchema, assignmentWarnings, careSitePackDataSchema, incidentPackDataSchema, patientPackDataSchema } from '../model.ts'
import { createAmbulanceSimEngine, type AmbulanceSimEngine } from './engine.ts'
import { createAmbulanceItem, validateAmbulanceDeletion, validateAmbulanceObjects } from './object-state.ts'

// Explicitly synthetic test route times, not ambulance-driving calibration.
const start = Date.parse('2026-01-01T09:00:00Z')
const at = new Date(start).toISOString() as OperationalObject['timestamps']['createdAt']
const routing: Pick<RoutingAdapter, 'id' | 'route'> = { id: 'test-routing', route: async ({ from, to }) => ({ geometry: { type: 'LineString', coordinates: [from.coordinates, to.coordinates] }, durationSeconds: 10, distanceM: meters(100), provider: 'test-routing' }) }
const unit = (id = 'ambulance:a') => ({ type: 'ambulance', id, label: id, position: [11, 59], patientCapacity: 1, capabilities: ['monitoring'], crewReady: true, mobilizationSeconds: 2, sceneSeconds: 3 })
const incident = { type: 'incident', id: 'incident:a', label: 'Incident', position: [11.002, 59], summary: 'Synthetic operational test', dispatchUrgency: 'acute' }
const patient = (id = 'patient:a') => ({ type: 'patient', id, label: id, incidentId: 'incident:a', summary: 'Synthetic patient, no physiological model', assessedUrgency: 'urgent', needs: ['monitoring'] })
const site = { type: 'care-site', id: 'site:a', label: 'Test receiving site', position: [11.004, 59], capabilities: ['monitoring'], acceptedUrgencies: ['acute', 'urgent', 'ordinary'], handoverSlots: 1, handoverSeconds: 4, accepting: true }
const build = (items: readonly unknown[] = [incident, patient(), site, unit()]): OperationalObject[] => {
  const objects: OperationalObject[] = []
  for (const raw of items) objects.push(createAmbulanceItem(ambulanceItemSchema.parse(raw), { at, simulationTimeMs: start, objectById: id => objects.find(object => object.id === id) }))
  return objects
}
const engine = (items?: readonly unknown[]) => createAmbulanceSimEngine({ simulationRunId: 'run:ambulance-test' as SimulationRunId, objects: build(items), routing, simulationTimeMs: start })
let commandNumber = 0
const command = (kind: string, payload: unknown): CommandEnvelope => ({ id: `command:test-${++commandNumber}` as CommandEnvelope['id'], simulationRunId: 'run:ambulance-test' as SimulationRunId, actorId: 'actor:test' as CommandEnvelope['actorId'], issuedAt: at, targetObjectIds: [], kind: `world.ambulance.${kind}`, payload })
const dispatch = async (e: AmbulanceSimEngine, unitId = 'ambulance:a', patientId = 'patient:a', destinationId: string | null = 'site:a') => {
  const assigned = await e.handleCommand(command('assign', { unitId, incidentId: 'incident:a', patientIds: [patientId] }))
  if (!assigned.result.ok || !destinationId) return assigned
  return await e.handleCommand(command('append-stop', { kind: 'handover', unitId, careSiteId: destinationId, patientIds: [patientId] }))
}
const read = (e: AmbulanceSimEngine, id: string): OperationalObject => e.snapshot().objects.find(object => object.id === id)!
const ambulance = (e: AmbulanceSimEngine, id = 'ambulance:a') => responseUnitPackDataSchema.parse(read(e, id).packData)
const person = (e: AmbulanceSimEngine, id = 'patient:a') => patientPackDataSchema.parse(read(e, id).packData)
const normalized = (e: AmbulanceSimEngine) => e.snapshot().objects.map(object => ({ id: object.id, status: object.operational.status, point: object.spatial.position?.point, data: object.packData }))

describe('Ambulance operational lifecycle', () => {
  test('crosses every timed phase, hands over patient and releases unit without a network call during advance', async () => {
    const e = engine()
    expect((await dispatch(e)).result.ok).toBe(true)
    expect(ambulance(e).assignment?.phase).toBe('mobilizing')
    const events = e.advanceTo(start + 30_000)
    expect(person(e)).toMatchObject({ holder: { kind: 'care-site', id: 'site:a' }, disposition: 'delivered', assignedAtMs: start, departedAtMs: start + 2_000, contactedAtMs: start + 12_000, pickedUpAtMs: start + 15_000, arrivedAtSiteMs: start + 25_000, handoverStartedAtMs: start + 25_000, completedAtMs: start + 29_000 })
    expect(ambulance(e).assignment).toBeUndefined()
    expect(ambulance(e).busyTimeMs).toBe(29_000)
    expect(incidentPackDataSchema.parse(read(e, 'incident:a').packData).closedAtMs).toBe(start + 29_000)
    expect(events.filter(event => event.type === 'object.upserted' && event.object.id === 'ambulance:a' && event.history === 'record').map(event => event.type === 'object.upserted' ? event.object.operational.status : '')).toEqual(['responding', 'on-scene', 'transporting', 'queued', 'handover', 'available'])
    validateAmbulanceObjects(e.snapshot().objects)
  })

  test('large versus small advances and exact mid-route checkpoint restoration produce the same outcome', async () => {
    const large = engine(), small = engine()
    await dispatch(large); await dispatch(small)
    small.advanceTo(start + 7_250)
    const restored = createAmbulanceSimEngine({ simulationRunId: 'run:copy' as SimulationRunId, objects: small.snapshot().objects, routing: { id: 'forbidden', route: async () => { throw new Error('Restore/advance must not route') } }, ...small.checkpoint() })
    for (let elapsed = 7_500; elapsed <= 30_000; elapsed += 250) small.advanceTo(start + elapsed)
    restored.advanceTo(start + 30_000); large.advanceTo(start + 30_000)
    expect(normalized(small)).toEqual(normalized(large))
    expect(normalized(restored)).toEqual(normalized(large))
  })

  test('queues are FIFO with stable ties, recover when slots free and when site capacity is increased', async () => {
    const e = engine([incident, patient(), patient('patient:b'), { ...site, handoverSlots: 0 }, unit(), unit('ambulance:b')])
    await dispatch(e); await dispatch(e, 'ambulance:b', 'patient:b')
    e.advanceTo(start + 26_000)
    expect(ambulance(e).assignment?.phase).toBe('queued')
    expect(ambulance(e, 'ambulance:b').assignment?.phase).toBe('queued')
    expect((await e.handleCommand(command('set-care-site', { careSiteId: 'site:a', handoverSlots: 1 }))).result.ok).toBe(true)
    expect(ambulance(e).assignment?.phase).toBe('handover')
    e.advanceTo(start + 35_000)
    expect(person(e).completedAtMs).toBe(start + 30_000)
    expect(person(e, 'patient:b').completedAtMs).toBe(start + 34_000)
    expect(careSitePackDataSchema.parse(read(e, 'site:a').packData).handoverSlots).toBe(1)
  })

  test('cancel retains onboard custody; explicit transport can resume; handover cannot be cancelled', async () => {
    const e = engine()
    await dispatch(e)
    e.advanceTo(start + 20_000)
    expect((await e.handleCommand(command('cancel', { unitId: 'ambulance:a' }))).result.ok).toBe(true)
    expect(ambulance(e).assignment?.phase).toBe('ready-for-transport')
    expect(person(e).holder).toEqual({ kind: 'response-unit', id: 'ambulance:a' as ObjectId })
    expect((await e.handleCommand(command('return-to-base', { unitId: 'ambulance:a' }))).result.ok).toBe(false)
    expect((await e.handleCommand(command('append-stop', { kind: 'handover', unitId: 'ambulance:a', careSiteId: 'site:a', patientIds: ['patient:a'] }))).result.ok).toBe(true)
    e.advanceTo(start + 31_000)
    expect((await e.handleCommand(command('cancel', { unitId: 'ambulance:a' }))).result.ok).toBe(false)
    e.advanceTo(start + 35_000)
    expect(person(e).disposition).toBe('delivered')
  })

  test('no destination means explicit ready-for-transport, never an invented hospital choice', async () => {
    const e = engine()
    await e.handleCommand(command('assign', { unitId: 'ambulance:a', incidentId: 'incident:a', patientIds: ['patient:a'] }))
    e.advanceTo(start + 20_000)
    expect(ambulance(e).assignment?.phase).toBe('ready-for-transport')
    expect(person(e).holder.kind).toBe('response-unit')
  })

  test('pre-pickup cancellation releases reservation and explicit no-transport completes patient with reason', async () => {
    const e = engine()
    await dispatch(e)
    e.advanceTo(start + 1_000)
    expect((await e.handleCommand(command('set-patient-disposition', { patientId: 'patient:a', disposition: 'no-transport', reason: 'Assessed on site' }))).result.ok).toBe(false)
    await e.handleCommand(command('cancel', { unitId: 'ambulance:a' }))
    expect((await e.handleCommand(command('set-patient-disposition', { patientId: 'patient:a', disposition: 'no-transport', reason: 'Operator-authored disposition' }))).result.ok).toBe(true)
    expect(person(e).disposition).toBe('no-transport')
    expect(read(e, 'incident:a').lifecycle).toBe('resolved')
  })

  test('rejects double reservation, wrong asset kinds, unavailable crews and incompatible destinations atomically', async () => {
    const e = engine([incident, patient(), { ...site, capabilities: [] }, unit(), unit('ambulance:b')])
    expect((await e.handleCommand(command('assign', { unitId: 'ambulance:a', incidentId: 'site:a', patientIds: ['patient:a'] }))).result.ok).toBe(false)
    expect((await e.handleCommand(command('assign', { unitId: 'ambulance:a', incidentId: 'incident:a', patientIds: ['patient:a'] }))).result.ok).toBe(true)
    expect((await e.handleCommand(command('append-stop', { kind: 'handover', unitId: 'ambulance:a', careSiteId: 'site:a', patientIds: ['patient:a'] }))).result.ok).toBe(false)
    expect((await e.handleCommand(command('assign', { unitId: 'ambulance:b', incidentId: 'incident:a', patientIds: ['patient:a'] }))).result.ok).toBe(false)
    await e.handleCommand(command('set-unit-readiness', { unitId: 'ambulance:b', ready: false }))
    expect(ambulance(e, 'ambulance:b').crewReady).toBe(false)
    expect((await e.handleCommand(command('return-to-base', { unitId: 'ambulance:b' }))).result.ok).toBe(false)
  })

  test('response cancellation and re-dispatch preserve first patient contact chronology', async () => {
    const e = engine()
    await dispatch(e)
    e.advanceTo(start + 13_000)
    await e.handleCommand(command('cancel', { unitId: 'ambulance:a' }))
    expect((await dispatch(e)).result.ok).toBe(true)
    e.advanceTo(start + 43_000)
    expect(person(e).contactedAtMs).toBe(start + 12_000)
    expect(person(e).assignedAtMs).toBe(start)
    validateAmbulanceObjects(e.snapshot().objects)
  })

  test('road-weather affects actual progress and ETA and zero factor stops without losing phase', async () => {
    const e = engine()
    await dispatch(e)
    e.advanceTo(start + 2_000)
    e.setRoadWeatherImpact('ambulance:a' as ObjectId, { source: { kind: 'runtime', id: 'ambulance.road-weather' }, label: 'Synthetic speed constraint', severity: 'blocked', speedFactor: 0, updatedAt: at })
    e.advanceTo(start + 22_000)
    expect(ambulance(e).assignment?.leg?.progressMs).toBe(0)
    expect(read(e, 'ambulance:a').spatial.route?.etaSeconds).toBeUndefined()
    e.setRoadWeatherImpact('ambulance:a' as ObjectId, undefined)
    e.advanceTo(start + 32_000)
    expect(ambulance(e).assignment?.phase).toBe('on-scene')
  })

  test('helicopters share the response lifecycle but use direct air travel and enforce two-patient capacity', async () => {
    const helicopter = { type: 'helicopter', id: 'helicopter:test', label: 'Test helicopter', position: [11, 59], patientCapacity: 2, capabilities: ['monitoring'], crewReady: true, mobilizationSeconds: 0, sceneSeconds: 3, cruiseSpeedMps: 60 }
    const objects = build([incident, patient(), patient('patient:b'), site, helicopter])
    const e = createAmbulanceSimEngine({ simulationRunId: 'run:helicopter-test' as SimulationRunId, objects, simulationTimeMs: start, routing: { id: 'road-routing-must-not-run', route: async () => { throw new Error('helicopter must not request a road route') } } })
    const assigned = await e.handleCommand(command('assign', { unitId: 'helicopter:test', incidentId: 'incident:a', patientIds: ['patient:a', 'patient:b'] }))
    expect(assigned.result.ok).toBe(true)
    expect(ambulance(e, 'helicopter:test')).toMatchObject({ unitKind: 'helicopter', mobility: { kind: 'rotary-wing', cruiseSpeedMps: 60 }, patientCapacity: 2 })
    expect(ambulance(e, 'helicopter:test').assignment?.leg?.provider).toBe('ambulance.direct-air')
    expect(ambulanceItemSchema.safeParse({ ...helicopter, patientCapacity: 3 }).success).toBe(false)
  })

  test('fractional air-leg arrivals advance on the millisecond Run clock without stalling', async () => {
    const helicopter = { type: 'helicopter', id: 'helicopter:fractional', label: 'Fractional-flight helicopter', position: [11, 59], patientCapacity: 1, capabilities: ['monitoring'], crewReady: true, mobilizationSeconds: 0, sceneSeconds: 3, cruiseSpeedMps: 60 }
    const e = createAmbulanceSimEngine({
      simulationRunId: 'run:helicopter-fractional' as SimulationRunId,
      objects: build([incident, patient(), site, helicopter]),
      simulationTimeMs: start,
      routing: { id: 'road-routing-must-not-run', route: async () => { throw new Error('helicopter must not request a road route') } },
    })
    expect((await e.handleCommand(command('assign', { unitId: 'helicopter:fractional', incidentId: 'incident:a', patientIds: ['patient:a'] }))).result.ok).toBe(true)
    const durationMs = ambulance(e, 'helicopter:fractional').assignment!.leg!.durationMs
    expect(Number.isInteger(durationMs)).toBe(false)

    expect(() => e.advanceTo(start + Math.ceil(durationMs))).not.toThrow()
    expect(ambulance(e, 'helicopter:fractional').assignment?.phase).toBe('on-scene')
    expect(e.checkpoint().simulationTimeMs).toBe(start + Math.ceil(durationMs))
  })

  test('late route results cannot resurrect changed or deleted canonical targets', async () => {
    const objects = build(), canonical = new Map(objects.map(object => [object.id, object]))
    let release!: () => void
    const e = createAmbulanceSimEngine({ simulationRunId: 'run:test' as SimulationRunId, objects, simulationTimeMs: start, objectById: id => canonical.get(id), routing: { id: 'delayed-test', route: async request => { await new Promise<void>(resolve => { release = resolve }); return routing.route(request) } } })
    const outcome = e.handleCommand(command('assign', { unitId: 'ambulance:a', incidentId: 'incident:a', patientIds: ['patient:a'] }))
    canonical.delete('incident:a' as ObjectId)
    release()
    const result = await outcome
    expect(result.result.ok).toBe(false)
    expect(result.events).toHaveLength(0)
    expect(ambulance(e).assignment).toBeUndefined()
  })

  test('accepts new assessment facts, exposes unsuitable plans and blocks only new admissions', async () => {
    const e = engine([incident, patient(), { ...site, handoverSlots: 0 }, unit()])
    await dispatch(e)
    e.advanceTo(start + 26_000)
    const reassess = () => e.handleCommand(command('set-patient-assessment', { patientId: 'patient:a', assessedUrgency: 'acute', needs: ['monitoring', 'specialist'] }))
    expect((await reassess()).result.ok).toBe(true)
    expect(person(e).holder.kind).toBe('response-unit')
    expect(assignmentWarnings(read(e, 'ambulance:a'), e.snapshot().objects)).toHaveLength(2)
    await e.handleCommand(command('set-care-site', { careSiteId: 'site:a', handoverSlots: 1 }))
    e.advanceTo(start + 30_000)
    expect(ambulance(e).assignment?.phase).toBe('queued')
    await e.handleCommand(command('set-care-site', { careSiteId: 'site:a', capabilities: ['monitoring', 'specialist'] }))
    expect(ambulance(e).assignment?.phase).toBe('handover')
    // Once admitted, closing the site or updating assessment does not undo custody.
    await e.handleCommand(command('set-care-site', { careSiteId: 'site:a', accepting: false, capabilities: [] }))
    expect((await reassess()).result.ok).toBe(true)
    e.advanceTo(start + 34_000)
    expect(person(e).disposition).toBe('delivered')
  })

  test('rechecks preplanned destination after assessment changes during response', async () => {
    const e = engine()
    await dispatch(e)
    expect((await e.handleCommand(command('set-patient-assessment', { patientId: 'patient:a', assessedUrgency: 'acute', needs: ['specialist'] }))).result.ok).toBe(true)
    e.advanceTo(start + 20_000)
    expect(ambulance(e).assignment?.phase).toBe('ready-for-transport')
    expect(ambulance(e).assignment?.stops.some(stop => stop.kind === 'handover')).toBe(false)
    expect(person(e).holder.kind).toBe('response-unit')
    expect(assignmentWarnings(read(e, 'ambulance:a'), e.snapshot().objects)).toHaveLength(1)
  })

  test('enforces requested revision against exactly the primary target and records command provenance', async () => {
    const e = engine()
    const base = command('set-unit-readiness', { unitId: 'ambulance:a', ready: false })
    const revision = read(e, 'ambulance:a').revision
    expect((await e.handleCommand({ ...base, expectedRevision: revision })).result.ok).toBe(false)
    expect((await e.handleCommand({ ...base, targetObjectIds: ['ambulance:a' as ObjectId], expectedRevision: revision + 1 })).result.ok).toBe(false)
    const accepted = await e.handleCommand({ ...base, targetObjectIds: ['ambulance:a' as ObjectId], expectedRevision: revision })
    expect(accepted.result.ok).toBe(true)
    expect(accepted.events.length).toBeGreaterThan(0)
    expect(accepted.events.every(event => event.provenance?.causedByCommandId === base.id)).toBe(true)
    expect(ambulance(e).crewReady).toBe(false)
  })

  test('duplicate item creation cannot overwrite owned or foreign objects', async () => {
    const e = engine()
    const before = e.snapshot().objects
    expect((await e.handleCommand(command('create-item', { item: unit() }))).result.ok).toBe(false)
    expect(e.snapshot().objects).toEqual(before)
    const existing = build()[0]!
    const foreign = { ...existing, id: 'plant:a' as ObjectId, packId: 'process-plant' as OperationalObject['packId'] }
    const foreignEngine = createAmbulanceSimEngine({ simulationRunId: 'run:test' as SimulationRunId, objects: [], routing, simulationTimeMs: start, objectById: id => id === foreign.id ? foreign : undefined })
    expect((await foreignEngine.handleCommand(command('create-item', { item: unit('plant:a') }))).result.ok).toBe(false)
    expect(foreignEngine.snapshot().objects).toHaveLength(0)
  })

  test('appends a second incident pickup and then a handover as one ordered route', async () => {
    const incidentB = { ...incident, id: 'incident:b', position: [11.003, 59] }
    const patientB = { ...patient('patient:b'), incidentId: 'incident:b' }
    const e = engine([incident, patient(), incidentB, patientB, site, { ...unit(), patientCapacity: 2 }])
    await dispatch(e, 'ambulance:a', 'patient:a', null)
    expect((await e.handleCommand(command('append-stop', { kind: 'pickup', unitId: 'ambulance:a', incidentId: 'incident:b', patientIds: ['patient:b'] }))).result.ok).toBe(true)
    const appendedHandover = await e.handleCommand(command('append-stop', { kind: 'handover', unitId: 'ambulance:a', careSiteId: 'site:a', patientIds: ['patient:a', 'patient:b'] }))
    expect(appendedHandover.result.ok).toBe(true)
    expect(ambulance(e).assignment?.stops.map(stop => stop.kind)).toEqual(['pickup', 'pickup', 'handover'])
    e.advanceTo(start + 50_000)
    expect(person(e).disposition).toBe('delivered')
    expect(person(e, 'patient:b').disposition).toBe('delivered')
  })

  test('deletion rejects reservations and occupied holders while leaving unrelated assets removable', async () => {
    const e = engine()
    await dispatch(e)
    for (const id of ['ambulance:a', 'incident:a', 'patient:a', 'site:a']) expect(() => e.validateDeletion(id)).toThrow()
    await e.handleCommand(command('cancel', { unitId: 'ambulance:a' }))
    expect(() => e.validateDeletion('ambulance:a')).not.toThrow()
    expect(() => e.validateDeletion('site:a')).not.toThrow()
    await dispatch(e)
    e.advanceTo(start + 30_000)
    expect(() => e.validateDeletion('site:a')).toThrow('patient')
    expect(() => e.validateDeletion('ambulance:a')).not.toThrow()
  })
})

describe('Ambulance item and reference invariants', () => {
  test('captures foreign asset point once without overwriting it or requiring future reference resolution', () => {
    const base = build()[0]!
    const foreign = { ...base, id: 'plant:a' as ObjectId, packId: 'process-plant' as OperationalObject['packId'], kind: 'facility' as const, spatial: { ...base.spatial, position: { point: geoPointFromLonLat(11.5, 59.5), observedAt: at } }, packData: { type: 'plant' } }
    const { position: _, ...rest } = incident
    const captured = createAmbulanceItem(ambulanceItemSchema.parse({ ...rest, atObject: 'plant:a' }), { at, simulationTimeMs: start, objectById: id => id === foreign.id ? foreign : undefined })
    expect(captured.spatial.position?.point).toEqual(foreign.spatial.position.point)
    expect(incidentPackDataSchema.parse(captured.packData).subjectObjectId).toBe('plant:a' as ObjectId)
    validateAmbulanceObjects([captured])
    expect(() => validateAmbulanceDeletion('plant:a', [captured])).not.toThrow()
    expect(() => createAmbulanceItem(ambulanceItemSchema.parse({ ...rest, atObject: 'plant:a' }), { at, simulationTimeMs: start, objectById: () => undefined })).toThrow('no canonical point')
  })

  test('one location, direct positioned reference, real incident holder and authored parameters are required', () => {
    expect(ambulanceItemSchema.safeParse({ ...incident, atObject: 'plant:a' }).success).toBe(false)
    expect(ambulanceItemSchema.safeParse({ type: 'ambulance', id: 'a', label: 'A', position: [11, 59] }).success).toBe(false)
    expect(() => createAmbulanceItem(ambulanceItemSchema.parse(patient()), { at, simulationTimeMs: start, objectById: () => undefined })).toThrow('existing incident')
    const objects = build()
    expect(() => validateAmbulanceDeletion('incident:a', objects)).toThrow('patient')
    const broken = objects.map(object => object.id === 'patient:a' ? { ...object, packData: { ...patientPackDataSchema.parse(object.packData), assignedAtMs: start + 10, contactedAtMs: start + 5 } } : object)
    expect(() => validateAmbulanceObjects(broken)).toThrow('milestones')
  })
})
