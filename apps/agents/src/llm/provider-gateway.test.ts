// ============================================================================
// Regression tests for createProviderGateway config merge.
//
// Bug context: production leitbild.app went silent because
//   `{ ...PROVIDER_GATEWAY_DEFAULTS, ...configOverrides }`
// where `configOverrides = { maxConcurrent: undefined }` clobbered the
// default `maxConcurrent` (=2) with undefined. The semaphore was created
// with `max=undefined`, so `active < max` was always false, every acquire
// queued, and every request timed out after 30 s with
// "LLM gateway queue timeout after 30000ms".
//
// The bug only manifested for cloud providers that didn't set explicit
// maxConcurrent in providers-config (anthropic, cerebras, groq, openrouter,
// mistral, sambanova). Gemini was fine because providers-config sets
// maxConcurrent: 3 explicitly. The user-visible symptom: "Send a message,
// nothing happens" — agents using a model whose router walked any of the
// undefined-max gateways hung for 30 s before timing out (often longer if
// the router fell through multiple).
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createProviderGateway, PROVIDER_GATEWAY_DEFAULTS } from './provider-gateway.ts'
import type { LLMProvider, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import { createAbortError } from './errors.ts'

const stubProvider = (): LLMProvider => ({
  chat: async (_req: ChatRequest): Promise<ChatResponse> =>
    ({ content: 'ok', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
  stream: async function* () { yield { delta: 'ok', done: false }; yield { delta: '', done: true } },
  models: async () => [],
  runningModels: async () => [],
})

const blockingStreamProvider = (): LLMProvider => ({
  chat: async (_req: ChatRequest): Promise<ChatResponse> =>
    ({ content: 'ok', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
  stream: async function* () {
    yield { delta: 'hold', done: false }
    await new Promise<void>(() => { /* held until caller closes iterator */ })
  },
  models: async () => [],
  runningModels: async () => [],
})

const abortAwareStreamProvider = (): LLMProvider => ({
  ...stubProvider(),
  stream: async function* (_request, signal) {
    yield { delta: 'started', done: false }
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(createAbortError())
      else signal?.addEventListener('abort', () => reject(createAbortError()), { once: true })
    })
  },
})

describe('createProviderGateway config merge', () => {
  test('undefined override does NOT clobber default (the bug)', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: undefined })
    // Pre-fix: maxConcurrent === undefined → semaphore.acquire queues forever.
    // Post-fix: defaults survive when override is undefined.
    expect(gw.getConfig().maxConcurrent).toBe(PROVIDER_GATEWAY_DEFAULTS.maxConcurrent)
    expect(typeof gw.getConfig().maxConcurrent).toBe('number')
  })

  test('omitted override falls back to default', () => {
    const gw = createProviderGateway(stubProvider(), {})
    expect(gw.getConfig().maxConcurrent).toBe(PROVIDER_GATEWAY_DEFAULTS.maxConcurrent)
  })

  test('explicit override is honored', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 7 })
    expect(gw.getConfig().maxConcurrent).toBe(7)
  })

  test('partial override merges with defaults — only the explicit field changes', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 5 })
    const cfg = gw.getConfig()
    expect(cfg.maxConcurrent).toBe(5)
    expect(cfg.queueTimeoutMs).toBe(PROVIDER_GATEWAY_DEFAULTS.queueTimeoutMs)
    expect(cfg.maxQueueDepth).toBe(PROVIDER_GATEWAY_DEFAULTS.maxQueueDepth)
  })

  test('chat() is admitted immediately when maxConcurrent is properly set (sentinel)', async () => {
    // The actual queue-timeout symptom: if the bug returns, every request
    // queues and times out after 30 s. Admission is decided when chat() is
    // called, so the request must hold a slot, not a queue place, at once —
    // however slowly a loaded machine then runs it.
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: undefined })
    const reply = gw.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(gw.getMetrics()).toMatchObject({ concurrentRequests: 1, queueDepth: 0 })
    expect((await reply).content).toBe('ok')
  })

  test('stream() honors maxQueueDepth override for immediate shed', async () => {
    const gw = createProviderGateway(blockingStreamProvider(), { maxConcurrent: 1, queueTimeoutMs: 10_000 })
    const first = gw.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })[Symbol.asyncIterator]()
    const firstChunk = await first.next()
    expect(firstChunk.value?.delta).toBe('hold')

    const second = gw.stream(
      { model: 'm', messages: [{ role: 'user', content: 'hi again' }] },
      undefined,
      { maxQueueDepth: 0 },
    )[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toThrow(/queue full/)
    await first.return?.()
  })

  test('queued stream can be cancelled without waiting for a provider slot', async () => {
    const gw = createProviderGateway(blockingStreamProvider(), { maxConcurrent: 1, queueTimeoutMs: 10_000 })
    const first = gw.stream({ model: 'm', messages: [] })[Symbol.asyncIterator]()
    await first.next()
    const controller = new AbortController()
    const queued = gw.stream({ model: 'm', messages: [] }, controller.signal)[Symbol.asyncIterator]()
    const pending = queued.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(gw.getMetrics().queueDepth).toBe(0)
    expect(gw.getMetrics().circuitState).toBe('closed')
    await first.return?.()
  })

  test('mid-stream cancellation is neutral for error rate and circuit health', async () => {
    const gw = createProviderGateway(abortAwareStreamProvider(), { maxConcurrent: 1 })
    const controller = new AbortController()
    const stream = gw.stream({ model: 'm', messages: [] }, controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value?.delta).toBe('started')
    controller.abort()
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(gw.getMetrics().errorCount).toBe(0)
    expect(gw.getMetrics().circuitState).toBe('closed')
  })

  test('refreshModels preserves stale cache but reports discovery failure', async () => {
    let fail = false
    const provider: LLMProvider = {
      ...stubProvider(),
      models: async () => {
        if (fail) throw new Error('catalog unavailable')
        return ['m']
      },
    }
    const gw = createProviderGateway(provider)
    await gw.refreshModels()
    expect(gw.getHealth().availableModels).toEqual(['m'])
    fail = true
    await expect(gw.refreshModels()).rejects.toThrow(/catalog unavailable/)
    expect(gw.getHealth().availableModels).toEqual(['m'])
  })
})

describe('updateConfig merge', () => {
  test('undefined in partial does NOT clobber existing config', () => {
    const gw = createProviderGateway(stubProvider(), { maxConcurrent: 4 })
    gw.updateConfig({ queueTimeoutMs: 10_000 } as Parameters<typeof gw.updateConfig>[0])
    expect(gw.getConfig().maxConcurrent).toBe(4)
    expect(gw.getConfig().queueTimeoutMs).toBe(10_000)
    // Calling updateConfig with explicit-undefined must not zero out fields
    // (e.g. when a partial form has empty inputs).
    gw.updateConfig({ maxConcurrent: undefined as unknown as number })
    expect(gw.getConfig().maxConcurrent).toBe(4)
  })
})
