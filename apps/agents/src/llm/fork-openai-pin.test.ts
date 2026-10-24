// Fork (drjonax/leitbild, multiunit plan T0.6): what PROVIDER=openai PROVIDER_ORDER=openai really pins. The router's
// order still lists every known provider (a user order is completed in default order), so the pin is the keys: with
// only OPENAI_API_KEY, the only cloud vendor registered is OpenAI; llamacpp and Ollama are keyless local endpoints that
// serve no OpenAI model, and the system fallback chain names OpenAI models only.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL_FALLBACK, DEFAULT_MODEL_ID } from './models/catalog.ts'
import { isLocal, parseProviderConfig } from './providers-config.ts'

describe('fork OpenAI provider pin', () => {
  const config = parseProviderConfig({ env: { PROVIDER: 'openai', PROVIDER_ORDER: 'openai', OPENAI_API_KEY: 'sk-test' } })

  test('orders OpenAI first; the rest of the order is completed but unkeyed', () => {
    expect(config.order[0]).toBe('openai')
    expect(config.orderFromUser).toBe(true)
  })

  test('registers OpenAI as the only cloud vendor', () => {
    const vendors = Object.keys(config.cloud).filter(name => !isLocal(name as never))
    expect(vendors).toEqual(['openai'])
  })

  test('falls back to OpenAI models only', () => {
    expect(DEFAULT_MODEL_ID).toBe('gpt-6-luna')
    expect(DEFAULT_MODEL_FALLBACK.every(ref => ref.startsWith('openai:'))).toBe(true)
  })
})
