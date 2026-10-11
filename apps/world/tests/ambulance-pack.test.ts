// Ambulance's own Pack tests, moved here from core test files that now use
// the fixture Pack. They go with the Ambulance Pack.
import { newWorkspaceId } from '@leitbild/contracts'
import { describe,expect,test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandEnvelope, SimulationRunId } from '../src/core/model/index.ts'
import { commandEnvelopeSchema,nowIso,type ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { appendStopCommandKind, assignCommandKind, cancelCommandKind, createItemCommandKind } from '../src/packs/ambulance/commands.ts'
import { responseUnitPackDataSchema, careSitePackDataSchema } from '../src/packs/ambulance/model.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { createAmbulanceSimEngine } from '../src/packs/ambulance/sim/engine.ts'
import { createDroneNativePackRuntimeAdapter } from '../src/packs/drone/native/adapter.ts'
import { dronePack } from '../src/packs/drone/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { loadActivePackViews, loadUiPack } from '../src/ui/pack-loader.ts'
import { responseScenario } from './ambulance-fixtures.ts'
import { expectFieldKeys } from './helpers/pack-presentation.ts'

const createDispatchRegistry = (dataDir: string) => {
  const routing = createDirectRoutingAdapter()
  const packs = [ambulancePack, dronePack]
  const dispatch = builtinScenarioDefinitions.find(source => source.id === 'halden-dispatch')
  if (!dispatch) throw new Error('missing built-in Scenario: halden-dispatch')
  return createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }),
    scenarioDefinitions: [dispatch],
    compileScenarioDefinition: source => compileScenarioDefinition(source, packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs),
    runtimeAdapters: [createLocalAmbulancePackRuntimeAdapter({ routing }), createDroneNativePackRuntimeAdapter()],
  })
}

