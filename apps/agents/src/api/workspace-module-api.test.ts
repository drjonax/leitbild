import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectionViewSchema,
  moduleCapabilityCollectionSchema,
  moduleDefinitionCollectionSchema,
  moduleResourceCollectionSchema,
  newWorkspaceId,
  workspaceModuleManifestSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceReferenceSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsModuleState, type AgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { agentsModuleManifest, handleAgentsModuleApi } from './workspace-module-api.ts'
import { messageFocus } from '../core/message-focus.ts'
import { asAIAgent } from '../agents/shared.ts'
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from '../llm/models/catalog.ts'

let home = ''
let originalHome: string | undefined
let originalProvider: string | undefined
let originalSeed: string | undefined
let state: AgentsModuleState
let registry: WorkspaceRuntimeRegistry

beforeEach(async () => {
  originalHome = process.env.LEITBILD_HOME
  originalProvider = process.env.PROVIDER
  originalSeed = process.env.LEITBILD_SEED_WORKSPACE
  home = await mkdtemp(join(tmpdir(), 'leitbild-module-api-'))
  process.env.LEITBILD_HOME = home
  process.env.PROVIDER = 'ollama'
  delete process.env.LEITBILD_SEED_WORKSPACE
  state = createAgentsModuleState()
  const deployment = createDeploymentRuntime()
  deployment.sharedSkillStore.register({
    name: 'leitbild-assistance', description: 'Test assistance Skill', body: 'Use Workspace evidence.',
    tools: [], allowedToolNames: ['workspace_explore', 'workspace_call'], dirPath: home,
  })
  deployment.sharedSkillStore.register({
    name: 'operator-displays', description: 'Test display Skill', body: 'Compose displays when useful.',
    tools: [], allowedToolNames: ['workspace_explore', 'workspace_call'], dirPath: home,
  })
  for (const name of ['product_search', 'product_read', 'place_resolve', 'get_time']) {
    deployment.sharedToolRegistry.register({
      name,
      description: `Test ${name}`,
      parameters: { type: 'object' },
      execute: async () => ({ success: true, data: {} }),
    })
  }
  registry = createWorkspaceRuntimeRegistry({ deployment, moduleState: state, idleMs: 1_000_000 })
})

afterEach(async () => {
  await registry.shutdown()
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
  if (originalProvider === undefined) delete process.env.PROVIDER
  else process.env.PROVIDER = originalProvider
  if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
  else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
  await rm(home, { recursive: true, force: true })
})

const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const url = new URL(path, 'http://leitbild.test')
  const response = await handleAgentsModuleApi(new Request(url.href, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }), url, { state, registry })
  if (!response) throw new Error(`Module API did not handle ${method} ${path}`)
  return response
}

const invokeBody = (workspaceId: WorkspaceId, capabilityId: string, input: unknown, target?: {
  readonly resource?: { readonly type: string; readonly id: string }
  readonly definition?: { readonly type: string; readonly id: string; readonly revisionId: string }
}) => ({
  workspaceId,
  capabilityId,
  ...(target?.resource === undefined ? {} : {
    resource: workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'agents', ...target.resource }),
  }),
  ...(target?.definition === undefined ? {} : {
    definition: { workspaceId, moduleId: 'agents', ...target.definition },
  }),
  input,
  access: {
    workspaceId,
    requestId: crypto.randomUUID(),
    actor: { kind: 'ai' as const, id: 'agent:operator', displayName: 'Operator' },
    client: { id: 'workspace-host', kind: 'service' as const },
  },
})

