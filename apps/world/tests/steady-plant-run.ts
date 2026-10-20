import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, IsoTimestamp, ObjectId, OperationalObject } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// One four-loop Plant at full power that holds there: the persistence
// fixture (test-plant) without its operating-point overrides, which trip it
// within two plant seconds. Paused, driven at maximum pace, recorded with the
// operations profile.

export const plantOperator: Actor = { id: 'actor:human:plant-operator' as ActorId, label: 'Plant operator', role: 'operator' }
export const plantAgent: Actor = { id: 'actor:ai:plant-agent' as ActorId, label: 'Plant agent', role: 'ai_agent' }
/** The Run itself, as its Scenario writes a boundary condition or a fault. */
export const plantScenario: Actor = { id: 'actor:plant-scenario' as ActorId, label: 'Plant scenario', role: 'system' }

const fixture = testScenarioDefinitions.find(definition => definition.id === 'test-plant')!
export const steadyPlantScenario = {
  ...fixture,
  id: 'test-plant-steady',
  title: 'Steady Plant at full power',
  packs: fixture.packs.map(pack => ({ ...pack, items: pack.items.map(item => ({ ...item, operatingPoint: { ref: 'process-plant.pwr.full-power' } })) })),
}

export interface SteadyPlantRun {
  readonly run: SimulationRunRuntime
  readonly plantId: ObjectId
  readonly dataDir: string
  /** Maximum pace to this many plant milliseconds after the start. */
  readonly runTo: (offsetMs: number) => Promise<unknown>
  readonly unit: () => OperationalObject
  readonly invoke: (actor: Actor, capabilityId: string, input: Record<string, unknown>) => Promise<any>
  /** Shuts the registry down, so the journal is flushed; the data directory stays until `remove`. */
  readonly shutdown: () => Promise<void>
  readonly remove: () => Promise<void>
}

export const createSteadyPlantRun = async (): Promise<SteadyPlantRun> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-steady-plant-'))
  const authoring = testScenarioAuthoring()
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), ...authoring, scenarioDefinitions: [...authoring.scenarioDefinitions, steadyPlantScenario],
    runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
  })
  const run = await registry.create({ scenarioId: steadyPlantScenario.id })
  await run.setClock({ paused: true })
  const plantId = run.snapshot().objects.find(object => object.packId === 'process-plant')!.id
  const start = Date.parse(run.snapshot().clock!.currentTime)
  let down = false
  const shutdown = async (): Promise<void> => {
    if (down) return
    down = true
    await registry.shutdown()
  }
  return {
    run,
    plantId,
    dataDir,
    runTo: offsetMs => run.runMaximumPace(new Date(start + offsetMs).toISOString() as IsoTimestamp, { shouldStop: () => false }),
    unit: () => run.snapshot().objects.find(object => object.id === plantId)!,
    invoke: async (actor, capabilityId, input) => (await run.invokeCapability(actor, { capabilityId, input: { plantId, ...input } })).result,
    shutdown,
    remove: async () => {
      await shutdown()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
