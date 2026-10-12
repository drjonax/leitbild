// Role-Run fixtures for World core tests: the test-only fixture Pack, opted
// into role Runs, and two otherwise identical Scenario Definitions, one that
// declares roles and one that does not.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import type { ScenarioRole, ScenarioRolePreset } from '../../src/core/model/index.ts'
import type { WorldPack } from '../../src/core/packs/protocol.ts'
import { scenarioAuthoringCatalogFor } from '../../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../../src/core/scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../../src/core/simulation-runs/registry.ts'
import { createWorldModuleState } from '../../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../../src/core/workspaces/runtime-registry.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { fixturePack } from './fixture-pack.ts'
import { createFixturePackRuntimeAdapter } from './fixture-runtime.ts'

export const roleAwareFixturePack: WorldPack = { ...fixturePack, roleAware: true }

export const roleRunPacks: ReadonlyArray<WorldPack> = [roleAwareFixturePack]

export const declaredRoles: ReadonlyArray<ScenarioRole> = [
  { id: 'dispatch', label: 'Dispatcher', class: 'operator' },
  { id: 'field', label: 'Field lead', class: 'operator' },
  { id: 'control', label: 'Controller', class: 'controller' },
]

export const declaredPresets: ReadonlyArray<ScenarioRolePreset> = [{ id: 'solo', label: 'Solo operator', roles: ['dispatch', 'field'] }]

const fixtureItems = [
  { id: 'site:base', label: 'Base', type: 'site', position: [10.7387, 59.9365] },
  { id: 'unit:one', label: 'Unit One', type: 'unit', atObject: 'site:base', speedMps: 15 },
  { id: 'unit:two', label: 'Unit Two', type: 'unit', position: [10.7707, 59.9146], speedMps: 15 },
  { id: 'task:one', label: 'Task One', type: 'task', position: [10.7874, 59.946], priority: 'high' },
]

export const openRunDefinition = {
  id: 'open-run',
  title: 'Open Run',
  packs: [{ id: 'fixture', config: {}, items: fixtureItems }],
  world: { startsAt: '2026-01-01T08:00:00.000Z' },
  view: { map: { center: [10.75, 59.93], zoom: 12 } },
}

export const roleRunDefinition = {
  ...openRunDefinition,
  id: 'role-run',
  title: 'Role Run',
  roles: declaredRoles,
  rolePresets: declaredPresets,
}

export const compileWithRolePacks = async (source: unknown, packs: ReadonlyArray<WorldPack> = roleRunPacks) =>
  await compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() })

const authoring = (packs: ReadonlyArray<WorldPack>) => ({
  scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }),
  scenarioDefinitions: [roleRunDefinition, openRunDefinition].map(definition => scenarioDefinitionSchema.parse(definition)),
  compileScenarioDefinition: (source: unknown) => compileWithRolePacks(source, packs),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs),
  runtimeAdapters: [createFixturePackRuntimeAdapter()],
})

export const createRoleRunRegistry = async (): Promise<SimulationRunRegistry> =>
  createSimulationRunRegistry({
    dataDir: await mkdtemp(join(tmpdir(), 'leitbild-role-runs-')),
    workspaceId: newWorkspaceId(),
    ...authoring(roleRunPacks),
  })

/** Workspaces whose Packs are the role-aware fixture Pack, plus any a test adds to compile against. */
export const createRoleRunWorkspaces = async (packs: ReadonlyArray<WorldPack> = roleRunPacks): Promise<{ readonly workspaces: WorldWorkspaceRuntimeRegistry; readonly dataDir: string }> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-role-workspaces-'))
  return {
    dataDir,
    workspaces: createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), ...authoring(packs) }),
  }
}
