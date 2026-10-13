import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  accessContextSchema,
  capabilityIdSchema,
  coreModuleIds,
  moduleIdSchema,
  moduleRegistrationSchema,
  newRequestId,
  newWorkspaceId,
  type ModuleId,
} from '@leitbild/contracts'
import { createWorkspaceHost } from '../src/host.ts'
import { createModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceStore } from '../src/store.ts'

const servers: Bun.Server<unknown>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

const createModule = (moduleId: ModuleId) => {
  const state: {
    available: boolean
    failLeave: boolean
    manifestRequests: number
    invokeFailure?: { readonly status: number; readonly code: string; readonly message: string }
    invokeDelayMs?: number
    featured: unknown
    activity: unknown
    activityStatus: number | undefined
    workspaces: Set<string>
  } = { available: true, failLeave: false, manifestRequests: 0, featured: { definitions: [], listed: [] }, activity: { workspaces: [] }, activityStatus: undefined, workspaces: new Set<string>() }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/manifest') {
        state.manifestRequests++
        if (!state.available) return new Response('offline', { status: 503 })
        return Response.json({
          module: { id: moduleId, title: String(moduleId) },
          endpoints: {
            workspace: `/internal/${moduleId}/workspaces/{workspaceId}`,
            definitions: `/internal/${moduleId}/workspaces/{workspaceId}/definitions`,
            resources: `/internal/${moduleId}/workspaces/{workspaceId}/resources`,
            capabilities: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities`,
            invoke: `/internal/${moduleId}/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke`,
            featuredDefinitions: `/internal/${moduleId}/featured-definitions`,
            activity: `/internal/${moduleId}/activity`,
          },
          ui: { workspace: `/workspaces/{workspaceId}/${moduleId}` },
        })
      }
      if (url.pathname === `/internal/${moduleId}/featured-definitions`) return Response.json(state.featured)
      if (url.pathname === `/internal/${moduleId}/activity`) {
        return state.activityStatus === undefined ? Response.json(state.activity) : new Response('unavailable', { status: state.activityStatus })
      }
      if (url.pathname.endsWith('/invoke') && state.invokeDelayMs) await Bun.sleep(state.invokeDelayMs)
      const root = url.pathname.match(new RegExp(`^/internal/${moduleId}/workspaces/([^/]+)$`))
      if (root && request.method === 'PUT') {
        state.workspaces.add(decodeURIComponent(root[1] ?? ''))
        return Response.json({ ok: true }, { status: 201 })
      }
      if (root && request.method === 'DELETE') {
        if (state.failLeave) return new Response('unavailable', { status: 503 })
        state.workspaces.delete(decodeURIComponent(root[1] ?? ''))
        return new Response(null, { status: 204 })
      }
      const resources = url.pathname.match(new RegExp(`^/internal/${moduleId}/workspaces/([^/]+)/resources$`))
      if (resources) {
        const workspaceId = decodeURIComponent(resources[1] ?? '')
        return Response.json({ resources: moduleId === 'world' ? [{
          ref: { workspaceId, moduleId, type: 'world.simulation-run', id: 'run-01' },
          title: 'Run 01', capabilityIds: ['world.simulation-run.read'], observedAt: new Date().toISOString(),
        }] : [] })
      }
      const definitions = url.pathname.match(new RegExp(`^/internal/${moduleId}/workspaces/([^/]+)/definitions$`))
      if (definitions) {
        const workspaceId = decodeURIComponent(definitions[1] ?? '')
        const item = moduleId === 'world'
          ? { type: 'world.scenario', id: 'test-scenario', title: 'Test Scenario', capabilityId: 'world.scenario.start' }
          : { type: 'agents.room-definition', id: 'halden-integrated-control-room', title: 'Halden Integrated Control Room', capabilityId: 'agents.room-definition.start' }
        return Response.json({ definitions: [{
          ref: { workspaceId, moduleId, type: item.type, id: item.id },
          title: item.title,
          currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
          capabilityIds: [item.capabilityId],
        }] })
      }
      if (new RegExp(`^/internal/${moduleId}/workspaces/[^/]+/capabilities$`).test(url.pathname)) {
        const startCapability = moduleId === 'world' ? {
          id: 'world.scenario.start', moduleId, kind: 'command',
          scope: { kind: 'definition', definitionType: 'world.scenario' },
          title: 'Start Scenario', description: 'Starts the selected Scenario.',
          risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        } : {
          id: 'agents.room-definition.start', moduleId, kind: 'command',
          scope: { kind: 'definition', definitionType: 'agents.room-definition' },
          title: 'Start Room', description: 'Starts the selected Room Definition.',
          risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        }
        return Response.json({ capabilities: [startCapability, ...(moduleId === 'world' ? [{
          id: 'world.simulation-run.read', moduleId, kind: 'query',
          scope: { kind: 'resource', resourceType: 'world.simulation-run' },
          title: 'Read Simulation Run', description: 'Reads the selected Simulation Run.',
          risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        }] : [])] })
      }
      if (new RegExp(`^/internal/${moduleId}/workspaces/[^/]+/capabilities/[^/]+/invoke$`).test(url.pathname)) {
        if (state.invokeFailure) {
          return Response.json({ error: {
            code: state.invokeFailure.code,
            message: state.invokeFailure.message,
            retryable: false,
          } }, { status: state.invokeFailure.status })
        }
        const invocation = await request.json() as { resource?: { id: string }; input: unknown }
        return Response.json({ result: { resourceId: invocation.resource?.id, input: invocation.input } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return {
    state,
    registration: moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://127.0.0.1:${server.port}`, manifestPath: '/manifest' }),
  }
}

