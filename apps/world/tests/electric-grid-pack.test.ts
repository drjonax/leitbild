import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { nowIso } from '../src/core/model/index.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { gridDerateBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import {
  gridDispatchGeneratorCommandKind,
  gridReturnGeneratorToServiceCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridTripGeneratorCommandKind,
} from '../src/packs/electric-grid/commands/generator.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition, compileGridModelIndex } from '../src/packs/electric-grid/definitions.ts'
import { electricGridPackDataSchema } from '../src/packs/electric-grid/model.ts'
import { electricGridPack } from '../src/packs/electric-grid/pack.ts'
import { addGridModelAssets, gridModelAdditionSchema } from '../src/packs/electric-grid/model-additions.ts'
import { balanceInitialGridDispatch, createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { electricGridRuntimeId } from '../src/packs/electric-grid/sim/constants.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { costsInReferences, referenceQuietMs } from './cpu-cost.ts'
import { scenarios } from './fixtures/scenarios.ts'
import type { PackRuntimeConnection, PackRuntimeEvent, PackRuntimeStateStore } from '../src/simulation/protocol.ts'

const simulationRunId = 'run-electric-grid-test' as SimulationRunId
const actorId = 'actor:electric-grid-test' as ActorId

const command = (config: {
  readonly kind: string
  readonly gridId: string
  readonly payload: unknown
}): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId,
  actorId,
  kind: config.kind,
  targetObjectIds: [config.gridId as ObjectId],
  payload: config.payload,
  issuedAt: nowIso(),
})

const gridScenario = () => {
  const scenario = scenarios.find(candidate => candidate.id === 'test-grid')
  if (!scenario) throw new Error('missing built-in test-grid scenario')
  return scenario
}

const connect = async (runtimeStateStore?: PackRuntimeStateStore): Promise<PackRuntimeConnection> => {
  const scenario = gridScenario()
  return await createLocalElectricGridPackRuntimeAdapter().connect({
    simulationRunId,
    ...(runtimeStateStore === undefined ? {} : { runtimeStateStore }),
    scenario: {
      scenarioId: scenario.id,
      runtimeIds: [electricGridRuntimeId],
      connections: [],
      world: scenario.world,
      initialObjects: scenario.initialObjects,
      runtimeConfigByRuntimeId: {},
      runtimeConfig: {},
    },
  })
}

const objectResult = (response: unknown): Record<string, unknown> => {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error('malformed query result')
  return response as Record<string, unknown>
}

