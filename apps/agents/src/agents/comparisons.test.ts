import { describe, expect, test } from 'bun:test'
import { createComparisons, type Comparisons } from './comparisons.ts'
import type { AgentTurnStart } from './ai-agent.ts'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { ChatRequest, ChatResponse, LLMProvider } from '../core/types/llm.ts'
import type { LLMService, LLMServiceBindOptions } from '../llm/llm-service.ts'
import { createConversationReadTool } from '../tools/built-in/conversation-read.ts'

const answer = (content: string): ChatResponse => ({ content, generationMs: 1, tokensUsed: { prompt: 30, completion: 5 } })
const call = (name: string, arguments_: Record<string, unknown> = {}): ChatResponse => ({
  ...answer(''), toolCalls: [{ id: crypto.randomUUID(), function: { name, arguments: arguments_ } }],
})

const setup = (chat: LLMProvider['chat']) => {
  const deliveries: string[] = []
  const rooms = createRoomDirectory({ onMessagePosted: (_roomId, message) => { deliveries.push(message.id) } })
  const room = rooms.createRoom({ name: 'Test comparison', createdBy: 'human' })
  room.addMember('agent')
  const prompt = room.post({ senderId: 'human', type: 'chat', content: 'Assess the current situation.' })
  const executions = createExecutionStore(':memory:')
  const registry = createToolRegistry()
  const requests: ChatRequest[] = []
  const binds: LLMServiceBindOptions[] = []
  const provider: LLMProvider = {
    models: async () => ['provider:alternative'],
    modelInfo: async id => ({ id, provider: 'provider', source: 'fixture', contextMax: 100_000 }),
    chat: async request => { requests.push(structuredClone(request)); return chat(request) },
  }
  const comparisons = createComparisons({
    rooms, executions, registry,
    llm: { bound: options => { binds.push(options); return provider } } as LLMService,
    growth: async (_bytes, work) => work(),
  })
  const input: AgentTurnStart = {
    executionTurnId: 'original-turn', roomId: room.profile.id, agentId: 'agent',
    context: { messages: [{ role: 'user', content: prompt.content }], systemBlocks: [{ text: 'Captured task instructions', cacheable: true }], warnings: [], flushInfo: { ids: new Set([prompt.id]), triggerRoomId: room.profile.id } },
    config: { name: 'Agent', model: 'provider:original', persona: 'Captured persona', seed: 17 },
    toolDefinitions: [], focusedSubjects: [],
  }
  const prepare = async (tools: string[] = []) => {
    await comparisons.capture({ ...input, toolDefinitions: tools.map(name => ({ type: 'function', function: { name, description: `Test ${name}`, parameters: { type: 'object' } } })) })
    const original = room.post({ senderId: 'agent', type: 'chat', content: 'Original answer that alternatives must not read.' })
    comparisons.link({ executionTurnId: input.executionTurnId, roomId: room.profile.id, messageId: original.id })
    return original.id
  }
  return { comparisons, room, rooms, executions, registry, requests, binds, deliveries, input, prepare, close: async () => { await comparisons.close(); executions.close() } }
}

// The deadline reports a comparison that never finishes; it is not a budget,
// so it leaves a loaded machine room.
const completed = async (service: Comparisons, roomId: string, messageId: string, id: string) => {
  const until = performance.now() + 30_000
  while (performance.now() < until) {
    const result = await service.detail(roomId, messageId, id)
    if (result.status !== 'running') return result
    await Bun.sleep(1)
  }
  throw new Error('Comparison did not finish within the test deadline')
}

