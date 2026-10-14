// ============================================================================
// Integration test: a progress line crosses workspace_call → evaluation →
// agent → spawn → Room → the agent's own view and the persisted Room. Each
// layer has unit tests; this proves the chain: a change carrying `say` that
// the Workspace Host accepts posts that line to the Room as the agent's own
// progress message while the turn continues, before its answer; the agent
// does not answer it; a later turn replays it; the Room persists it.
// ============================================================================

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import { workspaceModulePaths } from '../core/paths.ts'
import { loadWorkspaceModuleSnapshots, saveWorkspaceModuleSnapshots, serializeModuleSnapshots } from '../core/storage/module-snapshots.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { AIAgent } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'

describe('progress line wiring', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-progress-'))
    process.env.LEITBILD_HOME = homeDir
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('an accepted change posts its say line while the turn runs, and the answer follows as the only reply', async () => {
    const workspaceId = newWorkspaceId()
    const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
    const transition = 'world.procedure.run.transition'
    const observedAt = new Date().toISOString()
    const invoked: unknown[] = []
    const host = Bun.serve({
      port: 0,
      fetch: async request => {
        const path = new URL(request.url).pathname
        if (path.endsWith('/resources')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], resources: [
          { ref: run, title: 'Unit 1', capabilityIds: [transition], links: [], summary: [], observedAt },
        ] })
        if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], definitions: [] })
        if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], capabilities: [
          { id: transition, moduleId: 'world', kind: 'command', scope: { kind: 'resource', resourceType: run.type }, title: 'Transition', description: 'Answer the current step.', risk: 'write', idempotent: false, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
        ] })
        invoked.push(await request.json())
        return Response.json({ result: { ok: true, next: { stepId: '2' } } })
      },
    })
    try {
      const line = 'E-0 step 1 · Verified: RTB-A open, RTB-B open at 10:01:02 → step 2'
      const requests: ChatRequest[] = []
      const roomAtSecondPass: Message[][] = []
      let room: ReturnType<typeof system.rooms.createRoom> | undefined
      const gateway = {
        ...makeStubGateway(),
        stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
          requests.push(structuredClone(request))
          if (requests.length === 1) {
            yield { delta: '', done: true, finishReason: 'tool_calls', tokensUsed: { prompt: 1, completion: 1 }, toolCalls: [{ id: 'call-1', function: { name: 'workspace_call', arguments: {
              calls: [{ key: 'step', operationId: transition, input: { stepId: '1', branchIndex: 0 }, say: line }],
            } } }] }
            return
          }
          if (requests.length === 2) roomAtSecondPass.push([...room!.getRetainedMessages()])
          yield { delta: requests.length === 2 ? 'Unit 1 · E-0 step 2 · holding for your judgement' : 'Still at step 2.', done: false }
          yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }
        },
      }
      const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
      const system = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: `http://127.0.0.1:${host.port}` })
      room = system.rooms.createRoom({ name: 'Assistant', createdBy: 'test' })
      const assistant = await system.spawnAIAgent({ name: 'Assistant', model: 'mock-model', persona: 'Run procedures.' }) as AIAgent
      const human = await system.spawnHumanAgent({ name: 'Alice' }, () => {})
      await system.addAgentToRoom(assistant.id, room.profile.id, 'test')
      await system.addAgentToRoom(human.id, room.profile.id, 'test')

      const question = system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content: 'Run E-0 unit 1', type: 'chat' })[0]!
      await assistant.whenIdle()

      // One turn of two passes: neither the line nor the answer started another.
      expect(requests).toHaveLength(2)
      expect(invoked).toEqual([expect.objectContaining({ resource: run, input: { stepId: '1', branchIndex: 0 } })])
      expect(JSON.stringify(invoked)).not.toContain('RTB-A')
      // Live: the line was in the Room before the turn's next model pass.
      expect(roomAtSecondPass[0]!.filter(message => message.progress).map(message => message.content)).toEqual([line])

      const said = room.getRetainedMessages().filter(message => message.senderId === assistant.id && message.type === 'chat')
      expect(said.map(message => message.content)).toEqual([line, 'Unit 1 · E-0 step 2 · holding for your judgement'])
      const [progress, answer] = said
      expect(progress).toMatchObject({ progress: true, senderName: 'Assistant', inReplyTo: [question.id] })
      // The line is no answer: no generation evidence, telemetry or tool trace.
      for (const field of ['generationTraceId', 'generationMs', 'toolTrace', 'promptTokens', 'cause']) expect(progress).not.toHaveProperty(field)
      expect(answer!.progress).toBeUndefined()
      expect(answer!.toolTrace).toEqual([expect.objectContaining({ tool: 'workspace_call', success: true })])
      expect(answer!.generationTraceId).toBeDefined()

      // A later turn sees the line as the agent's own earlier message.
      system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content: 'continue', type: 'chat' })
      await assistant.whenIdle()
      expect(requests).toHaveLength(3)
      const replay = requests[2]!.messages.filter(message => message.role === 'assistant').map(message => message.content)
      expect(replay[0]).toBe(line)
      expect(replay[1]).toStartWith('Unit 1 · E-0 step 2 · holding for your judgement')

      // The strict Room document keeps the mark.
      const paths = workspaceModulePaths(workspaceId)
      await saveWorkspaceModuleSnapshots(serializeModuleSnapshots(system), paths)
      const stored = (await loadWorkspaceModuleSnapshots(paths)).rooms!.rooms.find(entry => entry.profile.id === room!.profile.id)!
      expect(stored.messages.filter(message => message.progress === true).map(message => message.content)).toEqual([line])
    } finally {
      host.stop(true)
    }
  })
})
