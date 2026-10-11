import { describe, expect, test } from 'bun:test'
import { createAIAgent, type AIAgentOptions } from './ai-agent.ts'
import { createEvalBuffer } from '../diagnostics/eval-buffer.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import type { EvalEvent, OnEvalEvent } from '../core/types/agent-eval.ts'
import type { LLMProvider } from '../core/types/llm.ts'

const config = { name: 'Trace test', model: 'fixture', persona: 'Test', historyLimit: 10 }
const message = () => ({ id: crypto.randomUUID(), roomId: 'room', senderId: 'human', content: 'Inspect state', timestamp: Date.now(), type: 'chat' as const })
const answer = { content: 'Done', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
const provider: LLMProvider = { models: async () => ['fixture'], chat: async () => answer }

const diagnostics = (capacity = 3) => {
  const buffer = createEvalBuffer({ capacity })
  const events: EvalEvent[] = []
  let listener: OnEvalEvent = () => {}
  buffer.attach(callback => { listener = callback; return () => {} })
  const onEvalEvent: OnEvalEvent = (scope, event) => { events.push(event); listener(scope, event) }
  return { buffer, events, onEvalEvent, terminals: () => events.filter(event => event.kind === 'eval_completed') }
}

describe('Agent turn diagnostic lifecycle', () => {
  test('cancelled pre-model captures close immediately and stay inside the bounded ring', async () => {
    const d = diagnostics()
    const traceIds: string[] = []
    let modelCalls = 0
    for (let i = 0; i < 12; i++) {
      const captured = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      const agent = createAIAgent(config, { ...provider, chat: async () => { modelCalls++; return answer } }, () => {}, {
        onEvalEvent: d.onEvalEvent,
        onTurnStart: async input => { traceIds.push(input.executionTurnId); captured.resolve(); await release.promise },
        onTurnFinished: () => finished.resolve(),
      })
      agent.receive(message())
      await captured.promise
      agent.cancelGeneration()
      // The capture is still pending, not merely eventually cleaned up.
      expect(d.buffer.getByTraceId(traceIds[i]!)?.outcome).toBe('cancelled')
      expect(d.buffer.getByTraceId(traceIds[i]!)?.endedAt).toBeNumber()
      release.resolve()
      await finished.promise
    }
    expect(modelCalls).toBe(0)
    expect(d.terminals()).toHaveLength(12)
    expect(d.buffer.listRecent()).toHaveLength(3)
    expect(traceIds.slice(0, 9).every(id => d.buffer.getByTraceId(id) === null)).toBe(true)
  })

  test('cancellation after model fallback but before context closes that trace too', async () => {
    const d = diagnostics()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const agent = createAIAgent(config, {
      ...provider,
      modelInfo: async () => { entered.resolve(); await release.promise; return { id: 'fallback', provider: 'test', contextMax: 0, source: 'test' } },
    }, () => {}, {
      onEvalEvent: d.onEvalEvent,
      resolveEffectiveModel: () => ({ model: 'fallback', fallback: true, reason: 'test' }),
      onTurnFinished: () => finished.resolve(),
    })
    agent.receive(message())
    await entered.promise
    expect(d.events.some(event => event.kind === 'model_fallback')).toBe(true)
    agent.cancelGeneration()
    expect(d.terminals()).toHaveLength(1)
    expect(d.buffer.listRecent()[0]?.outcome).toBe('cancelled')
    release.resolve()
    await finished.promise
    expect(d.terminals()).toHaveLength(1)
    expect(d.events.some(event => event.kind === 'context_ready')).toBe(false)
  })

  test('normal multi-tool evaluation has one terminal after delivery', async () => {
    const d = diagnostics()
    let calls = 0
    const agent = createAIAgent(config, { ...provider, chat: async () => ++calls === 1
      ? { ...answer, content: '', toolCalls: [{ id: 'read-1', function: { name: 'read', arguments: {} } }, { id: 'read-2', function: { name: 'read', arguments: {} } }] }
      : answer,
    }, () => { expect(d.terminals()).toHaveLength(0) }, {
      onEvalEvent: d.onEvalEvent,
      toolDefinitions: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: {} } }],
      toolExecutor: async calls => calls.map(() => ({ success: true, data: { state: 'ready' } })),
    })
    agent.receive(message())
    await agent.whenIdle()
    expect(d.terminals()).toHaveLength(1)
    expect(d.buffer.listRecent()[0]).toMatchObject({ outcome: 'respond', toolCalls: [{ callId: 'call_0_0', success: true }, { callId: 'call_0_1', success: true }] })
  })

  test('late tool results after cancellation cannot reopen a closed trace', async () => {
    const d = diagnostics()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let modelCalls = 0
    const agent = createAIAgent(config, { ...provider, chat: async () => { modelCalls++; return { ...answer, content: '', toolCalls: [{ id: 'read-1', function: { name: 'read', arguments: {} } }] } } }, () => {}, {
      onEvalEvent: d.onEvalEvent,
      toolDefinitions: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: {} } }],
      toolExecutor: async () => { entered.resolve(); await release.promise; return [{ success: true, data: {} }] },
      onTurnFinished: () => finished.resolve(),
    })
    agent.receive(message())
    await entered.promise
    agent.cancelGeneration()
    const countAtCancellation = d.events.length
    release.resolve()
    await finished.promise
    expect(d.events).toHaveLength(countAtCancellation)
    expect(modelCalls).toBe(1)
    expect(d.buffer.listRecent()).toHaveLength(1)
    expect(d.buffer.listRecent()[0]?.outcome).toBe('cancelled')
  })

  test('a model response returned after cancellation cannot start a tool action', async () => {
    const d = diagnostics()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let toolCalls = 0
    const agent = createAIAgent(config, { ...provider, chat: async () => {
      entered.resolve(); await release.promise
      return { ...answer, content: '', toolCalls: [{ function: { name: 'action', arguments: {} } }] }
    } }, () => {}, {
      onEvalEvent: d.onEvalEvent,
      toolDefinitions: [{ type: 'function', function: { name: 'action', description: 'Act', parameters: {} } }],
      toolExecutor: async () => { toolCalls++; return [{ success: true, data: {} }] },
      onTurnFinished: () => finished.resolve(),
    })
    agent.receive(message())
    await entered.promise
    agent.cancelGeneration()
    release.resolve()
    await finished.promise
    expect(toolCalls).toBe(0)
    expect(d.terminals()).toHaveLength(1)
    expect(d.buffer.listRecent()[0]?.outcome).toBe('cancelled')
  })

  test.each(['model-resolution', 'admission', 'provider', 'delivery'] as const)('%s failure closes the outer turn as error', async phase => {
    const d = diagnostics()
    const store = createExecutionStore(':memory:')
    try {
      const options: AIAgentOptions = {
        onEvalEvent: d.onEvalEvent,
        ...(phase === 'model-resolution' ? { resolveEffectiveModel: () => { throw new Error('resolver failed') } } : {}),
        ...(phase === 'admission' ? { executionStore: store, executionGrowth: async () => { throw new Error('quota unavailable') } } : {}),
      }
      const agent = createAIAgent(config, phase === 'provider' ? { ...provider, chat: async () => { throw new Error('provider failed') } } : provider,
        () => { if (phase === 'delivery') throw new Error('delivery failed') }, options)
      agent.receive(message())
      await agent.whenIdle()
      expect(d.terminals()).toHaveLength(1)
      expect(d.buffer.listRecent()[0]?.outcome).toBe('error')
    } finally { store.close() }
  })

  test('optional capture failure preserves a normal pass outcome', async () => {
    const d = diagnostics()
    const agent = createAIAgent(config, { ...provider, chat: async () => ({ ...answer, content: '', toolCalls: [{ function: { name: 'pass', arguments: { reason: 'Nothing to add' } } }] }) }, () => {}, {
      onEvalEvent: d.onEvalEvent,
      onTurnStart: async () => { throw new Error('capture unavailable') },
    })
    agent.receive(message())
    await agent.whenIdle()
    expect(d.terminals()).toHaveLength(1)
    expect(d.buffer.listRecent()[0]).toMatchObject({ outcome: 'pass', warnings: [expect.stringContaining('capture unavailable')] })
  })

  test('trigger cancellation uses the same terminal owner', async () => {
    const d = diagnostics()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const agent = createAIAgent(config, provider, () => {}, {
      onEvalEvent: d.onEvalEvent,
      onTurnStart: async () => { entered.resolve(); await release.promise },
    })
    const running = agent.fireTriggerExecute!('Inspect', 'room')
    await entered.promise
    agent.cancelGeneration()
    expect(d.buffer.listRecent()[0]?.outcome).toBe('cancelled')
    release.resolve()
    await running
    expect(d.terminals()).toHaveLength(1)
  })

  test('a diagnostic subscriber cannot strand generation or cause duplicate terminal events', async () => {
    const d = diagnostics()
    let releases = 0
    let decisions = 0
    const agent = createAIAgent(config, provider, () => { decisions++ }, {
      onEvalEvent: (scope, event) => { d.onEvalEvent(scope, event); throw new Error('subscriber failed') },
      onTurnFinished: () => { releases++ },
    })
    for (let i = 0; i < 2; i++) { agent.receive(message()); await agent.whenIdle() }
    expect(releases).toBe(2)
    expect(decisions).toBe(2)
    expect(d.terminals()).toHaveLength(2)
    expect(d.buffer.listRecent().every(record => record.outcome === 'respond')).toBe(true)
  })
})
