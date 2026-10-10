// Tests for evaluation's error classification — ensures LLM/transport failures
// produce typed `action: 'error'` decisions with the correct error code, never
// a `pass` action. Pass is reserved for genuine agent decisions (the `pass`
// tool); this distinction is what lets the UI surface real failures clearly
// (red error chip + "Change model" affordance) instead of hiding them behind
// a gray "[pass]".
//
// Direct unit tests for evaluate() / streamLLM / callLLM live in the
// additional describe blocks below — they exercise evaluate.ts's public
// surface without going through createAIAgent.

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from '../core/types/llm.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { createCloudProviderError, createGatewayError, createOllamaError } from '../llm/errors.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'
import type { ContextResult } from './context-builder.ts'
import { evaluate, callLLM, streamLLM, fitToolEvidence } from './evaluation.ts'

test('tool evidence budget includes system blocks and removes whole older turns', () => {
  const context: Array<ChatRequest['messages'][number]>=[
    {role:'user',content:'old request'.repeat(20)},
    {role:'assistant',content:'old response'.repeat(20)},
    {role:'user',content:'current'},
  ]
  const fit=fitToolEvidence(context,{role:'assistant',content:''},[{role:'tool',toolCallId:'call',content:'x'.repeat(100)}],100,60)
  expect(fit.droppedHistory).toBe(2)
  expect(context[0]!.content).toBe('current')
  expect(fit.overBudget).toBe(false)
})

test('tool evidence keeps the message that opened the turn after a later correction', () => {
  // A requested turn: its instruction opened the turn, then the loop insisted once.
  const context: Array<ChatRequest['messages'][number]>=[
    {role:'user',content:'old request'.repeat(20)},
    {role:'assistant',content:'old response'.repeat(20)},
    {role:'user',content:'instruction carrying the answer'},
    {role:'assistant',content:'first answer'},
    {role:'user',content:'correction'},
  ]
  const fit=fitToolEvidence(context,{role:'assistant',content:''},[{role:'tool',toolCallId:'call',content:'x'.repeat(100)}],100,60,2)
  expect(fit.droppedHistory).toBe(2)
  expect(context.map(message=>message.content).slice(0,3)).toEqual(['instruction carrying the answer','first answer','correction'])
})

const makeConfig = (over: Partial<AIAgentConfig> = {}): AIAgentConfig => ({
  name: 'Tester',
  model: 'test-model',
  persona: 'You are a tester.',
  ...over,
})

const makeMessage = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  senderId: 'alice',
  content: 'hello',
  timestamp: Date.now(),
  type: 'chat',
  roomId: 'room-1',
  ...over,
})

const errProvider = (err: unknown): LLMProvider => ({
  chat: async () => { throw err },
  models: async () => [],
})

describe('Evaluation — error classification', () => {
  test('cloud auth error → no_api_key', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'auth', provider: 'anthropic', message: 'invalid api key', status: 401,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('no_api_key')
      expect(decisions[0]!.response.providerHint).toBe('anthropic')
    }
  })

  test('cloud bad_request → model_unavailable', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'bad_request', provider: 'groq', message: 'unknown model', status: 400,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('model_unavailable')
      expect(decisions[0]!.response.providerHint).toBe('groq')
    } else {
      throw new Error('expected error action')
    }
  })

  test('cloud rate_limit → rate_limited', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'rate_limit', provider: 'gemini', message: '429 too many requests', status: 429,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('rate_limited')
    } else {
      throw new Error('expected error action')
    }
  })

  test('cloud provider_down → provider_down', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'provider_down', provider: 'cerebras', message: '503 service unavailable', status: 503,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('provider_down')
    } else {
      throw new Error('expected error action')
    }
  })

  // HTTP 402: a transient in-flight limit is retried, not a model problem;
  // missing credits make the model unavailable to this account.
  test.each([['in_flight_limit', 'rate_limited'], ['credits', 'model_unavailable']] as const)('cloud %s → %s', async (code, expected) => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code, provider: 'openrouter', message: 'openrouter refused (HTTP 402)', status: 402,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe(expected)
      expect(decisions[0]!.response.providerHint).toBe('openrouter')
    } else {
      throw new Error('expected error action')
    }
  })

  test('ollama 4xx → model_unavailable', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createOllamaError(404, 'model "qwen99" not found'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('model_unavailable')
      expect(decisions[0]!.response.providerHint).toBe('ollama')
    } else {
      throw new Error('expected error action')
    }
  })

  test('gateway error → provider_down', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createGatewayError('circuit_open', 'circuit open for ollama'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('provider_down')
    } else {
      throw new Error('expected error action')
    }
  })

  test('network-shaped error → network', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(new Error('fetch failed: ECONNREFUSED'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('network')
    } else {
      throw new Error('expected error action')
    }
  })

  test('unknown error → unknown', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(new Error('something weird happened'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('unknown')
    } else {
      throw new Error('expected error action')
    }
  })

  test('empty content from LLM → action:error / code:empty_response (NOT pass)', async () => {
    const decisions: Decision[] = []
    const provider: LLMProvider = {
      chat: async () => ({ content: '', generationMs: 5, tokensUsed: { prompt: 1, completion: 0 } }),
      models: async () => [],
    }
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('empty_response')
    }
  })

  test('a real `pass` tool call still produces action:pass (sanity check)', async () => {
    const decisions: Decision[] = []
    const provider: LLMProvider = {
      chat: async () => ({
        content: '',
        generationMs: 5,
        tokensUsed: { prompt: 1, completion: 0 },
        toolCalls: [{ function: { name: 'pass', arguments: { reason: 'no input' } } }],
      }),
      models: async () => [],
    }
    const agent = createAIAgent(
      makeConfig(),
      provider,
      (d) => { decisions.push(d) },
      {
        toolDefinitions: [{ type: 'function', function: { name: 'pass', description: 'decline', parameters: {} } }],
        toolExecutor: async () => [],
      },
    )
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('pass')
    if (decisions[0]!.response.action === 'pass') {
      expect(decisions[0]!.response.reason).toBe('no input')
    }
  })
})

