// Retry-loop integration tests — drive evaluate() through a stub
// LLMProvider that returns a scripted sequence of responses, and assert the
// retry behavior. We don't run a real provider; the stub records its calls
// so we can verify (a) how many times the LLM was invoked, (b) what context
// was sent on each call, (c) the final committed content.

import { describe, expect, test } from 'bun:test'
import { evaluate } from './evaluation.ts'
import type { ContextResult } from './context-builder.ts'
import type { LLMProvider, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'

// === Stub helpers ===

const mkResponse = (content: string): ChatResponse => ({
  content,
  generationMs: 1,
  tokensUsed: { prompt: 1, completion: 1 },
})

const mkProvider = (responses: ReadonlyArray<string>): {
  provider: LLMProvider
  callLog: { request: ChatRequest }[]
} => {
  const callLog: { request: ChatRequest }[] = []
  let i = 0
  const provider: LLMProvider = {
    chat: async (request: ChatRequest) => {
      callLog.push({ request })
      const r = responses[i] ?? responses[responses.length - 1] ?? ''
      i++
      return mkResponse(r)
    },
    models: async () => [],
  }
  return { provider, callLog }
}

const mkContext = (): ContextResult => ({
  messages: [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Make a map.' },
  ],
  flushInfo: { ids: new Set(), triggerRoomId: 'room-1' },
  warnings: [],
})

const mkConfig = (): AIAgentConfig => ({
  name: 'TestAgent',
  model: 'stub-model',
  persona: 'test',
})

// === Tests ===

describe('evaluation map-fence retry loop', () => {
  test('fence retries retain provider continuation and explicit reasoning settings in the captured request', async () => {
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const continuation = { provider: 'openrouter' as const, model: 'qwen/resolved', endpointHash: 'a'.repeat(64), reasoningDetails: [{ type: 'reasoning.encrypted', data: 'exact' }] }
    const calls: ChatRequest[] = []
    const provider: LLMProvider = { models: async () => [], chat: async request => {
      calls.push(structuredClone(request))
      return { ...mkResponse(calls.length === 1 ? broken : 'corrected'), continuation, model: 'qwen/resolved' }
    } }
    const result = await evaluate(mkContext(), { ...mkConfig(), reasoningEffort: 'high', thinking: true }, provider, undefined, 5, 'room-1')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ model: 'openrouter:qwen/resolved', reasoningEffort: 'high', think: true })
    expect(calls[1]!.messages.find(message => message.role === 'assistant')?.continuation).toEqual(continuation)
    expect(result.decision.generationQuery).toEqual(calls[1]!)
  })
  test('valid fence on first try → no retry, posts as-is', async () => {
    const valid = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const reply = `Here you go:\n\n${valid}`
    const { provider, callLog } = mkProvider([reply])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)
    expect(result.decision.response.action).toBe('respond')
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(reply)
    }
  })

  test('invalid fence → one retry → corrected response posts', async () => {
    // First attempt: agent uses old `position: [lat, lng]` form. Validator
    // tolerates `position` so we need a TRUE invalid case — out-of-range lat.
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken, fixed])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(2)   // initial + 1 retry
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(fixed)
    }
    // Second call's context must include the synthetic correction prompt.
    const retryRequest = callLog[1]!.request
    const lastUser = [...retryRequest.messages].reverse().find(m => m.role === 'user')
    expect(lastUser?.content).toMatch(/invalid fenced blocks/)
    expect(lastUser?.content).toMatch(/rendering skill for the schema/)
    expect(lastUser?.content).toMatch(/marker\.lat/)
  })

  test('two failed retries → broken fence posts (UI banner takes over)', async () => {
    const broken1 = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const broken2 = '```map\n{"features":[{"type":"marker","lat":888,"lng":5}]}\n```'
    const broken3 = '```map\n{"features":[{"type":"marker","lat":777,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken1, broken2, broken3])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    // 1 initial + MAX_FENCE_RETRIES=2 → 3 total LLM calls.
    expect(callLog.length).toBe(3)
    if (result.decision.response.action === 'respond') {
      // Last attempt is what gets posted (broken3, the third call's content).
      expect(result.decision.response.content).toBe(broken3)
    }
  })

  test('mermaid fences are NOT validated server-side (pass through unchecked)', async () => {
    // Even garbage mermaid never triggers a retry — server-side mermaid
    // validation is impractical, so the loop ignores ```mermaid fences.
    const garbageMermaid = '```mermaid\nthis is not valid mermaid syntax at all\n```'
    const reply = `Here:\n\n${garbageMermaid}`
    const { provider, callLog } = mkProvider([reply])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)   // no retry attempted
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(reply)
    }
  })

  test('response with no fences at all → no retry, no validation overhead', async () => {
    const reply = 'Just some plain prose, no fences here.'
    const { provider, callLog } = mkProvider([reply])
    await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)
  })

  test('retry budget is independent of maxToolIterations', async () => {
    // maxToolIterations=1: in pure tool terms only one round allowed. Retry
    // happens AFTER the tool loop completes (no tool calls in any of these
    // responses, so the for-loop runs once and terminates). The retry path
    // is its own loop, doesn't consume tool budget.
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken, fixed])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 1, 'room-1')
    expect(callLog.length).toBe(2)
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(fixed)
    }
  })

  test('eval_completed event fires exactly once, with the final outcome', async () => {
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider } = mkProvider([broken, fixed])
    const completedEvents: Array<{ outcome: string }> = []
    await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1', {
      onEvent: (e) => {
        if (e.kind === 'eval_completed') completedEvents.push({ outcome: e.outcome })
      },
    })
    expect(completedEvents).toEqual([{ outcome: 'respond' }])
  })

  test('signal abort during retry stops cleanly', async () => {
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider } = mkProvider([broken, fixed])
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1', {
      signal: ctrl.signal,
    })
    // Aborted before retry could happen — the broken response is what we get.
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(broken)
    }
  })
})

