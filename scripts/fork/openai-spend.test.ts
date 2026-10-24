import { describe, expect, test } from 'bun:test'
import { assertLocalOrigin, callCostUsd, createSpendGuard, priceOf, runGuardUsd } from './openai-spend.ts'

describe('fork OpenAI spend guard', () => {
  test('prices a measured luna and sol composition as the M1.0 baseline did', () => {
    // A luna turn of 42.7k prompt tokens, 67% cached, 364 completion: about $0.002.
    expect(callCostUsd({ model: 'gpt-6-luna', promptTokens: 42_700, cacheRead: 28_600, completionTokens: 364 })).toBeCloseTo(0.0019, 4)
    expect(callCostUsd({ model: 'openai/gpt-6-sol', promptTokens: 40_100, cacheRead: 28_500, completionTokens: 369 })).toBeCloseTo(0.033, 3)
  })

  test('refuses a model without a price, so an unpriced fallback is never spent on silently', () => {
    expect(() => priceOf('kimi:moonshot-v1-8k')).toThrow('No direct OpenAI price')
    expect(() => priceOf('gpt-5.4-mini')).toThrow('No direct OpenAI price')
  })

  test('guards a luna run at $0.50 and a sol run at $2.00; the environment only lowers them', () => {
    expect(runGuardUsd(['gpt-6-luna'], undefined)).toBe(0.5)
    expect(runGuardUsd(['gpt-6-sol'], undefined)).toBe(2)
    expect(runGuardUsd(['gpt-6-luna'], '0.2')).toBe(0.2)
    expect(() => runGuardUsd(['gpt-6-luna'], '3')).toThrow('exceeds')
    expect(() => runGuardUsd(['gpt-6-luna'], '0')).toThrow('positive')
  })

  test('stops before a turn whose worst case would pass the guard', () => {
    const guard = createSpendGuard(0.5, 0.01)
    guard.add(0.485)
    expect(guard.allows()).toBe(true)
    guard.add(0.01)
    expect(guard.allows()).toBe(false)
  })

  test('never probes a deployment', () => {
    expect(assertLocalOrigin('http://127.0.0.1:43100')).toBe('http://127.0.0.1:43100')
    expect(() => assertLocalOrigin('https://leitbild.app')).toThrow('loopback')
  })
})
