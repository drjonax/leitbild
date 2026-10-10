import { describe, expect, test } from 'bun:test'
import { accessContextSchema, newRequestId, newWorkspaceId } from '@leitbild/contracts'
import { handleAPI } from '../http-routes.ts'
import { createAgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import { createHumanAgent } from '../../agents/human-agent.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'
import { DISPLAY_REQUEST_CAUSE, DISPLAY_SKILL, displayRequestPath } from '../../core/display-request.ts'
import type { AIAgent, RequestedTurn, RequestedTurnResult } from '../../core/types/agent.ts'
import type { RoomDefinitionLibrary } from '../../core/definitions/room-definition-library.ts'
import type { RouteContext } from './types.ts'

const WORKSPACE_ID = newWorkspaceId()
const ACCESS_CONTEXT = accessContextSchema.parse({ workspaceId: WORKSPACE_ID, requestId: newRequestId(), actor: { kind: 'anonymous' } })

// The real Workspace runtime and route table; only the answer's author is a
// fake, since requestTurn belongs to the AI Agent implementation.
const setup = (result: RequestedTurnResult) => {
  const system = createAgentsWorkspaceRuntime({ workspaceLabel: 'display-request-route' })
  system.setOnRoomCreated(() => {})
  system.setOnMessagePosted(() => {})
  const room = system.rooms.createRoom({ name: 'Control', createdBy: SYSTEM_SENDER_ID })
  const reader = createHumanAgent({ name: 'Hilde' }, () => {})
  system.team.addAgent(reader)
  room.addMember(reader.id)
  const turns: Array<{ roomId: string; turn: RequestedTurn }> = []
  const author = {
    id: crypto.randomUUID(), name: 'Operator', kind: 'ai', metadata: {},
    receive: () => {},
    getSkills: () => [DISPLAY_SKILL],
    requestTurn: (roomId: string, turn: RequestedTurn) => { turns.push({ roomId, turn }); return result },
  } as unknown as AIAgent
  system.team.addAgent(author)
  const answer = room.post({ senderId: author.id, content: 'The level is steady at 42 %.', type: 'chat', generationTraceId: 'trace-1' })
  const post = (path: string, body: string) => handleAPI(
    new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    path, system, WORKSPACE_ID, ACCESS_CONTEXT,
    {
      broadcastAllWorkspaces: () => {},
      broadcastToWorkspace: () => {},
      subscribeAgentState: () => {},
      packManager: {} as RouteContext['packManager'],
      roomDefinitions: {} as RoomDefinitionLibrary,
    },
  )
  return { room, reader, answer, turns, post, path: displayRequestPath(room.profile.id, answer.id) }
}

describe('POST /rooms/:room/messages/:message/display-request', () => {
  test('accepts with 202 and asks the author for the turn', async () => {
    const { post, path, room, answer, turns, reader } = setup({ kind: 'accepted', queued: true })
    const response = await post(path, JSON.stringify({ requesterId: reader.id }))
    expect(response?.status).toBe(202)
    expect(await response?.json()).toEqual({ queued: true })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ roomId: room.profile.id, turn: { inReplyTo: [answer.id], cause: { kind: DISPLAY_REQUEST_CAUSE, name: 'Hilde' }, requireView: true } })
  })

  test('answers a refusal with its rule\'s status and code', async () => {
    const { post, path, reader } = setup({ kind: 'refused', reason: 'pending', message: 'Another request waits in this Room' })
    const pending = await post(path, JSON.stringify({ requesterId: reader.id }))
    expect(pending?.status).toBe(409)
    expect(await pending?.json()).toEqual({ error: 'Another request waits in this Room', code: 'request_pending' })

    const outsider = await post(path, JSON.stringify({ requesterId: 'missing' }))
    expect(outsider?.status).toBe(403)
    expect(await outsider?.json()).toMatchObject({ code: 'requester_invalid' })

    const missing = await post(displayRequestPath('Control', 'missing'), JSON.stringify({ requesterId: reader.id }))
    expect(missing?.status).toBe(404)
    expect(await missing?.json()).toMatchObject({ code: 'message_not_found' })
  })

  test('rejects a malformed body or path with 400', async () => {
    const { post, path, reader, turns } = setup({ kind: 'accepted', queued: false })
    for (const body of ['{', '{}', JSON.stringify({ requesterId: '' }), JSON.stringify({ requesterId: reader.id, extra: true })]) {
      const response = await post(path, body)
      expect(response?.status).toBe(400)
      expect(await response?.json()).toEqual({ error: expect.any(String) })
    }
    const malformed = await post('/rooms/%E0%A4%A/messages/m/display-request', JSON.stringify({ requesterId: reader.id }))
    expect(malformed?.status).toBe(400)
    expect(turns).toEqual([])
  })
})
