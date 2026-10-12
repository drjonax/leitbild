// Role-Run fixtures for World core tests: the test-only fixture Pack, opted
// into role Runs, two otherwise identical Scenario Definitions, one that
// declares roles and one that does not, and a sided Definition whose ids and
// labels carry a per-run nonce.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import type { ScenarioRole, ScenarioRolePreset, ScenarioSide } from '../../src/core/model/index.ts'
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

export const sides: ReadonlyArray<ScenarioSide> = [
  { id: 'red', label: 'Red', colour: '#c62828' },
  { id: 'blue', label: 'Blue', colour: '#1565c0' },
]

export const sidedRoles: ReadonlyArray<ScenarioRole> = [
  { id: 'red-lead', label: 'Red lead', class: 'operator', sees: ['red'] },
  { id: 'blue-lead', label: 'Blue lead', class: 'operator', sees: ['blue'] },
  { id: 'umpire', label: 'Umpire', class: 'operator', sees: 'all' },
  { id: 'control', label: 'Controller', class: 'controller', sees: 'all' },
]

/**
 * The ids and labels of a sided fixture Run. Each carries the nonce after a
 * name no other name starts with, so finding one in a message is exact.
 */
export const sidedNames = (nonce: string) => {
  const object = (kind: string, name: string) => ({ id: `${kind}:${name}-${nonce}`, label: `${name} ${nonce}` })
  return {
    depot: object('site', 'depot'),
    redUnit: object('unit', 'redunit'),
    redTask: object('task', 'redtask'),
    blueUnit: object('unit', 'blueunit'),
    blueTask: object('task', 'bluetask'),
    hidden: object('site', 'hiddensite'),
    redCued: object('unit', 'redcued'),
    blueCued: object('unit', 'bluecued'),
  }
}

/**
 * A Run with Red and Blue: each side's unit and task, a public depot, and a
 * site only truth roles see. Its opening highlights the Red unit and shows
 * guidance naming the depot; a cue a minute in creates one unit per side.
 * Unsided, the same Run declares the same roles without sides or audiences,
 * so every role is a truth role.
 */
export const sidedRunDefinition = (nonce: string, options: { readonly sided: boolean } = { sided: true }) => {
  const names = sidedNames(nonce)
  const audienceOf = (audience: 'public' | ReadonlyArray<string>) => options.sided ? { audience } : {}
  const item = (type: 'unit' | 'site' | 'task', name: { readonly id: string; readonly label: string }, audience: 'public' | ReadonlyArray<string>, extra: Record<string, unknown>) =>
    ({ id: name.id, label: name.label, type, ...audienceOf(audience), ...extra })
  const cuedUnit = (name: { readonly id: string; readonly label: string }, side: string, crew: string, position: readonly [number, number]) =>
    ({ type: 'invoke_capability', capabilityId: 'world.fixture.create-item', input: { item: { type: 'unit', id: name.id, label: name.label, position, speedMps: 10, crew, ...audienceOf([side]) } } })
  return {
    id: options.sided ? 'sided-run' : 'unsided-run',
    title: options.sided ? 'Sided Run' : 'Unsided Run',
    ...(options.sided ? { sides } : {}),
    roles: options.sided ? sidedRoles : sidedRoles.map(({ sees: _sees, ...role }) => role),
    packs: [{
      id: 'fixture',
      config: { authority: [{ roleId: 'red-lead', crews: ['alpha'] }, { roleId: 'blue-lead', crews: ['bravo'] }] },
      items: [
        item('site', names.depot, 'public', { position: [10.75, 59.93] }),
        item('unit', names.redUnit, ['red'], { position: [10.80, 59.95], speedMps: 12, crew: 'alpha' }),
        item('task', names.redTask, ['red'], { position: [10.79, 59.94], priority: 'high' }),
        item('unit', names.blueUnit, ['blue'], { position: [10.70, 59.91], speedMps: 12, crew: 'bravo' }),
        item('task', names.blueTask, ['blue'], { position: [10.71, 59.92], priority: 'normal' }),
        item('site', names.hidden, [], { position: [10.76, 59.94] }),
      ],
    }],
    world: { startsAt: '2026-01-01T08:00:00.000Z' },
    view: { map: { center: [10.75, 59.93], zoom: 12 } },
    timeline: {
      cues: [
        {
          id: 'opening',
          at: { kind: 'after_scenario_start', seconds: 0 },
          actions: [
            { type: 'highlight_objects', objectIds: [names.redUnit.id] },
            { type: 'show_guidance', guidance: { id: 'brief', title: 'Brief', message: 'Hold the depot.', objectIds: [names.depot.id] } },
          ],
        },
        { id: 'red-arrives', at: { kind: 'after_scenario_start', seconds: 60 }, actions: [cuedUnit(names.redCued, 'red', 'alpha', [10.81, 59.96])] },
        { id: 'blue-arrives', at: { kind: 'after_scenario_start', seconds: 60 }, actions: [cuedUnit(names.blueCued, 'blue', 'bravo', [10.69, 59.90])] },
      ],
    },
  }
}

export const compileWithRolePacks = async (source: unknown, packs: ReadonlyArray<WorldPack> = roleRunPacks) =>
  await compileScenarioDefinition(source, packs, { routing: createDirectRoutingAdapter() })

const authoring = (packs: ReadonlyArray<WorldPack>, extraDefinitions: ReadonlyArray<unknown> = []) => ({
  scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs }),
  scenarioDefinitions: [roleRunDefinition, openRunDefinition, ...extraDefinitions].map(definition => scenarioDefinitionSchema.parse(definition)),
  compileScenarioDefinition: (source: unknown) => compileWithRolePacks(source, packs),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(packs),
  runtimeAdapters: [createFixturePackRuntimeAdapter()],
})

export const createRoleRunRegistry = async (extraDefinitions: ReadonlyArray<unknown> = []): Promise<SimulationRunRegistry> =>
  createSimulationRunRegistry({
    dataDir: await mkdtemp(join(tmpdir(), 'leitbild-role-runs-')),
    workspaceId: newWorkspaceId(),
    ...authoring(roleRunPacks, extraDefinitions),
  })

/** Workspaces whose Packs are the role-aware fixture Pack, plus any a test adds to compile against. */
export const createRoleRunWorkspaces = async (
  packs: ReadonlyArray<WorldPack> = roleRunPacks,
  extraDefinitions: ReadonlyArray<unknown> = [],
): Promise<{ readonly workspaces: WorldWorkspaceRuntimeRegistry; readonly dataDir: string }> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-role-workspaces-'))
  return {
    dataDir,
    workspaces: createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), ...authoring(packs, extraDefinitions) }),
  }
}
