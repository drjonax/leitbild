import { describe, expect, test } from 'bun:test'
import { displayRequestInstruction, requestDisplay } from './display-requests.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { DISPLAY_REQUEST_CAUSE, DISPLAY_SKILL, isDisplayRequestRefusal, type DisplayRequestRefusalCode } from '../core/display-request.ts'
import type { AIAgent, RequestedTurn, RequestedTurnResult } from '../core/types/agent.ts'
import type { Message, ToolTraceEntry } from '../core/types/messaging.ts'

const VIEW = 'The level holds.\n```leitbild-view\nview call_1_0/level\n```'
const TRACE: ToolTraceEntry = { tool: 'workspace_call', argumentKeys: ['calls'], argumentBytes: 40, success: true, resultPreview: '{"level":42}' }

type Turns = Array<{ roomId: string; turn: RequestedTurn }>
interface AuthorOptions {
  readonly skills?: ReadonlyArray<string>
  readonly result?: RequestedTurnResult
  readonly turns?: Turns
  readonly requestTurn?: false
  readonly ingested?: Array<{ roomId: string; ids: ReadonlyArray<string> }>
}

// Only what the service reads of an AI Agent; requestTurn records each call.
const fakeAuthor = (name: string, options: AuthorOptions = {}): AIAgent => ({
  id: crypto.randomUUID(),
  name,
  kind: 'ai',
  metadata: {},
  getSkills: () => options.skills ?? [DISPLAY_SKILL],
  getHistoryLimit: () => 10,
  ingestHistory: (roomId: string, messages: ReadonlyArray<Message>) => { options.ingested?.push({ roomId, ids: messages.map(message => message.id) }) },
  ...(options.requestTurn === false ? {} : {
    requestTurn: (roomId: string, turn: RequestedTurn): RequestedTurnResult => {
      options.turns?.push({ roomId, turn })
      return options.result ?? { kind: 'accepted', queued: false }
    },
  }),
}) as unknown as AIAgent

const setup = (author: AuthorOptions = {}) => {
  const rooms = createRoomDirectory({})
  const team = createTeam()
  const room = rooms.createRoom({ name: 'Control', createdBy: SYSTEM_SENDER_ID })
  const reader = createHumanAgent({ name: 'Hilde' }, () => {})
  team.addAgent(reader)
  room.addMember(reader.id)
  const turns: Turns = []
  const ai = fakeAuthor('Operator', { turns, ...author })
  team.addAgent(ai)
  room.addMember(ai.id)
  const answer = room.post({ senderId: ai.id, senderName: ai.name, content: 'The level is steady at 42 %.', type: 'chat', generationTraceId: 'trace-1' })
  let scriptRunning = false
  const ask = (overrides: { roomId?: string; messageId?: string; requesterId?: string } = {}) =>
    requestDisplay({ rooms, team, isScriptRunning: () => scriptRunning }, overrides.roomId ?? room.profile.id, overrides.messageId ?? answer.id, overrides.requesterId ?? reader.id)
  const startScript = (): void => { scriptRunning = true }
  return { rooms, team, room, reader, ai, answer, turns, ask, startScript }
}

const refusal = (ask: () => unknown): { code: DisplayRequestRefusalCode; message: string } => {
  try {
    ask()
  } catch (error) {
    if (!isDisplayRequestRefusal(error)) throw error
    return { code: error.code, message: error.message }
  }
  throw new Error('expected a display request refusal')
}

describe('displayRequestInstruction', () => {
  const answer = { id: 'msg-1', senderId: 'a', content: 'The level is steady at 42 %.', timestamp: 0, type: 'chat', roomId: 'r' } satisfies Message

  test('carries the answer and names the display Skill', () => {
    expect(displayRequestInstruction({ requesterName: 'Hilde', answer })).toBe(
      '[Display request] Hilde asked you to show your answer below (messageId "msg-1") as a live display. '
        + 'This request replaces your own judgement of whether a display is needed. '
        + 'Compose the display that best supports this answer as the operator-displays skill describes. '
        + 'Do not repeat the answer: write one or two sentences on what the display shows and what to watch, then end with the leitbild-view block. '
        + 'If the answer concerns nothing a display can show, or two compositions are rejected, say why in one sentence instead.\n'
        + '\n'
        + 'Your answer:\n'
        + '<answer>\n'
        + 'The level is steady at 42 %.\n'
        + '</answer>',
    )
  })

  test('points an answer built on tool evidence back at that evidence', () => {
    expect(displayRequestInstruction({ requesterName: 'Hilde', answer: { ...answer, toolTrace: [TRACE] } })).toBe(
      '[Display request] Hilde asked you to show your answer below (messageId "msg-1") as a live display. '
        + 'This request replaces your own judgement of whether a display is needed. '
        + 'Compose the display that best supports this answer as the operator-displays skill describes, '
        + 'reusing the Run, plant and signal identifiers from that answer\'s evidence (conversation_read messageId="msg-1") rather than searching again. '
        + 'Do not repeat the answer: write one or two sentences on what the display shows and what to watch, then end with the leitbild-view block. '
        + 'If the answer concerns nothing a display can show, or two compositions are rejected, say why in one sentence instead.\n'
        + '\n'
        + 'Your answer:\n'
        + '<answer>\n'
        + 'The level is steady at 42 %.\n'
        + '</answer>',
    )
    expect(displayRequestInstruction({ requesterName: 'Hilde', answer: { ...answer, toolTrace: [] } })).not.toContain('conversation_read')
  })
})

