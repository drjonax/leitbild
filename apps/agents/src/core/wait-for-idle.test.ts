// ============================================================================
// wait-for-idle tests.
//
// Uses real Room objects but stubs the AIAgent surface just enough to satisfy
// whenIdle(). pollMs is shortened so tests finish in milliseconds.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createRoom } from './rooms/room.ts'
import type { AIAgent } from './types/agent.ts'
import type { Room } from './types/room.ts'
import { waitForRoomIdle } from './wait-for-idle.ts'

// Minimal AIAgent stub — only whenIdle is exercised by wait-for-idle.
const makeIdleAgent = (): AIAgent => ({
  whenIdle: async () => {},
} as unknown as AIAgent)

const makeGeneratingAgent = (idleAfterMs: number): AIAgent => ({
  whenIdle: () => new Promise<void>(resolve => setTimeout(resolve, idleAfterMs)),
} as unknown as AIAgent)

const makeRoom = (name: string) =>
  createRoom({ id: `room-${name}`, name, createdAt: Date.now(), createdBy: 'test', scope: { kind: 'workspace' }, scopeRevision: 0 })

describe('waitForRoomIdle', () => {
  test('empty room with no agents returns idle immediately', async () => {
    const room = makeRoom('alpha')
    const result = await waitForRoomIdle(room, {
      quietMs: 50,
      timeoutMs: 2000,
      pollMs: 10,
      inRoomAIAgents: () => [],
    })
    expect(result.idle).toBe(true)
    expect(result.messageCount).toBe(0)
    expect(result.lastMessageAt).toBeNull()
  })

  test('room with recent message waits for quietMs, then reports idle', async () => {
    const room = makeRoom('bravo')
    room.post({ senderId: 'u', senderName: 'U', content: 'hi', type: 'chat' })

    const result = await waitForRoomIdle(room, {
      quietMs: 100,
      timeoutMs: 2000,
      pollMs: 10,
      inRoomAIAgents: () => [makeIdleAgent()],
    })
    expect(result.idle).toBe(true)
    expect(result.messageCount).toBe(1)
    expect(result.lastMessageAt).not.toBeNull()
    // Quiet time starts at the message, not at the later wait invocation.
    expect(Date.now() - result.lastMessageAt!).toBeGreaterThanOrEqual(100)
  })

  test('generating agent (whenIdle slow) blocks idle until it resolves', async () => {
    const room = makeRoom('charlie')
    room.post({ senderId: 'u', senderName: 'U', content: 'hi', type: 'chat' })

    // Agent stays "generating" for 150ms — waitForRoomIdle must not declare idle before that
    const agent = makeGeneratingAgent(150)

    const start = Date.now()
    const result = await waitForRoomIdle(room, {
      quietMs: 50,
      timeoutMs: 2000,
      pollMs: 10,
      inRoomAIAgents: () => [agent],
    })
    const elapsed = Date.now() - start

    expect(result.idle).toBe(true)
    // Must have waited at least for the agent to finish
    expect(elapsed).toBeGreaterThanOrEqual(150)
  })

  test('maxMessages cap fires before quietMs elapses', async () => {
    const room = makeRoom('capped')
    // Pre-populate to exceed the cap
    for (let i = 0; i < 5; i++) {
      room.post({ senderId: 'u', senderName: 'U', content: `m${i}`, type: 'chat' })
    }

    const result = await waitForRoomIdle(room, {
      quietMs: 10_000,     // would otherwise force a long wait
      timeoutMs: 30_000,
      pollMs: 10,
      maxMessages: 3,
      inRoomAIAgents: () => [],
    })

    expect(result.idle).toBe(false)
    expect(result.capped).toBe(true)
    expect(result.messageCount).toBeGreaterThanOrEqual(3)
  })

  test('maxMessages not hit → normal idle path still works', async () => {
    const room = makeRoom('under-cap')
    room.post({ senderId: 'u', senderName: 'U', content: 'single', type: 'chat' })
    const result = await waitForRoomIdle(room, {
      quietMs: 50,
      timeoutMs: 2_000,
      pollMs: 10,
      maxMessages: 100,
      inRoomAIAgents: () => [makeIdleAgent()],
    })
    expect(result.idle).toBe(true)
    expect(result.capped).toBe(false)
  })

  test('timeout fires with idle:false when quietMs never satisfied', async () => {
    const room = makeRoom('delta')
    // Seed with a message so quietMs polling has a reference timestamp.
    room.post({ senderId: 'u', senderName: 'U', content: 'start', type: 'chat' })
    const start = Date.now()

    // Post a fresh message on every poll to prevent quietMs from being satisfied.
    // A message arrives whenever the room is read, so a loaded machine that
    // runs the polls late cannot open a quiet gap between them.
    let ticks = 0
    const busyRoom: Room = {
      ...room,
      getRecent: count => {
        ticks++
        room.post({ senderId: 'u', senderName: 'U', content: `m${ticks}`, type: 'chat' })
        return room.getRecent(count)
      },
    }

    const result = await waitForRoomIdle(busyRoom, {
      quietMs: 100, // never satisfied — every poll sees a message that just arrived
      timeoutMs: 200,
      pollMs: 10,
      inRoomAIAgents: () => [],
    })
    const elapsed = Date.now() - start

    expect(result.idle).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(result.messageCount).toBeGreaterThan(1)
  })
})