describe('evaluation view-fence guard', () => {
  const viewFence = (ref: string): string => `Pressure is holding in its control band.\n\n\`\`\`leitbild-view\nview ${ref}\n\`\`\``

  test('a view fence without a display composed in this turn is corrected, never posted as-is', async () => {
    const { provider, callLog } = mkProvider([viewFence('call_0_0/compose'), 'Pressure is holding in its control band.'])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(2)
    const correction = callLog[1]!.request.messages.at(-1)!.content
    expect(correction).toContain('call_0_0/compose is not a display composed in this turn')
    expect(result.decision.response).toEqual({ action: 'respond', content: 'Pressure is holding in its control band.' })
  })

  test('a view fence naming a display composed by workspace_call in this turn is accepted', async () => {
    const answers = [
      { content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: { calls: [] } } }] },
      { content: viewFence('call_0_0/compose') },
    ]
    let index = 0
    const calls: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => [],
      chat: async request => { calls.push(request); return { ...mkResponse(''), ...answers[index++]! } },
    }
    const executor = async () => [{
      success: true,
      data: { results: [{ key: 'compose', operationId: 'world.process-plant.display.compose', success: true, data: {}, viewRef: 'call_0_0/compose' }] },
    }]
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', {
      toolDefinitions: [{ type: 'function', function: { name: 'workspace_call', description: 'call', parameters: {} } }],
    })
    expect(calls).toHaveLength(2)
    expect(result.decision.response).toEqual({ action: 'respond', content: viewFence('call_0_0/compose') })
  })

  test('a display composed in this turn but left out of the answer is corrected', async () => {
    // Probe run 19: the answer said "the mimic below shows" and carried no view block.
    const answers = [
      { content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: { calls: [] } } }] },
      { content: 'The pump runs; the mimic below shows its branches.' },
      { content: viewFence('call_0_0/compose') },
    ]
    let index = 0
    const calls: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => [],
      chat: async request => { calls.push(request); return { ...mkResponse(''), ...answers[index++]! } },
    }
    const executor = async () => [{
      success: true,
      data: { results: [{ key: 'compose', operationId: 'world.process-plant.display.compose', success: true, data: {}, viewRef: 'call_0_0/compose' }] },
    }]
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', {
      toolDefinitions: [{ type: 'function', function: { name: 'workspace_call', description: 'call', parameters: {} } }],
    })
    expect(calls).toHaveLength(3)
    expect(calls[2]!.messages.at(-1)!.content).toContain('This turn composed a display (viewRef call_0_0/compose) but the response does not present it.')
    expect(result.decision.response).toEqual({ action: 'respond', content: viewFence('call_0_0/compose') })
  })

  test('more than one display per answer is corrected', async () => {
    const twice = `${viewFence('call_0_0/a')}\n\n\`\`\`leitbild-view\nview call_0_0/b\n\`\`\``
    const { provider, callLog } = mkProvider([twice, 'text only'])
    await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog[1]!.request.messages.at(-1)!.content).toContain('at most one display per answer')
  })
})

