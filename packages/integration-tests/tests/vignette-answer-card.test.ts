// End to end with real Modules, on the fixture Pack (the stand-in for a Pack World knows nothing about): an
// Assistant turn composes two vignettes through World's display.compose, reads their cards as lines keyed for
// the whole turn, cites a number its line contradicts and is corrected once, and the chat reads the same keys
// back from the turn's evidence for the frozen card and the key chips.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { embeddedViewPath } from '@leitbild/contracts/embedded-view-route'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { roomRoutes } from '../../../apps/agents/src/api/routes/rooms.ts'
import type { RouteContext } from '../../../apps/agents/src/api/routes/types.ts'
import { evaluate } from '../../../apps/agents/src/agents/evaluation.ts'
import { parseViewFenceBody, viewRefFor } from '../../../apps/agents/src/core/render-validators/view-fence.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createGetTimeTool, createPlaceResolveTool, createProductKnowledgeTools } from '../../../apps/agents/src/tools/built-in/index.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import type { ChatRequest, LLMProvider } from '../../../apps/agents/src/core/types/llm.ts'
import type { ToolExecutor } from '../../../apps/agents/src/core/types/tool.ts'
import { createTurnCardsReader, frozenCard, itemOf } from '../../../apps/agents/src/ui/modules/live-view/cards.ts'
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