describe('Ambulance Pack', () => {
  test('Ambulance authoring and commands require explicit patient selection, not generic targeting', () => {
    const adapter = createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() })
    expect(ambulancePack.targeting).toBeUndefined()
    expect(ambulancePack.creation).toBeUndefined()
    expect(ambulancePack.authoring?.itemTypes.map(item => item.id)).toEqual(['ambulance', 'helicopter', 'incident', 'patient', 'care-site'])
    const command = adapter.capabilities.find(capability => capability.id === assignCommandKind)!
    const input = { unitId: 'amb:a12', incidentId: 'incident:gronland-unattended', patientIds: ['patient:gronland-unattended:1'] }
    expect(command.input.safeParse({ unitId: 'amb:a12', incidentId: 'incident:gronland-unattended' }).success).toBe(false)
    const built = command.buildCommand!(input)
    expect(built.targetObjectIds).toEqual(['amb:a12' as ObjectId])
    expect(built.payload).toEqual(input)
    expect(adapter.capabilities.some(capability => capability.id === createItemCommandKind)).toBe(true)
    expect(adapter.capabilities.some(capability => capability.id === cancelCommandKind)).toBe(true)
  })

  test('Ambulance presentations derive readiness, custody and case demand from shared state', () => {
    const objects = responseScenario.initialObjects
    const ambulance = objects.find(object => object.id === 'amb:a12')!
    const patient = objects.find(object => object.id === 'patient:gronland-unattended:1')!
    const incident = objects.find(object => object.id === 'incident:gronland-unattended')!
    const unitPresentation = ambulancePack.presentation.presentObject(ambulance, { objects })
    expectFieldKeys(unitPresentation, ['capacity', 'on-board', 'patients', 'capabilities', 'mobilization', 'scene'])
    expect(unitPresentation.status?.tone).toBe('ready')
    expect(unitPresentation.fields.find(field => field.key === 'on-board')?.value).toBe('0')
    const patientPresentation = ambulancePack.presentation.presentObject(patient, { objects })
    expect(patientPresentation.mapIconVisible).toBe(false)
    expectFieldKeys(patientPresentation, ['urgency', 'needs', 'incident', 'holder'])
    const incidentPresentation = ambulancePack.presentation.presentObject(incident, { objects })
    expect(incidentPresentation.fields.find(field => field.key === 'patients')?.value).toBe('3 / 3')
    expect(incidentPresentation.status?.label).toBe('Awaiting first response')
  })

  test('care-site presentation shows actual handovers, not clinical bed counters', async () => {
    const initial = structuredClone(responseScenario.initialObjects.filter(object => object.packId === 'ambulance')).map(object => object.id === 'amb:a12' ? {
      ...object, packData: { ...responseUnitPackDataSchema.parse(object.packData), mobilizationSeconds: 0, sceneSeconds: 0 },
    } : object)
    const epoch = Date.parse(responseScenario.world.startsAt)
    const engine = createAmbulanceSimEngine({ simulationRunId: 'run-presentation' as SimulationRunId, objects: initial, simulationTimeMs: epoch, routing: {
      id: 'test-fast', route: async request => ({ geometry: { type: 'LineString', coordinates: [request.from.coordinates, request.to.coordinates] }, distanceM: 1 as import('../src/core/model/index.ts').Meters, durationSeconds: 1, provider: 'test-fast' }),
    } })
    const command = commandEnvelopeSchema.parse({ id: 'command:present', simulationRunId: 'run-presentation', actorId: 'actor:test', issuedAt: nowIso(), kind: assignCommandKind, targetObjectIds: [], payload: {
      unitId: 'amb:a12', incidentId: 'incident:gronland-unattended', patientIds: ['patient:gronland-unattended:1'],
    } }) as CommandEnvelope
    expect((await engine.handleCommand(command)).result.ok).toBe(true)
    const append = commandEnvelopeSchema.parse({ id: 'command:append', simulationRunId: 'run-presentation', actorId: 'actor:test', issuedAt: nowIso(), kind: appendStopCommandKind, targetObjectIds: [], payload: {
      kind: 'handover', unitId: 'amb:a12', careSiteId: 'facility:ous', patientIds: ['patient:gronland-unattended:1'],
    } }) as CommandEnvelope
    expect((await engine.handleCommand(append)).result.ok).toBe(true)
    engine.advanceTo(epoch + 2_000)
    const snapshot = engine.snapshot().objects
    const site = snapshot.find(object => object.id === 'facility:ous')!
    const presentation = ambulancePack.presentation.presentObject(site, { objects: snapshot })
    expect(presentation.status?.label).toBe('1/2 handover slots occupied')
    expect(presentation.fields.find(field => field.key === 'slots')?.value).toBe('2')
    const closedSite = { ...site, packData: { ...careSitePackDataSchema.parse(site.packData), accepting: false } }
    expect(ambulancePack.presentation.presentObject(closedSite, { objects: snapshot }).status?.label).toBe('Closed to arrivals')
    expect(presentation.fields.some(field => field.key === 'trauma-beds')).toBe(false)
  })

  test('the Ambulance browser view lists its own categories and carries map assignment', async () => {
    const pack = await loadActivePackViews(['ambulance'])

    expect(pack.packIds).toEqual(['ambulance'])
    expect(pack.presentation.categories.map(category => category.id)).toEqual([
      'ambulances',
      'helicopters',
      'incidents',
      'patients',
      'care-sites',
    ])
    expect(pack.creation?.createObjectTypes ?? []).toEqual([])
    expect(pack.surfacePanels).toEqual([])
    expect(pack.packs[0]?.mapAssignment).toBeDefined()
    const view = await loadUiPack('ambulance')
    expect(view).not.toBe(ambulancePack)
    expect(Object.hasOwn(view, 'scenarioConfigSchema')).toBe(false)
    expect(Object.hasOwn(view, 'scenario')).toBe(false)
  })

  test('starts the Halden dispatch exercise with real responses underway and advances their routes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-fast-forward-dispatch-'))
    const registry = createDispatchRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'halden-dispatch' })
      await source.setClock({ paused: true })
      const sourceUnits = source.snapshot().objects.filter(object =>
        object.packId === 'ambulance' && (object.packData as { type?: string }).type === 'response-unit')
      const responding = sourceUnits.filter(object =>
        (object.packData as { assignment?: { phase?: string } }).assignment?.phase === 'responding')
      expect(responding.map(object => String(object.id)).sort()).toEqual(['unit:halden-1', 'unit:halden-2'])
      expect(sourceUnits.find(object => object.id === 'unit:sarpsborg-1')?.operational.status).toBe('available')
      expect(sourceUnits.find(object => object.id === 'unit:helo-ostfold')?.operational.status).toBe('mobilizing')
      expect((sourceUnits.find(object => object.id === 'unit:helo-ostfold')?.packData as { patientCapacity?: number }).patientCapacity).toBe(2)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const incident = source.snapshot().objects.find(object => object.id === 'incident:e6-collision')!
        if ((incident.packData as { observations?: unknown[] }).observations?.length) break
        await Bun.sleep(5)
      }
      const observedIncident = source.snapshot().objects.find(object => object.id === 'incident:e6-collision')!
      expect((observedIncident.packData as { observations?: Array<{ casualtyCount: number }> }).observations?.at(-1)?.casualtyCount).toBe(3)
      expect(source.snapshot().objects.filter(object => object.packId === 'drone')).toHaveLength(2)

      const startingPoints = new Map(responding.map(object => [object.id, object.spatial.position?.point.coordinates]))
      const copy = await registry.copy(source.id, {})
      await registry.advanceExecution(copy.id, { minutes: 0.1, onComplete: 'pause' })
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if ((await registry.executionStatus(copy.id)).acceleration?.status !== 'running') break
        await Bun.sleep(25)
      }
      expect(await registry.executionStatus(copy.id)).toMatchObject({ playback: 'paused', pace: 'realtime', acceleration: { status: 'completed' } })
      const moved = copy.snapshot().objects.filter(object => startingPoints.has(object.id)).some(object =>
        JSON.stringify(object.spatial.position?.point.coordinates) !== JSON.stringify(startingPoints.get(object.id)))
      expect(moved).toBe(true)
    } finally { await registry.shutdown() }
  })
})