describe('full-turn model comparisons', () => {
  test('runs independent tool choices with the selected model without changing room history', async () => {
    let passes = 0
    const state = setup(async () => ++passes === 1 ? call('product_search', { query: 'plant model' }) : passes === 2 ? call('product_read', { path: 'found.md' }) : answer('Independently assessed.'))
    state.registry.register({ name: 'product_search', description: '', parameters: {}, execute: async () => ({ success: true, data: { path: 'found.md' } }) })
    state.registry.register({ name: 'product_read', description: '', parameters: {}, execute: async () => ({ success: true, data: { observed: 'nominal' } }) })
    try {
      const messageId = await state.prepare(['product_search', 'product_read'])
      const originalHistory = state.room.getRetainedMessages()
      const originalDeliveries = [...state.deliveries]
      const result = await state.comparisons.start(state.room.profile.id, messageId, 'provider:alternative')
      const finished = await completed(state.comparisons, state.room.profile.id, messageId, result.id)
      expect(finished.status).toBe('completed')
      expect(finished.content).toBe('Independently assessed.')
      expect(finished.calls.map(evidence => evidence.tool)).toEqual(['product_search', 'product_read'])
      const summary = (await state.comparisons.list(state.room.profile.id, messageId)).alternatives[0]!
      expect(summary.toolCount).toBe(2)
      expect('calls' in summary).toBe(false)
      expect(state.requests).toHaveLength(3)
      expect(state.requests.every(request => request.model === 'provider:alternative' && request.seed === 17)).toBe(true)
      expect(state.requests[0]!.messages).toEqual([{ role: 'user', content: 'Assess the current situation.' }])
      expect(state.requests[0]!.systemBlocks?.[0]?.text).toBe('Captured task instructions')
      expect(JSON.stringify(state.requests)).not.toContain('Original answer that alternatives must not read.')
      expect(finished.metrics?.modelCalls).toBe(3)
      expect(finished.query?.model).toBe('provider:alternative')
      expect(state.binds[0]?.fallbackChain).toEqual([])
      expect(state.room.getRetainedMessages()).toEqual(originalHistory)
      expect(state.deliveries).toEqual(originalDeliveries)
      expect(state.executions.listTurns(state.room.profile.id)).toEqual([])
      await state.comparisons.remove(state.room.profile.id, messageId, result.id)
      expect((await state.comparisons.list(state.room.profile.id, messageId)).alternatives).toEqual([])
      expect(state.room.getRetainedMessages()).toEqual(originalHistory)
    } finally { await state.close() }
  })

  test('withholds unreviewed tools and rejects hallucinated calls without executing them', async () => {
    let passes = 0
    let writes = 0
    const state = setup(async () => ++passes === 1 ? call('write_everything') : answer('I did not perform the action.'))
    state.registry.register({ name: 'write_everything', description: '', parameters: {}, execute: async () => { writes += 1; return { success: true } } })
    try {
      const messageId = await state.prepare(['write_everything'])
      const started = await state.comparisons.start(state.room.profile.id, messageId, 'provider:alternative')
      const result = await completed(state.comparisons, state.room.profile.id, messageId, started.id)
      expect(result.withheldTools).toEqual(['write_everything'])
      expect(state.requests[0]!.tools ?? []).toEqual([])
      expect(result.calls[0]!.result?.success).toBe(false)
      expect(writes).toBe(0)
    } finally { await state.close() }
  })

  test('conversation tool cannot obtain the original answer even when the model guesses its exact ID', async () => {
    let messageId = ''
    let passes = 0
    const state = setup(async () => ++passes === 1 ? call('conversation_read', { messageId }) : answer('Using only the starting evidence.'))
    state.registry.register(createConversationReadTool(state.rooms, state.executions))
    try {
      messageId = await state.prepare(['conversation_read'])
      const started = await state.comparisons.start(state.room.profile.id, messageId, 'provider:alternative')
      const result = await completed(state.comparisons, state.room.profile.id, messageId, started.id)
      expect(result.calls[0]!.result?.success).toBe(false)
      expect(result.calls[0]!.result?.error).toContain('comparison_evidence_out_of_scope')
      expect(JSON.stringify(state.requests)).not.toContain('Original answer that alternatives must not read.')
    } finally { await state.close() }
  })

  test('rejects historical messages lacking a retained input and agents removed from the room', async () => {
    const state = setup(async () => answer('Not called'))
    try {
      const old = state.room.post({ senderId: 'agent', type: 'chat', content: 'Uncaptured older answer' })
      expect(await state.comparisons.list(state.room.profile.id, old.id)).toMatchObject({ available: false })
      await expect(state.comparisons.start(state.room.profile.id, old.id, 'provider:alternative')).rejects.toThrow('Original starting input was not retained')
      const messageId = await state.prepare()
      state.room.removeMember('agent')
      await expect(state.comparisons.start(state.room.profile.id, messageId, 'provider:alternative')).rejects.toThrow('no longer a Room member')
      expect(state.requests).toEqual([])
    } finally { await state.close() }
  })

  test('cancellation interrupts a pending read and does not publish an answer', async () => {
    const entered = Promise.withResolvers<void>()
    const state = setup(async () => call('product_read', { path: 'slow.md' }))
    state.registry.register({ name: 'product_read', description: '', parameters: {}, execute: async (_params, context) => {
      entered.resolve()
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(context.signal?.reason)
        if (context.signal?.aborted) abort()
        else context.signal?.addEventListener('abort', abort, { once: true })
      })
    } })
    try {
      const messageId = await state.prepare(['product_read'])
      const count = state.room.getRetainedMessages().length
      const started = await state.comparisons.start(state.room.profile.id, messageId, 'provider:alternative')
      await entered.promise
      await state.comparisons.cancel(state.room.profile.id, messageId, started.id)
      const result = await completed(state.comparisons, state.room.profile.id, messageId, started.id)
      expect(result.status).toBe('interrupted')
      expect(state.room.getRetainedMessages()).toHaveLength(count)
      expect(state.requests).toHaveLength(1)
    } finally { await state.close() }
  })
})
