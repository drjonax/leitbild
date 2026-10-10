import { describe, expect, test } from 'bun:test'
import { toUIMessage, toUIRoomProfile, toAgentEntry } from './mappers.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../../core/types/messaging.ts'

// These mappers are the only translation layer between the WS wire format
// (server types) and the UI's view types. If they silently drop or mistype
// a field, the DOM receives bad data — usually manifesting as a blank or
// broken row. Tests pin the shape + telemetry forwarding.

describe('toUIMessage', () => {
  const base: Message = {
    id: 'm1',
    senderId: 'agent-1',
    content: 'hello',
    timestamp: 1234,
    type: 'chat',
    roomId: 'room-1',
    generationMs: 500,
  }

  test('passes through the core fields', () => {
    const ui = toUIMessage(base)
    expect(ui.id).toBe('m1')
    expect(ui.senderId).toBe('agent-1')
    expect(ui.content).toBe('hello')
    expect(ui.timestamp).toBe(1234)
    expect(ui.type).toBe('chat')
    expect(ui.roomId).toBe('room-1')
    expect(ui.generationMs).toBe(500)
  })

  test('forwards telemetry number fields when present', () => {
    const ui = toUIMessage({
      ...base,
      promptTokens: 100,
      lastPromptTokens: 60,
      completionTokens: 50,
      cacheCreation: 30,
      cacheRead: 60,
      cacheMiss: 40,
      modelCalls: 2,
      contextMax: 8000,
    })
    expect(ui.promptTokens).toBe(100)
    expect(ui.lastPromptTokens).toBe(60)
    expect(ui.completionTokens).toBe(50)
    expect(ui.cacheCreation).toBe(30)
    expect(ui.cacheRead).toBe(60)
    expect(ui.cacheMiss).toBe(40)
    expect(ui.modelCalls).toBe(2)
    expect(ui.contextMax).toBe(8000)
  })

  test('forwards attachments and tool trace without putting them in content', () => {
    const attachment = { kind: 'image' as const, dataUrl: 'data:image/png;base64,eA==', mimeType: 'image/png' as const, width: 1, height: 1, capturedAt: 1 }
    const trace = { tool: 'workspace_explore', argumentKeys: [], argumentBytes: 2, success: true, resultPreview: 'ok' }
    const ui = toUIMessage({ ...base, attachments: [attachment], toolTrace: [trace] })
    expect(ui.attachments).toEqual([attachment])
    expect(ui.toolTrace).toEqual([trace])
    expect(ui.content).toBe('hello')
  })

  test('forwards the cause and the messages a reply answers', () => {
    const ui = toUIMessage({ ...base, cause: { kind: 'display-request', name: 'Hilde' }, inReplyTo: ['answer-1'] })
    expect(ui.cause).toEqual({ kind: 'display-request', name: 'Hilde' })
    expect(ui.inReplyTo).toEqual(['answer-1'])
    expect('inReplyTo' in toUIMessage(base)).toBe(false)
  })

  test('forwards provider + model strings when present', () => {
    const ui = toUIMessage({
      ...base,
      provider: 'ollama',
      model: 'llama3.2',
    })
    expect(ui.provider).toBe('ollama')
    expect(ui.model).toBe('llama3.2')
  })

  test('omits telemetry keys entirely when absent', () => {
    const ui = toUIMessage(base)
    expect('promptTokens' in ui).toBe(false)
    expect('model' in ui).toBe(false)
    expect('provider' in ui).toBe(false)
  })
})

describe('toUIRoomProfile', () => {
  test('narrows server profile to id + name only', () => {
    const server: ServerRoomProfile = {
      id: 'room-1',
      name: 'general',
      members: ['a', 'b'],
      deliveryMode: 'broadcast',
    } as ServerRoomProfile
    const ui = toUIRoomProfile(server)
    expect(ui).toEqual({ id: 'room-1', name: 'general' })
    // Server fields that don't belong to the UI view type must not leak:
    expect('members' in ui).toBe(false)
    expect('deliveryMode' in ui).toBe(false)
  })
})

describe('toAgentEntry', () => {
  test('always initializes state to idle', () => {
    const server: AgentProfile = {
      id: 'agent-1',
      name: 'Alice',
      kind: 'ai',
      model: 'gpt-4',
    } as AgentProfile
    const ui = toAgentEntry(server)
    expect(ui).toEqual({
      id: 'agent-1',
      name: 'Alice',
      kind: 'ai',
      model: 'gpt-4',
      state: 'idle',
    })
  })

  test('human kind survives the round-trip', () => {
    const ui = toAgentEntry({ id: 'h1', name: 'Bob', kind: 'human' } as AgentProfile)
    expect(ui.kind).toBe('human')
    expect(ui.state).toBe('idle')
  })
})
