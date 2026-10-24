import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceResourceCatalogSchema } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../../../apps/world/tests/helpers.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../../apps/agents/src/api/__fixtures__/stub-gateway.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { createPlaceResolveTool, createProductKnowledgeTools } from '../../../apps/agents/src/tools/built-in/index.ts'
import { PROPOSAL_RESUME_CAUSE } from '../../../apps/agents/src/core/proposal-resume.ts'
import type { AIAgent } from '../../../apps/agents/src/core/types/agent.ts'
import type { ChatRequest, StreamChunk } from '../../../apps/agents/src/core/types/llm.ts'
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

const until = async <T>(read: () => T | undefined, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Not reached within ${timeoutMs} ms`)
    await Bun.sleep(100)
  }
}

describe('an approved proposal resumes the procedure with real Modules', () => {
  test('the agent proposes through the Host, a person approves in World, and the same agent continues in the same room', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'proposal-resume-world-'))
    const uiDir = await mkdtemp(join(tmpdir(), 'proposal-resume-ui-'))
    const leitbildHome = await mkdtemp(join(tmpdir(), 'proposal-resume-agents-'))
    await writeFile(join(uiDir, 'embed.html'), 'embed page')
    const originalLeitbildHome = process.env.LEITBILD_HOME
    process.env.LEITBILD_HOME = leitbildHome
    let agentsRegistry: AgentsWorkspaceRuntimeRegistry | undefined
    cleanup.push(async () => {
      await agentsRegistry?.shutdown()
      if (originalLeitbildHome === undefined) delete process.env.LEITBILD_HOME
      else process.env.LEITBILD_HOME = originalLeitbildHome
      for (const dir of [leitbildHome, dataDir, uiDir]) await rm(dir, { recursive: true, force: true })
    })

    const worldRegistry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    const worldServer = createWorldServer({ workspaces: worldRegistry, featuredDefinitions: { definitions: [], listed: [] }, bindHost: '127.0.0.1', port: 0, uiDistPath: uiDir, mapArtifacts: { rootDir: join(dataDir, 'maps') } })
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

    // What the model proposes once the Run is known.
    const proposal = { run: undefined as unknown, input: undefined as unknown }
    // The model: proposes on the person's order, holds with its answer, and continues when resumed.
    const requests: ChatRequest[] = []
    const say = (text: string): ReadonlyArray<StreamChunk> => [{ delta: text, done: false }, { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }]
    const gateway = {
      ...makeStubGateway(),
      stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
        requests.push(structuredClone(request))
        const last = request.messages.at(-1)!
        if (typeof last.content === 'string' && last.content.startsWith('[Proposal approved]')) {
          yield* say('Unit A1 · MOV-8000A reads shut; continuing the procedure.')
        } else if (!request.messages.some(message => message.role === 'tool')) {
          yield {
            delta: '', done: true, finishReason: 'tool_calls', tokensUsed: { prompt: 1, completion: 1 },
            toolCalls: [{ id: 'propose-1', function: { name: 'workspace_call', arguments: { calls: [{ key: 'propose', operationId: 'world.process-plant.control.propose', target: { kind: 'resource', ref: proposal.run }, input: proposal.input }] } } }],
          }
        } else {
          yield* say('Unit A1 · proposed SHUT MOV-8000A; approve it in the display window.')
        }
      },
    }
    const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
    for (const name of ['leitbild-assistance', 'operator-displays', 'multiunit-displays', 'procedure-runner']) {
      deployment.sharedSkillStore.register({ name, description: `Test ${name}`, body: 'Test skill.', tools: [], allowedToolNames: [], dirPath: leitbildHome })
    }
    deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
    deployment.sharedToolRegistry.register(createPlaceResolveTool())
    agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment, moduleState: agentsState, workspaceHostUrl: baseUrl, idleMs: 1_000_000 })

    const { workspace } = await (await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Proposal resume' }),
    })).json() as { workspace: { id: string } }
    const invoke = async <T>(capabilityId: string, body: Record<string, unknown>): Promise<T> =>
      (await json<{ result: T }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/${capabilityId}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }))).result
    const { definitions } = await json<{ definitions: Array<{ ref: Record<string, string>; currentRevisionId: string }> }>(await fetch(`${baseUrl}/api/workspaces/${workspace.id}/definitions`))
    const scenario = definitions.find(definition => definition.ref.type === 'world.scenario' && definition.ref.id === 'test-plant')!
    const started = await invoke<{ id: string }>('world.scenario.start', { definition: { ...scenario.ref, revisionId: scenario.currentRevisionId }, input: {} })
    const resources = workspaceResourceCatalogSchema.parse(await (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/resources`)).json()).resources
    const run = resources.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === started.id)!
    const operator = { kind: 'human', id: 'operator', displayName: 'Operator' }
    const plantId = 'plant:halden-a1'
    proposal.run = run.ref
    proposal.input = { plantId, tagId: 'MOV-8000A', value: 0, reason: 'PORV-456A does not follow its SHUT demand', procedureStep: 'Isolate a leaking PORV', evidence: ['PT-455'] }

    const opened = await invoke<{ resource: { id: string } }>('agents.assistance.open', { input: { scope: { kind: 'resource', resource: run.ref }, title: run.title }, actor: operator })
    const agentsRuntime = await agentsRegistry.getOrLoad(workspaceIdSchema.parse(workspace.id))
    const room = agentsRuntime.rooms.getRoom(opened.resource.id)!
    const assistant = room.getParticipantIds().map(id => agentsRuntime.team.getAgent(id)).find(agent => agent?.kind === 'ai') as AIAgent
    assistant.updateModel('mock-model')
    const person = await agentsRuntime.spawnHumanAgent({ name: 'Operator' }, () => {})
    await agentsRuntime.addAgentToRoom(person.id, room.profile.id, 'test')

    agentsRuntime.routeMessage({ rooms: [room.profile.id] }, { senderId: person.id, senderName: 'Operator', content: 'PORV-456A is leaking: isolate it.', type: 'chat' })
    await assistant.whenIdle()
    const answer = room.getRetainedMessages().find(message => message.senderId === assistant.id && message.type === 'chat')!
    expect(answer.content).toContain('proposed SHUT MOV-8000A')
    expect(agentsRuntime.proposalResumes!.watching()).toEqual([answer.generationTraceId!])

    // The person approves in the display window: World executes the stored write under their command.
    const [pending] = (await invoke<{ proposals: Array<{ proposal: { id: string; status: string } }> }>('world.process-plant.control.proposals', { resource: run.ref, input: { plantId }, actor: operator })).proposals
    expect(pending!.proposal.status).toBe('pending')
    expect(requests).toHaveLength(2)
    await invoke('world.process-plant.control.decide', { resource: run.ref, input: { plantId, proposalId: pending!.proposal.id, decision: 'approve' }, actor: operator })

    const reply = await until(() => room.getRetainedMessages().find(message => message.cause?.kind === PROPOSAL_RESUME_CAUSE), 15_000)
    await assistant.whenIdle()
    expect(reply.senderId).toBe(assistant.id)
    expect(reply.inReplyTo?.[0]).toBe(answer.id)
    expect(reply.cause).toEqual({ kind: PROPOSAL_RESUME_CAUSE, name: 'operator approved SHUT MOV-8000A' })
    expect(reply.content).toBe('Unit A1 · MOV-8000A reads shut; continuing the procedure.')
    const instruction = requests.at(-1)!.messages.at(-1)!.content
    expect(instruction).toContain('approved your proposal SHUT MOV-8000A on Plant plant:halden-a1 for Isolate a leaking PORV')
    expect(instruction).toContain(`messageId "${answer.id}"`)
    // The instruction is transient, and the proposal resumed the agent once.
    expect(room.getRetainedMessages().some(message => message.content.includes('[Proposal approved]'))).toBe(false)
    expect(requests).toHaveLength(3)
    expect(agentsRuntime.proposalResumes!.watching()).toEqual([])
  }, 60_000)
})