describe('electric grid Pack', () => {
  test('composes declarative topology additions without coupling the compiler to Halden', async () => {
    const definition = (modelRef: string, operatingPointRef: string) => compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:test', model: { ref: modelRef }, operatingPoint: { ref: operatingPointRef }, automation: { ref: 'electric-grid.norway.standard' },
    }))
    const base = definition('electric-grid.norway.transmission', 'electric-grid.norway.normal').model
    const haldenJson = await Bun.file(new URL('../src/packs/electric-grid/models/halden.grid-model.json', import.meta.url)).json() as object
    const addition = gridModelAdditionSchema.parse({ ...haldenJson, id: 'electric-grid.test.addition', title: 'Test addition' })
    const combined = addGridModelAssets(base, addition, 'test addition')
    expect(combined.id).toBe('electric-grid.test.addition')
    expect(combined.buses.length).toBe(base.buses.length + addition.buses.length)
    expect(combined.generators).toEqual(base.generators)
    expect(() => compileGridModelIndex(combined)).not.toThrow()
    expect(() => compileGridModelIndex({ ...combined, connectionPoints: [{ ...combined.connectionPoints[0]!, busId: 'missing' }] })).toThrow()
    expect(() => addGridModelAssets(base, { ...addition, baseModelRef: 'missing' }, 'test addition')).toThrow('base mismatch')
    // A published model is an immutable artifact used by persisted Run state.
    expect(definition('electric-grid.halden.four-unit', 'electric-grid.halden.four-unit.normal').definitionDigest)
      .toBe('2f785ba0ebb800eb206d3d3890f8e3713d6bb6c06bd9802832b3c8dc889b8ac0')
    expect(definition('electric-grid.halden.four-unit', 'electric-grid.norway.normal').model.connectionPoints).toHaveLength(4)
  })

  test('compiles a Scenario to one Grid object with discoverable selections', () => {
    const scenario = gridScenario()
    const resolver = createScenarioRuntimeResolver({ packs: [electricGridPack, weatherPack] })
    const runtime = resolver.resolve(scenario)
    const gridObjects = scenario.initialObjects.filter(object => object.packId === 'electric-grid')

    expect(runtime?.runtimes).toContainEqual({ packId: 'electric-grid', runtimeId: electricGridRuntimeId, runtimeConfig: {} })
    expect(gridObjects).toHaveLength(1)
    expect(String(gridObjects[0]?.id)).toBe('grid:norway')
    expect(electricGridPack.authoring?.itemTypes.map(item => item.id)).toEqual(['grid'])
    expect(electricGridPack.presentation.categories.map(category => category.id)).toEqual(['electric-grids'])
    expect(electricGridPack.presentation.mapLayerGroups?.map(group => group.id)).toContain('electric-grid:reference-lines')
    expect(createLocalElectricGridPackRuntimeAdapter().capabilities.every(capability => capability.input !== undefined && capability.output !== undefined)).toBe(true)
    expect(electricGridPackDataSchema.parse(gridObjects[0]?.packData)).toMatchObject({
      model: { ref: 'electric-grid.norway.transmission' },
      operatingPoint: { ref: 'electric-grid.norway.normal' },
      automation: { ref: 'electric-grid.norway.standard' },
    })
  })

  test('keeps the shared snapshot compact while exposing private Grid Assets through bounded queries', async () => {
    const connection = await connect()
    try {
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects).toHaveLength(1)
      expect(JSON.stringify(snapshot).length).toBeLessThan(5_000)
      const data = electricGridPackDataSchema.parse(snapshot.objects[0]?.packData)
      expect(data.projection.tick).toBeGreaterThanOrEqual(1)
      expect(data.projection.totalGenerationMw).toBeGreaterThan(0)
      expect(data.projection.servedLoadMw).toBeGreaterThan(0)

      const search = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.assets.search',
        input: { gridId: 'grid:norway', kinds: ['branch'], limit: 10 },
      }))
      expect(search.total).toBeGreaterThan(250)
      expect((search.assets as unknown[]).length).toBe(10)
      expect((search.assets as ReadonlyArray<Record<string, unknown>>)[0]).toMatchObject({
        kind: 'branch',
        status: { tone: expect.any(String), label: expect.any(String) },
        applicableOperationIds: expect.any(Array),
        mapTarget: { kind: 'bounds' },
      })
      const firstBranch = (search.assets as ReadonlyArray<{ readonly id: string }>)[0]!
      const branchDetail = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:norway', assetId: firstBranch.id },
      }))
      expect(branchDetail.asset).toMatchObject({ definition: { sourceId: expect.any(String), sourceFeatureId: expect.any(String) } })

      const summary = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.grid.summary',
        input: { gridId: 'grid:norway' },
      }))
      expect(summary.assetCounts).toMatchObject({ bus: 255, generator: 70, load: 22, storage: 1 })
      expect((summary.constrainedBranches as unknown[]).length).toBeLessThanOrEqual(8)
      const connections = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.connection-points.list',
        input: { gridId: 'grid:norway' },
      })).connectionPoints as ReadonlyArray<unknown>
      expect(connections).toEqual([])
    } finally {
      await connection.close()
    }
  })

  test('targets private assets explicitly and persists command consequences on the Grid', async () => {
    const connection = await connect()
    try {
      const generators = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.assets.search', input: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const branches = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.assets.search', input: { gridId: 'grid:norway', kinds: ['branch'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const generatorId = generators[0]!.id
      const branchId = branches[0]!.id
      const before = objectResult(await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:norway' } }))
      const beforeReserve = (before.projection as { readonly reserveMarginMw: number }).reserveMarginMw

      const dispatch = await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 0 } }))
      const trip = await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))
      const derate = await connection.sendCommand(command({ kind: gridDerateBranchCommandKind, gridId: 'grid:norway', payload: { assetId: branchId, availability: 0.6 } }))
      expect(dispatch.ok).toBe(true)
      expect(trip.ok).toBe(true)
      expect(derate.ok).toBe(true)

      const generator = objectResult(await connection.invokeQuery({ capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:norway', assetId: generatorId } }))
      const branch = objectResult(await connection.invokeQuery({ capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:norway', assetId: branchId } }))
      const after = objectResult(await connection.invokeQuery({ capabilityId: 'world.electric-grid.grid.summary', input: { gridId: 'grid:norway' } }))
      expect(generator.asset).toMatchObject({ state: { state: 'tripped', dispatchMw: 0, targetMw: 0 } })
      expect(branch.asset).toMatchObject({ state: { state: 'closed', availability: 0.6 }, status: { label: 'Derated 60%' } })
      expect((after.projection as { readonly reserveMarginMw: number }).reserveMarginMw).toBeLessThanOrEqual(beforeReserve)
    } finally {
      await connection.close()
    }
  })

  test('keeps generator availability separate from lifecycle state', async () => {
    const connection = await connect()
    try {
      const generators = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.assets.search', input: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const generatorId = generators[0]!.id
      expect((await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
      expect((await connection.sendCommand(command({ kind: gridSetGeneratorAvailabilityCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, availableMw: 50 } }))).ok).toBe(true)
      const tripped = objectResult(await connection.invokeQuery({ capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:norway', assetId: generatorId } }))
      expect(tripped.asset).toMatchObject({ state: { state: 'tripped', availableMw: 50 } })
      expect((await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 20 } }))).ok).toBe(false)
      expect((await connection.sendCommand(command({ kind: gridReturnGeneratorToServiceCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
      expect((await connection.sendCommand(command({ kind: gridDispatchGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId, targetMw: 20 } }))).ok).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('applies typed Operating Point overrides with exact generation semantics', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:scaled',
      model: data.model,
      operatingPoint: { ...data.operatingPoint, overrides: { loadScale: 0.8, generationAvailabilityScale: 0.5, storageStateOfCharge: 0.25 } },
      automation: data.automation,
    }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    const generator = definition.model.generators[0]!
    expect(grid.generators.get(generator.id)?.availableMw).toBeCloseTo(Math.min(generator.capacityMw, generator.availableMw * 0.5))
    const load = definition.model.loads[0]!
    expect(grid.loads.get(load.id)?.nominalDemandMw).toBeCloseTo(load.demandMw * 0.8)
    expect([...grid.storage.values()][0]?.stateOfChargeFraction).toBeCloseTo(0.25)
  })

  test('rejects invalid Model identity and references during compilation', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    expect(() => compileGridModelIndex({ ...definition.model, buses: [...definition.model.buses, definition.model.buses[0]!] })).toThrow('duplicate bus ids')
    expect(() => compileGridModelIndex({
      ...definition.model,
      branches: [{ ...definition.model.branches[0]!, fromBusId: 'missing:bus' }, ...definition.model.branches.slice(1)],
    })).toThrow('references unknown bus')
  })

  test('tracks storage energy, island frequency, and cached topology in private runtime state', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    advanceGrid(grid, 0, '2026-01-01T10:00:00.000Z' as IsoTimestamp)
    const firstPlan = grid.topologyPlan
    const storage = [...grid.storage.values()][0]!
    const initialCharge = storage.stateOfChargeFraction
    for (const generator of grid.generators.values()) {
      generator.state = 'tripped'
      generator.dispatchMw = 0
      generator.targetMw = 0
    }
    advanceGrid(grid, 2, '2026-01-01T10:00:02.000Z' as IsoTimestamp)
    advanceGrid(grid, 3_600, '2026-01-01T11:00:02.000Z' as IsoTimestamp)
    expect(grid.topologyPlan).toBe(firstPlan)
    expect(new Set([...grid.busStates.values()].map(state => state.islandId)).size).toBeGreaterThanOrEqual(grid.projection.activeIslandCount)
    expect(grid.projection.activeIslandCount).toBeGreaterThan(0)
    expect(storage.dispatchMw).toBeGreaterThan(0)
    expect(storage.stateOfChargeFraction).toBeLessThan(initialCharge)

    const branchId = definition.model.branches[0]!.id
    grid.branches.get(branchId)!.state = 'open'
    advanceGrid(grid, 1, '2026-01-01T11:00:01.000Z' as IsoTimestamp)
    expect(grid.topologyPlan).not.toBe(firstPlan)
  })

  test('external supply loss lowers the connected island frequency against a time-aligned control', () => {
    const scenario = scenarios.find(candidate => candidate.id === 'halden-power-complex')!
    const object = scenario.initialObjects.find(candidate => candidate.packId === 'electric-grid')!
    const data = electricGridPackDataSchema.parse(object.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
    const setup = () => {
      const grid = createGridRuntimeInstance({ definition, at, connections: scenario.connections.filter(connection => connection.type === 'electrical') })
      // A controlled, non-saturated operating point isolates the coupling. The
      // authored four-full-power-unit scenario is deliberately left unchanged.
      for (const point of grid.externalConnections.values()) { point.connected = true; point.systemActivePowerMw = 200 }
      balanceInitialGridDispatch(grid)
      advanceGrid(grid, 0, at)
      return grid
    }
    const control = setup(), tripped = setup()
    const lost = [...tripped.externalConnections.values()][0]!
    lost.systemActivePowerMw = 0
    const islandId = tripped.busStates.get(lost.busId)!.islandId
    for (let second = 1; second <= 10; second += 1) {
      const time = new Date(Date.parse(at) + second * 1_000).toISOString() as IsoTimestamp
      advanceGrid(control, 1, time)
      advanceGrid(tripped, 1, time)
    }
    expect(tripped.busStates.get(lost.busId)!.frequencyHz).toBeLessThan(control.busStates.get(lost.busId)!.frequencyHz - 0.01)
    expect(tripped.projection.totalGenerationMw).toBeLessThan(control.projection.totalGenerationMw)
    for (const [id, state] of tripped.busStates) {
      if (state.islandId !== islandId) expect(state.frequencyHz).toBe(control.busStates.get(id)!.frequencyHz)
    }
  })

  // A tick's cost is the main-thread CPU time of a ten-tick batch in
  // reference computations timed immediately before it, per tick, the median
  // of five batches (cpu-cost.ts), not wall time, which measures a loaded
  // shared machine.
  test('keeps steady-topology Grid ticks within the lightweight runtime budget of 5 ms quiet', () => {
    const data = electricGridPackDataSchema.parse(gridScenario().initialObjects.find(object => object.id === 'grid:norway')?.packData)
    const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: 'grid:norway', model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
    const grid = createGridRuntimeInstance({ definition, at: '2026-01-01T10:00:00.000Z' })
    advanceGrid(grid, 0, '2026-01-01T10:00:00.000Z' as IsoTimestamp)
    let ticks = 0
    const tenTicks = (): void => {
      for (let tick = 0; tick < 10; tick += 1) {
        ticks += 1
        advanceGrid(grid, 2, new Date(Date.parse('2026-01-01T10:00:00.000Z') + ticks * 2_000).toISOString() as IsoTimestamp)
      }
    }
    const [cost] = costsInReferences([tenTicks], 5)
    expect(ticks).toBe(50)
    expect(cost! / 10).toBeLessThan(5 / referenceQuietMs)
    expect(grid.diagnostics.topologyRebuildCount).toBe(1)
    expect(grid.diagnostics.lastSuccessfulTickAt).not.toBeNull()
  })

  test('records a compact Grid projection when an operator changes a private asset', async () => {
    const connection = await connect()
    try {
      const emitted: ReadonlyArray<PackRuntimeEvent>[] = []
      const unsubscribe = connection.subscribe(emission => emitted.push(emission.events))
      const generators = objectResult(await connection.invokeQuery({
        capabilityId: 'world.electric-grid.assets.search', input: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
      })).assets as ReadonlyArray<{ readonly id: string }>
      const result = await connection.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generators[0]!.id } }))
      unsubscribe()
      expect(result.ok).toBe(true)
      const objectEvents = emitted.flat().filter(event => event.type === 'object.upserted')
      expect(objectEvents).toHaveLength(1)
      expect(objectEvents[0]).toMatchObject({ history: 'record', object: { id: 'grid:norway' } })
    } finally {
      await connection.close()
    }
  })

  test('restores private asset controls only against the exact resolved Grid definition', async () => {
    let stored: unknown = null
    const store: PackRuntimeStateStore = {
      load: async () => stored,
      save: async state => { stored = state },
    }
    const first = await connect(store)
    const generators = objectResult(await first.invokeQuery({
      capabilityId: 'world.electric-grid.assets.search', input: { gridId: 'grid:norway', kinds: ['generator'], limit: 1 },
    })).assets as ReadonlyArray<{ readonly id: string }>
    const generatorId = generators[0]!.id
    expect((await first.sendCommand(command({ kind: gridTripGeneratorCommandKind, gridId: 'grid:norway', payload: { assetId: generatorId } }))).ok).toBe(true)
    await first.close()

    const restored = await connect(store)
    try {
      const generator = objectResult(await restored.invokeQuery({
        capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:norway', assetId: generatorId },
      }))
      expect(generator.asset).toMatchObject({ state: { state: 'tripped', dispatchMw: 0, targetMw: 0 } })
    } finally {
      await restored.close()
    }

    const invalid = structuredClone(stored) as { grids: Array<{ definitionDigest: string }> }
    invalid.grids[0]!.definitionDigest = '0'.repeat(64)
    stored = invalid
    await expect(connect(store)).rejects.toThrow('does not match its resolved Model, Operating Point, and Automation definition')
  })
})
