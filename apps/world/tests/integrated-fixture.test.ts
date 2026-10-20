import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import type { ActorId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The integrated all-pack evaluation fixture (plan v3.1 §6, V14): every World pack but situation-monitor in one Halden
// Run, for the Run context (T08), the replay (T09) and the cross-pack worry scenarios. It lives beside the tests and is
// never in the product catalog; the display probe saves it in its own Workspace (scripts/display-eval, fixture:<name>).

const fixtureFile = join(import.meta.dir, 'fixtures', 'scenarios', 'integrated-all-packs.scenario.json')
const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const viewer: Actor = { id: 'actor:human:integrated-fixture' as ActorId, label: 'Integrated fixture viewer', role: 'operator' }
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const registryOn = (dataDir: string, workspaceId: ReturnType<typeof newWorkspaceId>, fixture: ReturnType<typeof scenarioDefinitionSchema.parse>) => createSimulationRunRegistry({
  dataDir,
  workspaceId,
  scenarioDefinitions: [...builtinScenarioDefinitions, fixture],
  compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs),
  runtimeAdapters: assembly.runtimeAdapters,
  scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
})

// Each object's identity, lifecycle and status: what a restored Run must give back unchanged.
const states = (objects: ReadonlyArray<any>) => objects.map(object => `${object.id} ${object.lifecycle} ${object.operational?.status ?? '-'}`).sort()

describe('the integrated all-pack fixture', () => {
  test('is no product Scenario, holds six packs in open mode, plays two simulated minutes with its cues and restores', async () => {
    const fixture = scenarioDefinitionSchema.parse(await Bun.file(fixtureFile).json())
    expect(builtinScenarioDefinitions.some(definition => definition.id === fixture.id)).toBe(false)
    expect(fixture.packs.map(pack => pack.id).sort()).toEqual(['ambulance', 'drone', 'einsatz', 'electric-grid', 'process-plant', 'weather'])
    // Einsatz runs in open mode: the fixture declares no roles, so the Assistant is not refused.
    expect('roles' in fixture).toBe(false)

    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-integrated-fixture-'))
    const workspaceId = newWorkspaceId()
    const first = registryOn(dataDir, workspaceId, fixture)
    cleanups.push(async () => { await first.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const run = await first.create({ scenarioId: fixture.id })
    await run.setClock({ paused: true })
    const packsPresent = new Set(run.snapshot().objects.map(object => String(object.packId)))
    expect([...packsPresent].sort()).toEqual(['ambulance', 'drone', 'einsatz', 'electric-grid', 'process-plant', 'weather'])
    // No live pack (situation-monitor is left out), so the Run fast-forwards: plan §6's realtime budget came from it (architecture E15).
    expect((await first.executionStatus(run.id)).maximumPace).toEqual({ available: true })

    const startedAt = Date.parse(run.snapshot().clock!.currentTime)
    await run.runMaximumPace(new Date(startedAt + 120_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const played = run.snapshot()
    expect(Date.parse(played.clock!.currentTime)).toBeGreaterThanOrEqual(startedAt + 120_000)
    // The added cue fired: both circuits stand open.
    for (const assetId of ['branch:osm-1022cbf125eebbb4', 'branch:osm-50a77b48767677b0']) {
      const outcome = await run.invokeCapability(viewer, { capabilityId: 'world.electric-grid.asset.get', input: { gridId: 'grid:halden-four-unit', assetId } })
      if (outcome.kind !== 'query') throw new Error('asset.get is not a query')
      expect((outcome.result as { asset: { status: { label: string } } }).asset.status.label).toBe('Open')
    }
    // Every cue due in the two minutes started: the dispatch exercise's, the supply run's and the added one.
    const due = fixture.timeline!.cues.filter(cue => cue.at.kind === 'after_scenario_start' && cue.at.seconds <= 120).map(cue => cue.id).sort()
    const started = run.events().flatMap(event => event.type === 'scenario.cue.started' ? [event.cueId] : []).sort()
    expect(started).toEqual(due)
    expect(due).toContain('tegneby-north-trips')
    const savedObjects = states(played.objects)
    const savedClock = played.clock!.currentTime
    const savedEvents = run.events().length
    await first.shutdown()

    // A fresh registry on the same data restores the Run as it was and plays on.
    const second = registryOn(dataDir, workspaceId, fixture)
    cleanups.push(() => second.shutdown())
    const restored = await second.load(run.id as SimulationRunId)
    expect(states(restored.snapshot().objects)).toEqual(savedObjects)
    expect(restored.snapshot().clock!.currentTime).toBe(savedClock)
    expect(restored.events().length).toBeGreaterThanOrEqual(savedEvents)
    await restored.runMaximumPace(new Date(Date.parse(savedClock) + 2_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    expect(Date.parse(restored.snapshot().clock!.currentTime)).toBeGreaterThanOrEqual(Date.parse(savedClock) + 2_000)
  })
})
