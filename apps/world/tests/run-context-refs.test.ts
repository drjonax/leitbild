import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { assembleRunContext } from '../src/features/displays/context/run-context.ts'
import { observationProviderFor } from '../src/features/displays/observation/port.ts'
import { resolveName, searchObservables, type SearchRun } from '../src/features/displays/observation/search.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Refs the Assistant reads are whole and resolve (G1: T08 full refs; the resolver round trip). The Run context never
// cuts a ref to fit a line, and every ref search returns resolves exactly, a grid element's included, which its Pack
// declares only on request.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const integrated = scenarioDefinitionSchema.parse(await Bun.file(new URL('./fixtures/scenarios/integrated-all-packs.scenario.json', import.meta.url)).json())
const person = { id: 'actor:human:refs' as ActorId, label: 'Refs', role: 'operator' as const }
let registry: SimulationRunRegistry
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const runOf = async (scenarioId: string, seconds = 5): Promise<SimulationRunRuntime> => {
  if (registry === undefined) {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-refs-'))
    registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [...builtinScenarioDefinitions, integrated],
      compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
      // An unleased test Run is never closed as idle: under load a read came after the 30 s idle close.
      idleRuntimeCloseTimer: () => () => {},
    })
    cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  }
  const run = await registry.create({ scenarioId })
  await run.setClock({ paused: true })
  await run.runMaximumPace(new Date(Date.parse(run.snapshot().clock!.currentTime) + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  return run
}
const searchRunOf = (run: SimulationRunRuntime): SearchRun => ({ objects: run.snapshot().objects, denied: new Set(), packs: run.packs(), port: run.observations(person) })

describe('T08: the Run context never cuts a ref', () => {
  // The loss of offsite power after its switchyard fault (2 min), when trips and long lead refs fill the asset lines.
  for (const [scenarioId, seconds] of [['halden-offsite-power-restoration', 180], [integrated.id, 60], ['halden-normal-operation', 30], ['rogaland-black-start', 30]] as const) {
    test(`${scenarioId}: every ref in the context is whole, and dropped refs are counted`, async () => {
      const run = await runOf(scenarioId, seconds)
      const snapshot = run.snapshot()
      const { text } = await assembleRunContext({ title: scenarioId, objects: snapshot.objects, denied: new Set(), clock: snapshot.clock, packs: run.packs(), port: run.observations(person) })
      const leads = text.split('\n').flatMap(line => line.includes(' · lead: ') ? [line.slice(line.indexOf(' · lead: ') + ' · lead: '.length).split(', ')] : [])
      expect(leads.length).toBeGreaterThan(0)
      const refs = leads.flat().filter(entry => !/^\+\d+ refs$/.test(entry) && entry !== 'none declared')
      expect(refs.length).toBeGreaterThan(0)
      for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(400)
      const read = await run.observations(person).read({ refs })
      expect({ unknown: read.unknown, refused: read.refused }).toEqual({ unknown: [], refused: [] })
      expect(new Set(read.observations.map(observation => observation.ref))).toEqual(new Set(refs))
    })
  }
})

describe('every ref search returns resolves exactly', () => {
  test('plant, grid (element-scoped values included) and weather refs from the integrated fixture', async () => {
    const run = await runOf(integrated.id)
    const searchRun = searchRunOf(run)
    const observed = run.snapshot().objects.filter(object => observationProviderFor(run.packs())(object) !== undefined)
    // A grid generator by its label brings the values its Pack declares only for that element.
    const grid = observed.find(object => object.packId === 'electric-grid')!
    const [declaration] = await searchRun.port.declarations([grid.id as ObjectId])
    if (!declaration || 'refused' in declaration) throw new Error('the grid declares nothing')
    const generator = declaration.elements.find(element => element.class === 'generator')!
    const results = await searchObservables(searchRun, [{ text: 'SG pressure' }, { text: 'pressurizer pressure' }, { text: generator.label }, { text: 'frequency', pack: 'electric-grid' }, { text: 'air temperature' }, { text: 'wind speed' }])
    const refs = [...new Set(results.flatMap(result => result.matches.flatMap(match => match.ref === undefined ? [] : [match.ref])))]
    const packs = new Set<string | undefined>(refs.map(ref => run.snapshot().objects.find(object => object.id === ref.slice(0, ref.indexOf('#')))?.packId))
    expect(packs).toEqual(new Set<string | undefined>(['process-plant', 'electric-grid', 'weather']))
    expect(refs.some(ref => ref.startsWith(`${grid.id}#`) && declaration.observables.every(observable => observable.ref !== ref))).toBe(true)
    for (const ref of refs) expect({ ref, resolved: await resolveName(searchRun, ref) }).toEqual({ ref, resolved: [ref] })
  })
})
