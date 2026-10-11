import { describe,expect,test } from 'bun:test'
import {
  electricalPortFromObject,
  nowIso,
  type ActorId,
  type CommandId,
  type CompiledScenario,
  type EventId,
  type ObjectId,
  type SimulationRunEvent,
  type SimulationRunId,
} from '../src/core/model/index.ts'
import { z } from 'zod'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { electricGridPackDataSchema } from '../src/packs/electric-grid/model.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { processPlantActionInvokeCommandKind } from '../src/packs/process-plant/commands.ts'
import { processPlantPack } from '../src/packs/process-plant/pack.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { weatherSampleSchema } from '../src/packs/weather/model.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import { scenarios,testScenarioDefinitions } from './fixtures/scenarios.ts'

const simulationRunId = 'run:halden-four-unit-integration' as SimulationRunId
const packs = [processPlantPack, electricGridPack, weatherPack]
const connectScenario = (scenario: CompiledScenario) => {
  const resolved = createScenarioRuntimeResolver({ packs }).resolve(scenario)
  return createRuntimeHub([
    createLocalProcessPlantPackRuntimeAdapter(),
    createLocalElectricGridPackRuntimeAdapter(),
    createLocalWeatherPackRuntimeAdapter(),
  ]).connect({
    simulationRunId,
    scenario: {
      scenarioId: scenario.id,
      runtimeIds: resolved.runtimes.map(runtime => runtime.runtimeId),
      connections: scenario.connections,
      world: scenario.world,
      initialObjects: scenario.initialObjects,
      runtimeConfigByRuntimeId: resolved.runtimeConfigByRuntimeId,
      runtimeConfig: {},
    },
  })
}

