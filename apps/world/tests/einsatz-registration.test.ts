import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { accessContextSchema, moduleResourceCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { einsatzCommandIds, einsatzQueryIds } from '../src/packs/einsatz/capabilities.ts'
import { low, templates, types } from '../src/packs/einsatz/fixtures/engine-harness.ts'
import { groupConfig, groupItems, groupSides, groups } from '../src/packs/einsatz/fixtures/groups-run.ts'
import { definitionOf, lonLat, taskItem, unitItem } from '../src/packs/einsatz/fixtures/run-harness.ts'
import { einsatzPackId, einsatzRuntimeId } from '../src/packs/einsatz/ids.ts'
import type { RoutingAdapter } from '../src/routing/protocol.ts'
import { createRoleRunWorkspaces, roleRunPacks } from './fixtures/role-runs.ts'

/**
 * Einsatz as production registers it, beside Ambulance: the application
 * assembly hands it the same routing every road Pack gets, a routing outage
 * reaches the caller as a refusal and never as a straight line, and a Run
 * whose Definition declares only a Controller and groups publishes its roles
 * in the Run's catalog summary, which the Host reads to leave the Run
 * Assistant out.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A router that is down: every call fails, and each is counted. */
const offlineRouting = () => {
  const calls = { route: 0, table: 0 }
  const routing: RoutingAdapter = {
    id: 'offline',
    route: async () => { calls.route += 1; throw new Error('Router offline') },
    table: async () => { calls.table += 1; throw new Error('Router offline') },
  }
  return { routing, calls }
}

const openDefinition = {
  ...definitionOf([unitItem('c1', types.roadCarrier, lonLat(0)), taskItem('low1', templates.load, lonLat(0.01), { [low]: 1 })]),
  id: 'einsatz-registered-open',
}

/** Groups and a Controller, and no other declared role: every operator role is derived from a group. */
const groupsOnlyDefinition = {
  ...definitionOf(groupItems, undefined, {
    roles: [{ id: 'control', label: 'Control', class: 'controller', sees: 'all' }],
    sides: groupSides,
    config: { ...groupConfig, authority: [] },
  }),
  id: 'einsatz-groups-only',
}

const setup = async (routing: RoutingAdapter): Promise<{ readonly workspaces: WorldWorkspaceRuntimeRegistry; readonly workspaceId: WorkspaceId }> => {
  const assembly = createWorldApplicationAssembly({ routing })
  const einsatz = assembly.packs.find(pack => pack.descriptor.id === einsatzPackId)
  const adapter = assembly.runtimeAdapters.find(candidate => candidate.id === einsatzRuntimeId)
  if (einsatz === undefined || adapter === undefined) throw new Error('The World application assembly does not register Einsatz')
  const { workspaces, dataDir } = await createRoleRunWorkspaces([...roleRunPacks, einsatz], [openDefinition, groupsOnlyDefinition], [adapter])
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  return { workspaces, workspaceId }
}

const call = async <T>(workspaces: WorldWorkspaceRuntimeRegistry, path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: T }> => {
  const request = new Request(`http://world.test${path}`, init)
  const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
  if (!response) throw new Error(`Module route did not handle ${path}`)
  return { status: response.status, body: await response.json() as T }
}

const invoke = async <T>(workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, run: SimulationRunId, capabilityId: string, input: unknown) =>
  await call<T>(workspaces, `/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      capabilityId,
      input,
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run },
      access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: 'human', id: 'registration-test-person' } }),
    }),
  })

const createRun = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, scenarioId: string): Promise<SimulationRunId> =>
  await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId })).id)

describe('Einsatz registered in the World application assembly', () => {
  test('it stands beside Ambulance, which stays registered', () => {
    const assembly = createWorldApplicationAssembly({ routing: offlineRouting().routing })
    const ids = assembly.packs.map(pack => pack.descriptor.id)
    expect(ids).toContain('ambulance')
    expect(ids).toContain(einsatzPackId)
    expect(assembly.runtimeAdapters.map(adapter => String(adapter.id))).toEqual(expect.arrayContaining(['ambulance.local', einsatzRuntimeId]))
  })

  test('a road send goes to the assembly\'s router, and an outage is refused routing_unavailable, never sent in a straight line', async () => {
    const { routing, calls } = offlineRouting()
    const { workspaces, workspaceId } = await setup(routing)
    const run = await createRun(workspaces, workspaceId, openDefinition.id)
    const sent = await invoke<unknown>(workspaces, workspaceId, run, einsatzCommandIds.send, { units: ['c1'], to: { taskId: 'low1' } })
    expect(sent).toEqual({ status: 409, body: { error: { code: 'simulation_command_rejected', message: 'routing_unavailable: No route for C1: Router offline' } } })
    expect(calls.route).toBe(1)
    const recommended = await invoke<{ result: { proposal: { units: ReadonlyArray<{ unitId: string; eta: { kind: string; reason?: string } }> } } }>(workspaces, workspaceId, run, einsatzQueryIds.recommend, { taskId: 'low1' })
    expect(recommended.status).toBe(200)
    expect(recommended.body.result.proposal.units).toMatchObject([{ unitId: 'c1', eta: { kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: Router offline' } }])
    expect(calls.table).toBe(1)
  })

  test('a Run whose Definition declares only a Controller and groups publishes its derived roles in its summary', async () => {
    const { workspaces, workspaceId } = await setup(offlineRouting().routing)
    const grouped = await createRun(workspaces, workspaceId, groupsOnlyDefinition.id)
    const open = await createRun(workspaces, workspaceId, openDefinition.id)
    const { resources } = moduleResourceCollectionSchema.parse((await call(workspaces, `/internal/workspaces/${workspaceId}/resources`)).body)
    const summaryOf = (run: SimulationRunId) => resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === run)!.summary
    expect(summaryOf(grouped)).toContainEqual({ key: 'roles', label: 'Roles', kind: 'count', value: 1 + groups.length })
    expect(summaryOf(open).some(item => item.key === 'roles')).toBe(false)
  })
})
