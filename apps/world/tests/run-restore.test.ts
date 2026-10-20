import { afterAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceId } from '@leitbild/contracts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { unpackFixtureRun } from './run-restore/fixture-runs.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T03 (plan v3.1 Appendix F): Runs saved at bacf7a115 restore with today's code: the four-unit Halden loss of offsite
// power and an Einsatz supply Run. Their journals carry no simulationTime; the plant runtime state is v1. A change that
// alters what a saved Run holds must keep these restoring (D4); a new stored field is listed and owner-signed.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const viewer: Actor = { id: 'actor:human:restore-viewer' as ActorId, label: 'Restore viewer', role: 'operator' }
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const restore = async (name: string) => {
  const { dataDir, runDir, meta } = await unpackFixtureRun(name)
  const registry: SimulationRunRegistry = createSimulationRunRegistry({
    dataDir,
    workspaceId: meta.workspaceId as WorkspaceId,
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
    runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
  })
  cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const saved = {
    snapshot: await Bun.file(join(runDir, 'snapshot.json')).json(),
    execution: await Bun.file(join(runDir, 'execution.json')).json(),
    events: (await Bun.file(join(runDir, 'events.jsonl')).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)),
  }
  const run = await registry.load(meta.runId as SimulationRunId)
  return { run, runDir, meta, saved }
}

// Saved events stay unstamped ("time unknown"); every event the restored Run commits carries its simulation time.
const expectNewEventsStamped = (run: Awaited<ReturnType<typeof restore>>['run'], saved: ReadonlyArray<{ readonly seq: number }>): void => {
  const lastSaved = Math.max(...saved.map(event => event.seq))
  const added = run.events().filter(event => event.seq > lastSaved)
  expect(added.length).toBeGreaterThan(0)
  expect(added.every(event => event.simulationTime !== undefined)).toBe(true)
  expect(run.events().filter(event => event.seq <= lastSaved).some(event => event.simulationTime !== undefined)).toBe(false)
}

// Each object's identity, lifecycle and status as the Run shows it: what a restored Run must give back unchanged.
const states = (objects: ReadonlyArray<any>) => objects.map(object => `${object.id} ${object.lifecycle} ${object.operational?.status ?? '-'}`).sort()

const query = async (run: Awaited<ReturnType<typeof restore>>['run'], capabilityId: string, input: Record<string, unknown>): Promise<any> => {
  const outcome = await run.invokeCapability(viewer, { capabilityId, input })
  if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
  return outcome.result
}

describe('T03: saved Runs restore', () => {
  test('the four-unit Halden loss of offsite power restores its objects, clock, journal and plant state v1', async () => {
    const { run, runDir, saved } = await restore('halden-loop')
    const snapshot = run.snapshot()
    expect(states(snapshot.objects)).toEqual(states(saved.snapshot.snapshot.objects))
    expect(snapshot.objects.filter(object => object.packId === 'process-plant')).toHaveLength(4)
    expect(snapshot.clock!.currentTime).toBe(saved.execution.execution.currentSimulationTime)
    expect(run.events().length).toBeGreaterThanOrEqual(saved.events.length)
    expect(saved.events.some((event: Record<string, unknown>) => 'simulationTime' in event)).toBe(false)
    // The stored Pack state envelope holds the plant runtime state v1, unchanged.
    const stored = await Bun.file(join(runDir, 'runtimes', 'process-plant.local.json')).json()
    expect(stored).toMatchObject({ schemaVersion: 1, runtimeId: 'process-plant.local' })
    expect(processPlantRuntimeStateSchema.parse(stored.state).plants.map(plant => plant.plantId)).toEqual(['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4'])
    // The restored Plants still read the loss: every unit off its grid, its diesels running.
    for (const plantId of ['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4']) {
      const read = await query(run, 'world.process-plant.signals.read', { plantId, signals: [{ tagId: 'GRID-AVAIL' }, { tagId: 'EDG-A-RUN' }] })
      expect(read.signals.map((entry: { variable: { value: unknown } }) => entry.variable.value)).toEqual([false, true])
    }
    // And they run on: a restored Run plays.
    const at = Date.parse(snapshot.clock!.currentTime)
    await run.runMaximumPace(new Date(at + 2_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    expect(Date.parse(run.snapshot().clock!.currentTime)).toBeGreaterThanOrEqual(at + 2_000)
    expectNewEventsStamped(run, saved.events)
  })

  test('the Einsatz supply Run restores its objects, clock and journal', async () => {
    const { run, saved } = await restore('einsatz-supply-run')
    const snapshot = run.snapshot()
    expect(states(snapshot.objects)).toEqual(states(saved.snapshot.snapshot.objects))
    expect(snapshot.objects.some(object => object.packId === 'einsatz')).toBe(true)
    expect(snapshot.clock!.currentTime).toBe(saved.execution.execution.currentSimulationTime)
    expect(run.events().length).toBeGreaterThanOrEqual(saved.events.length)
    expect(saved.events.some((event: Record<string, unknown>) => 'simulationTime' in event)).toBe(false)
    const at = Date.parse(snapshot.clock!.currentTime)
    await run.runMaximumPace(new Date(at + 2_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    expect(Date.parse(run.snapshot().clock!.currentTime)).toBeGreaterThanOrEqual(at + 2_000)
    expectNewEventsStamped(run, saved.events)
  })
})