/** World, Agents and the Host on real servers, with an assistance Room on a started fixture Run. */
const startChain = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vignette-card-world-'))
  const uiDir = await mkdtemp(join(tmpdir(), 'vignette-card-ui-'))
  const leitbildHome = await mkdtemp(join(tmpdir(), 'vignette-card-agents-'))
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
    dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(),
  })
  const worldServer = createWorldServer({ workspaces: worldRegistry, featuredDefinitions: { definitions: [], listed: [] }, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
  cleanup.push(() => worldServer.stop())
  const agentsState = createAgentsModuleState()
  const agentsServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
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
    modules: createModuleGateway({ registrations: [
      moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: `http://127.0.0.1:${worldServer.port}`, manifestPath: '/.well-known/workspace-module' }),
      moduleRegistrationSchema.parse({ moduleId: 'agents', internalBaseUrl: `http://127.0.0.1:${agentsServer.port}`, manifestPath: '/.well-known/workspace-module' }),
    ] }),
  })
  const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
  cleanup.push(() => hostServer.stop(true))
  const baseUrl = `http://127.0.0.1:${hostServer.port}`
  const deployment = createDeploymentRuntime()
  for (const name of ['leitbild-assistance', 'operator-displays', 'procedure-runner']) {
    deployment.sharedSkillStore.register({ name, description: `Test ${name}`, body: 'Test skill.', tools: [], allowedToolNames: [], dirPath: leitbildHome })
  }
  deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
  deployment.sharedToolRegistry.register(createPlaceResolveTool())
  deployment.sharedToolRegistry.register(createGetTimeTool())
  agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: baseUrl, idleMs: 1_000_000 })

  const { workspace } = await (await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Vignette card chain' }),
  })).json() as { workspace: { id: string } }
  const { definitions } = await json<{ definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }> }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`))
  const scenario = definitions.find(definition => definition.ref.type === 'world.scenario' && definition.ref.id === 'test-response')!
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
  const agents = await agentsRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
  const room = agents.rooms.getRoom(opened.result.resource.id)!
  const assistant = room.getParticipantIds().map(id => agents.team.getAgent(id)).find(agent => agent?.kind === 'ai')!
  return { workspaceId: workspace.id, run, agents, room, assistant }
}

describe('a vignette answer card with real Modules', () => {
  test('compose → card lines keyed for the turn → a contradicted key corrected once → the frozen card and key chips', async () => {
    const { workspaceId, run, agents, room, assistant } = await startChain()
    const roomId = room.profile.id
    const turnId = 'turn-cards'
    agents.executionStore.beginTurn({ id: turnId, roomId, agentId: assistant.id, startedAt: Date.now() })

    // The runtime's own executor, as spawn.ts drives it: each call recorded before and after it runs.
    const workspaceCall = agents.toolRegistry.get('workspace_call')!
    const executor: ToolExecutor = async (calls, _roomId, _signal, executionTurnId) => {
      const results = []
      for (const call of calls) {
        agents.executionStore.recordAttempt(executionTurnId!, { id: call.callId!, tool: call.tool, arguments: call.arguments, startedAt: Date.now() })
        const result = await workspaceCall.execute(call.arguments, { callerId: assistant.id, callerName: assistant.name, roomId, executionCallId: call.callId! })
        agents.executionStore.recordOutcome(executionTurnId!, call.callId!, result)
        results.push(result)
      }
      return results
    }
    const compose = (key: string, subject: string) => ({ calls: [{ key, operationId: 'world.simulation-run.display.compose', target: { kind: 'resource', ref: run.ref }, input: { title: subject, question: `How is ${subject}?`, subjects: [subject], views: [] } }] })
    // The model: one vignette per round, then answers from the lines it read, first with a number its line contradicts.
    let line = ''
    let speed = 0
    const requests: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => [],
      chat: async request => {
        // evaluate keeps appending to the same context array: keep what this call was sent.
        requests.push({ ...request, messages: [...request.messages] })
        const base = { generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
        if (requests.length === 1) return { ...base, content: '', toolCalls: [{ id: 'w0', function: { name: 'workspace_call', arguments: compose('first', 'unit:a12') } }] }
        if (requests.length === 2) return { ...base, content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: compose('second', 'unit:a21') } }] }
        const shown = request.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n')
        line = /k\d+ · Unit A-21 · [^"\\]*speed · [\d.]+ m\/s/.exec(shown)?.[0] ?? ''
        const [key, value] = [line.split(' · ')[0]!, Number(/([\d.]+) m\/s$/.exec(line)![1])]
        speed = value
        const answer = (value: number) => `Unit A-21 runs at ${value.toFixed(1)} m/s ⟦${key}⟧.\n\n\`\`\`leitbild-view\nview call_1_0/second\n\`\`\``
        return { ...base, content: requests.length === 3 ? answer(value + 5) : answer(value) }
      },
    }
    const result = await evaluate({ messages: [{ role: 'system', content: 'Test.' }, { role: 'user', content: 'How are the units?' }], flushInfo: { ids: new Set(), triggerRoomId: roomId }, warnings: [] },
      { name: assistant.name, model: 'stub-model', persona: 'test' }, provider, executor, 5, roomId,
      { executionTurnId: turnId, toolDefinitions: [{ type: 'function', function: { name: 'workspace_call', description: 'call', parameters: {} } }] })
    agents.executionStore.finishTurn(turnId, 'completed')

    // The second card's lines continue the first card's keys, and the model read them as lines.
    const firstCard = JSON.parse(requests[1]!.messages.at(-1)!.content) as { results: Array<{ data: { card: string[] } }> }
    const firstKeys = firstCard.results[0]!.data.card.slice(1).filter(text => /^k\d+ · /.test(text)).length
    expect(firstKeys).toBeGreaterThan(0)
    expect(line).toStartWith(`k${firstKeys + 1} · Unit A-21 · `)
    // One correction for the contradicted number, then the answer as the line reads it.
    expect(requests).toHaveLength(4)
    const key = line.split(' · ')[0]!
    // Only the contradicted speed: "A-21" is the label's own name for the unit.
    expect(requests[3]!.messages.at(-1)!.content.split('\n').filter(text => text.startsWith('- '))).toEqual([
      `- ${(speed + 5).toFixed(1)} is cited with ⟦${key}⟧, but ${key} reads "${line.split(' · ').at(-1)}" (${line.split(' · ').slice(1, 3).join(' · ')}).`,
    ])
    if (result.decision.response.action !== 'respond') throw new Error(JSON.stringify(result.decision.response))
    const answer = result.decision.response.content
    expect(answer).toContain(`${line.split(' · ').at(-1)} ⟦${key}⟧`)

    // The chat: the fence resolves to the vignette from the turn's own evidence ...
    const fetchJson = async (path: string) => {
      const route = roomRoutes.find(candidate => candidate.method === 'GET' && candidate.pattern.test(path))!
      const response = await route.handler(new Request(`http://agents${path}`), path.match(route.pattern)!, { system: agents } as unknown as RouteContext)
      return { status: response.status, body: response.status === 200 ? await response.json() : null }
    }
    const fence = parseViewFenceBody('view call_1_0/second')
    if (fence.kind !== 'reference') throw new Error(fence.error)
    const resolution = await resolveViewReference(fence.ref, { roomId, turnId, workspaceId }, fetchJson)
    if (resolution.kind !== 'view') throw new Error(resolution.message)
    expect(String(resolution.envelope.viewType)).toBe('display.vignette')
    expect(embeddedViewPath(resolution.envelope)).toBe(`/workspaces/${workspaceId}/world/embed/display.vignette`)
    // ... and its chip and key chips read the keys the model read.
    const read = await createTurnCardsReader(fetchJson)(roomId, turnId)
    if (read.kind !== 'cards') throw new Error(read.message)
    expect(read.cards.map(entry => entry.viewRef)).toEqual(['call_0_0/first', 'call_1_0/second'])
    const presented = read.cards.find(entry => entry.viewRef === viewRefFor(fence.ref.callId, fence.ref.key))!
    const frozen = frozenCard(presented.card)
    expect(frozen.caption).toMatch(/^FROZEN · sim \d{2}:\d{2}:\d{2}$/)
    expect(frozen.lines.map(entry => entry.text)).toContain(line)
    expect(itemOf(read.cards, key)?.label).toBe(line.split(' · ').slice(1, 3).join(' · '))
    expect(itemOf(read.cards, `k${read.cards.flatMap(entry => entry.card.items).length + 1}`)).toBeUndefined()
  }, 60_000)
})
