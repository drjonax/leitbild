import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import type { ActorId, ObjectId } from '../src/core/model/index.ts'
import type { ObservationDeclaration } from '../src/core/observation/capabilities.ts'
import { observableSchema, quantityUnits } from '../src/core/observation/model.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { observationProviderFor } from '../src/features/displays/observation/port.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T12, core half (plan v3.1 §2.2, Appendix F; rulings R25, R26): every declaring Pack names its observables with the
// core quantities and unit codes; labels are unique within each object, "<object label> · <label>" is unique per Run,
// and so are object labels; plant `power` and grid `active-power` meet as `electric-power`. Measured on the two
// four-unit Halden Scenarios, the power complex (with weather) and the loss of offsite power, and on the integrated
// fixture of every Pack.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const integrated = scenarioDefinitionSchema.parse(await Bun.file(new URL('./fixtures/scenarios/integrated-all-packs.scenario.json', import.meta.url)).json())
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('T12: observation coverage on the four-unit Halden', () => {
  for (const [scenarioId, packs] of [['halden-power-complex', ['process-plant', 'electric-grid', 'weather']], ['halden-offsite-power-restoration', ['process-plant', 'electric-grid']], [integrated.id, ['process-plant', 'electric-grid', 'weather']]] as const) test(`${scenarioId}: core quantities and codes, unique labels, one electric power`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-coverage-'))
    const registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [...builtinScenarioDefinitions, integrated],
      compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }),
    })
    cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const run = await registry.create({ scenarioId })
    await run.setClock({ paused: true })
    const port = run.observations({ id: 'actor:human:coverage' as ActorId, label: 'Coverage', role: 'operator' })
    const objects = run.snapshot().objects
    const observed = objects.filter(object => observationProviderFor(run.packs())(object) !== undefined)
    expect(new Set<string>(observed.map(object => object.packId))).toEqual(new Set(packs))
    expect(observed.filter(object => object.packId === 'process-plant')).toHaveLength(4)

    // Every declaration, with a grid's per-element observables read in element batches.
    const declarations: ObservationDeclaration[] = []
    for (const object of observed) {
      const [declaration] = await port.declarations([object.id])
      if (!declaration || 'refused' in declaration) throw new Error(`${object.id} declares nothing`)
      declarations.push(declaration)
      for (let start = 0; start < declaration.elements.length; start += 256) {
        const [batch] = await port.declarations([object.id], declaration.elements.slice(start, start + 256).map(element => element.id))
        if (!batch || 'refused' in batch) throw new Error(`${object.id} refuses its elements`)
        declarations.push({ ...batch, elements: [] })
      }
    }
    // One entry per ref: a Pack whose declaration is not element-scoped answers every batch with all it declares.
    const observables = [...new Map(declarations.flatMap(declaration => declaration.observables.map(observable => [observable.ref, { objectId: declaration.objectId, observable }] as const))).values()]
    expect(observables.length).toBeGreaterThan(4 * 1_000)
    for (const { observable } of observables) {
      expect(observableSchema.safeParse(observable).success).toBe(true)
      expect((quantityUnits[observable.quantity] as ReadonlyArray<string>)).toContain(observable.unit)
    }

    const labelOf = new Map(objects.map(object => [object.id, object.label]))
    for (const objectId of new Set(observables.map(entry => entry.objectId))) {
      const labels = observables.filter(entry => entry.objectId === objectId).map(entry => entry.observable.label)
      expect({ objectId, repeated: labels.filter((label, at) => labels.indexOf(label) !== at) }).toEqual({ objectId, repeated: [] })
    }
    const qualified = observables.map(({ objectId, observable }) => `${labelOf.get(objectId as ObjectId)} · ${observable.label}`)
    expect(qualified.filter((label, at) => qualified.indexOf(label) !== at)).toEqual([])
    const objectLabels = objects.map(object => object.label)
    expect(objectLabels.filter((label, at) => objectLabels.indexOf(label) !== at)).toEqual([])

    const electric = (packId: string) => observables.filter(({ objectId, observable }) =>
      objects.find(object => object.id === objectId)?.packId === packId && observable.quantity === 'electric-power')
    expect(electric('process-plant').length).toBeGreaterThan(0)
    expect(electric('electric-grid').length).toBeGreaterThan(0)
  })
})