// ============================================================================
// Direct evaluate() / streamWithRetry / streamLLM / callLLM tests.
// Real LLMProvider implementations as fixtures (no mocks).
// ============================================================================

const baseContextResult = (): ContextResult => ({
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  flushInfo: { ids: new Set<string>(), triggerRoomId: 'room-1' },
  warnings: [],
})

const asyncIterFromArray = <T>(items: ReadonlyArray<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => {
    let i = 0
    return {
      next: async () => i < items.length
        ? { value: items[i++]!, done: false }
        : { value: undefined as unknown as T, done: true },
    }
  },
})

interface StaticProviderOptions {
  readonly content?: string
  readonly toolCalls?: ChatResponse['toolCalls']
  readonly streamChunks?: ReadonlyArray<StreamChunk>
}

const makeStaticProvider = (opts: StaticProviderOptions = {}): LLMProvider => {
  const { content = '', toolCalls, streamChunks } = opts
  const chat = async (): Promise<ChatResponse> => ({
    content,
    generationMs: 1,
    tokensUsed: { prompt: 5, completion: 2 },
    ...(toolCalls ? { toolCalls } : {}),
  })
  if (streamChunks) {
    return {
      chat,
      stream: () => asyncIterFromArray(streamChunks),
      models: async () => ['test-model'],
    }
  }
  return { chat, models: async () => ['test-model'] }
}

const makeScriptedProvider = (
  scripts: ReadonlyArray<Partial<ChatResponse>>,
): { provider: LLMProvider; calls: ChatRequest[] } => {
  const calls: ChatRequest[] = []
  let i = 0
  const provider: LLMProvider = {
    chat: async (request): Promise<ChatResponse> => {
      calls.push(request)
      const s = scripts[Math.min(i++, scripts.length - 1)]!
      return {
        ...s,
        content: s.content ?? '',
        generationMs: 1,
        tokensUsed: { prompt: 1, completion: 1 },
        ...(s.toolCalls ? { toolCalls: s.toolCalls } : {}),
      }
    },
    models: async () => ['test-model'],
  }
  return { provider, calls }
}

