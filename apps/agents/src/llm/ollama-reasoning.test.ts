import { expect, test } from 'bun:test'
import type { ChatRequest } from '../core/types/llm.ts'
import { createOllamaProvider } from './ollama.ts'
import { createOllamaGateway } from './gateway.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'
import { createProviderGateway } from './provider-gateway.ts'
import { createProviderRouter } from './router.ts'
import { createLLMService } from './llm-service.ts'
import { isCloudProviderError } from './errors.ts'

const fixture = async () => {
  const ollamaBodies: Record<string, unknown>[] = []
  const backupBodies: Record<string, unknown>[] = []
  let cloudCalls = 0
  const server = Bun.serve({ port: 0, fetch: async request => {
    const path = new URL(request.url).pathname
    if (path === '/cloud/models' || path === '/backup/models') return Response.json({ data: [{ id: 'shared' }] })
    if (path === '/cloud/chat/completions') { cloudCalls++; return new Response('fixture unavailable', { status: 503 }) }
    if (path === '/backup/chat/completions') {
      const body = await request.json() as Record<string, unknown>
      backupBodies.push(body)
      const answer = { role: 'assistant', content: 'answer with the requested effort' }
      return body.stream
        ? new Response([JSON.stringify({ choices: [{ delta: answer, finish_reason: 'stop' }] }), '[DONE]'].map(line => `data: ${line}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        : Response.json({ choices: [{ message: answer, finish_reason: 'stop' }] })
    }
    if (path === '/ollama/api/tags') return Response.json({ models: [{ name: 'shared' }] })
    if (path === '/ollama/api/ps') return Response.json({ models: [] })
    if (path === '/ollama/api/chat') {
      const body = await request.json() as Record<string, unknown>
      ollamaBodies.push(body)
      const result = { model: 'shared', message: { role: 'assistant', content: 'ordinary answer' }, done: true, eval_count: 2, prompt_eval_count: 3 }
      return body.stream ? new Response(`${JSON.stringify(result)}\n`) : Response.json(result)
    }
    return new Response('unexpected path', { status: 404 })
  } })
  const url = `http://localhost:${server.port}`
  const cloud = createProviderGateway(createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => `${url}/cloud`, getApiKey: () => 'fixture' }), {}, { isPermanentError: isCloudProviderError })
  const ollama = createOllamaGateway(createOllamaProvider(`${url}/ollama`), { circuitBreakerThreshold: 1 })
  // A conforming route: the OpenRouter wire carries an explicit effort or refuses it.
  const backup = createProviderGateway(createOpenAICompatibleProvider({ name: 'openrouter', getBaseUrl: () => `${url}/backup`, getApiKey: () => 'fixture' }), {}, { isPermanentError: isCloudProviderError })
  await Promise.all([cloud.refreshModels(), ollama.refreshModels(), backup.refreshModels()])
  const router = createProviderRouter({ cloud, ollama, backup }, { order: ['cloud', 'ollama', 'backup'], contextLookup: async () => ({ contextMax: 0, source: 'fixture_unknown' }) })
  return { router, ollama, ollamaBodies, backupBodies, cloudCalls: () => cloudCalls, backupCalls: () => backupBodies.length, close: () => { router.dispose(); server.stop(true) } }
}

for (const mode of ['chat', 'stream'] as const) {
  // Routes of one model: Ollama refuses the explicit effort before any I/O,
  // so the router skips it with a recorded reason and the next route that
  // carries the exact effort serves the request.
  test(`explicit effort skips Ollama after cloud failure and reaches only a route that carries it (${mode}, router fallthrough)`, async () => {
    const fx = await fixture()
    try {
      const request: ChatRequest = { model: 'shared', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high', think: true }
      const text = mode === 'chat' ? (await fx.router.chat(request)).content : (await Array.fromAsync(fx.router.stream(request))).map(chunk => chunk.delta).join('')
      expect(text).toBe('answer with the requested effort')
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.ollamaBodies).toHaveLength(0)
      expect(fx.backupBodies.map(body => body.reasoning)).toEqual([{ effort: 'high' }])
      expect(fx.ollama.getMetrics().circuitState).toBe('closed')
    } finally { fx.close() }
  })

  // The service skips an incapable fallback route, without changing the
  // request. This is the same refusal policy as the router (7f643957).
  test(`explicit effort skips incapable Ollama fallback and reaches a capable model (${mode}, service chain)`, async () => {
    const fx = await fixture()
    try {
      const provider = createLLMService({ router: fx.router }).bound({ source: 'agent', fallbackChain: ['ollama:shared', 'backup:shared'] })
      const request: ChatRequest = { model: 'cloud:shared', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high', think: true }
      const text = mode === 'chat' ? (await provider.chat(request)).content : (await Array.fromAsync(provider.stream!(request))).map(chunk => chunk.delta).join('')
      expect(text).toBe('answer with the requested effort')
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.ollamaBodies).toHaveLength(0)
      expect(fx.backupBodies.map(body => body.reasoning)).toEqual([{ effort: 'high' }])
      expect(fx.ollama.getMetrics().circuitState).toBe('closed')
    } finally { fx.close() }
  })

  test(`requested Ollama model refusal still stops the service chain (${mode})`, async () => {
    const fx = await fixture()
    try {
      const provider = createLLMService({ router: fx.router }).bound({ source: 'agent', fallbackChain: ['backup:shared'] })
      const request: ChatRequest = { model: 'ollama:shared', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high' }
      await expect(mode === 'chat' ? provider.chat(request) : Array.fromAsync(provider.stream!(request))).rejects.toThrow('reasoning_effort_unsupported')
      expect(fx.ollamaBodies).toHaveLength(0)
      expect(fx.backupCalls()).toBe(0)
      expect(fx.cloudCalls()).toBe(0)
    } finally { fx.close() }
  })

  test(`exhausted service fallback retains the actual outage, not Ollama's refusal (${mode})`, async () => {
    const fx = await fixture()
    try {
      const provider = createLLMService({ router: fx.router }).bound({ source: 'agent', fallbackChain: ['ollama:shared'] })
      const request: ChatRequest = { model: 'cloud:shared', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high' }
      await expect(mode === 'chat' ? provider.chat(request) : Array.fromAsync(provider.stream!(request))).rejects.toThrow('fixture unavailable')
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.ollamaBodies).toHaveLength(0)
      expect(fx.backupCalls()).toBe(0)
    } finally { fx.close() }
  })

  test(`ordinary think settings remain exact through real cloud-to-Ollama fallback (${mode})`, async () => {
    const fx = await fixture()
    try {
      for (const think of [undefined, false, true]) {
        const request: ChatRequest = { model: 'shared', messages: [{ role: 'user', content: 'hello' }], ...(think === undefined ? {} : { think }) }
        if (mode === 'chat') expect((await fx.router.chat(request)).content).toBe('ordinary answer')
        else expect((await Array.fromAsync(fx.router.stream(request))).some(chunk => chunk.delta.includes('ordinary answer'))).toBe(true)
        const body = fx.ollamaBodies.at(-1)!
        if (think === undefined) expect(body).not.toHaveProperty('think')
        else expect(body.think).toBe(think)
        expect(body).not.toHaveProperty('reasoningEffort')
        expect(body).not.toHaveProperty('reasoning_effort')
      }
      // After the initial fallback, the router prefers the successful local
      // provider for later calls with the same model.
      expect(fx.cloudCalls()).toBe(1)
      expect(fx.backupCalls()).toBe(0)
    } finally { fx.close() }
  })
}