describe('evaluation required view (display requests)', () => {
  const viewFence = (ref: string): string => `The display tracks pressurizer level against its alarms.\n\n\`\`\`leitbild-view\nview ${ref}\n\`\`\``
  const composeCall = { content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: { calls: [] } } }] }
  const scripted = (answers: ReadonlyArray<{ content: string; toolCalls?: ChatResponse['toolCalls'] }>) => {
    let index = 0
    const calls: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => [],
      // The loop keeps appending to the same context array; record each request as sent.
      chat: async request => { calls.push(structuredClone(request)); return { ...mkResponse(''), ...answers[index++]! } },
    }
    return { provider, calls }
  }
  // The compose result names the call that produced it, as workspace_call does.
  const executor = async (calls: ReadonlyArray<{ callId?: string }>) => [{
    success: true,
    data: { results: [{ key: 'compose', operationId: 'world.process-plant.display.compose', success: true, data: {}, viewRef: `${calls[0]!.callId}/compose` }] },
  }]
  const options = { toolDefinitions: [{ type: 'function' as const, function: { name: 'workspace_call', description: 'call', parameters: {} } }], requireView: true }

  test('an answer without a display is asked once more, and can still compose one', async () => {
    const { provider, calls } = scripted([
      { content: 'Pressurizer level is steady at 55 %.' },
      composeCall,
      { content: viewFence('call_1_0/compose') },
    ])
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', options)
    expect(calls).toHaveLength(3)
    expect(calls[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: 'Pressurizer level is steady at 55 %.' })
    expect(calls[1]!.messages.at(-1)!.content).toContain('The reader asked for a live display, and this response presents none.')
    expect(result.decision.response).toEqual({ action: 'respond', content: viewFence('call_1_0/compose') })
  })

  test('the second answer without a display stands', async () => {
    const { provider, calls } = scripted([
      { content: 'Pressurizer level is steady at 55 %.' },
      { content: 'No display can be produced: the answer is about the product, not the plant.' },
    ])
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', options)
    expect(calls).toHaveLength(2)
    expect(result.decision.response).toEqual({ action: 'respond', content: 'No display can be produced: the answer is about the product, not the plant.' })
  })

  test('an answer that presents the display it composed is not asked again', async () => {
    const { provider, calls } = scripted([composeCall, { content: viewFence('call_0_0/compose') }])
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', options)
    expect(calls).toHaveLength(2)
    expect(result.decision.response).toEqual({ action: 'respond', content: viewFence('call_0_0/compose') })
  })

  test('asking again does not count against the tool iteration limit', async () => {
    const { provider, calls } = scripted([
      { content: 'Pressurizer level is steady at 55 %.' },
      composeCall,
      { content: viewFence('call_1_0/compose') },
    ])
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 1, 'room-1', options)
    expect(calls).toHaveLength(3)
    expect(result.decision.response).toEqual({ action: 'respond', content: viewFence('call_1_0/compose') })
  })

  test('without the requirement an answer without a display is final', async () => {
    const { provider, calls } = scripted([{ content: 'Pressurizer level is steady at 55 %.' }])
    await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', { ...options, requireView: false })
    expect(calls).toHaveLength(1)
  })
})

describe('evaluation answer-display consistency', () => {
  // Run 19 rcp-trip: the answer cited a loop flow its display did not show.
  const fenced = (text: string): string => `${text}\n\n\`\`\`leitbild-view\nview call_0_0/compose\n\`\`\``
  const inconsistent = fenced('Core cooling is not confirmed. All four RCP loops were at about 401 kg/s; CET-AVG is 302.4 °C.')
  const corrected = fenced('Core cooling is not confirmed. CET-AVG is 302.4 °C; loop flow (not shown) is about 401 kg/s.')
  const viewContent = {
    items: [{ names: ['CET-AVG', 'Core coolant outlet temperature'], values: [{ value: 302.4, unit: '°C' }], limits: [], history: true }],
    span: { shownMs: 60_000, horizonMs: 120_000 },
    lead: null,
  }
  const run = async (answers: ReadonlyArray<string>, data: unknown = { viewContent }) => {
    const scripted = [
      { content: '', toolCalls: [{ id: 'w1', function: { name: 'workspace_call', arguments: { calls: [] } } }] },
      ...answers.map(content => ({ content })),
    ]
    let index = 0
    const calls: ChatRequest[] = []
    const provider: LLMProvider = {
      models: async () => [],
      chat: async request => { calls.push(request); return { ...mkResponse(''), ...scripted[index++]! } },
    }
    const executor = async () => [{
      success: true,
      data: { results: [{ key: 'compose', operationId: 'world.process-plant.display.compose', success: true, data, viewRef: 'call_0_0/compose' }] },
    }]
    const result = await evaluate(mkContext(), mkConfig(), provider, executor, 5, 'room-1', {
      toolDefinitions: [{ type: 'function', function: { name: 'workspace_call', description: 'call', parameters: {} } }],
    })
    return { calls, result }
  }

  test('an answer citing what its display does not show is corrected once, naming each issue', async () => {
    const { calls, result } = await run([inconsistent, corrected])
    expect(calls).toHaveLength(3)
    const correction = calls[2]!.messages.at(-1)!.content
    expect(correction).toContain('- It cites 401 kg/s, but the display shows no value in kg/s.')
    expect(correction).toContain('mark one "(not shown)"')
    expect(correction).not.toMatch(/\b(?:below|above) the answer\b/)
    expect(result.decision.response).toEqual({ action: 'respond', content: corrected })
  })

  test('a second disagreement is posted as it is: one correction per answer', async () => {
    const { calls, result } = await run([inconsistent, inconsistent])
    expect(calls).toHaveLength(3)
    expect(result.decision.response).toEqual({ action: 'respond', content: inconsistent })
  })

  test('an answer agreeing with its display, or a view without published content, costs no extra call', async () => {
    expect((await run([corrected])).calls).toHaveLength(2)
    expect((await run([inconsistent], {})).calls).toHaveLength(2)
  })
})