const passToolDef: ToolDefinition = {
  type: 'function',
  function: {
    name: 'pass',
    description: 'Decline',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

const baseConfig: AIAgentConfig = {
  name: 'TestBot', model: 'test-model', persona: 'tester', historyLimit: 10,
}

// ---------------------------------------------------------------------------
// evaluate() — tool loop, exhaustion, truncation. The pass-tool short-circuit
// is already covered above via createAIAgent.
// ---------------------------------------------------------------------------

describe('evaluate (tool loop)', () => {
  test('continuation and explicit effort survive multiple tool rounds with actual model metrics and complete query', async () => {
    const continuation = { provider: 'openrouter' as const, model: 'qwen/resolved', endpointHash: 'a'.repeat(64), reasoningDetails: [{ type: 'reasoning.encrypted', data: 'exact' }] }
    const toolCalls = [1, 2].map(index => ({ id: `native00${index}`, function: { name: 'inspect', arguments: { index } } }))
    const { provider, calls } = makeScriptedProvider([
      { toolCalls, continuation, model: 'qwen/resolved' },
      { toolCalls: toolCalls.slice(0, 1), continuation, model: 'qwen/resolved' },
      { content: 'done', model: 'qwen/resolved' },
    ])
    const result = await evaluate(baseContextResult(), { ...baseConfig, model: 'openrouter:openrouter/auto', reasoningEffort: 'high' }, provider, async tools => tools.map(() => ({ success: true, data: 'seen' })), 5, 'room-1', { toolDefinitions: [] })
    expect(calls.map(call => call.model)).toEqual(['openrouter:openrouter/auto', 'openrouter:qwen/resolved', 'openrouter:qwen/resolved'])
    expect(calls.every(call => call.reasoningEffort === 'high')).toBe(true)
    const final = result.decision.generationQuery!
    expect(final).toEqual(calls[2]!)
    expect(final.messages.filter(message => message.continuation).map(message => message.continuation)).toEqual([continuation, continuation])
    expect(final.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['native001', 'native002', 'native001'])
    expect(result.decision.metrics?.model).toBe('qwen/resolved')
  })

  test('length output is an error and never executes even apparently complete tool arguments', async () => {
    const { provider } = makeScriptedProvider([{ content: 'partial answer', finishReason: 'length', toolCalls: [{ id: 'native001', function: { name: 'mutate', arguments: {} } }] }])
    let executed = 0
    const result = await evaluate(baseContextResult(), baseConfig, provider, async () => { executed++; return [] }, 5, 'room-1', { toolDefinitions: [] })
    expect(executed).toBe(0)
    expect(result.decision.response.action).toBe('error')
    expect(JSON.stringify(result.decision.response)).toContain('incomplete_output')
  })
  test('plain content → respond decision', async () => {
    const provider = makeStaticProvider({ content: 'hello world' })
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, undefined, 5, 'room-1',
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') expect(r.content).toBe('hello world')
  })

  test('records the complete final generation query after tool use', async () => {
    const tools: ToolDefinition[] = [{
      type: 'function',
      function: { name: 'inspect', description: 'Inspect evidence', parameters: { type: 'object' } },
    }]
    const { provider } = makeScriptedProvider([
      { toolCalls: [{ id: 'call-1', function: { name: 'inspect', arguments: { subject: 'plant' } } }] },
      { content: 'grounded answer' },
    ])
    const result = await evaluate(
      baseContextResult(), baseConfig, provider,
      async () => [{ success: true, data: { status: 'nominal' } }],
      5, 'room-1', { toolDefinitions: tools },
    )
    expect(result.decision.generationQuery?.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', function: { name: 'inspect', arguments: { subject: 'plant' } } }] },
      { role: 'tool', toolCallId: 'call-1', name: 'inspect', content: '{"status":"nominal"}' },
    ])
    expect(result.decision.generationQuery?.tools).toEqual(tools)
  })

  test('one tool round → result feeds next call → final content', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }] },
      { content: 'final answer' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(c => ({ success: true, data: { echoed: c.arguments.text } }))
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') expect(r.content).toBe('final answer')
    expect(calls).toHaveLength(2)
    // Second call preserves the provider-native assistant/tool exchange.
    const last = calls[1]!
    const assistantToolMessage = last.messages.find(m => m.role === 'assistant' && m.toolCalls?.length)
    const toolMessage = last.messages.find(m => m.role === 'tool')
    expect(assistantToolMessage?.toolCalls?.[0]?.function.name).toBe('echo')
    expect(toolMessage?.content).toContain('echoed')
    expect(toolMessage?.toolCallId).toBe(assistantToolMessage?.toolCalls?.[0]?.id)
    expect(result.decision.metrics?.modelCalls).toBe(2)
    // toolTrace populated.
    expect(result.decision.toolTrace).toHaveLength(1)
    expect(result.decision.toolTrace![0]!.tool).toBe('echo')
    expect(result.decision.toolTrace![0]!.success).toBe(true)
    expect(result.decision.toolTrace![0]!.argumentKeys).toEqual(['text'])
    expect(result.decision.toolTrace![0]!.argumentBytes).toBeGreaterThan(0)
    expect(result.decision.toolTrace![0]).not.toHaveProperty('arguments')
  })

  test('preserves fresh tool evidence when it alone exceeds the context budget', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ id: 'read_1', function: { name: 'read', arguments: {} } }] },
      { content: 'answered from evidence' },
    ])
    const evidence = 'current-evidence-'.repeat(80)
    const warnings: string[] = []
    const result = await evaluate(
      {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: `old-${'history'.repeat(100)}` },
          { role: 'assistant', content: `old-${'answer'.repeat(100)}` },
          { role: 'user', content: 'current question' },
        ],
        flushInfo: { ids: new Set<string>(), triggerRoomId: 'room-1' },
        warnings: [],
        tokenBudget: 80,
      },
      baseConfig,
      provider,
      async () => [{ success: true, data: evidence }],
      5,
      'room-1',
      { toolDefinitions: [], onEvent: event => { if (event.kind === 'warning') warnings.push(event.message) } },
    )

    expect(result.decision.response.action).toBe('respond')
    expect(calls[1]?.messages.find(message => message.role === 'tool')?.content).toBe(evidence)
    expect(calls[1]?.messages.some(message => message.content.startsWith('old-'))).toBe(false)
    expect(warnings.some(message => message.includes('Evidence was preserved intact'))).toBe(true)
  })

  test('multi-round tool loop (2 tools then content)', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ function: { name: 'b', arguments: {} } }] },
      { content: 'done' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: 'ok' }))
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    expect(calls).toHaveLength(3)
    const r = result.decision.response
    if (r.action === 'respond') expect(r.content).toBe('done')
    expect(result.decision.toolTrace).toHaveLength(2)
  })

  test('execution IDs are unique while provider wire IDs remain unchanged', async () => {
    const { provider } = makeScriptedProvider([
      { toolCalls: [{ id: 'Ab123Cd45', function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ id: 'Ab123Cd45', function: { name: 'b', arguments: {} } }] },
      { content: 'done' },
    ])
    const executedIds: string[] = []
    const result = await evaluate(baseContextResult(), baseConfig, provider, async calls => {
      executedIds.push(...calls.map(call => call.callId!))
      return calls.map(call => ({ success: true, data: call.tool }))
    }, undefined, 'room-1')
    const messages = result.decision.generationQuery!.messages
    expect(new Set(executedIds).size).toBe(2)
    expect(messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? [])).toEqual(['Ab123Cd45', 'Ab123Cd45'])
    expect(messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['Ab123Cd45', 'Ab123Cd45'])
  })

  test('records nested Workspace operation failures and tool-evidence size', async () => {
    const { provider } = makeScriptedProvider([
      { toolCalls: [{ id: 'workspace_1', function: { name: 'workspace_call', arguments: { calls: [{ key: 'bad', operationId: 'world.test.read', input: {} }] } } }] },
      { content: 'The requested read was rejected.' },
    ])
    const result = await evaluate(
      baseContextResult(),
      baseConfig,
      provider,
      async () => [{ success: true, data: { results: [{ key: 'bad', operationId: 'world.test.read', success: false, error: 'invalid input' }] } }],
      undefined,
      'room-1',
      { toolDefinitions: [] },
    )
    expect(result.decision.toolTrace).toEqual([expect.objectContaining({
      tool: 'workspace_call',
      success: false,
      resultBytes: expect.any(Number),
      operationOutcomes: [{ key: 'bad', operationId: 'world.test.read', success: false }],
    })])
    expect(result.decision.toolTrace![0]!.resultBytes).toBeGreaterThan(0)
  })

  test('tool calls without executor → tools_unavailable', async () => {
    const provider = makeStaticProvider({
      toolCalls: [{ function: { name: 'echo', arguments: {} } }],
    })
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, undefined, 5, 'room-1',
      { toolDefinitions: [passToolDef] },
    )
    const r = result.decision.response
    expect(r.action).toBe('error')
    if (r.action === 'error') expect(r.code).toBe('tools_unavailable')
  })

  test('iteration cap with prior text → respond with partial-result footer', async () => {
    // Every round emits both content AND a tool call → loop never ends via
    // content; surfaces as exhaustion, BUT lastAssistantText was captured
    // and is delivered with a footer instead of a bare error.
    const { provider } = makeScriptedProvider([
      { content: 'partial answer', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { content: 'still working', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { content: 'still working', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
    ])
    const exec: ToolExecutor = async (calls) =>
      calls.map(() => ({ success: true, data: 'k' }))
    // maxToolIterations = 1 → 2 rounds (0 and 1) before exhaustion.
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 1, 'room-1',
      { toolDefinitions: [] },
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') {
      expect(r.content).toContain('still working')
      expect(r.content).toContain('partial result')
    }
  })

  test('checkin: paused at cap, user continues → loop resumes', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ function: { name: 'b', arguments: {} } }] },
      { content: 'finally done' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: 'k' }))
    let checkinCalls = 0
    const requestToolCheckin = async (info: { iterations: number; recentTools: ReadonlyArray<{ tool: string; success: boolean }> }) => {
      checkinCalls++
      expect(info.iterations).toBeGreaterThan(0)
      expect(info.recentTools.length).toBeGreaterThan(0)
      return true
    }
    // maxToolIterations = 1 would normally stop after the threshold. Once a
    // human continues, the Agent owns the rest of this turn without a quota.
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 1, 'room-1',
      { toolDefinitions: [], requestToolCheckin },
    )
    expect(checkinCalls).toBeGreaterThan(0)
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') expect(r.content).toBe('finally done')
    expect(calls).toHaveLength(3)
  })

  test('checkin: user stops → falls through to exceeded path with partial', async () => {
    const { provider } = makeScriptedProvider([
      { content: 'work in progress', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ function: { name: 'b', arguments: {} } }] },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: 'k' }))
    const requestToolCheckin = async () => false
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 1, 'room-1',
      { toolDefinitions: [], requestToolCheckin },
    )
    const r = result.decision.response
    // Partial content was captured → delivered with footer.
    expect(r.action).toBe('respond')
    if (r.action === 'respond') {
      expect(r.content).toContain('work in progress')
      expect(r.content).toContain('partial result')
    }
  })

  test('checkin not wired → configured iteration cap remains authoritative', async () => {
    const { provider } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ function: { name: 'b', arguments: {} } }] },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: 'k' }))
    // No requestToolCheckin in EvalOptions → falls through to legacy.
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 1, 'room-1',
      { toolDefinitions: [] },
    )
    const r = result.decision.response
    // No prior text → error path, not respond path.
    expect(r.action).toBe('error')
    if (r.action === 'error') expect(r.code).toBe('tool_loop_exceeded')
  })

  test('large tool results are passed through verbatim (no truncation)', async () => {
    // Fence-emitting tools like station_status_arrivals routinely
    // produce 5-50 KB payloads that must reach the model intact. Any cap
    // here would slice the fence mid-content and break the renderer.
    const huge = 'x'.repeat(10_000)
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'big', arguments: {} } }] },
      { content: 'done' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: huge }))
    await evaluate(
      baseContextResult(), baseConfig,
      provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    const second = calls[1]!
    expect(second.messages.some(m => m.content.includes(huge))).toBe(true)
    expect(second.messages.some(m => m.content.includes('characters omitted'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// streamLLM / callLLM
// ---------------------------------------------------------------------------

describe('streamLLM', () => {
  test('an incomplete stream rejects after provisional deltas instead of reporting completion', async () => {
    const provider = makeStaticProvider({ streamChunks: [{ delta: 'provisional', done: false }, { delta: '', done: true, finishReason: 'length' }] })
    await expect(Array.fromAsync(streamLLM(provider, { model: 'm', messages: [] }))).rejects.toThrow('incomplete_output')
  })
  test('yields deltas from provider stream', async () => {
    const provider = makeStaticProvider({
      streamChunks: [
        { delta: 'hel', done: false },
        { delta: 'lo', done: false },
        { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } },
      ],
    })
    const got: string[] = []
    for await (const chunk of streamLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'x' }],
    })) {
      if (chunk) got.push(chunk)
    }
    expect(got).toEqual(['hel', 'lo'])
  })

  test('falls back to chat() when provider has no stream method', async () => {
    const provider = makeStaticProvider({ content: 'whole answer' })
    expect(provider.stream).toBeUndefined()
    const got: string[] = []
    for await (const chunk of streamLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'x' }],
    })) {
      got.push(chunk)
    }
    expect(got).toEqual(['whole answer'])
  })
})

describe('callLLM', () => {
  test('standalone chat and chat-backed stream propagate settings and reject incomplete answers', async () => {
    const { provider, calls } = makeScriptedProvider([{ content: 'partial', finishReason: 'length' }])
    const options = { model: 'm', messages: [], reasoningEffort: 'high' as const, think: true, seed: 7 }
    await expect(callLLM(provider, options)).rejects.toThrow('incomplete_output')
    await expect(Array.fromAsync(streamLLM(provider, options))).rejects.toThrow('incomplete_output')
    expect(calls.every(call => call.reasoningEffort === 'high' && call.think === true && call.seed === 7)).toBe(true)
  })
  test('returns raw chat content', async () => {
    const provider = makeStaticProvider({ content: 'sync result' })
    const out = await callLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }],
    })
    expect(out).toBe('sync result')
  })
})
