import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import {
  accessContextSchema,
  moduleCapabilityCollectionSchema,
  moduleResourceCollectionSchema,
  newRequestId,
  newWorkspaceId,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createServer } from '../src/core/api/server.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createRoleRunWorkspaces, declaredRoles, openRunDefinition, roleAwareFixturePack, roleRunDefinition } from './fixtures/role-runs.ts'
import { waitForCondition } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const setup = async (packs?: ReadonlyArray<WorldPack>): Promise<{ readonly workspaces: WorldWorkspaceRuntimeRegistry; readonly workspaceId: WorkspaceId }> => {
  const { workspaces, dataDir } = await createRoleRunWorkspaces(packs)
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  return { workspaces, workspaceId }
}

const createRun = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, scenarioId: string): Promise<SimulationRunId> =>
  await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId })).id)

const call = async <T>(workspaces: WorldWorkspaceRuntimeRegistry, path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: T }> => {
  const request = new Request(`http://world.test${path}`, init)
  const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
  if (!response) throw new Error(`Module route did not handle ${path}`)
  return { status: response.status, body: await response.json() as T }
}

const invoke = async <T = { error?: { code: string } }>(
  workspaces: WorldWorkspaceRuntimeRegistry,
  workspaceId: WorkspaceId,
  capabilityId: string,
  config: { readonly actor: 'human' | 'ai'; readonly input?: unknown; readonly run?: SimulationRunId; readonly definition?: { readonly id: string; readonly revisionId: string } },
) => await call<T>(workspaces, `/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workspaceId,
    capabilityId,
    input: config.input ?? {},
    ...(config.run === undefined ? {} : { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.run } }),
    ...(config.definition === undefined ? {} : { definition: { workspaceId, moduleId: 'world', type: 'world.scenario', ...config.definition } }),
    access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: config.actor, id: config.actor === 'ai' ? 'role-test-agent' : 'role-test-person' } }),
  }),
})

describe('Role Runs through the Host broker', () => {
  test('AI is refused on every Run-scoped Capability of a role Run and keeps Scenario Definitions', async () => {
    const { workspaces, workspaceId } = await setup()
    const run = await createRun(workspaces, workspaceId, 'role-run')
    const listed = moduleCapabilityCollectionSchema.parse((await call(workspaces, `/internal/workspaces/${workspaceId}/capabilities`)).body)
    const runScoped = listed.capabilities.filter(capability => capability.scope.kind === 'resource' && capability.scope.resourceType === 'world.simulation-run')
    expect(runScoped.length).toBeGreaterThan(20)
    expect(runScoped.some(capability => capability.id === 'world.fixture.assign')).toBe(true)
    for (const capability of runScoped) {
      const refused = await invoke(workspaces, workspaceId, capability.id, { actor: 'ai', run })
      expect({ id: capability.id, status: refused.status, code: refused.body.error?.code }).toEqual({ id: capability.id, status: 403, code: 'ai_role_run_unsupported' })
    }
    expect((await workspaces.withRuntime(workspaceId, async runtime => runtime.simulationRuns.get(run)))?.events().some(event => event.type === 'command.issued')).toBe(false)

    // Definitions are authoring material outside play: AI reads and updates them.
    const definitions = await call<{ definitions: Array<{ ref: { id: string }; currentRevisionId: string }> }>(workspaces, `/internal/workspaces/${workspaceId}/definitions`)
    const definition = definitions.body.definitions.find(candidate => candidate.ref.id === 'role-run')!
    const read = await invoke<{ result: { source: { roles: unknown } } }>(workspaces, workspaceId, 'world.scenario.read', { actor: 'ai', definition: { id: 'role-run', revisionId: definition.currentRevisionId } })
    expect(read.status).toBe(200)
    expect(read.body.result.source.roles).toEqual([...declaredRoles])
    const updated = await invoke<{ result: { definition: { revisionId: string } } }>(workspaces, workspaceId, 'world.scenario.update', {
      actor: 'ai',
      definition: { id: 'role-run', revisionId: definition.currentRevisionId },
      input: { source: { ...roleRunDefinition, title: 'Role Run, revised' } },
    })
    expect(updated.status).toBe(200)
  })

  test('a person without a role reaches only the open Run controls', async () => {
    const { workspaces, workspaceId } = await setup()
    const run = await createRun(workspaces, workspaceId, 'role-run')
    for (const capabilityId of ['world.simulation-run.read', 'world.simulation-run.context', 'world.simulation-run.inspect', 'world.simulation-run.objects.search', 'world.simulation-run.observables.search', 'world.simulation-run.background.set', 'world.fixture.assign', 'world.object.delete']) {
      const refused = await invoke(workspaces, workspaceId, capabilityId, { actor: 'human', run })
      expect({ capabilityId, status: refused.status, code: refused.body.error?.code }).toEqual({ capabilityId, status: 403, code: 'role_required' })
    }
    expect((await invoke(workspaces, workspaceId, 'world.simulation-run.execution.read', { actor: 'human', run })).status).toBe(200)
    expect((await invoke(workspaces, workspaceId, 'world.simulation-run.execution.set', { actor: 'human', run, input: { playback: 'paused' } })).status).toBe(200)
    expect((await invoke(workspaces, workspaceId, 'world.simulation-run.scenario-source', { actor: 'human', run })).status).toBe(200)
    expect((await invoke(workspaces, workspaceId, 'world.simulation-run.rename', { actor: 'human', run, input: { name: 'Exercise one', expectedTitle: 'Role Run' } })).status).toBe(200)
    const copied = await invoke<{ result: { id: SimulationRunId } }>(workspaces, workspaceId, 'world.simulation-run.copy', { actor: 'human', run })
    expect(copied.status).toBe(201)
    expect((await invoke(workspaces, workspaceId, 'world.simulation-run.delete', { actor: 'human', run: copied.body.result.id })).status).toBe(200)
  })

  test('a role Run lists no AI restrictions or Inspect; a Run without roles keeps them', async () => {
    const { workspaces, workspaceId } = await setup()
    const roleRun = await createRun(workspaces, workspaceId, 'role-run')
    const openRun = await createRun(workspaces, workspaceId, 'open-run')
    const { resources } = moduleResourceCollectionSchema.parse((await call(workspaces, `/internal/workspaces/${workspaceId}/resources`)).body)
    const role = resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === roleRun)!
    const open = resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === openRun)!
    expect(role.capabilityIds.filter(id => id.includes('agent-restrictions') || id === 'world.simulation-run.inspect')).toEqual([])
    expect('inspectionCapabilityId' in role).toBe(false)
    expect(role.summary).toContainEqual({ key: 'roles', label: 'Roles', kind: 'count', value: 3 })
    expect(open.capabilityIds.map(String)).toEqual(expect.arrayContaining(['world.simulation-run.agent-restrictions.read', 'world.simulation-run.agent-restrictions.set', 'world.simulation-run.inspect']))
    expect(String(open.inspectionCapabilityId)).toBe('world.simulation-run.inspect')
    expect(open.summary.some(item => item.key === 'roles')).toBe(false)
    expect(role.capabilityIds).toEqual(open.capabilityIds.filter(id => !id.includes('agent-restrictions') && id !== 'world.simulation-run.inspect'))
  })

  test('saving a role Scenario names the refusal code of a non-role-aware Pack or AI restrictions', async () => {
    const { workspaces, workspaceId } = await setup([roleAwareFixturePack, weatherPack])
    const withWeather = { ...roleRunDefinition, id: 'role-weather', packs: [...roleRunDefinition.packs, { id: 'weather', config: {}, items: [] }] }
    const notRoleAware = await invoke(workspaces, workspaceId, 'world.scenario.create', { actor: 'human', input: { source: withWeather } })
    expect(notRoleAware).toMatchObject({ status: 400, body: { error: { code: 'role_run_pack_not_role_aware' } } })
    const restricted = await invoke(workspaces, workspaceId, 'world.scenario.create', { actor: 'ai', input: { source: { ...roleRunDefinition, id: 'role-restricted', agentRestrictions: { operationIds: ['world.fixture.assign'] } } } })
    expect(restricted).toMatchObject({ status: 400, body: { error: { code: 'agent_restrictions_in_role_run' } } })
    expect((await invoke(workspaces, workspaceId, 'world.scenario.create', { actor: 'ai', input: { source: { ...openRunDefinition, id: 'open-restricted', agentRestrictions: { operationIds: ['world.fixture.assign'] } } } })).status).toBe(201)
  })
})

interface ReceivedMessage { readonly type: string; readonly epoch?: number; readonly [key: string]: unknown }

const openSocket = async (url: string): Promise<{ readonly socket: WebSocket; readonly messages: ReceivedMessage[] }> => {
  const socket = new WebSocket(url)
  const messages: ReceivedMessage[] = []
  socket.onmessage = event => { messages.push(JSON.parse(String(event.data)) as ReceivedMessage) }
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error(`WebSocket failed: ${url}`)) })
  cleanups.push(async () => { socket.close() })
  return { socket, messages }
}

const nextOf = async (messages: ReceivedMessage[], type: string, after: number): Promise<ReceivedMessage> => {
  await waitForCondition(`${type} after ${after}`, () => messages.slice(after).some(message => message.type === type))
  return messages.slice(after).find(message => message.type === type)!
}

describe('Role sets on the WebSocket', () => {
  const startServer = async () => {
    const { workspaces, workspaceId } = await setup()
    const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1' })
    cleanups.push(async () => { await server.stop() })
    const base = `127.0.0.1:${server.port}/api/workspaces/${workspaceId}/world`
    return { workspaces, workspaceId, http: `http://${base}`, ws: `ws://${base}/ws` }
  }

  test('switches a connection role set in place with a fresh snapshot in a new epoch', async () => {
    const { workspaces, workspaceId, http, ws } = await startServer()
    const run = await createRun(workspaces, workspaceId, 'role-run')
    const unroled = await fetch(`${ws.replace('ws://', 'http://')}?simulationRun=${run}`)
    expect(unroled.status).toBe(403)
    expect(await unroled.json()).toMatchObject({ error: { code: 'role_required' } })
    const unknown = await fetch(`${ws.replace('ws://', 'http://')}?simulationRun=${run}&roles=ghost`)
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_role' } })

    const { socket, messages } = await openSocket(`${ws}?simulationRun=${run}&roles=dispatch`)
    const first = await nextOf(messages, 'realtime.ready', 0)
    expect(first).toMatchObject({ epoch: 1, roleIds: ['dispatch'], compiledScenario: { id: 'role-run', roles: [...declaredRoles] } })
    expect((first.snapshot as { objects: unknown[] }).objects).toHaveLength(4)
    const presence = async () => (await (await fetch(`${http}/simulation-runs/${run}/presence`)).json() as { roles: { holders: Record<string, number> } }).roles.holders
    expect(await presence()).toEqual({ dispatch: 1 })

    // A dispatcher may not delete: the refusal names its code in the epoch it was asked in.
    let mark = messages.length
    socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'r1', capabilityId: 'world.object.delete', invocation: { input: { objectId: 'unit:two' } } }))
    expect(await nextOf(messages, 'capability.error', mark)).toMatchObject({ requestId: 'r1', code: 'role_controller_only', epoch: 1 })

    mark = messages.length
    socket.send(JSON.stringify({ type: 'role.set', roles: ['ghost'] }))
    expect(await nextOf(messages, 'role.refused', mark)).toMatchObject({ code: 'unknown_role', epoch: 1 })
    mark = messages.length
    socket.send(JSON.stringify({ type: 'role.set', roles: [] }))
    expect(await nextOf(messages, 'role.refused', mark)).toMatchObject({ code: 'role_required', epoch: 1 })

    mark = messages.length
    const switchedAt = performance.now()
    socket.send(JSON.stringify({ type: 'role.set', roles: ['control', 'dispatch'] }))
    const second = await nextOf(messages, 'realtime.ready', mark)
    expect(performance.now() - switchedAt).toBeLessThan(500)
    expect(second).toMatchObject({ epoch: 2, roleIds: ['dispatch', 'control'], compiledScenario: { id: 'role-run', roles: [...declaredRoles] } })
    expect((second.snapshot as { objects: unknown[] }).objects).toHaveLength(4)
    expect((second.compiledScenario as { initialObjects: unknown[] }).initialObjects).toHaveLength(4)
    expect(await presence()).toEqual({ dispatch: 1, control: 1 })

    mark = messages.length
    socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'r2', capabilityId: 'world.object.delete', invocation: { input: { objectId: 'unit:two' } } }))
    expect(await nextOf(messages, 'capability.result', mark)).toMatchObject({ requestId: 'r2', epoch: 2, outcome: { kind: 'command', result: { ok: true } } })
    const events = await nextOf(messages, 'events', mark)
    expect(events.epoch).toBe(2)
    const issued = (await workspaces.withRuntime(workspaceId, async runtime => runtime.simulationRuns.get(run)))!.events()
      .flatMap(event => event.type === 'command.issued' ? [event.command] : [])
    expect(issued.map(command => command.roleIds)).toEqual([['dispatch', 'control']])
  })

  test('a Run without roles keeps its WebSocket messages unchanged', async () => {
    const { workspaces, workspaceId, ws } = await startServer()
    const run = await createRun(workspaces, workspaceId, 'open-run')
    const { socket, messages } = await openSocket(`${ws}?simulationRun=${run}`)
    const ready = await nextOf(messages, 'realtime.ready', 0)
    expect(Object.keys(ready).sort()).toEqual(['clock', 'scenarioId', 'simulationRunId', 'snapshotSeq', 'type', 'workspaceId'])
    let mark = messages.length
    socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'r1', capabilityId: 'world.object.delete', invocation: { input: { objectId: 'unit:two' } } }))
    const result = await nextOf(messages, 'capability.result', mark)
    expect('epoch' in result).toBe(false)
    expect(result).toMatchObject({ outcome: { result: { ok: true } } })
    expect('epoch' in await nextOf(messages, 'events', mark)).toBe(false)
    mark = messages.length
    socket.send(JSON.stringify({ type: 'role.set', roles: ['dispatch'] }))
    const refused = await nextOf(messages, 'role.refused', mark)
    expect(refused).toMatchObject({ code: 'unknown_role' })
    expect('epoch' in refused).toBe(false)
    const roled = await fetch(`${ws.replace('ws://', 'http://')}?simulationRun=${run}&roles=dispatch`)
    expect(roled.status).toBe(400)
  })
})