describe('Agents Workspace Module API', () => {
  test('AI can discover and replace existing Room Packs through the validated owner, durably and independently', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const runtime = await registry.getOrLoad(workspaceId)
    const first = runtime.rooms.createRoom({ name: 'First', createdBy: 'test' })
    const second = runtime.rooms.createRoom({ name: 'Second', createdBy: 'test' })
    const knownPack = runtime.packCatalog.list()[0]!.id
    const changed: string[] = []
    runtime.setOnRoomPacksChanged(roomId => changed.push(roomId))
    const operationId = 'agents.room.packs.set'
    const packList = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.packs.list/invoke`, invokeBody(workspaceId, 'agents.packs.list', {}))
    expect(packList.status).toBe(200)
    expect(await packList.json()).toEqual({ result: { packs: runtime.packCatalog.list().map(pack => ({ id: pack.id, title: pack.descriptor.name, description: pack.descriptor.description, deployment: pack.deployment })) } })
    const set = (roomId: string, input: unknown) => request('POST', `/internal/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, invokeBody(workspaceId, operationId, input, { resource: { type: 'agents.room', id: roomId } }))
    const catalog = await request('GET', `/internal/workspaces/${workspaceId}/capabilities`)
    expect(moduleCapabilityCollectionSchema.parse(await catalog.json()).capabilities.some(capability => capability.id === operationId)).toBe(true)
    const resources = await request('GET', `/internal/workspaces/${workspaceId}/resources`)
    expect(moduleResourceCollectionSchema.parse(await resources.json()).resources.find(resource => resource.ref.id === first.profile.id)!.capabilityIds.some(id => id === operationId)).toBe(true)
    const [a, b] = await Promise.all([set(first.profile.id, { activePacks: [knownPack, knownPack] }), set(second.profile.id, { activePacks: [] })])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(await a.json()).toMatchObject({ result: { activePacks: [knownPack] } })
    expect(first.getActivePacks()).toEqual([knownPack])
    expect(second.getActivePacks()).toEqual([])
    expect(changed.sort()).toEqual([first.profile.id, second.profile.id].sort())
    const invalid = await set(first.profile.id, { activePacks: [knownPack, 'absent-pack'] })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'unknown_pack' } })
    expect(first.getActivePacks()).toEqual([knownPack])
    expect((await set(first.profile.id, { activePacks: [3] })).status).toBe(400)
    expect((await set(first.profile.id, { activePacks: [], extra: true })).status).toBe(400)
    expect((await set('missing', { activePacks: [] })).status).toBe(404)
    expect(changed).toHaveLength(2)
    await registry.evictOne(workspaceId)
    const restored = await registry.getOrLoad(workspaceId)
    expect(restored.rooms.getRoom(first.profile.id)!.getActivePacks()).toEqual([knownPack])
    const read = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.room.read/invoke`, invokeBody(workspaceId, 'agents.room.read', {}, { resource: { type: 'agents.room', id: first.profile.id } }))
    expect(await read.json()).toMatchObject({ result: { state: { activePacks: [knownPack] } } })
  })

  test('opens one concurrent-safe Leitbild Assistant Room and preserves focused subjects', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const runtime = await registry.getOrLoad(workspaceId)
    runtime.skillStore.register({
      name: 'leitbild-assistance', description: 'Test Assistant Skill', body: 'Use Workspace discovery.',
      tools: [], allowedToolNames: [], dirPath: home,
    })
    runtime.skillStore.register({
      name: 'operator-displays', description: 'Test display Skill', body: 'Compose displays when useful.',
      tools: [], allowedToolNames: [], dirPath: home,
    })
    const focusedResource = workspaceResourceReferenceSchema.parse({
      workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-one',
    })
    const focusedDefinition = workspaceDefinitionRevisionReferenceSchema.parse({
      workspaceId, moduleId: 'world', type: 'world.scenario', id: 'scenario-one', revisionId: 'revision-one',
    })
    const open = (prompt: string, focusedSubjects = [focusedResource, focusedDefinition]) => request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.assistance.open/invoke`,
      invokeBody(workspaceId, 'agents.assistance.open', { prompt, focusedSubjects }),
    )

    const opened = await Promise.all([
      open('Explain this simulation.'),
      open('What can I change?'),
    ])
    expect(opened.map(response => response.status).sort()).toEqual([200, 201])
    const created = opened.find(response => response.status === 201)!
    const createdBody = await created.json() as { result: { resource: { id: string }; reused: boolean; uiPath: string }; createdResources: Array<{ id: string }> }
    expect(createdBody.result.reused).toBe(false)
    expect(createdBody.result.uiPath).toContain(`room=${createdBody.result.resource.id}`)
    expect(createdBody.createdResources).toHaveLength(1)
    const room = runtime.rooms.getRoom(createdBody.result.resource.id)!
    const posted = room.getRecent(10).find(message => message.content === 'Explain this simulation.')
    expect(posted).toBeDefined()
    expect(messageFocus(posted!)).toEqual([focusedResource, focusedDefinition])
    expect(room.getRecent(10).some(message => message.content === 'What can I change?')).toBe(true)
    const assistant = asAIAgent(runtime.team.listByKind('ai')[0]!)!
    expect(assistant.getConfig().maxToolIterations).toBeUndefined()
    // The default model brings its own effort when the definition names neither.
    expect(assistant.getConfig()).toMatchObject({ model: DEFAULT_MODEL_ID, reasoningEffort: DEFAULT_REASONING_EFFORT })
    expect(assistant.getSkills()).toEqual(['leitbild-assistance', 'operator-displays'])

    const reused = await open('Now create a scenario.')
    expect(reused.status).toBe(200)
    const reusedBody = await reused.json() as { result: { resource: { id: string }; reused: boolean }; createdResources?: unknown[] }
    expect(reusedBody.result).toMatchObject({ resource: { id: room.profile.id }, reused: true })
    expect(reusedBody.createdResources).toBeUndefined()
    expect(runtime.rooms.listAllRooms()).toHaveLength(1)
    expect(runtime.team.listByKind('ai')).toHaveLength(1)

    const definition = await registry.definitionsFor(workspaceId).currentRevision('leitbild-assistant')
    const startedAgain = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.start/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.start', {}, {
        definition: { type: 'agents.room-definition', id: 'leitbild-assistant', revisionId: definition!.id },
      }),
    )
    expect(startedAgain.status).toBe(409)
    expect(runtime.rooms.listAllRooms()).toHaveLength(1)

    const wrongWorkspace = await open('Use this.', [{ ...focusedResource, workspaceId: newWorkspaceId() }])
    expect(wrongWorkspace.status).toBe(409)
  })

  test('Run assistance is concurrent-safe, durable, and shared by one derived Run Family', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const family = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.run-family', id: 'family-one' })
    const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-one' })
    const scope = { kind: 'collection' as const, collection: family, members: { mode: 'all' as const, except: [] } }
    const ensure = (selected = scope) => request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.assistance.open/invoke`,
      invokeBody(workspaceId, 'agents.assistance.open', { scope: selected, title: 'Test run', focusedSubjects: [run] }),
    )
    expect((await ensure({ ...scope, collection: { ...family, workspaceId: newWorkspaceId() } })).status).toBe(409)
    const replies = await Promise.all(Array.from({ length: 4 }, () => ensure()))
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 200, 200, 201])
    const ids = await Promise.all(replies.map(async reply => (await reply.json() as { result: { resource: { id: string } } }).result.resource.id))
    expect(new Set(ids).size).toBe(1)
    const runtime = await registry.getOrLoad(workspaceId)
    expect(runtime.rooms.listAllRooms()).toHaveLength(1)
    expect(runtime.team.listByKind('ai')).toHaveLength(1)
    const room = runtime.rooms.getRoom(ids[0]!)!
    expect(room.getParticipantIds()).toHaveLength(2)
    expect(room.deliveryMode).toBe('broadcast')
    room.setPaused(true) // User edits must survive both reuse and template edits.
    const library = registry.definitionsFor(workspaceId)
    const revision = await library.currentRevision('leitbild-assistant')
    await library.update({ ...revision!.document, title: 'Edited template' }, revision!.id)
    await registry.evictOne(workspaceId)
    const saved = moduleResourceCollectionSchema.parse(await (await request('GET', `/internal/workspaces/${workspaceId}/resources`)).json()).resources
    expect(saved.find(item => item.ref.id === ids[0])?.links).toContainEqual({ rel: 'scope-collection', ref: family })
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
    expect((await (await ensure()).json() as { result: { resource: { id: string } } }).result.resource.id).toBe(ids[0]!)
    const restored = await registry.getOrLoad(workspaceId)
    expect(restored.rooms.getRoom(ids[0]!)!.paused).toBe(true)
    expect(restored.team.listByKind('ai')).toHaveLength(1)
    const anotherFamily = workspaceResourceReferenceSchema.parse({ ...family, id: 'family-two' })
    expect((await ensure({ ...scope, collection: anotherFamily })).status).toBe(201)
    expect(restored.rooms.listAllRooms()).toHaveLength(2)
    expect(restored.team.listByKind('ai')).toHaveLength(2)
    restored.removeRoom(ids[0]!)
    expect(restored.team.listByKind('ai')).toHaveLength(1)
    const replacement = (await (await ensure()).json() as { result: { resource: { id: string } } }).result.resource.id
    expect(replacement).not.toBe(ids[0]!)
    expect(restored.team.listByKind('ai')).toHaveLength(2)
  })

  test('failed Assistance Room membership rolls back the Room and Room-owned AI, and retry succeeds', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const library = registry.definitionsFor(workspaceId)
    await library.list()
    const runtime = await registry.getOrLoad(workspaceId)
    const original = runtime.addAgentToRoom
    const join = spyOn(runtime, 'addAgentToRoom').mockImplementation(async (agentId, ...args) => {
      if (runtime.team.getAgent(agentId)?.kind === 'ai') throw new Error('Test membership failure')
      return original(agentId, ...args)
    })
    const body = invokeBody(workspaceId, 'agents.assistance.open', {
      scope: {
        kind: 'collection',
        collection: { workspaceId, moduleId: 'world', type: 'world.run-family', id: 'family-one' },
        members: { mode: 'all', except: [] },
      },
      title: 'Test',
    })
    const path = `/internal/workspaces/${workspaceId}/capabilities/agents.assistance.open/invoke`
    try {
      const failed = await request('POST', path, body)
      expect(failed.status).toBe(500)
      expect(await failed.text()).toContain('Test membership failure')
      expect(runtime.rooms.listAllRooms()).toHaveLength(0)
      expect(runtime.team.listByKind('ai')).toHaveLength(0)
    } finally { join.mockRestore() }
    expect((await request('POST', path, body)).status).toBe(201)
  })

  test('resource discovery stays lazy and keyed retries are rejected before loading', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
    const response = await request('GET', `/internal/workspaces/${workspaceId}/resources`)
    expect(response.status).toBe(200)
    expect(moduleResourceCollectionSchema.parse(await response.json()).resources).toEqual([])
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
    const keyed = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.room.create/invoke`, { ...invokeBody(workspaceId, 'agents.room.create', { name: 'Test' }), idempotencyKey: 'retry' })
    expect(keyed.status).toBe(400)
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
  })
  test('definition writes reject unavailable Packs, tools and scripts before persistence', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const base = { id: 'invalid', title: 'Invalid', description: 'Invalid configuration', room: { deliveryMode: 'manual', packs: [], agents: [] }, deck: { entries: [] } }
    for (const definition of [
      { ...base, room: { ...base.room, packs: ['missing-pack'] } },
      { ...base, room: { ...base.room, agents: [{ name: 'Agent', persona: 'Tester', tools: ['missing-tool'] }] } },
      { ...base, deck: { entries: [{ id: 'entry', label: 'Missing script', description: 'Missing script', action: { kind: 'start-script', scriptName: 'does-not-exist' } }] } },
    ]) {
      const response = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.create/invoke`, invokeBody(workspaceId, 'agents.room-definition.create', { definition }))
      expect(response.status).toBe(400)
    }
    expect(await registry.definitionsFor(workspaceId).currentRevision('invalid')).toBeUndefined()
  })
  test('concurrent definition revisions have one winner and catalog ownership survives runtime eviction', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const library = registry.definitionsFor(workspaceId)
    const definition = { id: 'race', title: 'Race', description: 'Concurrent editing', room: { deliveryMode: 'manual' as const, packs: [], agents: [] }, deck: { entries: [] } }
    const created = await library.create(definition)
    const target = { definition: { type: 'agents.room-definition', id: definition.id, revisionId: created.id } }
    const writes = await Promise.all(['A', 'B'].map(title => request('POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.update/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.update', { definition: { ...definition, title } }, target))))
    expect(writes.map(response => response.status).sort()).toEqual([200, 409])
    await registry.evictOne(workspaceId)
    expect(registry.definitionsFor(workspaceId)).toBe(library)
  })

  test('publishes one strict Agents manifest', async () => {
    const body = await (await request('GET', '/.well-known/workspace-module')).json()
    expect(workspaceModuleManifestSchema.parse(body)).toEqual(agentsModuleManifest)
  })

  test('provisions and discovers Rooms and Agent Profiles through one Module', async () => {
    const workspaceId = newWorkspaceId()
    expect((await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)

    const capabilities = moduleCapabilityCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/capabilities`)).json(),
    )
    expect(capabilities.capabilities.every(capability => capability.id.startsWith('agents.'))).toBe(true)
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room.create')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room.delete')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.agent.create')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room-definition.start')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room-definition.inspect')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room-definition.create')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room-definition.update')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.room.inspect')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.prompt-deck.run-entry')
    expect(capabilities.capabilities.map(capability => String(capability.id))).toContain('agents.assistance.open')

    const definitions = moduleDefinitionCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/definitions`)).json(),
    )
    const roomDefinition = definitions.definitions.find(definition => definition.ref.id === 'leitbild-assistant')!
    expect(String(roomDefinition.inspectionCapabilityId)).toBe('agents.room-definition.inspect')
    expect(roomDefinition.primaryCapabilityId).toBeUndefined()
    const definitionInspectionResponse = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.inspect/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.inspect', {}, {
        definition: {
          type: String(roomDefinition.ref.type),
          id: roomDefinition.ref.id,
          revisionId: roomDefinition.currentRevisionId,
        },
      }),
    )
    const definitionInspection = inspectionViewSchema.parse(
      (await definitionInspectionResponse.json() as { result: unknown }).result,
    )
    expect(definitionInspection.sections.map(section => section.id)).toContain('configured-agents')
    expect(definitionInspection.sections.map(section => section.id)).toContain('prompt-deck')
    const started = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.assistance.open/invoke`,
      invokeBody(workspaceId, 'agents.assistance.open', {
        scope: {
          kind: 'collection',
          collection: { workspaceId, moduleId: 'world', type: 'world.run-family', id: 'family-one' },
          members: { mode: 'all', except: [] },
        },
        title: 'Test simulation',
      }),
    )
    expect(started.status).toBe(201)
    const startedRoomId = (await started.json() as { result: { resource: { id: string } } }).result.resource.id

    expect((await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.room.create/invoke`,
      invokeBody(workspaceId, 'agents.room.create', { name: 'Operations' }))).status).toBe(201)
    const createAgent = await request('POST', `/internal/workspaces/${workspaceId}/capabilities/agents.agent.create/invoke`,
      invokeBody(workspaceId, 'agents.agent.create', {
        name: 'Analyst', model: 'test-model', persona: 'Analyse.',
      }))
    expect(createAgent.status).toBe(201)
    const agentId = (await createAgent.json() as { result: { id: string } }).result.id

    const resources = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(resources.resources.map(resource => resource.title)).toContain('Operations')
    expect(resources.resources.map(resource => resource.title)).toContain('Analyst')
    expect(resources.resources.map(resource => String(resource.ref.type))).toContain('agents.room')
    expect(resources.resources.map(resource => String(resource.ref.type))).toContain('agents.agent')

    const agentProfile = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.agent.read/invoke`,
      invokeBody(workspaceId, 'agents.agent.read', {}, { resource: { type: 'agents.agent', id: agentId } }),
    )
    expect((await agentProfile.json() as { result: { config: Record<string, unknown> } }).result.config)
      .not.toHaveProperty('toolGrants')

    const startedRoom = resources.resources.find(resource => resource.ref.id === startedRoomId)
    expect(startedRoom?.sourceDefinition?.revisionId).toBe(roomDefinition.currentRevisionId)
    expect(startedRoom?.summary.find(item => item.key === 'created-at')?.kind).toBe('timestamp')
    expect(startedRoom?.summary.find(item => item.key === 'message-count')?.kind).toBe('count')
    expect(startedRoom?.summary.find(item => item.key === 'status')?.kind).toBe('status')
    expect(String(startedRoom?.inspectionCapabilityId)).toBe('agents.room.inspect')

    const roomInspectionResponse = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room.inspect/invoke`,
      invokeBody(workspaceId, 'agents.room.inspect', {}, {
        resource: { type: 'agents.room', id: startedRoomId },
      }),
    )
    const roomInspection = inspectionViewSchema.parse(
      (await roomInspectionResponse.json() as { result: unknown }).result,
    )
    expect(roomInspection.sections.map(section => section.id)).toContain('members')
    expect(roomInspection.sections.map(section => section.id)).toContain('source-definition')

    expect((await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.delete/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.delete', {}, {
        definition: {
          type: String(roomDefinition.ref.type),
          id: roomDefinition.ref.id,
          revisionId: roomDefinition.currentRevisionId,
        },
      }),
    )).status).toBe(200)
    const definitionsAfterDelete = moduleDefinitionCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/definitions`)).json(),
    )
    expect(definitionsAfterDelete.definitions.some(definition => definition.ref.id === roomDefinition.ref.id)).toBe(false)
    const resourcesAfterDelete = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(resourcesAfterDelete.resources.some(resource => resource.ref.id === startedRoomId)).toBe(true)

    expect((await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room.delete/invoke`,
      invokeBody(workspaceId, 'agents.room.delete', {}, {
        resource: { type: 'agents.room', id: startedRoomId },
      }),
    )).status).toBe(200)
    const resourcesAfterRoomDelete = moduleResourceCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/resources`)).json(),
    )
    expect(resourcesAfterRoomDelete.resources.some(resource => resource.ref.id === startedRoomId)).toBe(false)
  })

  test('creates and revises Room Definitions through the same capability surface', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    const definition = {
      id: 'custom-briefing',
      title: 'Custom briefing',
      description: 'An editable briefing Room.',
      room: { deliveryMode: 'manual', packs: [], agents: [] },
      deck: { entries: [] },
    }
    const created = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.create/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.create', { definition }),
    )
    expect(created.status).toBe(201)
    const createdRef = (await created.json() as {
      result: { definition: { type: string; id: string; revisionId: string } }
    }).result.definition

    const updated = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.update/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.update', {
        definition: { ...definition, title: 'Revised briefing' },
      }, { definition: createdRef }),
    )
    expect(updated.status).toBe(200)
    const updatedRef = (await updated.json() as {
      result: { definition: { revisionId: string } }
    }).result.definition
    expect(updatedRef.revisionId).not.toBe(createdRef.revisionId)

    const listed = moduleDefinitionCollectionSchema.parse(
      await (await request('GET', `/internal/workspaces/${workspaceId}/definitions`)).json(),
    )
    const custom = listed.definitions.find(item => item.ref.id === definition.id)
    expect(custom?.title).toBe('Revised briefing')
    expect(String(custom?.currentRevisionId)).toBe(updatedRef.revisionId)

    const startOriginal = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.start/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.start', {}, { definition: createdRef }),
    )
    expect(startOriginal.status).toBe(201)
    const originalRoom = (await startOriginal.json() as {
      result: { room: { id: string; name: string }; revisionId: string }
    }).result
    expect(originalRoom.room.name).toBe('Custom briefing')
    expect(originalRoom.revisionId).toBe(createdRef.revisionId)

    const staleUpdate = await request(
      'POST',
      `/internal/workspaces/${workspaceId}/capabilities/agents.room-definition.update/invoke`,
      invokeBody(workspaceId, 'agents.room-definition.update', { definition }, {
        definition: createdRef,
      }),
    )
    expect(staleUpdate.status).toBe(409)
  })

  test('removing Agents removes the complete Module', async () => {
    const workspaceId = newWorkspaceId()
    await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })
    expect((await request('DELETE', `/internal/workspaces/${workspaceId}`)).status).toBe(204)
    expect((await request('GET', `/internal/workspaces/${workspaceId}/resources`)).status).toBe(404)
  })
})
