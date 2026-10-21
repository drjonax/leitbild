import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import { leadRefs } from '../src/features/displays/compose/defaults.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { compileVignette, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'

guardPlantTests()

// Architecture A3: the World default of every subject kind, for each of the six Packs of the integrated fixture and the
// fixture Pack, from what they declare: at most four views, each only where its data exists, every number from a read.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const integrated = scenarioDefinitionSchema.parse(await Bun.file(new URL('./fixtures/scenarios/integrated-all-packs.scenario.json', import.meta.url)).json())
const person = { id: 'actor:human:defaults' as ActorId, label: 'Defaults', role: 'operator' as const }
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-defaults-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [...builtinScenarioDefinitions, integrated],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
  })
  const runtime = await registry.create({ scenarioId: integrated.id })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + 60_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

const kinds = (sections: ReadonlyArray<VignetteSection>) => sections.map(section => section.kind)
const opened = async (viewRun: ViewRun, subject: Parameters<typeof composeDefault>[1]) => {
  const outcome = await composeDefault(viewRun, subject)
  if (!outcome.ok) throw new Error(`${JSON.stringify(subject)}: ${JSON.stringify(outcome.issues)}`)
  const view = await compileVignette(viewRun, outcome.state)
  const sample = await sampleVignette(viewRun, outcome.state, { fromMs: 0 })
  expect(outcome.state.views.length).toBeLessThanOrEqual(4)
  expect(outcome.rows).toBeLessThanOrEqual(40)
  expect(JSON.stringify(outcome.state)).not.toMatch(/"value"|"limits"|coordinates/)
  // Every number on the card is one a read gave: an observation's value, a threshold, or an object's slot.
  return { ...outcome, view, sample }
}
const firstElement = async (objectId: string, cls?: string) => {
  const [declaration] = await run.port.declarations([objectId as ObjectId])
  if (declaration === undefined || 'refused' in declaration) throw new Error(`${objectId} declares nothing`)
  return declaration.elements.find(element => cls === undefined || element.class === cls)!.id
}

describe('World defaults of every subject kind', () => {
  test('declared objects lead with their Pack\'s lead values (plant, grid, weather)', async () => {
    for (const objectId of ['plant:halden-1', 'grid:halden-four-unit', 'weather-probe:halden-complex']) {
      const { view, card, sample } = await opened(run, objectId)
      expect(kinds(view.sections)[0]).toBe('values')
      expect(card.items.length).toBeGreaterThan(0)
      expect(sample.observations.length).toBeGreaterThan(0)
      expect(card.items.slice(0, 2).map(item => item.subject)).toEqual((await leadRefs(run, objectId as ObjectId)).slice(0, 2).map(ref => ({ ref })))
    }
    const grid = await opened(run, 'grid:halden-four-unit')
    const drawing = grid.view.sections.find(section => section.kind === 'topology')
    expect(drawing?.kind === 'topology' && [drawing.family, drawing.nodes.length > 0]).toEqual(['network', true])
  })

  test('entity-floor objects show their core slots and a map focus (ambulance, drone, Einsatz)', async () => {
    for (const objectId of ['unit:halden-1', 'drone:halden-search', 'unit:truck-1', 'site:brekke-depot']) {
      const { view, card, sample } = await opened(run, objectId)
      expect(kinds(view.sections)).toEqual(['slots', 'map'])
      expect(card.items.length).toBeGreaterThan(0)
      expect(sample.maps[1]?.positioned).toBe(1)
    }
    const drone = await opened(run, 'drone:halden-search')
    expect(drone.view.sections[0]?.kind === 'slots' && drone.view.sections[0].slots.some(slot => slot.key.startsWith('telemetry:'))).toBe(true)
  })

  test('elements and observables show what is measured on them (plant, grid, weather)', async () => {
    const bus = await opened(run, `grid:halden-four-unit#${await firstElement('grid:halden-four-unit', 'bus')}`)
    expect(kinds(bus.view.sections)).toEqual(expect.arrayContaining(['values', 'topology']))
    expect(kinds((await opened(run, `plant:halden-1#${await firstElement('plant:halden-1')}`)).view.sections)[0]).toBe('values')
    for (const objectId of ['plant:halden-1', 'grid:halden-four-unit', 'weather-probe:halden-complex']) {
      const [ref] = await leadRefs(run, objectId as ObjectId)
      const { card } = await opened(run, ref!)
      expect(card.items[0]?.subject).toEqual({ ref: ref! })
    }
  })

  test('a connection shows both ends\' electric values and its alerts; its title comes from its ends', async () => {
    const tie = await opened(run, 'halden-unit-1-grid')
    expect(kinds(tie.view.sections)[0]).toBe('values')
    expect(new Set(tie.card.items.flatMap(item => item.subject !== undefined && 'ref' in item.subject ? [item.subject.ref.split('#')[0]] : []))).toEqual(new Set(['plant:halden-1', 'grid:halden-four-unit']))
    expect(tie.state.title).toBe(`${run.objects.find(object => object.id === 'plant:halden-1')!.label} – ${run.objects.find(object => object.id === 'grid:halden-four-unit')!.label}`)
  })

  test('every presentation category of every Pack opens as a table with its map', async () => {
    for (const pack of run.packs) {
      for (const category of pack.presentation.categories) {
        const { view, sample } = await opened(run, { of: { category: `${category.label} (${pack.descriptor.id})`, closed: false } })
        expect(kinds(view.sections)).toEqual(expect.arrayContaining(['entity', 'map']))
        expect(sample.entities[0]?.rows.every(row => run.objects.find(object => object.id === row.objectId)?.packId === pack.descriptor.id)).toBe(true)
      }
    }
  })

  test('the fixture Pack, which World knows nothing of, has the same defaults', async () => {
    const fixture = await fixtureComposeRun()
    try {
      const fixtureRun = await fixture.runOf()
      expect(kinds((await opened(fixtureRun, 'unit:one')).view.sections)).toEqual(['values', 'topology'])
      expect(kinds((await opened(fixtureRun, 'site:base')).view.sections)).toEqual(['slots', 'map'])
      expect(kinds((await opened(fixtureRun, 'unit:one#engine')).view.sections)).toEqual(['values', 'topology'])
      expect(kinds((await opened(fixtureRun, { of: { category: 'tasks', closed: false } })).view.sections)).toEqual(['entity', 'map'])
    } finally { await fixture.close() }
  })
})