const featuredScenario = (overrides: Record<string, unknown> = {}) => ({
  definition: { moduleId: 'world', type: 'world.scenario', id: 'test-scenario' },
  revisionId: 'revision-0123456789abcdef0123456789abcdef',
  title: 'Test Scenario',
  summary: 'A short test scenario.',
  about: 'A short test scenario that shows the featured catalogue.',
  tags: ['Test'],
  previews: [{ alt: 'Test map', width: 1600, height: 1000, sources: [{ path: '/assets/world/scenario-previews/test.webp', width: 1600 }] }],
  ...overrides,
})

const listedScenario = (overrides: Record<string, unknown> = {}) => ({
  definition: { moduleId: 'world', type: 'world.scenario', id: 'quiet-scenario' },
  revisionId: 'revision-fedcba9876543210fedcba9876543210',
  title: 'Quiet Scenario',
  summary: 'A test scenario where nothing is scripted.',
  tags: ['Test'],
  ...overrides,
})

const createFixture = () => {
  const modules = coreModuleIds.map(createModule)
  const store = createWorkspaceStore(':memory:')
  const host = createWorkspaceHost({ store, modules: createModuleGateway({ registrations: modules.map(item => item.registration) }) })
  return { modules, store, host }
}

describe('Leitbild Workspace Host', () => {
  test('a Module command deadline reports unknown outcome rather than promising a safe retry', async () => {
    const { modules, host, store } = createFixture()
    try {
      const workspace = await host.create({ name: null })
      const gateway = createModuleGateway({ registrations: modules.map(item => item.registration), requestTimeoutMs: 50 })
      const world = modules.find(item => item.registration.moduleId === 'world')!
      await gateway.resources(world.registration.moduleId, workspace.id)
      world.state.invokeDelayMs = 200
      const result = await gateway.invoke(world.registration.moduleId, {
        workspaceId: workspace.id,
        capabilityId: capabilityIdSchema.parse('world.scenario.start'),
        definition: { workspaceId: workspace.id, moduleId: world.registration.moduleId, type: 'world.scenario', id: 'test-scenario', revisionId: 'revision-0123456789abcdef0123456789abcdef' } as never,
        input: {},
        access: accessContextSchema.parse({ workspaceId: workspace.id, requestId: newRequestId(), actor: { kind: 'ai', id: 'timeout-test' } }),
      })
      expect(result).toMatchObject({ ok: false, failure: { code: 'module_outcome_unknown', status: 504, retryable: false } })
    } finally { store.close() }
  })
  test('a lost Module connection is reported in words, with the transport text kept only for diagnosis', async () => {
    const raw = 'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
    const gateway = createModuleGateway({
      registrations: [moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: 'http://127.0.0.1:9', manifestPath: '/manifest' })],
      fetch: (async () => { throw new Error(raw) }) as unknown as typeof fetch,
    })
    const result = await gateway.resources(moduleIdSchema.parse('world'), newWorkspaceId())
    expect(result).toMatchObject({ ok: false, failure: {
      code: 'module_unavailable', message: 'Lost the connection to the simulation. Reload to reconnect.', details: { cause: raw },
    } })
  })
  test('provisions every core Module and owns the complete lifecycle', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    expect(workspace.modules.map(item => [String(item.moduleId), item.status])).toEqual([
      ['agents', 'ready'], ['world', 'ready'],
    ])
    expect(modules.every(item => item.state.workspaces.has(workspace.id))).toBe(true)
    expect(host.rename(workspace.id, { name: 'Exercise Alpha' }).name).toBe('Exercise Alpha')
    await host.delete(workspace.id)
    expect(host.get(workspace.id)).toBeUndefined()
    store.close()
  })

  test('records a failed core Module provision and retries it', async () => {
    const { modules, host, store } = createFixture()
    const world = modules.find(item => item.registration.moduleId === 'world')!
    world.state.available = false
    const workspace = await host.create({ name: null })
    expect(workspace.modules.find(item => item.moduleId === 'world')).toMatchObject({ status: 'provision_failed' })
    world.state.available = true
    expect((await host.retryModule(workspace.id, world.registration.moduleId)).modules.find(item => item.moduleId === 'world')?.status).toBe('ready')
    store.close()
  })

  test('aggregates and invokes dynamically discovered capabilities', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    const resources = await host.resources(workspace.id)
    expect(resources.resources.map(resource => String(resource.ref.id))).toEqual(['run-01'])
    expect((await host.capabilities(workspace.id)).capabilities.map(item => String(item.id))).toEqual([
      'agents.room-definition.start', 'world.scenario.start', 'world.simulation-run.read',
    ])
    const result = await host.invoke(
      workspace.id,
      capabilityIdSchema.parse('world.simulation-run.read'),
      { resource: resources.resources[0]!.ref, input: { include: 'summary' } },
      accessContextSchema.parse({ workspaceId: workspace.id, requestId: newRequestId(), actor: { kind: 'ai', id: 'agent:test' } }),
    )
    expect(result).toEqual({ result: { resourceId: 'run-01', input: { include: 'summary' } } })
    expect(modules.every(item => item.state.manifestRequests === 1)).toBe(true)
    store.close()
  })

  test('queries one Module when discovery supplies an exact Module filter', async () => {
    const { host, store } = createFixture()
    const workspace = await host.create({ name: null })
    const agentsId = moduleIdSchema.parse('agents')
    const catalog = await host.capabilities(workspace.id, agentsId)
    expect(catalog.modules.map(item => item.moduleId)).toEqual([agentsId])
    expect(catalog.capabilities.map(item => item.moduleId)).toEqual([agentsId])
    expect((await host.resources(workspace.id, agentsId)).modules.map(item => item.moduleId)).toEqual([agentsId])
    expect((await host.definitions(workspace.id, agentsId)).modules.map(item => item.moduleId)).toEqual([agentsId])
    store.close()
  })

  test('preserves a Module capability error across the Host boundary', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    const world = modules.find(item => item.registration.moduleId === 'world')!
    world.state.invokeFailure = {
      status: 409,
      code: 'scenario_revision_unavailable',
      message: 'Simulation Run has no readable Scenario Revision',
    }
    const resources = await host.resources(workspace.id)
    await expect(host.invoke(
      workspace.id,
      capabilityIdSchema.parse('world.simulation-run.read'),
      { resource: resources.resources[0]!.ref, input: {} },
      accessContextSchema.parse({ workspaceId: workspace.id, requestId: newRequestId(), actor: { kind: 'ai', id: 'agent:test' } }),
    )).rejects.toMatchObject({
      code: 'scenario_revision_unavailable',
      message: 'Simulation Run has no readable Scenario Revision',
    })
    store.close()
  })


  test('aggregates every Module\'s featured Definitions without any Workspace', async () => {
    const { modules, host, store } = createFixture()
    try {
      modules.find(item => item.registration.moduleId === 'world')!.state.featured = { definitions: [featuredScenario()], listed: [listedScenario()] }
      const catalog = await host.featuredDefinitions()
      expect(catalog.modules).toEqual(coreModuleIds.map(moduleId => ({ moduleId, status: 'ready' })))
      expect(catalog.definitions.map(item => `${item.definition.moduleId}:${item.definition.id}@${item.revisionId}`))
        .toEqual(['world:test-scenario@revision-0123456789abcdef0123456789abcdef'])
      expect(catalog.listed.map(item => `${item.definition.moduleId}:${item.definition.id}@${item.revisionId}`))
        .toEqual(['world:quiet-scenario@revision-fedcba9876543210fedcba9876543210'])
      expect(host.list()).toEqual([])
      expect(modules.every(item => item.state.workspaces.size === 0)).toBe(true)
    } finally { store.close() }
  })

  test('reports each Module\'s featured outcome instead of dropping a failed Module', async () => {
    const { modules, host, store } = createFixture()
    try {
      const world = modules.find(item => item.registration.moduleId === 'world')!
      const agents = modules.find(item => item.registration.moduleId === 'agents')!
      world.state.featured = { definitions: [featuredScenario()], listed: [listedScenario()] }
      agents.state.available = false
      const offline = await host.featuredDefinitions()
      expect(offline.modules.find(item => item.moduleId === 'agents')).toMatchObject({ status: 'failed', failure: { code: 'module_discovery_failed' } })
      expect(offline.definitions).toHaveLength(1)
      expect(offline.listed).toHaveLength(1)

      agents.state.available = true
      agents.state.featured = { definitions: [featuredScenario()], listed: [] }
      const foreign = await host.featuredDefinitions()
      expect(foreign.modules.find(item => item.moduleId === 'agents')).toMatchObject({
        status: 'failed', failure: { code: 'module_contract_invalid', message: 'Module agents featured a Definition owned by world' },
      })
      expect(foreign.definitions.map(item => String(item.definition.moduleId))).toEqual(['world'])

      agents.state.featured = { definitions: [], listed: [listedScenario({ definition: { moduleId: 'world', type: 'world.scenario', id: 'other' } })] }
      const foreignListed = await host.featuredDefinitions()
      expect(foreignListed.modules.find(item => item.moduleId === 'agents')).toMatchObject({
        status: 'failed', failure: { code: 'module_contract_invalid', message: 'Module agents listed a Definition owned by world' },
      })
      expect(foreignListed.listed.map(item => String(item.definition.id))).toEqual(['quiet-scenario'])

      agents.state.featured = { definitions: [], listed: [] }
      world.state.featured = { definitions: [featuredScenario()] }
      const unlisted = await host.featuredDefinitions()
      expect(unlisted.modules.find(item => item.moduleId === 'world')).toMatchObject({ status: 'failed', failure: { code: 'module_contract_invalid' } })
      expect([unlisted.definitions, unlisted.listed]).toEqual([[], []])

      world.state.featured = { definitions: [featuredScenario({
        previews: [{ alt: 'Test map', width: 1600, height: 1000, sources: [{ path: '/assets/host/test.webp', width: 1600 }] }],
      })], listed: [] }
      const outside = await host.featuredDefinitions()
      expect(outside.modules.find(item => item.moduleId === 'world')).toMatchObject({ status: 'failed', failure: { code: 'module_contract_invalid' } })
      expect(outside.definitions).toEqual([])
    } finally { store.close() }
  })

  test('reads a Module\'s activity through its manifest and refuses an answer outside the contract', async () => {
    const world = createModule(moduleIdSchema.parse('world'))
    const gateway = createModuleGateway({ registrations: [world.registration] })
    const workspaceId = newWorkspaceId()
    world.state.activity = { workspaces: [{ workspaceId, items: [
      { key: 'simulations-running', label: '2 simulations running', count: 2, active: true },
      { key: 'simulations', label: '5 simulations', count: 5, active: false },
    ] }] }
    const read = await gateway.activity(world.registration.moduleId)
    expect(read).toEqual({ ok: true, value: world.state.activity as never })

    world.state.activity = { workspaces: [{ workspaceId, items: [
      { key: 'simulations', label: '5 simulations', count: 5, active: false },
      { key: 'simulations', label: '5 simulations', count: 5, active: false },
    ] }] }
    expect(await gateway.activity(world.registration.moduleId)).toMatchObject({ ok: false, failure: { code: 'module_contract_invalid', retryable: false } })

    world.state.activityStatus = 500
    expect(await gateway.activity(world.registration.moduleId)).toMatchObject({
      ok: false, failure: { code: 'module_query_failed', message: 'Module activity query returned HTTP 500', status: 500, retryable: true },
    })
    expect(await gateway.activity(moduleIdSchema.parse('elsewhere'))).toMatchObject({ ok: false, failure: { code: 'module_not_installed' } })
  })

  test('merges every Module\'s activity per known Workspace, in installed-Module order, with one outcome per Module', async () => {
    const { modules, host, store } = createFixture()
    try {
      const first = await host.create({ name: 'First' })
      const second = await host.create({ name: 'Second' })
      const world = modules.find(item => item.registration.moduleId === 'world')!
      const agents = modules.find(item => item.registration.moduleId === 'agents')!
      const running = { key: 'simulations-running', label: '2 simulations running', count: 2, active: true }
      const total = { key: 'simulations', label: '5 simulations', count: 5, active: false }
      const answering = { key: 'assistant-answering', label: 'Assistant answering', count: 1, active: true }
      agents.state.activity = { workspaces: [{ workspaceId: first.id, items: [answering] }] }
      const orphan = newWorkspaceId()
      world.state.activity = { workspaces: [
        { workspaceId: second.id, items: [running, total] },
        { workspaceId: orphan, items: [running] },
        { workspaceId: first.id, items: [total] },
      ] }
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      const catalog = await host.activity()
      await host.activity()
      expect(warn.mock.calls).toEqual([[`Module world reports activity for a Workspace the Host does not know: ${orphan}`]])
      warn.mockRestore()
      expect(catalog).toEqual({
        modules: coreModuleIds.map(moduleId => ({ moduleId, status: 'ready' })),
        workspaces: [
          { workspaceId: first.id, items: [{ moduleId: 'world', ...total }, { moduleId: 'agents', ...answering }] },
          { workspaceId: second.id, items: [{ moduleId: 'world', ...running }, { moduleId: 'world', ...total }] },
        ],
      } as never)

      agents.state.activityStatus = 503
      const partial = await host.activity()
      expect(partial.modules).toEqual([
        { moduleId: 'world', status: 'ready' },
        { moduleId: 'agents', status: 'failed', failure: { code: 'module_query_failed', message: 'Module activity query returned HTTP 503', status: 503, retryable: true } },
      ] as never)
      expect(partial.workspaces.map(workspace => [workspace.workspaceId, workspace.items.map(item => `${item.moduleId}:${item.key}`)])).toEqual([
        [first.id, ['world:simulations']],
        [second.id, ['world:simulations-running', 'world:simulations']],
      ])

      await host.delete(second.id)
      world.state.activity = { workspaces: [] }
      agents.state.activityStatus = undefined
      expect(await host.activity()).toEqual({ modules: coreModuleIds.map(moduleId => ({ moduleId, status: 'ready' })), workspaces: [
        { workspaceId: first.id, items: [{ moduleId: 'agents', ...answering }] },
      ] } as never)
    } finally { store.close() }
  })

  test('keeps a Workspace visible when any Module cleanup fails', async () => {
    const { modules, host, store } = createFixture()
    const workspace = await host.create({ name: null })
    modules[0]!.state.failLeave = true
    await expect(host.delete(workspace.id)).rejects.toMatchObject({ code: 'workspace_delete_incomplete' })
    expect(host.get(workspace.id)).toBeDefined()
    store.close()
  })
})
