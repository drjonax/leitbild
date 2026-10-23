import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { objectIdSchema, type ActorId, type ObjectId } from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { fixtureObservationIds, fixturePack } from './fixtures/fixture-pack.ts'
import { createFixturePackRuntimeAdapter } from './fixtures/fixture-runtime.ts'
import { compileWithRolePacks, createRoleRunRegistry, createRoleRunWorkspaces, openRunDefinition, roleRunDefinition, sidedNames, sidedRunDefinition } from './fixtures/role-runs.ts'

// T25 (public half) and T06 for the observation port (plan v3.1 Appendix F, R10): a Pack's observation
// Capabilities are World's own, never in a catalog or on the public path, and World reads them only as the
// original caller, so that caller's restrictions, role and picture apply.

const person: Actor = { id: 'actor:human:observer' as ActorId, label: 'Observer', role: 'operator' }
const ai: Actor = { id: 'actor:ai:assistant' as ActorId, label: 'Assistant', role: 'ai_agent' }
const unitOne = objectIdSchema.parse('unit:one')
const unitTwo = objectIdSchema.parse('unit:two')
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const roleRegistry = async (extra: ReadonlyArray<unknown> = []): Promise<SimulationRunRegistry> => {
  const registry = await createRoleRunRegistry(extra)
  cleanups.push(async () => { await registry.shutdown() })
  return registry
}
const codeOf = (entry: unknown): string | undefined => (entry as { refused?: { code: string } }).refused?.code

describe('T25: observation Capabilities are World\'s own', () => {
  test('no catalog lists them and neither the broker nor the Run serves them to a caller', async () => {
    const { workspaces, dataDir } = await createRoleRunWorkspaces()
    cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const workspaceId = newWorkspaceId() as WorkspaceId
    const call = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://world.test${path}`, init)
      const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces as WorldWorkspaceRuntimeRegistry))!
      return { status: response.status, body: await response.json() as any }
    }
    await call(`/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
    const runs = workspaces.getLoaded(workspaceId)!.simulationRuns
    const run = await runs.create({ scenarioId: 'open-run' })
    const ids = Object.values(fixtureObservationIds)
    const catalog = (await call(`/internal/workspaces/${workspaceId}/capabilities`)).body.capabilities.map((entry: { id: string }) => entry.id)
    expect(catalog).toContain('world.fixture.state')
    expect(catalog.filter((id: string) => ids.includes(id as never))).toEqual([])
    expect(run.capabilities().capabilities.map(entry => entry.id).filter(id => ids.includes(id as never))).toEqual([])
    expect((await runs.summary(run.id)).activeCapabilityIds.filter(id => ids.includes(id as never))).toEqual([])
    for (const kind of ['ai', 'human'] as const) {
      const access = accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: `${kind}-caller` } })
      const refused = await call(`/internal/workspaces/${workspaceId}/capabilities/${fixtureObservationIds.read}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, capabilityId: fixtureObservationIds.read, resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id }, input: { refs: ['unit:one#speed'] }, access }),
      })
      expect([refused.status, refused.body.error.code]).toEqual([404, 'capability_not_found'])
    }
    await expect(run.invokeCapability(person, { capabilityId: fixtureObservationIds.read, input: { refs: ['unit:one#speed'] } }))
      .rejects.toMatchObject({ code: 'capability_not_public' })
  })
})

describe('the observation port', () => {
  test('reads declarations, values and topology as the caller; warm calls come back unchanged from the Pack', async () => {
    const run = await (await roleRegistry()).create({ scenarioId: 'open-run' })
    const port = run.observations(person)
    const [declared, task, missing] = await port.declarations([unitOne, objectIdSchema.parse('task:one'), objectIdSchema.parse('unit:none')])
    expect(declared).toMatchObject({ objectId: 'unit:one', revision: 'fixture-observation-1' })
    expect((declared as { observables: Array<{ ref: string }> }).observables.map(observable => observable.ref)).toEqual(['unit:one#speed', 'unit:one#status'])
    expect([codeOf(task), codeOf(missing)]).toEqual(['not_observed', 'unknown_object'])
    expect((await port.declarations([unitOne]))[0]).toBe(declared)

    const read = await port.read({ refs: ['unit:one#speed', 'unit:one#odometer', 'unit:two#status'] })
    expect(read.observations.map(observation => [observation.ref, observation.clock])).toEqual([['unit:one#speed', 'simulation'], ['unit:two#status', 'simulation']])
    expect([read.unknown, read.refused]).toEqual([['unit:one#odometer'], []])
    const lead = await port.read({ leads: [{ objectId: unitOne, count: 1 }] })
    expect([lead.observations.map(observation => observation.ref), lead.leads]).toEqual([['unit:one#speed'], [['unit:one#speed']]])

    const graph = await port.topology(unitOne)
    expect(graph).toMatchObject({ objectId: 'unit:one', family: 'flow' })
    expect(await port.topology(unitOne)).toBe(graph)
    expect(codeOf(await port.topology(objectIdSchema.parse('task:one')))).toBe('not_observed')
    // The cache is the Run's: another caller's warm call still runs, and gets the same validated graph.
    expect(await run.observations(ai).topology(unitOne)).toBe(graph)
  })
})

