// ============================================================================
// Integration test: a display request crosses route → runtime → agent →
// evaluation → posted reply. Each layer has unit tests; this proves the
// chain: the author's ordinary turn sees the request's instruction carrying
// the answer, insists once on a live view, and posts a reply whose cause
// names the requester and whose inReplyTo starts with the answer.
// ============================================================================

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from './__fixtures__/stub-gateway.ts'
import { displayRequestRoutes } from './routes/display-requests.ts'
import { DISPLAY_REQUEST_CAUSE, DISPLAY_SKILL, displayRequestPath } from '../core/display-request.ts'
import type { RouteContext } from './routes/types.ts'
import type { ChatRequest, StreamChunk } from '../core/types/llm.ts'
import type { AIAgent } from '../core/types/agent.ts'

describe('display request wiring', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-display-request-'))
    process.env.LEITBILD_HOME = homeDir
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('the author answers the request in an ordinary turn and replies to the answer', async () => {
    const requests: ChatRequest[] = []
    const answers = [
      'Pressurizer level is steady at 55 %.',
      'Level holds at 55 %.',
      'No display can be produced: this Workspace runs no Plant.',
    ]
    // Agents stream; each request answers with the next scripted text.
    const gateway = {
      ...makeStubGateway(),
      stream: async function* (request: ChatRequest): AsyncIterable<StreamChunk> {
        requests.push(structuredClone(request))
        yield { delta: answers[Math.min(requests.length - 1, answers.length - 1)]!, done: false }
        yield { delta: '', done: true, finishReason: 'stop', tokensUsed: { prompt: 1, completion: 1 } }
      },
    }
    const deployment = createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(gateway) })
    const system = createAgentsWorkspaceRuntime({ deployment })
    const room = system.rooms.createRoom({ name: 'Displays', createdBy: 'test' })
    const assistant = await system.spawnAIAgent({ name: 'Assistant', model: 'mock-model', persona: 'Answer briefly.', skills: [DISPLAY_SKILL] }) as AIAgent
    const human = await system.spawnHumanAgent({ name: 'Alice' }, () => {})
    await system.addAgentToRoom(assistant.id, room.profile.id, 'test')
    await system.addAgentToRoom(human.id, room.profile.id, 'test')

    system.routeMessage({ rooms: [room.profile.id] }, { senderId: human.id, senderName: 'Alice', content: 'How is pressurizer level?', type: 'chat' })
    await assistant.whenIdle()
    const answer = room.getRetainedMessages().find(message => message.senderId === assistant.id && message.type === 'chat')!
    expect(answer.content).toBe(answers[0]!)

    const path = displayRequestPath(room.profile.id, answer.id)
    const route = displayRequestRoutes.find(entry => entry.method === 'POST' && entry.pattern.test(path))!
    const response = await route.handler(
      new Request(`http://agents.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requesterId: human.id }) }),
      path.match(route.pattern)!,
      { system } as unknown as RouteContext,
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ queued: false })
    await assistant.whenIdle()

    const reply = room.getRetainedMessages().find(message => message.cause?.kind === DISPLAY_REQUEST_CAUSE)!
    expect(reply.senderId).toBe(assistant.id)
    expect(reply.cause).toEqual({ kind: DISPLAY_REQUEST_CAUSE, name: 'Alice' })
    expect(reply.inReplyTo?.[0]).toBe(answer.id)
    expect(reply.generationTraceId).toBeDefined()
    expect(reply.content).toBe(answers[2]!)

    // The request turn ended with the instruction carrying the answer; the
    // display-less reply was asked once more; neither entered history.
    const instruction = requests[1]!.messages.at(-1)!.content
    expect(instruction).toContain('[Display request] Alice asked you to show your answer below')
    expect(instruction).toContain(answer.content)
    expect(requests[2]!.messages.at(-1)!.content).toContain('The reader asked for a live display')
    expect(room.getRetainedMessages().some(message => message.content.includes('[Display request]'))).toBe(false)
  })
})
