// The fork-only N-unit Halden fixtures (halden-fleet-8, halden-fleet-12): identical PWR units in one cluster, for fleet
// and unit-comparison displays at scale. They live beside the tests, never in the product catalog; the display probe
// saves them in its own Workspace (scripts/display-eval, fixture:<name>).
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../../src/app-assembly.ts'
import { displayRunOf } from '../../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp } from '../../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../../src/core/scenarios/runtime-resolver.ts'
import type { Actor } from '../../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../../src/core/simulation-runs/registry.ts'
import type { ViewRun } from '../../src/features/displays/compose/view.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../../src/scenarios/definitions.ts'

export type FleetSize = 8 | 12
export const fleetFixtureFile = (units: FleetSize): string => join(import.meta.dir, 'scenarios', `halden-fleet-${units}.scenario.json`)
export const fleetFixture = async (units: FleetSize): Promise<ScenarioDefinition> => scenarioDefinitionSchema.parse(await Bun.file(fleetFixtureFile(units)).json())

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
export const fleetViewer: Actor = { id: 'actor:human:fleet' as ActorId, label: 'Fleet viewer', role: 'operator' }

/** A paused Run of an N-unit fixture, played `seconds` at maximum pace; the test holds no lease, so no idle close. */
export const fleetRun = async (units: FleetSize, seconds = 5) => {
  const fixture = await fleetFixture(units)
  const dataDir = await mkdtemp(join(tmpdir(), `leitbild-fleet-${units}-`))
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: [...builtinScenarioDefinitions, fixture],
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  const runtime = await registry.create({ scenarioId: fixture.id })
  await runtime.setClock({ paused: true })
  const start = Date.parse(runtime.snapshot().clock!.currentTime)
  const play = (until: number) => runtime.runMaximumPace(new Date(start + until * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  await play(seconds)
  const runOf = (): Promise<ViewRun> => displayRunOf(registry, runtime, fleetViewer, new Set())
  return { fixture, registry, runtime, play, runOf, close: async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) } }
}
