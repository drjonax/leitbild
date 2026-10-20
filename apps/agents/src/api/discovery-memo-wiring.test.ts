// ============================================================================
// Integration test: the discovery memo crosses workspace_explore and
// workspace_call → execution record → the agent's next turn. A later turn in
// the same Room starts with the operations the first one found and used, with
// their exact target and input schema, so it calls them without exploring.
// ============================================================================

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, workspaceResourceReferenceSchema } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { AIAgent } from '../core/types/agent.ts'

describe('discovery memo wiring', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-discovery-memo-'))
    process.env.LEITBILD_HOME = homeDir
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('a later turn in the Room starts with the operation the first one explored and used', async () => {
    const workspaceId = newWorkspaceId()
    const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
    const read = 'world.process-plant.plants.list'
    const inputSchema = { type: 'object', properties: { detail: { type: 'string' } }, additionalProperties: false }
    const host = Bun.serve({
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname
        const modules = [{ moduleId: 'world', status: 'ready' }]
        if (path.endsWith('/resources')) return Response.json({ workspaceId, modules, resources: [
          { ref: run, title: 'Halden', capabilityIds: [read], links: [], summary: [], observedAt: new Date().toISOString() },
        ] })
        if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules, definitions: [] })
        if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules, capabilities: [
          { id: read, moduleId: 'world', kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'plants · list', description: 'List the Plants of the Run.', risk: 'read', idempotent: true, inputSchema, outputSchema: { type: 'object' } },
        ] })
        return Response.json({ result: { plants: [{ plantId: 'plant:halden-2' }] } })
      },
    })
    try {
      const requests: ChatRequest[] = []
      const toolCall = (name: string, args: Record<string, unknown>): StreamChunk =>
        ({ delta: '', done: true, finishReason: 'tool_calls', tokensUsed: { prompt: 1, completion: 1 }, toolCalls: [{ id: `call-${requests.length}`, function: { name, arguments: args } }] })
      const gateway = {
        ...makeStubGateway(),
        stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
          requests.push(structuredClone(request))
          if (requests.length === 1) { yield toolCall('workspace_explore', { view: 'operations', queries: [read], includeInputSchema: true }); return }
          if (requests.length === 2) { yield toolCall('workspace_call', { calls: [{ key: 'plants', operationId: read, input: {} }] }); return }
          yield { delta: 'Unit 2 is running.', done: false }
          yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }
        },
      }
      const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
      const system = createAgentsWorkspaceRuntime({ deployment, workspaceId, workspaceHostUrl: `http://127.0.0.1:${host.port}` })
      const room = system.rooms.createRoom({ name: 'Assistant', createdBy: 'test' })
      const assistant = await system.spawnAIAgent({ name: 'Assistant', model: 'mock-model', persona: 'Answer briefly.' }) as AIAgent
      const human = await system.spawnHumanAgent({ name: 'Alice' }, () => {})
      await system.addAgentToRoom(assistant.id, room.profile.id, 'test')
      await system.addAgentToRoom(human.id, room.profile.id, 'test')

      const systemText = (request: ChatRequest): string => (request.systemBlocks ?? []).map(block => block.text).join('\n')
      system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content: 'Which units run?', type: 'chat' })
      await assistant.whenIdle()
      expect(requests).toHaveLength(3)
      expect(systemText(requests[0]!)).not.toContain('Workspace operations you used earlier')

      system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content: 'And now?', type: 'chat' })
      await assistant.whenIdle()
      expect(requests).toHaveLength(4)
      const memo = systemText(requests[3]!)
      expect(memo).toContain('Workspace operations you used earlier in this conversation')
      expect(memo).toContain(`- ${read} · target ${JSON.stringify({ kind: 'resource', ref: run })} · input schema ${JSON.stringify(inputSchema)}`)
    } finally {
      host.stop(true)
    }
  })
})
