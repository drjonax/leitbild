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
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import type { VignetteView } from '../src/features/displays/compose/model.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { standsBeside } from '../src/ui/embed/vignette/grid.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Every element a four-loop Halden unit declares opens its World default: drawn, or refused with the reason the
// composer states; never a throw (the batteries, inverters and loads at the end of an electrical line once threw
// from the layout engine, drawn as bars joined only to each other).

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person = { id: 'actor:human:element-defaults' as ActorId, label: 'Element defaults', role: 'operator' as const }
const plantId = 'plant:halden-1' as ObjectId
let registry: SimulationRunRegistry
let dataDir: string
let run: ViewRun
/** Each element's default as compiled by the first test, for the tests after it. */
const views = new Map<string, VignetteView>()
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-element-defaults-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  await runtime.setClock({ paused: true })
  const start = Date.parse(runtime.snapshot().clock!.currentTime)
  await runtime.runMaximumPace(new Date(start + 30_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('element defaults on four-loop Halden', () => {
  test('every declared element composes and compiles, or is refused with a stated reason; none throws', async () => {
    const [declaration] = await run.port.declarations([plantId])
    if (declaration === undefined || 'refused' in declaration) throw new Error('the Plant declares nothing')
    expect(declaration.elements.length).toBeGreaterThan(50)
    expect(declaration.elements.map(element => element.id)).toEqual(expect.arrayContaining(['vitalBatteryA', 'dcInverterA', 'plantControlsLoadA']))
    const failures: string[] = []
    for (const element of declaration.elements) {
      const subject = `${plantId}#${element.id}`
      try {
        const outcome = await composeDefault(run, subject)
        if (!outcome.ok) {
          if (outcome.issues.length === 0 || outcome.issues.some(issue => issue.message === '')) failures.push(`${subject}: refused without a reason`)
          continue
        }
        views.set(element.id, await compileVignette(run, outcome.state))
      } catch (error) {
        failures.push(`${subject}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    expect(failures).toEqual([])
  }, 240_000)

  test('in an element\'s pop-over every default stacks its views at the pop-over\'s width: none keeps the window\'s 360 px column, so no value falls outside it', () => {
    // UX audit H3: SG A's default, beside its drawing in the window, kept that column inside the 304 px pop-over and
    // lost 4 of its 8 values, AFW flow to SG A among them.
    const beside = [...views].filter(([, view]) => view.beside === true)
    expect(beside.map(([id]) => id)).toEqual(expect.arrayContaining(['sgA']))
    expect(beside.filter(([, view]) => !standsBeside(view, true)).map(([id]) => id)).toEqual([])
    expect([...views].filter(([, view]) => standsBeside(view, false)).map(([id]) => id)).toEqual([])
    // Stacked, each values view has a row for each of its values (the pop-over draws every section but its drawings).
    const short = [...views].flatMap(([id, view]) => view.sections.flatMap(section => (section.kind === 'values' && section.rows < section.values.length ? [`${id}: ${section.values.length} values in ${section.rows} rows`] : [])))
    expect(short).toEqual([])
  })
})
