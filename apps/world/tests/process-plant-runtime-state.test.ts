import { describe, expect, test } from 'bun:test'
import type {
  ActorId,
  CommandEnvelope,
  CommandId,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  PackRuntimeRecordingBatch,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock } from '../src/core/model/time.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import { createRunHistorian } from '../src/features/historian/store.ts'
import type { PackRuntimeConnection, PackRuntimeQuery, PackRuntimeStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantPackRuntimeAdapter,
  processPlantControlRampCommandKind,
  processPlantControlWriteCommandKind,
  processPlantPwrReferenceModelRef,
  processPlantUnitPackDataSchema,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

const simulationRunId = 'run:process-plant-test' as SimulationRunId
const issuedAt = '2026-01-01T09:00:00.000Z' as IsoTimestamp
const builtIn = scenarios.find(scenario => scenario.id === 'test-plant')
if (builtIn === undefined) throw new Error('Halden Process Plant scenario is required by runtime tests')
const basePlant = builtIn.initialObjects.find(object => object.packId === 'process-plant')
if (basePlant === undefined) throw new Error('Halden Process Plant scenario has no Plant')

const createMemoryStateStore = (): PackRuntimeStateStore => {
  let state: unknown | null = null
  return {
    load: async () => state,
    save: async next => { state = structuredClone(next) },
  }
}

/** A paused Run clock: real-time Pack ticks see no elapsed time, so only `advance` moves the Plants. */
const pausedRunClock = (): SimulationClock => createSimulationClock({ currentTime: builtIn.world.startsAt, updatedAt: issuedAt, paused: true })

/** Advances the Pack by `ms` of simulation time as the Run does at maximum pace. */
const advance = async (connection: PackRuntimeConnection, runClock: SimulationClock, ms: number): Promise<void> => {
  const current = runClock.read()
  const next = { ...current, currentTime: new Date(Date.parse(current.currentTime) + ms).toISOString() as IsoTimestamp }
  if (!connection.advanceTo) throw new Error('process-plant runtime cannot advance to a Run clock')
  await connection.advanceTo(next)
  runClock.set(next)
}

const scenarioWithPlants = (plants: ReadonlyArray<OperationalObject> = [basePlant]) => ({
  scenarioId: builtIn.id,
  runtimeIds: ['process-plant.local'],
  connections: [],
  world: builtIn.world,
  initialObjects: plants,
  runtimeConfig: {},
})

const query = (capabilityId: string, input: unknown = {}): PackRuntimeQuery => ({
  capabilityId,
  input,
})

const command = (kind: string, payload: unknown): CommandEnvelope => ({
  id: `command:${crypto.randomUUID()}` as CommandId,
  simulationRunId,
  actorId: 'actor:operator' as ActorId,
  kind,
  targetObjectIds: [],
  payload,
  issuedAt,
})

describe('process plant Pack runtime lifecycle', () => {
  test('discovers Plants from Operational Objects and projects live status', async () => {
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
    })
    try {
      const snapshot = await connection.getSnapshot()
      expect(snapshot.objects.map(object => object.id)).toEqual([basePlant.id])
      const data = processPlantUnitPackDataSchema.parse(snapshot.objects[0]?.packData)
      expect(data.model.ref).toBe(processPlantPwrReferenceModelRef)
      // The panel leads with the values protection trips on and the energy source's and sink's, generated from the model.
      expect(data.projection?.fields.map(field => field.key)).toEqual(expect.arrayContaining(['core.powerRangePercent', 'pressurizer.pressureMPa', 'turbine.electricMw']))
      expect(data.projection?.summary).toMatch(/^Core thermal power [0-9]+ MW · Electrical output [0-9]+ MW$/)

      const read = await connection.invokeQuery(query('world.process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['core.totalThermalPowerMw', 'pressurizer.pressureMPa'],
      }))
      expect((read as { variables: ReadonlyArray<unknown> }).variables).toHaveLength(2)
    } finally {
      await connection.close()
    }
  })

  test('keeps commands isolated by Plant identity', async () => {
    const secondPlant: OperationalObject = {
      ...structuredClone(basePlant),
      id: 'plant:test-second' as ObjectId,
      label: 'Second test Plant',
      provenance: { ...basePlant.provenance, externalId: 'plant:test-second' },
    }
    const runClock = pausedRunClock()
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants([basePlant, secondPlant]),
      runtimeStateStore: createMemoryStateStore(),
      runClock,
    })
    try {
      const accepted = await connection.sendCommand(command(processPlantControlWriteCommandKind, {
        plantId: basePlant.id,
        path: 'rcpA.running',
        value: false,
      }), {})
      expect(accepted.ok).toBe(true)
      await advance(connection, runClock, 1_000)

      const first = await connection.invokeQuery(query('world.process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['rcpA.running'],
      }))
      const second = await connection.invokeQuery(query('world.process-plant.variables.read', {
        plantId: secondPlant.id,
        paths: ['rcpA.running'],
      }))
      expect((first as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(false)
      expect((second as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(true)
    } finally {
      await connection.close()
    }
  })

  test('persists queued commands and restores them against the same model', async () => {
    const stateStore = createMemoryStateStore()
    const first = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: stateStore,
      runClock: pausedRunClock(),
    })
    expect((await first.sendCommand(command(processPlantControlWriteCommandKind, {
      plantId: basePlant.id,
      path: 'rcpA.running',
      value: false,
    }), {})).ok).toBe(true)
    await first.close()

    const runClock = pausedRunClock()
    const restored = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: stateStore,
      runClock,
    })
    try {
      await advance(restored, runClock, 1_000)
      const read = await restored.invokeQuery(query('world.process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['rcpA.running'],
      }))
      expect((read as { variables: ReadonlyArray<{ value: unknown }> }).variables[0]?.value).toBe(false)
    } finally {
      await restored.close()
    }
  })

  test('applies typed ramps and exposes displays and automation through discovery', async () => {
    const runClock = pausedRunClock()
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
      runClock,
    })
    try {
      expect((await connection.sendCommand(command(processPlantControlRampCommandKind, {
        plantId: basePlant.id,
        path: 'turbine.loadFraction',
        targetValue: 0.5,
        durationSeconds: 1,
      }), {})).ok).toBe(true)
      await advance(connection, runClock, 1_000)

      const read = await connection.invokeQuery(query('world.process-plant.variables.read', {
        plantId: basePlant.id,
        paths: ['turbine.loadFraction'],
      }))
      expect((read as { variables: ReadonlyArray<{ value: number }> }).variables[0]?.value).toBeCloseTo(0.5, 2)

      const overview = await connection.invokeQuery(query('world.process-plant.display.overview', { plantId: basePlant.id }))
      expect(JSON.parse((overview as { view: { state: string } }).view.state)).toEqual({ overview: { plantId: basePlant.id } })

      const automation = await connection.invokeQuery(query('world.process-plant.ic.catalog', { plantId: basePlant.id })) as { ruleCount: number; returned: number; rules: ReadonlyArray<unknown> }
      expect(automation.rules.length).toBeGreaterThan(0)
      expect(automation.returned).toBe(automation.rules.length)
      expect(automation.ruleCount).toBeGreaterThanOrEqual(automation.returned)

      const catalog = await connection.invokeQuery(query('world.process-plant.catalog.list'))
      expect(catalog).toMatchObject({ models: [{ id: processPlantPwrReferenceModelRef }] })
    } finally {
      await connection.close()
    }
  })

  test('emits only the selected recording profile with discoverable series metadata', async () => {
    const runClock = pausedRunClock()
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
      recording: { packId: 'process-plant', profileId: 'operations', intervalMs: 250 },
      runClock,
    })
    try {
      const batches: PackRuntimeRecordingBatch[] = []
      connection.subscribe(emission => { if (emission.recording) batches.push(emission.recording) })
      await advance(connection, runClock, 250)
      expect(batches).toHaveLength(1)
      const batch = batches[0]!
      expect(batch.descriptors.length).toBeGreaterThan(0)
      expect(batch.samples).toHaveLength(batch.descriptors.length)
      expect(batch.descriptors.every(descriptor => descriptor.subjectId === basePlant.id)).toBe(true)
      expect(batch.descriptors.map(descriptor => descriptor.signalId)).toContain('core.totalThermalPowerMw')
      // Each title stands alone: the unit by its object's label, the equipment, and the tag where there is one.
      const titles = batch.descriptors.map(descriptor => descriptor.title)
      expect(new Set(titles).size).toBe(titles.length)
      expect(titles.every(title => title.startsWith(`${basePlant.label} · `))).toBe(true)
      expect(batch.descriptors.find(descriptor => descriptor.signalId === 'rcpA.speedFraction')?.title).toBe(`${basePlant.label} · Speed · Reactor Coolant Pump A (RCP-A-SPD)`)
    } finally {
      await connection.close()
    }
  })

  test('a Run recorded under earlier series titles keeps recording: a title is no series semantics', async () => {
    const runClock = pausedRunClock()
    const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants(),
      runtimeStateStore: createMemoryStateStore(),
      recording: { packId: 'process-plant', profileId: 'operations', intervalMs: 250 },
      runClock,
    })
    const historian = createRunHistorian(':memory:')
    try {
      const batches: PackRuntimeRecordingBatch[] = []
      connection.subscribe(emission => { if (emission.recording) batches.push(emission.recording) })
      await advance(connection, runClock, 250)
      const batch = batches[0]!
      // The history a saved Run holds: the same series, described with the titles plants were recorded under before.
      const id = recordingSeriesIdFor(basePlant.id, 'rcpA.speedFraction')
      const current = batch.descriptors.find(descriptor => descriptor.id === id)!
      historian.record('process-plant.local', { descriptors: batch.descriptors.map(descriptor => ({ ...descriptor, title: 'Reference PWR 4-loop plant · Speed' })), samples: [] })
      historian.record('process-plant.local', batch)
      expect(historian.status().sampleCount).toBe(batch.samples.length)
      // The stored description is kept; only series recorded afresh carry the new titles.
      expect(historian.listSeries().find(series => series.id === id)).toMatchObject({ title: 'Reference PWR 4-loop plant · Speed', unit: current.unit })
    } finally {
      historian.close()
      await connection.close()
    }
  })

  test('rejects unknown model refs before starting a Run', async () => {
    const data = processPlantUnitPackDataSchema.parse(basePlant.packData)
    const invalid: OperationalObject = {
      ...structuredClone(basePlant),
      packData: { ...data, model: { ...data.model, ref: 'process-plant.unknown' } },
    }
    await expect(createLocalProcessPlantPackRuntimeAdapter().connect({
      simulationRunId,
      scenario: scenarioWithPlants([invalid]),
      runtimeStateStore: createMemoryStateStore(),
    })).rejects.toThrow('unknown process plant model')
  })
})
