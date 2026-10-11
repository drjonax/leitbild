import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createWorldApplicationAssembly } from '../../../apps/world/src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../../../apps/world/src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../../apps/world/src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../../../apps/world/src/core/scenarios/runtime-resolver.ts'
import { createDirectRoutingAdapter } from '../../../apps/world/src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../../../apps/world/src/scenarios/definitions.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { asAIAgent } from '../../../apps/agents/src/agents/shared.ts'
import { effectiveAgentToolSelection } from '../../../apps/agents/src/agents/spawn.ts'
import { introspectAgentSurface } from '../../../apps/agents/src/diagnostics/surface-introspect.ts'
import { BUNDLED_ROOM_DEFINITIONS } from '../../../apps/agents/src/core/definitions/room-definition-catalog.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { messageFocus } from '../../../apps/agents/src/core/message-focus.ts'
import { createGetTimeTool, createPlaceResolveTool, createProductKnowledgeTools } from '../../../apps/agents/src/tools/built-in/index.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import {
  createWorkspaceRuntimeRegistry as createAgentsWorkspaceRuntimeRegistry,
  type WorkspaceRuntimeRegistry as AgentsWorkspaceRuntimeRegistry,
} from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

describe('Workspace Host with real Modules', () => {
  test('provisions real World and Agents Modules without stored Resource bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-combined-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'workspace-combined-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'workspace-combined-leitbild-'))
    const originalLeitbildHome = process.env.LEITBILD_HOME
    const originalProvider = process.env.PROVIDER
    const originalSeed = process.env.LEITBILD_SEED_WORKSPACE
    process.env.LEITBILD_HOME = leitbildHome
    process.env.PROVIDER = 'ollama'
    delete process.env.LEITBILD_SEED_WORKSPACE

    let leitbildRegistry: AgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await leitbildRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      if (originalProvider === undefined) delete process.env.PROVIDER
      else process.env.PROVIDER = originalProvider
      if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
      else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
      await rm(leitbildHome, { recursive: true, force: true })
    })
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }))

    // The shipped World catalogue, assembled as src/index.ts does, with
    // straight-line routing instead of OSRM.
    const routing = createDirectRoutingAdapter()
    const worldAssembly = createWorldApplicationAssembly({ routing })
    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: worldAssembly.packs }),
      scenarioDefinitions: builtinScenarioDefinitions,
      compileScenarioDefinition: source => compileScenarioDefinition(source, worldAssembly.packs, { routing }),
      scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldAssembly.packs),
      runtimeAdapters: worldAssembly.runtimeAdapters,
    })
    const worldServer = createWorldServer({
      workspaces: worldRegistry,
      bindHost: '127.0.0.1',
      port: 0,
      uiDistPath: uiDir,
      mapArtifacts: { rootDir: join(dataDir, 'maps') },
    })
    cleanup.push(() => worldServer.stop())

    const leitbildState = createAgentsModuleState()
    const leitbildServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!leitbildRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        const url = new URL(request.url)
        return await handleAgentsModuleApi(request, url, { state: leitbildState, registry: leitbildRegistry })
          ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => leitbildServer.stop(true))

    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({
            moduleId: 'world',
            internalBaseUrl: `http://127.0.0.1:${worldServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
          moduleRegistrationSchema.parse({
            moduleId: 'agents',
            internalBaseUrl: `http://127.0.0.1:${leitbildServer.port}`,
            manifestPath: '/.well-known/workspace-module',
          }),
        ],
      }),
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`

    const deployment = createDeploymentRuntime()
    deployment.sharedSkillStore.register({
      name: 'leitbild-assistance', description: 'Test Assistant Skill', body: 'Use Workspace discovery.',
      tools: [], allowedToolNames: [], dirPath: leitbildHome,
    })
    deployment.sharedSkillStore.register({
      name: 'operator-displays', description: 'Test display Skill', body: 'Compose displays when useful.',
      tools: [], allowedToolNames: [], dirPath: leitbildHome,
    })
    deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
    deployment.sharedToolRegistry.register(createPlaceResolveTool())
    deployment.sharedToolRegistry.register(createGetTimeTool())
    leitbildRegistry = createAgentsWorkspaceRuntimeRegistry({
      deployment,
      moduleState: leitbildState,
      workspaceHostUrl: baseUrl,
      idleMs: 1_000_000,
    })

    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Combined Lab' }),
    })
    expect(createdResponse.status).toBe(201)
    const workspace = (await createdResponse.json() as {
      workspace: { id: string; modules: Array<{ moduleId: string; status: string }> }
    }).workspace
    expect(workspace.modules.map(module => [module.moduleId, module.status])).toEqual([
      ['agents', 'ready'],
      ['world', 'ready'],
    ])

    const capabilityCatalogResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities`)
    expect(capabilityCatalogResponse.status).toBe(200)
    const capabilityIds = new Set((await capabilityCatalogResponse.json() as {
      capabilities: Array<{ id: string }>
    }).capabilities.map(capability => capability.id))
    expect(BUNDLED_ROOM_DEFINITIONS.map(definition => definition.id)).toEqual(['leitbild-assistant'])
    expect(BUNDLED_ROOM_DEFINITIONS[0]?.room.agents[0]).not.toHaveProperty('toolGrants')
    expect(capabilityIds).toContain('agents.assistance.open')

    const definitionCatalog = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`)
    expect(definitionCatalog.status).toBe(200)
    const scenario = (await definitionCatalog.json() as {
      definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }>
    }).definitions.find(
      (definition) => definition.ref.type === 'world.scenario' && definition.ref.id === 'halden-weather-response',
    )!
    const createRunResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.scenario.start/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...scenario.ref, revisionId: scenario.currentRevisionId },
          input: {},
        }),
      },
    )
    expect(createRunResponse.status).toBe(200)
    const runId = (await createRunResponse.json() as { result: { id: string } }).result.id
    const agentsRuntime = await leitbildRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    expect(agentsRuntime.rooms.listAllRooms()).toHaveLength(0)
    expect(agentsRuntime.team.listByKind('ai')).toHaveLength(0)

    // Exercise the same discovery → Host broker → Agents Definition → Room
    // path as opening a World run in the browser, with both real Modules.
    const resources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const worldRun = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === runId)!
    const runFamily = resources.find(resource => resource.ref.type === 'world.run-family' && resource.links.some(link => link.rel === 'contains' && link.ref.id === runId))!
    const assistanceResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.assistance.open/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          scope: { kind: 'collection', collection: runFamily.ref, members: { mode: 'all', except: [] } },
          title: worldRun.title,
          focusedSubjects: [worldRun.ref],
        },
        actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
      }),
    })
    expect(assistanceResponse.status).toBe(200)
    const runAssistantRef = (await assistanceResponse.json() as { result: { resource: { id: string } } }).result.resource
    const runAssistantRoom = agentsRuntime.rooms.getRoom(runAssistantRef.id)!
    const assistant = runAssistantRoom.getParticipantIds().map(id => agentsRuntime.team.getAgent(id)).find(agent => agent?.kind === 'ai')!
    expect(runAssistantRoom.getParticipantIds()).toHaveLength(2)
    expect(JSON.stringify(asAIAgent(assistant)!.getConfig())).not.toContain(runId)
    const runAssistantContext = { callerId: assistant.id, callerName: assistant.name, roomId: runAssistantRef.id }
    const runAssistantDiscovery = await agentsRuntime.toolRegistry.get('workspace_explore')!.execute({ view: 'scope', moduleId: 'world' }, runAssistantContext)
    expect(runAssistantDiscovery).toMatchObject({ success: true, data: { scope: { kind: 'collection', collection: runFamily.ref } } })
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'context', operationId: 'world.simulation-run.context', target: { kind: 'resource', ref: worldRun.ref }, input: {} }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'context', success: true }] } })

    // A later what-if copy becomes available to the default family selection
    // without mutating the Room or synchronizing a second family store.
    const copyResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.copy/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: worldRun.ref, input: { name: 'Weather response · what-if' } }),
    })
    expect(copyResponse.status).toBe(200)
    const copyId = (await copyResponse.json() as { result: { id: string } }).result.id
    const refreshedResources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const copiedRun = refreshedResources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === copyId)!
    expect(refreshedResources.find(resource => resource.ref.type === 'world.run-family' && resource.ref.id === runFamily.ref.id)?.links.filter(link => link.rel === 'contains')).toHaveLength(2)
    expect(agentsRuntime.rooms.listAllRooms()).toHaveLength(1)
    expect(agentsRuntime.team.listByKind('ai')).toHaveLength(1)
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'copy-context', operationId: 'world.simulation-run.context', target: { kind: 'resource', ref: copiedRun.ref }, input: {} }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'copy-context', success: true }] } })

    const roomRef = { workspaceId: workspace.id, moduleId: 'agents', type: 'agents.room', id: runAssistantRef.id }
    const setScope = (members: unknown, expectedRevision: number) => fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.room.scope.set/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: roomRef, input: { scope: { kind: 'collection', collection: runFamily.ref, members }, expectedRevision }, actor: { kind: 'human', id: 'operator' } }),
      },
    )
    expect((await setScope({ mode: 'selected', only: [worldRun.ref] }, 0)).status).toBe(200)
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'copy-context', operationId: 'world.simulation-run.context', target: { kind: 'resource', ref: copiedRun.ref }, input: {} }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'copy-context', success: false, error: expect.stringContaining('target_out_of_scope') }] } })
    expect((await setScope({ mode: 'all', except: [] }, 1)).status).toBe(200)
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'dispatch', operationId: 'world.ambulance.dispatch-state', target: { kind: 'resource', ref: worldRun.ref }, input: {} }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'dispatch', success: true }] } })
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'cancel', operationId: 'world.ambulance.cancel', target: { kind: 'resource', ref: worldRun.ref }, input: { unitId: 'amb:weather-response' } }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'cancel', success: true }] } })

    const restrictDelete = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.agent-restrictions.set/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: worldRun.ref, input: { restrictions: { operationIds: ['world.simulation-run.delete'], objects: [] }, expectedRevision: 0 }, actor: { kind: 'human', id: 'operator' } }),
    })
    expect(restrictDelete.status).toBe(200)
    expect(await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{ key: 'delete', operationId: 'world.simulation-run.delete', target: { kind: 'resource', ref: worldRun.ref }, input: {} }],
    }, runAssistantContext)).toMatchObject({ success: true, data: { results: [{ key: 'delete', success: false, error: expect.stringContaining('agent_access_restricted') }] } })

    // The Host launcher is only a generic Capability call. Agents owns the
    // reusable Room lifecycle and carries the current World Resource as
    // transient focus on the triggering message.
    const openAssistant = (prompt: string) => fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.assistance.open/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { prompt, focusedSubjects: [worldRun.ref] },
          actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
        }),
      },
    )
    const assistantResponse = await openAssistant('Explain this Run.')
    if (assistantResponse.status !== 200) throw new Error(await assistantResponse.text())
    expect(assistantResponse.status).toBe(200)
    const assistantRoomId = (await assistantResponse.json() as { result: { resource: { id: string }; reused: boolean } }).result.resource.id
    const assistantRoom = agentsRuntime.rooms.getRoom(assistantRoomId)!
    const assistantPrompt = assistantRoom.getRecent(10).find(message => message.content === 'Explain this Run.')!
    expect(messageFocus(assistantPrompt)).toEqual([worldRun.ref])
    const generalAssistant = assistantRoom.getParticipantIds()
      .map(id => agentsRuntime.team.getAgent(id))
      .find(agent => agent?.kind === 'ai')!
    const generalAssistantAI = asAIAgent(generalAssistant)!
    expect(generalAssistantAI.getMaxToolIterations()).toBeUndefined()
    expect(effectiveAgentToolSelection(generalAssistantAI.getConfig())).toEqual(expect.arrayContaining([
      'product_search',
      'product_read',
      'place_resolve',
      'workspace_explore',
      'workspace_call',
    ]))
    await agentsRuntime.refreshAllAgentTools()
    const refreshedSurface = introspectAgentSurface(agentsRuntime, generalAssistant.name, assistantRoomId)
    expect(refreshedSurface).not.toHaveProperty('error')
    expect('tools' in refreshedSurface ? refreshedSurface.tools.map(tool => tool.name) : []).toEqual(expect.arrayContaining([
      'workspace_explore',
      'workspace_call',
    ]))
    const reusedAssistantResponse = await openAssistant('What Packs are active?')
    expect(reusedAssistantResponse.status).toBe(200)
    expect((await reusedAssistantResponse.json() as { result: { resource: { workspaceId: string; moduleId: string; type: string; id: string }; uiPath: string; reused: boolean } }).result).toEqual({
      resource: { workspaceId: workspace.id, moduleId: 'agents', type: 'agents.room', id: assistantRoomId },
      uiPath: `/workspaces/${workspace.id}/agents?room=${assistantRoomId}`,
      reused: true,
    })
    expect(agentsRuntime.rooms.listAllRooms().filter(room => room.sourceDefinition?.id === 'leitbild-assistant')).toHaveLength(2)
    expect(agentsRuntime.rooms.getRoom(assistantRoomId)?.profile.scope).toEqual({ kind: 'workspace' })
    expect(agentsRuntime.rooms.getRoom(runAssistantRef.id)?.profile.scope).toMatchObject({ kind: 'collection', collection: runFamily.ref })

    const runtime = agentsRuntime
    const context = runAssistantContext
    const discover = runtime.toolRegistry.get('workspace_explore')
    const invoke = runtime.toolRegistry.get('workspace_call')
    expect(discover).toBeDefined()
    expect(invoke).toBeDefined()
    const discovered = await discover!.execute({ view: 'scope' }, context)
    expect(discovered.success).toBe(true)
    const currentRun = (discovered.data as {
      resources: Array<{
        target: { kind: 'resource'; ref: { workspaceId: string; moduleId: string; type: string; id: string } }
        summary: Array<{ key: string; kind: string; value: unknown }>
      }>
    }).resources.find(resource =>
      resource.target.ref.type === 'world.simulation-run' && resource.target.ref.id === runId,
    )!
    expect(currentRun.target.ref.id).toBe(runId)
    expect(currentRun.summary.find(item => item.key === 'viewer-count')).toMatchObject({ kind: 'count', value: 0 })

    const invokeOne = async (call: Record<string, unknown>) => {
      const response = await invoke!.execute({ calls: [{ key: 'result', ...call }] }, context)
      if (!response.success) return response
      const result = (response.data as { results: Array<{ success: boolean; data?: unknown; error?: string; details?: unknown }> }).results[0]!
      return result.success
        ? { success: true as const, data: result.data }
        : { success: false as const, error: result.error, data: result.details }
    }

    const read = await invokeOne({
      operationId: 'world.simulation-run.read',
      target: currentRun.target,
      input: {},
    })
    expect(read.success).toBe(true)
    expect((read.data as { id: string }).id).toBe(runId)

    // Real Agent tool → Host broker → World command, without any model call or
    // stored Run ID in the profile. Discover IDs, check eligibility, act, verify.
    const initialDispatch = await invokeOne({ operationId: 'world.ambulance.dispatch-state', target: currentRun.target, input: {} })
    expect(initialDispatch.success).toBe(true)
    const dispatchState = initialDispatch.data as { units: Array<{ id: string }>; incidents: Array<{ id: string }>; patients: Array<{ id: string; incidentId: string }>; careSites: Array<{ id: string }> }
    const unitId = dispatchState.units[0]!.id
    const incidentId = dispatchState.incidents[0]!.id
    const patientIds = dispatchState.patients.filter(patient => patient.incidentId === incidentId).map(patient => patient.id)
    const cancel = await invokeOne({ operationId: 'world.ambulance.cancel', target: currentRun.target, input: { unitId } })
    expect(cancel).toMatchObject({ success: true, data: { ok: true } })
    const options = await invokeOne({ operationId: 'world.ambulance.dispatch-options', target: currentRun.target, input: { action: 'assign', incidentId, patientIds } })
    expect(options).toMatchObject({ success: true, data: { candidates: expect.arrayContaining([expect.objectContaining({ id: unitId, eligible: true })]) } })
    const dispatched = await invokeOne({ operationId: 'world.ambulance.assign', target: currentRun.target, input: { unitId, incidentId, patientIds } })
    expect(dispatched).toMatchObject({ success: true, data: { ok: true } })
    const planned = await invokeOne({ operationId: 'world.ambulance.append-stop', target: currentRun.target, input: { kind: 'handover', unitId, careSiteId: dispatchState.careSites[0]!.id, patientIds } })
    expect(planned).toMatchObject({ success: true, data: { ok: true } })
    const afterDispatch = await invokeOne({ operationId: 'world.ambulance.dispatch-state', target: currentRun.target, input: {} })
    expect(afterDispatch).toMatchObject({ success: true, data: { units: expect.arrayContaining([expect.objectContaining({ id: unitId, patientIds, phase: 'mobilizing', stops: expect.arrayContaining([expect.objectContaining({ kind: 'pickup', targetId: incidentId })]) })]) } })

    const weatherPoint = { type: 'Point', coordinates: [11.41, 59.13] }
    const weatherRead = await invokeOne(
      { operationId: 'world.weather.sample-at-point', target: currentRun.target, input: { point: weatherPoint } },
    )
    expect(weatherRead.success).toBe(true)
    expect((weatherRead.data as { quality: { model: string } }).quality.model).toBe(
      'prescribed-atmosphere/heuristic-ground',
    )
    const intervention = await invokeOne(
      {
        operationId: 'world.weather.intervene-ground',
        target: currentRun.target,
        input: {
          area: {
            type: 'Polygon',
            coordinates: [
              [
                [11.4, 59.12],
                [11.42, 59.12],
                [11.42, 59.14],
                [11.4, 59.14],
                [11.4, 59.12],
              ],
            ],
          },
          surface: { ice: 0.8 },
        },
      },
    )
    expect(intervention).toMatchObject({ success: true })
    const afterWeather = await invokeOne(
      { operationId: 'world.weather.sample-at-point', target: currentRun.target, input: { point: weatherPoint } },
    )
    expect(afterWeather.success).toBe(true)
    expect((afterWeather.data as { state: { surface: { ice: number } } }).state.surface.ice).toBeCloseTo(0.8, 1)

    const deleteRun = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.delete/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: currentRun.target.ref, input: {} }),
      },
    )
    expect(deleteRun.status).toBe(200)
    expect(agentsRuntime.rooms.getRoom(runAssistantRef.id)).toBeDefined()
    const resourcesAfterDelete = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)
    expect(resourcesAfterDelete.status).toBe(200)
    expect((await resourcesAfterDelete.json() as {
      resources: Array<{ ref: { type: string; id: string } }>
    }).resources.some(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === runId)).toBe(false)

    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await worldRegistry.list()).toEqual([])
    expect(await leitbildState.has(workspaceIdSchema.parse(workspace.id))).toBe(false)
  })
})
