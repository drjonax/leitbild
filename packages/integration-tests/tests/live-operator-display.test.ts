import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { embeddedViewFragment, embeddedViewPath } from '@leitbild/contracts/embedded-view-route'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { collectViewRefs } from '../../../apps/agents/src/agents/evaluation.ts'
import { checkViewEnvelope, parseViewFenceBody } from '../../../apps/agents/src/core/render-validators/view-fence.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createGetTimeTool, createPlaceResolveTool, createProductKnowledgeTools } from '../../../apps/agents/src/tools/built-in/index.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { resolveViewReference } from '../../../apps/agents/src/ui/modules/live-view/resolve.ts'
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

const json = async <T>(response: Response): Promise<T> => {
  expect(response.status).toBe(200)
  return await response.json() as T
}

describe('live operator display chain with real Modules', () => {
  test('an agent composes a display that the chat resolves and World renders live', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'live-display-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'live-display-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'live-display-agents-'))
    await writeFile(join(uiDir, 'embed.html'), 'embed page')
    const originalLeitbildHome = process.env.LEITBILD_HOME
    const originalProvider = process.env.PROVIDER
    process.env.LEITBILD_HOME = leitbildHome
    process.env.PROVIDER = 'ollama'
    let agentsRegistry: AgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await agentsRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      if (originalProvider === undefined) delete process.env.PROVIDER
      else process.env.PROVIDER = originalProvider
      for (const dir of [leitbildHome, dataDir, uiDir]) await rm(dir, { recursive: true, force: true })
    })

    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const worldServer = createWorldServer({ workspaces: worldRegistry, featuredDefinitions: { definitions: [] }, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
    cleanup.push(() => worldServer.stop())
    const agentsState = createAgentsModuleState()
    const agentsServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!agentsRegistry) return Response.json({ error: { code: 'runtime_unavailable' } }, { status: 503 })
        return await handleAgentsModuleApi(request, new URL(request.url), { state: agentsState, registry: agentsRegistry }) ?? new Response('Not found', { status: 404 })
      },
    })
    cleanup.push(() => agentsServer.stop(true))
    const store = createWorkspaceStore(':memory:')
    cleanup.push(() => store.close())
    const host = createWorkspaceHost({
      store,
      modules: createModuleGateway({
        registrations: [
          moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: `http://127.0.0.1:${worldServer.port}`, manifestPath: '/.well-known/workspace-module' }),
          moduleRegistrationSchema.parse({ moduleId: 'agents', internalBaseUrl: `http://127.0.0.1:${agentsServer.port}`, manifestPath: '/.well-known/workspace-module' }),
        ],
      }),
    })
    const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
    cleanup.push(() => hostServer.stop(true))
    const baseUrl = `http://127.0.0.1:${hostServer.port}`
    const worldUrl = `http://127.0.0.1:${worldServer.port}`

    const deployment = createDeploymentRuntime()
    for (const name of ['leitbild-assistance', 'operator-displays']) {
      deployment.sharedSkillStore.register({ name, description: `Test ${name}`, body: 'Test skill.', tools: [], allowedToolNames: [], dirPath: leitbildHome })
    }
    deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
    deployment.sharedToolRegistry.register(createPlaceResolveTool())
    deployment.sharedToolRegistry.register(createGetTimeTool())
    agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: baseUrl, idleMs: 1_000_000 })

    const { workspace } = await (await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Display chain' }),
    })).json() as { workspace: { id: string } }
    const { definitions } = await json<{ definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }> }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`))
    const scenario = definitions.find(definition => definition.ref.type === 'world.scenario' && definition.ref.id === 'test-plant')!
    const started = await json<{ result: { id: string } }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.scenario.start/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { ...scenario.ref, revisionId: scenario.currentRevisionId }, input: {} }),
    }))
    const resources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const run = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === started.result.id)!
    const opened = await json<{ result: { resource: { id: string } } }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/agents.assistance.open/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { scope: { kind: 'resource', resource: run.ref }, title: run.title }, actor: { kind: 'human', id: 'operator', displayName: 'Operator' } }),
    }))
    const agentsRuntime = await agentsRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const room = agentsRuntime.rooms.getRoom(opened.result.resource.id)!
    const assistant = room.getParticipantIds().map(id => agentsRuntime.team.getAgent(id)).find(agent => agent?.kind === 'ai')!

    // Agents → Host broker → World: compose is a read the agent can batch.
    const composed = await agentsRuntime.toolRegistry.get('workspace_call')!.execute({
      calls: [{
        key: 'display',
        operationId: 'world.process-plant.display.compose',
        target: { kind: 'resource', ref: run.ref },
        input: {
          plantId: 'plant:halden-a1',
          title: 'Pressurizer pressure',
          question: 'Is pressurizer pressure holding inside its control band?',
          need: 'Decide whether spray or heaters need manual action',
          subjects: ['PT-455'],
          panels: [{ kind: 'trend', horizon: '2m', signals: [{ ref: 'PT-455', role: 'primary' }] }],
        },
      }],
    }, { callerId: assistant.id, callerName: assistant.name, roomId: room.profile.id, executionCallId: 'call_0_0' })
    expect(composed).toMatchObject({ success: true, data: { results: [{ key: 'display', success: true, viewRef: 'call_0_0/display' }] } })
    const entry = (composed.data as { results: Array<{ embeddedView: unknown; data: { shows: string[] } }> }).results[0]!
    expect(entry.data.shows.join('\n')).toContain('"LO-LO 13.8 MPa · RX TRIP" automatic action line: Low pressurizer pressure reactor trip, acts below 13.8 MPa')

    // The evaluation loop accepts exactly this reference for this turn.
    const viewRefs = new Set<string>()
    collectViewRefs(viewRefs, 'workspace_call', composed)
    expect([...viewRefs]).toEqual(['call_0_0/display'])

    // The chat resolves the fence from the turn evidence, never from the fence text.
    const fence = parseViewFenceBody('view call_0_0/display')
    if (fence.kind !== 'reference') throw new Error(fence.error)
    const resolution = await resolveViewReference(fence.ref, { roomId: room.profile.id, turnId: 'turn-1', workspaceId: workspace.id }, async () => ({
      status: 200, body: { id: 'call_0_0', tool: 'workspace_call', arguments: {}, result: composed },
    }))
    expect(resolution.kind).toBe('view')
    if (resolution.kind !== 'view') return
    expect(checkViewEnvelope(resolution.envelope, workspace.id).kind).toBe('view')
    expect(resolution.envelope.subject).toEqual(run.ref)
    const path = embeddedViewPath(resolution.envelope)
    expect(path).toBe(`/workspaces/${workspace.id}/world/embed/process-plant.display`)
    expect(embeddedViewFragment(resolution.envelope)).toStartWith('#view=')

    // World serves the embed page and the browser operations it uses.
    expect(await (await fetch(`${worldUrl}${path}`)).text()).toBe('embed page')
    const runPath = `${worldUrl}/api/workspaces/${workspace.id}/world/simulation-runs/${run.ref.id}`
    expect(await json<{ loaded: boolean }>(await fetch(`${runPath}/presence`))).toMatchObject({ loaded: true })
    const invoke = async <T>(capabilityId: string, input: unknown): Promise<T> => (await json<{ result: T }>(await fetch(`${runPath}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }),
    }))).result
    const view = await invoke<{ display: { panels: Array<{ strips: Array<{ pens: Array<{ path: string; thresholds: unknown[] }> }> }> }; modelChanged: boolean }>(
      'world.process-plant.display.view', { plantId: 'plant:halden-a1', state: resolution.envelope.state })
    expect(view.modelChanged).toBe(false)
    const pen = view.display.panels[0]!.strips[0]!.pens[0]!
    expect(pen.thresholds.length).toBeGreaterThan(0)
    const sample = await invoke<{ values: Array<{ path: string; value: unknown }> }>('world.process-plant.display.sample', { plantId: 'plant:halden-a1', paths: [pen.path] })
    expect(typeof sample.values[0]!.value).toBe('number')
  })
})
