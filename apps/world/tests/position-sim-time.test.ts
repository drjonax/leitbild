import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { maximumPaceStepMs } from '../src/core/simulation-runs/execution.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'

// T13, core half (plan v3.1 §2.2 V8; architecture A3, C7, ruling R19): the Packs that write positions stamp each fix
// with the Run's simulation time (`simAt`); `observedAt` stays as each Pack writes it. A Pack advances before the Run's
// clock is set, so at maximum pace a fix may lead the committed clock by at most one slice.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('T13: position fixes carry simulation time', () => {
  for (const [scenarioId, packs] of [['halden-dispatch', ['ambulance', 'drone']], ['halden-weather-response', ['weather', 'ambulance']], ['halden-emergency', ['einsatz']]] as const) {
    test(`${scenarioId}: every ${packs.join(' and ')} fix names its simulation time`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-sim-at-'))
      const registry = createSimulationRunRegistry({
        dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
        compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
        scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
        scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
      })
      cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
      const run = await registry.create({ scenarioId })
      await run.setClock({ paused: true })
      const scenarioStart = Date.parse((await registry.compiledScenarioForRun(run.id)).world.startsAt)
      const startsAt = Date.parse(run.snapshot().clock!.currentTime)
      await run.runMaximumPace(new Date(startsAt + 30_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
      const clock = Date.parse(run.snapshot().clock!.currentTime)
      const fixes = run.snapshot().objects.filter(object => (packs as ReadonlyArray<string>).includes(object.packId) && object.spatial.position !== undefined)
      expect(new Set<string>(fixes.map(object => object.packId))).toEqual(new Set<string>(packs))
      for (const object of fixes) {
        const simAt = object.spatial.position!.simAt
        expect({ id: object.id, stamped: simAt !== undefined }).toEqual({ id: object.id, stamped: true })
        expect(Date.parse(simAt!)).toBeGreaterThanOrEqual(scenarioStart)
        expect(Date.parse(simAt!)).toBeLessThanOrEqual(clock + maximumPaceStepMs)
      }
    })
  }
})