describe('T06: the port reads only what its caller may', () => {
  test('an object the AI may not inspect is refused for it alone, and for nobody else', async () => {
    const run = await (await roleRegistry()).create({ scenarioId: 'open-run' })
    await run.setAgentRestrictions(person, { operationIds: [], objects: [{ objectId: unitOne, deny: ['inspect'] }] }, 0)
    const port = run.observations(ai)
    const [one, two] = await port.declarations([unitOne, unitTwo])
    expect([codeOf(one), (two as { objectId: string }).objectId]).toEqual(['agent_access_restricted', 'unit:two'])
    const read = await port.read({ refs: ['unit:one#speed', 'unit:two#speed'] })
    expect([read.observations.map(observation => observation.ref), read.refused.map(entry => [entry.objectId, entry.refused.code])])
      .toEqual([['unit:two#speed'], [['unit:one', 'agent_access_restricted']]])
    expect(codeOf(await port.topology(unitOne))).toBe('agent_access_restricted')
    const lead = await port.read({ refs: ['unit:two#speed'], leads: [{ objectId: unitOne, count: 2 }] })
    expect([codeOf(lead.refused[0]), lead.leads, lead.observations.map(observation => observation.ref)]).toEqual(['agent_access_restricted', [[]], ['unit:two#speed']])
    expect((await run.observations(person).declarations([unitOne]))[0]).toMatchObject({ objectId: 'unit:one' })
  })

  test('a restricted operation is refused for the AI on every object', async () => {
    const run = await (await roleRegistry()).create({ scenarioId: 'open-run' })
    await run.setAgentRestrictions(person, { operationIds: [fixtureObservationIds.read], objects: [] }, 0)
    const read = await run.observations(ai).read({ refs: ['unit:one#speed', 'unit:two#speed'] })
    expect([read.observations, read.refused.map(entry => entry.refused.code)]).toEqual([[], ['agent_access_restricted', 'agent_access_restricted']])
    expect((await run.observations(ai).declarations([unitOne]))[0]).toMatchObject({ objectId: 'unit:one' })
  })

  test('the AI is refused in a Run that declares roles', async () => {
    const run = await (await roleRegistry()).create({ scenarioId: 'role-run' })
    expect(codeOf((await run.observations(ai).declarations([unitOne]))[0])).toBe('ai_role_run_unsupported')
    expect(codeOf(await run.observations(ai).topology(unitOne))).toBe('ai_role_run_unsupported')
  })

  test('a side view reads observations only of role-aware Packs, and those answer within its picture', async () => {
    const nonce = crypto.randomUUID().slice(0, 8)
    const names = sidedNames(nonce)
    const red: Actor = { id: 'actor:human:red' as ActorId, label: 'Red lead', role: 'operator', roleIds: ['red-lead'] }
    const redUnit = objectIdSchema.parse(names.redUnit.id)
    // Role-aware: the red lead reads its own unit.
    const aware = await (await roleRegistry([sidedRunDefinition(nonce)])).create({ scenarioId: 'sided-run' })
    expect((await aware.observations(red).declarations([redUnit]))[0]).toMatchObject({ objectId: redUnit })
    // The same Run on a Pack that never accepted the role obligations: refused before it reaches the Pack.
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-observation-side-'))
    const registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: [fixturePack] }),
      scenarioDefinitions: [sidedRunDefinition(nonce)].map(definition => scenarioDefinitionSchema.parse(definition)),
      compileScenarioDefinition: source => compileWithRolePacks(source),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor([fixturePack]),
      runtimeAdapters: [createFixturePackRuntimeAdapter()],
    })
    cleanups.push(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const unaware: SimulationRunRuntime = await registry.create({ scenarioId: 'sided-run' })
    expect(codeOf((await unaware.observations(red).declarations([redUnit]))[0])).toBe('role_view_not_supported')
    expect(codeOf((await unaware.observations(red).read({ refs: [`${redUnit}#speed`] })).refused[0])).toBe('role_view_not_supported')
  })

  test('the AI cannot read an object it may not inspect through read-object either', async () => {
    const { workspaces, dataDir } = await createRoleRunWorkspaces()
    cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const workspaceId = newWorkspaceId() as WorkspaceId
    const call = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://world.test${path}`, init)
      const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces))!
      return { status: response.status, body: await response.json() as any }
    }
    await call(`/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
    const run = await workspaces.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'open-run' })
    await run.setAgentRestrictions(person, { operationIds: [], objects: [{ objectId: unitOne as ObjectId, deny: ['inspect'] }] }, 0)
    const readObject = (objectId: string, kind: 'ai' | 'human') => call(`/internal/workspaces/${workspaceId}/capabilities/world.simulation-run.read-object/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId: 'world.simulation-run.read-object', resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id },
        input: { objectId }, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: `${kind}-reader` } }) }),
    })
    expect((await readObject('unit:one', 'ai')).body.error?.code).toBe('agent_access_restricted')
    expect((await readObject('unit:two', 'ai')).status).toBe(200)
    expect((await readObject('unit:one', 'human')).status).toBe(200)
  })
})

void openRunDefinition
void roleRunDefinition
