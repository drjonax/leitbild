import { describe, expect, test } from 'bun:test'
import { parseModelCall, parseModelCalls, summariseCalls } from './billing.ts'

// Lines as the local stack's Agents wrote them on 20 Oct 2026 (llm-service.ts logLine).
const billed = '[llm] source=agent path=stream provider=openrouter model=gpt-6-sol content_len=0 tools=1 prompt_tokens=8378 completion_tokens=56 cache_read=0 cache_write=8375 cache_miss=? chunks_emit=0 duration_ms=4747 generation=gen-1792504851-HXuXRbZVGvRWJ0Kql44w upstream=OpenAI cost_usd=0.0215035'
const unbilled = '[llm] source=agent path=chat provider=? model=kimi:moonshot-v1-8k content_len=24 tools=0 prompt_tokens=1 completion_tokens=1 cache_read=? cache_write=? cache_miss=? chunks_emit=? duration_ms=0'

describe('Agents log billing', () => {
  test('reads OpenRouter\'s generation id, upstream and billed cost from a call line', () => {
    expect(parseModelCall(billed)).toEqual({
      source: 'agent', path: 'stream', provider: 'openrouter', model: 'gpt-6-sol', toolCalls: 1,
      promptTokens: 8378, completionTokens: 56, cacheRead: 0, cacheWrite: 8375, durationMs: 4747,
      generationId: 'gen-1792504851-HXuXRbZVGvRWJ0Kql44w', upstream: 'OpenAI', costUsd: 0.0215035,
    })
  })

  test('a call without a billed cost is counted as unbilled, never priced at zero silently', () => {
    const calls = parseModelCalls(['Leitbild v0.6.0', billed, unbilled, ''].join('\n'))
    expect(calls).toHaveLength(2)
    expect(summariseCalls(calls)).toEqual({ calls: 2, costUsd: 0.0215035, unbilledCalls: 1, upstreams: ['OpenAI', 'unknown'], models: ['gpt-6-sol', 'kimi:moonshot-v1-8k'] })
  })

  test('an [llm] line in another format fails loudly', () => {
    expect(() => parseModelCall('[llm] something else entirely')).toThrow('Unrecognised')
  })
})