describe('electrical Pack connection', () => {
  test('Weather composes without modifying Plant/Grid definitions or their electrical connections', async () => {
    const source = testScenarioDefinitions.find(candidate => candidate.id === 'halden-power-complex')!
    const withoutWeather = {
      ...source,
      packs: source.packs.filter(pack => pack.id !== 'weather'),
    }
    const standalone = await compileScenarioDefinition(withoutWeather, packs, { routing: createDirectRoutingAdapter() })
    const combined = scenarios.find(candidate => candidate.id === source.id)!
    expect(combined.initialObjects.filter(object => object.packId !== 'weather')).toEqual([...standalone.initialObjects])
    expect(combined.connections).toEqual(standalone.connections)
    expect(combined.initialObjects.filter(object => object.packId === 'weather')).toHaveLength(3)
    expect(combined.view.rail.sections.map(section => section.categoryId)).toContain('weather')
    const connection = await connectScenario(standalone)
    try {
      const result = await connection.invokeQuery({ capabilityId: 'world.process-plant.plants.list', input: {} }) as { plants: unknown[] }
      expect(result.plants).toHaveLength(4)
    } finally { await connection.close() }
  })
  test('rejects unresolved and multiply connected electrical ports at Scenario compilation', async () => {
    const source = testScenarioDefinitions.find(candidate => candidate.id === 'halden-power-complex')
    if (!source) throw new Error('missing Halden four-unit Scenario source')
    const badPort = structuredClone(source)
    badPort.connections[0]!.network.portId = 'missing-port'
    await expect(compileScenarioDefinition(badPort, packs, { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('unknown network port')

    const reversedRoles = structuredClone(source)
    const original = reversedRoles.connections[0]!
    reversedRoles.connections[0] = { ...original, system: original.network, network: original.system }
    await expect(compileScenarioDefinition(reversedRoles, packs, { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('system endpoint is not a system port')

    const duplicated = structuredClone(source)
    duplicated.connections[1]!.system = { ...duplicated.connections[0]!.system }
    await expect(compileScenarioDefinition(duplicated, packs, { routing: createDirectRoutingAdapter() }))
      .rejects.toThrow('electrical port is connected more than once')

    // Two Plants on one Grid connection point fail at the second connection's network endpoint.
    const sharedPoint = structuredClone(source)
    sharedPoint.connections[1]!.network = { ...sharedPoint.connections[0]!.network }
    const rejection = await compileScenarioDefinition(sharedPoint, packs, { routing: createDirectRoutingAdapter() }).then(() => null, (error: unknown) => error)
    expect(rejection).toBeInstanceOf(z.ZodError)
    expect((rejection as z.ZodError).issues.map(issue => [issue.path, issue.message])).toEqual([
      [['connections', 1, 'network'], 'electrical port is connected more than once: grid:halden-four-unit:unit-1-420kv'],
    ])
    // The Grid runtime refuses the same pair if it is ever handed one, instead of keeping the last.
    const halden = scenarios.find(candidate => candidate.id === source.id)!
    const gridObject = halden.initialObjects.find(object => object.id === 'grid:halden-four-unit' as ObjectId)!
    const gridData = electricGridPackDataSchema.parse(gridObject.packData)
    const gridDefinition = compileGridDefinition({ id: gridObject.id, model: gridData.model, operatingPoint: gridData.operatingPoint, automation: gridData.automation })
    const pair = [halden.connections[0]!, { ...halden.connections[1]!, network: halden.connections[0]!.network }]
    expect(() => createGridRuntimeInstance({ definition: gridDefinition, at: halden.world.startsAt, connections: pair }))
      .toThrow('Grid connection point grid:halden-four-unit:unit-1-420kv is connected by both halden-unit-1-grid and halden-unit-2-grid')

    const laterDeletion = structuredClone(source)
    laterDeletion.timeline = { cues: [{
      id: 'remove-connected-plant',
      at: { kind: 'after_scenario_start', seconds: 60 },
      actions: [{ type: 'invoke_capability', capabilityId: 'world.object.delete', input: { objectId: 'plant:halden-1' } }],
    }] }
    const compiled = await compileScenarioDefinition(laterDeletion, packs, { routing: createDirectRoutingAdapter() })
    expect(compiled.connections.map(connection => connection.id)).toContain('halden-unit-1-grid')
  })

  test('couples four independent Plants to Grid supply without duplicate generators', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')
    if (!scenario) throw new Error('missing Halden four-unit scenario')
    const connection = await connectScenario(scenario)
    let sequence = 0
    let committed = Promise.resolve()
    const unsubscribe = connection.subscribe(emission => {
      const events: SimulationRunEvent[] = emission.events.flatMap(event => {
        if (event.type !== 'object.upserted' && event.type !== 'object.deleted') return []
        sequence += 1
        return [{
          ...event,
          id: `event:electrical-integration:${sequence}` as EventId,
          simulationRunId,
          seq: sequence,
        } as SimulationRunEvent]
      })
      committed = committed.then(() => connection.observeCommittedEvents(events))
    })
    try {
      await Bun.sleep(3_200)
      await committed
      const before = await connection.getSnapshot()
      const gridBefore = before.objects.find(object => object.id === 'grid:halden-four-unit' as ObjectId)
      const plantBefore = before.objects.find(object => object.id === 'plant:halden-1' as ObjectId)
      if (!gridBefore || !plantBefore) throw new Error('connected runtime snapshot is incomplete')
      const weather = weatherSampleSchema.parse(await connection.invokeQuery({
        capabilityId: 'world.weather.sample-at-point', input: { point: plantBefore.spatial.position!.point },
      }))
      expect(weather.activeInfluenceIds).toContain('weather:halden-complex')
      expect(weather.state.atmosphere.precipitation.intensityMmPerHour).toBeGreaterThan(0)
      expect(before.objects.filter(object => object.packId === 'weather')).toHaveLength(3)
      const plantPortBefore = electricalPortFromObject(plantBefore, 'grid-420kv')
      const gridPortBefore = electricalPortFromObject(gridBefore, 'unit-1-420kv')
      expect(plantPortBefore?.state?.connected).toBe(true)
      expect(plantPortBefore?.state?.activePowerMw).toBeGreaterThan(800)
      expect(gridPortBefore?.state?.activePowerMw).toBeLessThan(-800)

      const beforeQuery = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const beforePoints = (beforeQuery as { connectionPoints: ReadonlyArray<{ connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(beforePoints).toHaveLength(4)
      expect(beforePoints.every(point => point.connected && point.systemActivePowerMw > 1000)).toBe(true)
      const summaryBefore = await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:halden-four-unit' } })
      const projectionBefore = (summaryBefore as { projection: { activeAlarmCount: number; frequencyHz: number | null; frequencyBasis: string; highestBranchLoadingPercent: number; totalGenerationMw: number } }).projection
      // The four units' surplus over the island's demand is exported over the real 420 kV ties to the
      // Nordic synchronous equivalent, so the island holds the Nordic normal band (±0.1 Hz).
      expect(projectionBefore.frequencyBasis).toBe('largest-load-energized-island')
      expect(Math.abs(projectionBefore.frequencyHz! - 50)).toBeLessThan(0.1)
      expect(projectionBefore.totalGenerationMw).toBeGreaterThanOrEqual(beforePoints.reduce((sum, point) => sum + point.systemActivePowerMw, 0))

      const trip = await connection.sendCommand({
        id: 'command:trip-halden-unit-1' as CommandId,
        simulationRunId,
        actorId: 'actor:integration-test' as ActorId,
        kind: processPlantActionInvokeCommandKind,
        targetObjectIds: ['plant:halden-1' as ObjectId],
        payload: { plantId: 'plant:halden-1', actionId: 'turbine-trip', parameters: {} },
        issuedAt: nowIso(),
      })
      expect(trip.ok).toBe(true)
      await Bun.sleep(8_500)
      await committed
      const after = await connection.getSnapshot()
      const plantAfter = after.objects.find(object => object.id === 'plant:halden-1' as ObjectId)
      if (!plantAfter) throw new Error('tripped Plant disappeared')
      expect(electricalPortFromObject(plantAfter, 'grid-420kv')?.state?.activePowerMw).toBeLessThan(plantPortBefore!.state!.activePowerMw * 0.45)
      const afterQuery = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const afterPoints = (afterQuery as { connectionPoints: ReadonlyArray<{ system: { objectId: string }; systemActivePowerMw: number }> }).connectionPoints
      expect(afterPoints.find(point => point.system.objectId === 'plant:halden-1')?.systemActivePowerMw).toBeLessThan(beforePoints[0]!.systemActivePowerMw * 0.45)
      const summaryAfter = await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:halden-four-unit' } })
      const projectionAfter = (summaryAfter as { projection: { frequencyHz: number | null; totalGenerationMw: number } }).projection
      // The lost infeed is contained by the island's and the Nordic equivalent's inertia and FCR:
      // frequency falls but stays above the 49.0 Hz reference-incident minimum.
      expect(projectionAfter.frequencyHz!).toBeLessThan(50)
      expect(projectionAfter.frequencyHz!).toBeGreaterThan(49)
      expect(projectionAfter.totalGenerationMw).toBeLessThan(projectionBefore.totalGenerationMw - 500)
    } finally {
      unsubscribe()
      await connection.close()
    }
  }, 120_000)

  test('removes a Plant runtime and its Grid exchange immediately on committed deletion', async () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')
    if (!scenario) throw new Error('missing Halden four-unit scenario')
    const connection = await connectScenario(scenario)
    try {
      const before = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const beforePoints = (before as { connectionPoints: ReadonlyArray<{ connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(beforePoints).toHaveLength(4)
      expect(beforePoints.every(point => point.connected && point.systemActivePowerMw > 800)).toBe(true)

      const deletedAt = nowIso()
      await connection.observeCommittedEvents([{
        id: 'event:delete-halden-unit-1' as EventId,
        simulationRunId,
        seq: 1,
        at: deletedAt,
        provenance: { source: 'operator' },
        type: 'object.deleted',
        objectId: 'plant:halden-1' as ObjectId,
      }])

      const plants = await connection.invokeQuery({
        capabilityId: 'world.process-plant.plants.list',
        input: {},
      })
      expect((plants as { plants: ReadonlyArray<{ id: string }> }).plants.map(plant => plant.id))
        .toEqual(['plant:halden-2', 'plant:halden-3', 'plant:halden-4'])

      const after = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:halden-four-unit' },
      })
      const afterPoints = (after as { connectionPoints: ReadonlyArray<{ id: string; connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(afterPoints.find(point => point.id === 'unit-1-420kv')).toMatchObject({ connected: false, systemActivePowerMw: 0 })
      expect(afterPoints.filter(point => point.connected)).toHaveLength(3)

      const snapshot = await connection.getSnapshot()
      const grid = snapshot.objects.find(object => object.id === 'grid:halden-four-unit' as ObjectId)
      if (!grid) throw new Error('Grid disappeared after connected Plant deletion')
      expect(electricalPortFromObject(grid, 'unit-1-420kv')?.state).toMatchObject({ connected: false, activePowerMw: 0 })

      const switchyard = await connection.invokeQuery({
        capabilityId: 'world.electric-grid.asset.get',
        input: { gridId: 'grid:halden-four-unit', assetId: 'bus:curated-halden-pwr-switchyard@420' },
      })
      expect(switchyard).toMatchObject({
        asset: {
          status: { tone: 'working', label: '3/4 connected' },
          summary: expect.stringMatching(/MW supplied · 3\/4 connected/),
        },
      })
    } finally {
      await connection.close()
    }
  })
})