describe('requestDisplay', () => {
  test('asks the author for one requested turn carrying the answer', () => {
    const { ask, room, answer, turns } = setup()
    expect(ask({ roomId: 'Control' })).toEqual({ queued: false })
    expect(turns).toEqual([{
      roomId: room.profile.id,
      turn: {
        instruction: displayRequestInstruction({ requesterName: 'Hilde', answer }),
        inReplyTo: [answer.id],
        cause: { kind: DISPLAY_REQUEST_CAUSE, name: 'Hilde' },
        requireView: true,
      },
    }])
  })

  test('reports a turn queued behind the author\'s current work', () => {
    expect(setup({ result: { kind: 'accepted', queued: true } }).ask()).toEqual({ queued: true })
  })

  test('maps refused turns to their own codes with the Agent\'s reason', () => {
    expect(refusal(setup({ result: { kind: 'refused', reason: 'pending', message: 'Another request waits in this Room' } }).ask))
      .toEqual({ code: 'request_pending', message: 'Another request waits in this Room' })
    expect(refusal(setup({ result: { kind: 'refused', reason: 'script', message: 'A script directs this Room' } }).ask))
      .toEqual({ code: 'script_running', message: 'A script directs this Room' })
  })

  test('refuses an unknown Room or message', () => {
    const { ask } = setup()
    expect(refusal(() => ask({ roomId: 'missing' })).code).toBe('room_not_found')
    expect(refusal(() => ask({ messageId: 'missing' })).code).toBe('message_not_found')
  })

  test('accepts only a person in the Room, named by id', () => {
    const { ask, team, reader, ai } = setup()
    const outsider = createHumanAgent({ name: 'Visitor' }, () => {})
    team.addAgent(outsider)
    for (const requesterId of ['missing', ai.id, outsider.id, reader.name]) {
      expect(refusal(() => ask({ requesterId })).code).toBe('requester_invalid')
    }
  })

  test('refuses messages that are not an Agent\'s answer', () => {
    const { ask, room, reader, ai, answer } = setup()
    const posts = [
      { senderId: reader.id, content: 'Show me the level', type: 'chat', generationTraceId: 'trace-2' },
      { senderId: ai.id, content: 'Scripted note', type: 'chat' },
      { senderId: ai.id, content: '', type: 'pass', generationTraceId: 'trace-3' },
      { senderId: SYSTEM_SENDER_ID, content: 'Operator joined', type: 'system' },
      { senderId: ai.id, content: 'Nothing to show.', type: 'chat', generationTraceId: 'trace-4', inReplyTo: [answer.id], cause: { kind: DISPLAY_REQUEST_CAUSE, name: 'Hilde' } },
    ] as const
    for (const post of posts) {
      expect(refusal(() => ask({ messageId: room.post(post).id })).code).toBe('not_an_answer')
    }
  })

  test('refuses an answer that already shows a display, or whose requested display is shown', () => {
    const { ask, room, ai, answer } = setup()
    const showing = room.post({ senderId: ai.id, content: VIEW, type: 'chat', generationTraceId: 'trace-2' })
    expect(refusal(() => ask({ messageId: showing.id })).code).toBe('answer_shows_display')

    const reply = { senderId: ai.id, type: 'chat', generationTraceId: 'trace-3', cause: { kind: DISPLAY_REQUEST_CAUSE, name: 'Hilde' } } as const
    // A reply that explained why no display fits, or a display of another
    // answer, leaves this answer open to a new request.
    room.post({ ...reply, content: 'Nothing here can be shown live.', inReplyTo: [answer.id] })
    room.post({ ...reply, content: VIEW, inReplyTo: [showing.id, answer.id] })
    expect(ask()).toEqual({ queued: false })
    room.post({ ...reply, content: VIEW, inReplyTo: [answer.id] })
    expect(refusal(ask).code).toBe('display_already_shown')
  })

  test('refuses when the author cannot take the turn', () => {
    const removed = setup()
    removed.team.removeAgent(removed.ai.id)
    expect(refusal(removed.ask)).toEqual({ code: 'agent_unavailable', message: 'The Agent that wrote this answer no longer exists' })

    const left = setup()
    left.room.removeMember(left.ai.id)
    expect(refusal(left.ask)).toEqual({ code: 'agent_unavailable', message: 'Operator is no longer in this Room' })

    const muted = setup()
    muted.room.setMuted(muted.ai.id, true)
    expect(refusal(muted.ask)).toEqual({ code: 'agent_unavailable', message: 'Operator is muted in this Room' })

    expect(refusal(setup({ requestTurn: false }).ask)).toEqual({ code: 'agent_unavailable', message: 'Operator cannot take requested turns' })
  })

  test('refuses a paused Room', () => {
    const { room, ask, turns } = setup()
    room.setPaused(true)
    expect(refusal(ask)).toEqual({ code: 'room_paused', message: 'This Room is paused; resume it to ask for a display' })
    expect(turns).toEqual([])
  })

  test('refuses a Room a script directs, cast or not', () => {
    const { ask, turns, startScript } = setup()
    startScript()
    expect(refusal(ask)).toEqual({ code: 'script_running', message: 'A script directs this Room; ask again when it ends' })
    expect(turns).toEqual([])
  })

  test('catches the author up on a manual Room before its turn', () => {
    const ingested: Array<{ roomId: string; ids: ReadonlyArray<string> }> = []
    const { room, answer, ask, turns } = setup({ ingested })
    expect(ask()).toEqual({ queued: false })
    expect(ingested).toEqual([])
    room.setDeliveryMode('manual')
    expect(ask()).toEqual({ queued: false })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]!.roomId).toBe(room.profile.id)
    expect(ingested[0]!.ids).toContain(answer.id)
    expect(turns).toHaveLength(2)
  })

  test('refuses an author without the display Skill', () => {
    const { ask, turns } = setup({ skills: ['process-plant'] })
    expect(refusal(ask)).toEqual({ code: 'display_skill_missing', message: 'Operator does not have the operator-displays Skill' })
    expect(turns).toEqual([])
  })

  test('applies its gates in order', () => {
    // Every message below also fails the gates after the one that refuses it.
    const rooms = createRoomDirectory({})
    const team = createTeam()
    const room = rooms.createRoom({ name: 'Control', createdBy: SYSTEM_SENDER_ID })
    const reader = createHumanAgent({ name: 'Hilde' }, () => {})
    team.addAgent(reader)
    const ai = fakeAuthor('Operator', { skills: [] })
    team.addAgent(ai)
    const cause = { kind: DISPLAY_REQUEST_CAUSE, name: 'Hilde' } as const
    const shown = room.post({ senderId: ai.id, content: 'The level is steady.', type: 'chat', generationTraceId: 'trace-1' })
    const reply = room.post({ senderId: ai.id, content: VIEW, type: 'chat', generationTraceId: 'trace-2', inReplyTo: [shown.id], cause })
    const showing = room.post({ senderId: ai.id, content: VIEW, type: 'chat', generationTraceId: 'trace-3' })
    const answer = room.post({ senderId: ai.id, content: 'The flow is steady.', type: 'chat', generationTraceId: 'trace-4' })
    room.removeMember(ai.id)
    const code = (roomId: string, messageId: string) =>
      refusal(() => requestDisplay({ rooms, team, isScriptRunning: () => false }, roomId, messageId, reader.id)).code

    expect(code('missing', 'missing')).toBe('room_not_found')
    expect(code(room.profile.id, 'missing')).toBe('message_not_found')
    expect(code(room.profile.id, reply.id)).toBe('requester_invalid')
    room.addMember(reader.id)
    expect(code(room.profile.id, reply.id)).toBe('not_an_answer')
    expect(code(room.profile.id, showing.id)).toBe('answer_shows_display')
    expect(code(room.profile.id, shown.id)).toBe('display_already_shown')
    expect(code(room.profile.id, answer.id)).toBe('agent_unavailable')
    room.addMember(ai.id)
    expect(code(room.profile.id, answer.id)).toBe('display_skill_missing')
  })
})
