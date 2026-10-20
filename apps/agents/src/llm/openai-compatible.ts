// ============================================================================
// OpenAI-compatible provider — Groq, Cerebras, OpenRouter, Mistral, SambaNova.
//
// All five providers speak the OpenAI Chat Completions API. This adapter
// converts leitbild's ChatRequest/ChatResponse to/from OpenAI format, handles
// incremental tool-call accumulation in streaming, and maps HTTP failure
// modes to typed CloudProviderError variants (rate_limit, quota, auth,
// provider_down) so the router can decide whether to fall through.
//
// Behaviour specific to individual providers (e.g. OpenRouter's ":free"
// model slugs, DeepSeek R1's <think>...</think> content stream) is handled
// here rather than requiring per-provider subclasses.
// ============================================================================

import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, ProviderContinuation, GenerationBilling } from '../core/types/llm.ts'
import type { ModelInfo } from '../core/types/model-info.ts'
import { createHash } from 'node:crypto'
import type { NativeToolCall } from '../core/types/tool.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'
import { createCloudProviderError, createLLMRequestError } from './errors.ts'
import { mapHttpError } from './openai-compatible-errors.ts'
import { type OAIMessage, buildOAIBody } from './openai-compatible-wire.ts'
import { fetchWithTimeout } from '../core/fetch-utils.ts'
import {
  normalizeModelId,
  expandAnthropicAliases,
  expandOpenRouterOpenAIAliases,
} from './models/normalize.ts'

const DEFAULT_CHAT_TIMEOUT_MS = 300_000
const DEFAULT_MODELS_TIMEOUT_MS = 10_000
// Two-tier idle handling: warn the user at warnMs (emits a slowWarning
// StreamChunk, does NOT abort) so they know the provider is slow and
// can intervene with the existing Stop button; hard-abort at hardMs so
// a genuinely dead stream still eventually fails over to the next
// provider via the router. Pre-PR-2 there was a single 60s threshold
// that silently aborted with no user-visible explanation.
const DEFAULT_STREAM_SLOW_WARN_MS = 30_000
const DEFAULT_STREAM_HARD_ABORT_MS = 180_000
// Hard cap on the SSE re-assembly buffer. Frames are normally a few KB; a
// runaway provider sending one giant unterminated `data:` line would otherwise
// grow this buffer without bound. 10 MB is well above any legitimate frame
// and small enough to fail loud rather than OOM the process.
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024

// === Config ===

export interface OpenAICompatConfig {
  readonly name: string                  // logical provider name, e.g. "groq"
  // Resolved lazily so runtime URL changes (PUT /api/providers/:name with
  // baseUrl) take effect on the next request without recreating the provider
  // or its gateway. Mirrors `getApiKey`.
  readonly getBaseUrl: () => string
  // Resolved lazily so runtime key changes take effect without restart.
  readonly getApiKey: () => string
  // Optional: replace the default `Authorization: Bearer <key>` auth with
  // provider-specific headers. Anthropic, for example, rejects Bearer and
  // requires `x-api-key` + `anthropic-version`. Returning an empty object is
  // allowed (no auth headers at all).
  readonly authHeaders?: () => Record<string, string>
  // Optional extra non-auth headers (no current callers — kept for future).
  readonly extraHeaders?: () => Record<string, string>
  readonly chatTimeoutMs?: number
  readonly modelsTimeoutMs?: number
  // Two-tier idle thresholds. `warn` emits a slowWarning chunk and
  // continues waiting; `hard` aborts the stream so the router can
  // fail over. Tests can shorten both.
  readonly streamSlowWarnMs?: number
  readonly streamHardAbortMs?: number
  // Optional process-global counters; when present, SSE-buffer overflow is
  // tracked. Tests omit.
  readonly limitMetrics?: LimitMetrics
}

// === OpenAI wire types ===

// Anthropic's OpenAI-compat endpoint accepts an array of content parts on a
// message, where each part can carry a `cache_control` marker. We only emit
// this shape when talking to Anthropic; other providers continue to get a
// plain string in `content`.

interface OAIChatResponse {
  id?: string
  model?: string
  // OpenRouter: the upstream provider that served the generation.
  provider?: unknown
  choices: ReadonlyArray<{
    message: OAIMessage
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // OpenRouter: what it billed for the generation, in USD.
    cost?: unknown
    // Anthropic-specific. Passed through when present.
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    // OpenAI-standard cache hit count (Gemini's OAI-compat shim emits this
    // for implicit prompt caching on Gemini 2.5 family). When set on a
    // response, the listed token count was billed at the cached rate.
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    cached_tokens?: number
    total_cached_tokens?: number
  }
}

interface OAIStreamChunk {
  id?: unknown
  model?: string
  provider?: unknown
  choices?: ReadonlyArray<{
    delta?: {
      content?: string
      // Reasoning/thinking channel emitted by some OAI-compat providers
      // (Kimi/Moonshot, DeepSeek-R1, Qwen QwQ, etc.) BEFORE the final
      // content. Routed into Leitbild's thinking pane via StreamChunk.thinking;
      // never round-tripped into outbound history.
      reasoning_content?: string
      // Same channel under an alternate field name (OpenAI's o-series
      // exposes it as `reasoning` in some shapes). Treat identically.
      reasoning?: string
      reasoning_details?: ReadonlyArray<Readonly<Record<string, unknown>>>
      tool_calls?: ReadonlyArray<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: unknown
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
    }
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    cached_tokens?: number
    total_cached_tokens?: number
  }
}

interface OAIModelsResponse {
  data?: ReadonlyArray<{
    id: string
    context_length?: number | null
    top_provider?: { max_completion_tokens?: number | null } | null
    supported_parameters?: ReadonlyArray<string>
    reasoning?: { supported_efforts?: ReadonlyArray<string> | null; mandatory?: boolean; default_effort?: string }
  }>
}

// === Error mapping ===
// HTTP-status → CloudProviderError classification moved to
// ./openai-compatible-errors.ts.
// Imported at the top of this file. Not re-exported: no caller outside
// this module needed it (knip-confirmed during item #4 triage).

// === Cache-marker helper ===
// Spread-clones the array AND its last entry, attaches `cache_control:
// ephemeral` to the cloned tail entry, and returns a new array. Pure and
// non-mutating — safe to use on a `ChatRequest.tools` reference shared with
// the router's failover path. Aliasing risk is the load-bearing concern
// here: an in-place mutation would leak the marker into a subsequent
// failover call to a non-Anthropic provider whose OpenAI-compat shim may
// reject the unknown field.

// Some providers (DeepSeek R1 via OpenRouter) emit chain-of-thought inside
// <think>...</think> in the content stream, without a dedicated "thinking"
// field. We pull those out into StreamChunk.thinking to keep leitbild's
// thinking-indicator UX working.
// OpenRouter's record of a generation from the fields its response carries.
// A field of the wrong type is left out, so the log never shows a guess.
const openRouterBilling = (id: unknown, upstream: unknown, cost: unknown): GenerationBilling | undefined => {
  const billing: GenerationBilling = {
    ...(typeof id === 'string' && id.length > 0 ? { generationId: id } : {}),
    ...(typeof upstream === 'string' && upstream.length > 0 ? { upstreamProvider: upstream } : {}),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  }
  return Object.keys(billing).length === 0 ? undefined : billing
}

const splitThinkAndContent = (raw: string): { thinking: string; content: string } => {
  let thinking = ''
  let content = ''
  let cursor = 0
  const openRe = /<think>/gi
  while (cursor < raw.length) {
    openRe.lastIndex = cursor
    const open = openRe.exec(raw)
    if (!open) {
      content += raw.slice(cursor)
      break
    }
    content += raw.slice(cursor, open.index)
    const closeIdx = raw.indexOf('</think>', open.index + open[0].length)
    if (closeIdx === -1) {
      thinking += raw.slice(open.index + open[0].length)
      break
    }
    thinking += raw.slice(open.index + open[0].length, closeIdx)
    cursor = closeIdx + '</think>'.length
  }
  return { thinking, content }
}

// === Factory ===

export const createOpenAICompatibleProvider = (config: OpenAICompatConfig): LLMProvider => {
  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  const modelsTimeoutMs = config.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS
  const streamSlowWarnMs = config.streamSlowWarnMs ?? DEFAULT_STREAM_SLOW_WARN_MS
  const streamHardAbortMs = config.streamHardAbortMs ?? DEFAULT_STREAM_HARD_ABORT_MS

  // Anthropic ships dated canonical ids in /models (`claude-haiku-4-5-20251001`)
  // but the curated UI list and agents carry the bare alias (`claude-haiku-4-5`).
  // We publish BOTH forms in `models()` so the router's exact-match filter
  // accepts the alias, then translate alias→canonical at request time so the
  // wire payload uses the id Anthropic's API actually accepts. Empty until
  // the first models() resolves; chat()/stream() before that point fall
  // through identity (the request was always going to fail or hit a different
  // provider anyway).
  let modelAliasMap: ReadonlyMap<string, string> = new Map()
  let modelInfoMap: ReadonlyMap<string, ModelInfo> = new Map()
  let catalogLoaded = false
  let catalogRefreshedAt = 0
  let catalogRetryAt = 0
  let catalogInFlight: Promise<string[]> | undefined
  let catalogEndpoint = config.getBaseUrl()
  const endpoint = (): { url: string; hash: string } => {
    const url = config.getBaseUrl()
    if (url !== catalogEndpoint) {
      modelAliasMap = new Map()
      modelInfoMap = new Map()
      catalogLoaded = false
      catalogRefreshedAt = 0
      catalogRetryAt = 0
      catalogInFlight = undefined
      catalogEndpoint = url
    }
    return { url, hash: createHash('sha256').update(url).digest('hex') }
  }

  const continuationFor = (request: ChatRequest, endpointHash: string, details: OAIMessage['reasoning_details'], reasoning: string | undefined): ProviderContinuation | undefined => {
    if (config.name !== 'openrouter') return undefined
    if (details != null && (!Array.isArray(details) || details.some(detail => !detail || typeof detail !== 'object' || Array.isArray(detail)))) throw createLLMRequestError('invalid_provider_continuation', 'Invalid OpenRouter reasoning_details response')
    if (reasoning !== undefined && typeof reasoning !== 'string') throw createLLMRequestError('invalid_provider_continuation', 'Invalid OpenRouter reasoning response')
    if (!details?.length && reasoning === undefined) return undefined
    return {
      provider: 'openrouter', model: request.model, endpointHash,
      ...(details?.length ? { reasoningDetails: details } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }

  const checkContinuationEndpoint = (request: ChatRequest, hash: string): void => {
    for (const message of request.messages) {
      if (message.continuation && message.continuation.endpointHash !== hash) throw createLLMRequestError('provider_continuation_endpoint_changed', 'provider_continuation_endpoint_changed: cannot replay provider state after changing its endpoint')
    }
  }

  const resolveWireModel = (model: string): string => {
    if (config.name !== 'anthropic' && config.name !== 'openrouter') return model
    return modelAliasMap.get(model) ?? model
  }

  const headers = (): Record<string, string> => {
    const key = config.getApiKey()
    const auth = config.authHeaders
      ? config.authHeaders()
      : { Authorization: `Bearer ${key}` }
    return {
      'Content-Type': 'application/json',
      ...auth,
      ...(config.extraHeaders?.() ?? {}),
    }
  }

  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const startMs = performance.now()
    const target = endpoint()
    const wireRequest = { ...request, model: resolveWireModel(request.model) }
    checkContinuationEndpoint(wireRequest, target.hash)
    const info = modelInfoMap.get(wireRequest.model)
    if (request.reasoningEffort !== undefined && info?.reasoning?.supportedEfforts === undefined) console.warn(`[${config.name}] reasoning effort ${request.reasoningEffort} requested for ${wireRequest.model}; supported efforts are not advertised, provider will validate`)
    const body = buildOAIBody(wireRequest, false, config.name, info)

    const response = await fetchWithTimeout(
      `${target.url}/chat/completions`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) },
      chatTimeoutMs,
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const data = (await response.json()) as OAIChatResponse
    const choice = data.choices?.[0]
    if (!choice) {
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name}: empty choices array`,
        status: response.status,
      })
    }

    // Anthropic's OAI-compat response returns content as either a plain
    // string or an array of content parts. Normalise to string.
    const rawContentRaw = choice.message.content
    const rawContent: string = typeof rawContentRaw === 'string'
      ? rawContentRaw
      : Array.isArray(rawContentRaw)
        ? rawContentRaw.filter(p => p.type === 'text').map(p => p.text).join('')
        : ''
    const { thinking, content } = splitThinkAndContent(rawContent)
    void thinking // thinking in non-streaming is discarded — leitbild only surfaces it during streaming
    // OpenRouter protocol continuation is separate from readable content.
    // Preserve its original sequence; never synthesize a reasoning transcript.
    const continuation = choice.finish_reason === 'length' ? undefined : continuationFor({ ...wireRequest, model: data.model || wireRequest.model }, target.hash,
      choice.message.reasoning_details, choice.message.reasoning ?? choice.message.reasoning_content ?? undefined)

    const toolCalls: NativeToolCall[] | undefined = choice.finish_reason !== 'length' && choice.message.tool_calls?.length
      ? choice.message.tool_calls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: parseArgs(tc.function.arguments, config.name, tc.function.name),
          },
        }))
      : undefined

    const generationMs = Math.round(performance.now() - startMs)
    const cacheCreation = data.usage?.cache_creation_input_tokens
      ?? data.usage?.prompt_tokens_details?.cache_write_tokens
    // cacheRead is filled by Anthropic's `cache_read_input_tokens` OR the
    // OpenAI-standard `prompt_tokens_details.cached_tokens` (Gemini emits
    // this for implicit caching on the 2.5 family). Take whichever is
    // present so a single `cacheRead` field stays the cross-provider truth.
    const cacheRead = data.usage?.cache_read_input_tokens
      ?? data.usage?.prompt_tokens_details?.cached_tokens
      ?? data.usage?.prompt_cache_hit_tokens
      ?? data.usage?.cached_tokens
      ?? data.usage?.total_cached_tokens
    const cacheMiss = data.usage?.prompt_cache_miss_tokens
    const billing = config.name === 'openrouter' ? openRouterBilling(data.id, data.provider, data.usage?.cost) : undefined
    return {
      content,
      model: data.model || wireRequest.model,
      generationMs,
      tokensUsed: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        ...(cacheCreation !== undefined ? { cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheMiss !== undefined ? { cacheMiss } : {}),
      },
      toolCalls,
      ...(continuation ? { continuation } : {}),
      ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
      ...(billing ? { billing } : {}),
    }
  }

  const stream = async function* (request: ChatRequest, externalSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    const target = endpoint()
    const wireRequest = { ...request, model: resolveWireModel(request.model) }
    checkContinuationEndpoint(wireRequest, target.hash)
    const info = modelInfoMap.get(wireRequest.model)
    if (request.reasoningEffort !== undefined && info?.reasoning?.supportedEfforts === undefined) console.warn(`[${config.name}] reasoning effort ${request.reasoningEffort} requested for ${wireRequest.model}; supported efforts are not advertised, provider will validate`)
    const body = buildOAIBody(wireRequest, true, config.name, info)

    const controller = new AbortController()
    // Hard-abort timer — fires only if the stream is genuinely dead for
    // streamHardAbortMs. Reset on every chunk arrival. The earlier warn
    // tier (raced against reader.read below) handles user notification.
    let hardAbortTimer = setTimeout(() => controller.abort(), streamHardAbortMs)
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const response = await fetch(`${target.url}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      clearTimeout(hardAbortTimer)
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const reader = response.body?.getReader()
    if (!reader) {
      clearTimeout(hardAbortTimer)
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name} stream: no response body`,
      })
    }

    const decoder = new TextDecoder()
    let buffer = ''
    // Accumulators for incremental tool calls (OpenAI streams arguments as fragments).
    const toolAccum: Array<{ id?: string; name: string; argsBuffer: string }> = []
    // Accumulator for <think> block spanning chunks.
    let inThink = false
    let thinkCarry = ''

    const flushDelta = (delta: string): StreamChunk | null => {
      if (!delta) return null
      let thinkingOut = ''
      let contentOut = ''
      let cursor = 0
      while (cursor < delta.length) {
        if (inThink) {
          const close = delta.indexOf('</think>', cursor)
          if (close === -1) {
            thinkingOut += delta.slice(cursor)
            break
          }
          thinkingOut += delta.slice(cursor, close)
          inThink = false
          cursor = close + '</think>'.length
        } else {
          const combined = thinkCarry + delta.slice(cursor)
          const openIdx = combined.indexOf('<think>')
          if (openIdx === -1) {
            // Possible partial "<think" at tail — keep up to 6 chars as carry.
            const safe = combined.length - 6
            if (safe > 0) {
              contentOut += combined.slice(0, safe)
              thinkCarry = combined.slice(safe)
            } else {
              thinkCarry = combined
            }
            break
          }
          contentOut += combined.slice(0, openIdx)
          thinkCarry = ''
          inThink = true
          cursor = delta.length - (combined.length - (openIdx + '<think>'.length))
        }
      }
      if (!thinkingOut && !contentOut) return null
      const out: StreamChunk = { delta: contentOut, done: false }
      if (thinkingOut) (out as { thinking?: string }).thinking = thinkingOut
      return out
    }

    // Accumulators for final-chunk metadata (finish_reason may arrive before
    // [DONE]; usage typically arrives AFTER finish_reason but BEFORE [DONE]).
    let finishReason: string | undefined
    let actualModel = wireRequest.model
    const reasoningDetails: Array<Readonly<Record<string, unknown>>> = []
    let reasoning: string | undefined
    let usageTokens: { prompt: number; completion: number; cacheCreation?: number; cacheRead?: number; cacheMiss?: number } | undefined
    let generationId: unknown
    let upstreamProvider: unknown
    let billedCost: unknown

    const emitFinal = (): StreamChunk => {
      const toolCalls: NativeToolCall[] | undefined = finishReason !== 'length' && toolAccum.length
        ? toolAccum.map((t, index) => ({
            id: t.id ?? `call_${index}`,
            function: { name: t.name, arguments: parseArgs(t.argsBuffer, config.name, t.name) },
          }))
        : undefined
      const continuation = finishReason === 'length' ? undefined : continuationFor({ ...wireRequest, model: actualModel }, target.hash, reasoningDetails, reasoning)
      const billing = config.name === 'openrouter' ? openRouterBilling(generationId, upstreamProvider, billedCost) : undefined
      const chunk: StreamChunk = {
        delta: '', done: true,
        ...(toolCalls ? { toolCalls } : {}),
        ...(usageTokens ? { tokensUsed: usageTokens } : {}),
        provider: config.name,
        model: actualModel,
        ...(continuation ? { continuation } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(billing ? { billing } : {}),
      }
      return chunk
    }

    // Race read vs warn timer. The Web Streams API forbids overlapping
    // .read() calls on a locked reader, so we keep ONE pending read across
    // a race-loss and re-await it on the next iteration. `warnEmitted`
    // resets after each real chunk so a subsequent gap can warn again
    // (e.g. provider stalls, recovers, stalls).
    let pendingRead: Promise<{ done: boolean; value: Uint8Array | undefined }> | null = null
    let warnEmitted = false
    let lastChunkAt = Date.now()

    try {
      while (true) {
        clearTimeout(hardAbortTimer)
        hardAbortTimer = setTimeout(() => controller.abort(), streamHardAbortMs)
        if (!pendingRead) pendingRead = reader.read()

        type ReadResult = { done: boolean; value: Uint8Array | undefined }
        let raceResult: ReadResult | 'warn'
        if (!warnEmitted) {
          const sinceLast = Date.now() - lastChunkAt
          const remainingToWarn = Math.max(0, streamSlowWarnMs - sinceLast)
          raceResult = await Promise.race([
            pendingRead,
            new Promise<'warn'>(r => setTimeout(() => r('warn'), remainingToWarn)),
          ])
        } else {
          raceResult = await pendingRead
        }

        if (raceResult === 'warn') {
          warnEmitted = true
          yield {
            delta: '', done: false,
            slowWarning: { elapsedMs: Date.now() - lastChunkAt, provider: config.name },
          }
          continue  // pendingRead still pending — loop awaits it again
        }

        // Real read settled.
        pendingRead = null
        const { done, value } = raceResult
        if (done) break
        lastChunkAt = Date.now()
        warnEmitted = false
        buffer += decoder.decode(value, { stream: true })

        // Bound the unframed buffer. Treat as a recoverable provider issue
        // (fallbackable) so the router can try the next provider.
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          config.limitMetrics?.inc('sseBufferExceeded')
          throw createCloudProviderError({
            code: 'provider_down',
            provider: config.name,
            message: `${config.name} stream: buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame boundary`,
          })
        }

        // SSE: split on double-newline frames.
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          sep = buffer.indexOf('\n\n')

          // Each frame may have multiple "data:" lines.
          const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
          for (const payload of dataLines) {
            if (payload === '[DONE]') {
              if (thinkCarry) { yield { delta: thinkCarry, done: false }; thinkCarry = '' }
              yield emitFinal()
              return
            }
            let parsed: OAIStreamChunk
            try { parsed = JSON.parse(payload) } catch { continue }
            if (typeof parsed.model === 'string' && parsed.model.length > 0) actualModel = parsed.model
            if (parsed.id !== undefined) generationId = parsed.id
            if (parsed.provider !== undefined) upstreamProvider = parsed.provider

            // Final usage frame (OpenAI with include_usage: true; Groq,
            // Cerebras follow the same convention). The frame carries an
            // empty choices array + a `usage` field.
            if (parsed.usage && (parsed.usage.prompt_tokens !== undefined || parsed.usage.completion_tokens !== undefined)) {
              billedCost = parsed.usage.cost
              const cacheReadCount = parsed.usage.cache_read_input_tokens
                ?? parsed.usage.prompt_tokens_details?.cached_tokens
                ?? parsed.usage.prompt_cache_hit_tokens
                ?? parsed.usage.cached_tokens
                ?? parsed.usage.total_cached_tokens
              const cacheCreationCount = parsed.usage.cache_creation_input_tokens
                ?? parsed.usage.prompt_tokens_details?.cache_write_tokens
              usageTokens = {
                prompt: parsed.usage.prompt_tokens ?? 0,
                completion: parsed.usage.completion_tokens ?? 0,
                ...(cacheCreationCount !== undefined ? { cacheCreation: cacheCreationCount } : {}),
                ...(cacheReadCount !== undefined ? { cacheRead: cacheReadCount } : {}),
                ...(parsed.usage.prompt_cache_miss_tokens !== undefined ? { cacheMiss: parsed.usage.prompt_cache_miss_tokens } : {}),
              }
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            // Native reasoning channel (Kimi, DeepSeek, etc.) — surface as
            // thinking BEFORE content for this frame so the UI sees reasoning
            // arrive in its natural order. The `<think>` text-embedded parser
            // is disjoint from this field, so both can coexist (e.g. DeepSeek
            // historically emitted both). Both routes feed the same channel.
            const deltaReasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? ''
            if (config.name === 'openrouter') {
              const details = choice.delta?.reasoning_details
              if (details != null) {
                if (!Array.isArray(details) || details.some(detail => !detail || typeof detail !== 'object' || Array.isArray(detail))) throw createLLMRequestError('invalid_provider_continuation', 'Invalid OpenRouter reasoning_details stream')
                // OpenRouter specifies concatenation in original arrival order,
                // not grouping or overwriting blocks by index/signature/type.
                reasoningDetails.push(...details)
              }
              const originalReasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content
              if (originalReasoning != null) {
                if (typeof originalReasoning !== 'string') throw createLLMRequestError('invalid_provider_continuation', 'Invalid OpenRouter reasoning stream')
                reasoning = (reasoning ?? '') + originalReasoning
              }
            }
            if (deltaReasoning) {
              yield { delta: '', thinking: deltaReasoning, done: false }
            }

            const deltaContent = choice.delta?.content ?? ''
            if (deltaContent) {
              const chunk = flushDelta(deltaContent)
              if (chunk) yield chunk
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                // Accumulator slot resolution:
                //   1. Explicit `index` (OpenAI / Groq / Cerebras spec).
                //   2. Existing slot with matching `id` (some providers).
                //   3. No index, no id (Gemini via OpenAI-compat): stay on the
                //      last slot unless its buffer is already a complete JSON
                //      object AND the incoming fragment starts a fresh one —
                //      which indicates a distinct parallel tool call. Without
                //      this split, two `web_search` calls get concatenated into
                //      `{...}{...}` which fails JSON.parse.
                let idx: number
                if (typeof tc.index === 'number') {
                  idx = tc.index
                } else if (tc.id) {
                  const existing = toolAccum.findIndex(s => s?.id === tc.id)
                  idx = existing >= 0 ? existing : toolAccum.length
                } else {
                  idx = Math.max(0, toolAccum.length - 1)
                  const incomingArgs = tc.function?.arguments?.trim() ?? ''
                  const current = toolAccum[idx]?.argsBuffer.trim() ?? ''
                  if (incomingArgs.startsWith('{') && current.length > 0) {
                    try {
                      JSON.parse(current)
                      // Current slot is a complete JSON object; incoming starts
                      // a new object → it's a new tool call.
                      idx = toolAccum.length
                    } catch { /* still mid-object, keep accumulating */ }
                  }
                }
                if (!toolAccum[idx]) toolAccum[idx] = { name: '', argsBuffer: '' }
                const acc = toolAccum[idx]!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.argsBuffer += tc.function.arguments
              }
            }

            if (choice.finish_reason) {
              // Mark finish but don't emit yet — wait one more frame in case
              // usage arrives (it typically does on a subsequent SSE event).
              finishReason = choice.finish_reason
            }
          }
        }
      }
      // Reader closed. Emit final chunk with whatever we've accumulated.
      if (thinkCarry) yield { delta: thinkCarry, done: false }
      yield emitFinal()
    } finally {
      clearTimeout(hardAbortTimer)
      reader.releaseLock()
    }
  }

  const fetchModels = async (): Promise<string[]> => {
    const target = endpoint()
    const response = await fetchWithTimeout(
      `${target.url}/models`,
      { headers: headers() },
      modelsTimeoutMs,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }
    const data = (await response.json()) as OAIModelsResponse
    if (endpoint().url !== target.url) throw new Error('Provider endpoint changed while loading model metadata')
    const info = new Map<string, ModelInfo>()
    for (const row of data.data ?? []) {
      const id = normalizeModelId(config.name, row.id)
      const capacity = Number.isSafeInteger(row.context_length) && row.context_length! > 0 ? row.context_length! : undefined
      const output = Number.isSafeInteger(row.top_provider?.max_completion_tokens) && row.top_provider!.max_completion_tokens! > 0 ? row.top_provider!.max_completion_tokens! : undefined
      const parameters = Array.isArray(row.supported_parameters) && row.supported_parameters.every(value => typeof value === 'string') ? row.supported_parameters : undefined
      const rawEfforts = row.reasoning?.supported_efforts
      const efforts = rawEfforts === null || (Array.isArray(rawEfforts) && rawEfforts.every(value => typeof value === 'string')) ? rawEfforts : undefined
      if ((row.context_length != null && capacity === undefined) || (row.top_provider?.max_completion_tokens != null && output === undefined) || (row.supported_parameters !== undefined && parameters === undefined) || (rawEfforts !== undefined && efforts === undefined)) {
        console.warn(`[${config.name}] Invalid capability metadata for ${id}; unrecognized fields remain unknown, model availability is unchanged`)
      }
      info.set(id, {
        id, provider: config.name, contextMax: capacity ?? 0, source: `${config.name}_api`,
        ...(output != null ? { maxOutputTokens: output } : {}),
        ...(parameters ? { supportedParameters: parameters } : {}),
        ...(row.reasoning ? { reasoning: {
          ...(efforts !== undefined ? { supportedEfforts: efforts } : {}),
          ...(typeof row.reasoning.mandatory === 'boolean' ? { mandatory: row.reasoning.mandatory } : {}),
          ...(typeof row.reasoning.default_effort === 'string' ? { defaultEffort: row.reasoning.default_effort } : {}),
        } } : {}),
      })
    }
    // Provider-specific id normalization (e.g. strip Gemini's "models/" prefix
    // so the catalog matches user-facing names). Single place for these quirks:
    // src/llm/models/normalize.ts. See that file for the full bug story.
    const ids = (data.data ?? []).map(m => normalizeModelId(config.name, m.id))
    catalogRefreshedAt = Date.now()
    catalogRetryAt = 0
    if (config.name === 'anthropic') {
      const { expanded, aliasMap } = expandAnthropicAliases(ids)
      modelAliasMap = aliasMap
      modelInfoMap = info
      catalogLoaded = true
      return [...expanded]
    }
    if (config.name === 'openrouter') {
      const { expanded, aliasMap } = expandOpenRouterOpenAIAliases(ids)
      modelAliasMap = aliasMap
      modelInfoMap = info
      catalogLoaded = true
      return [...expanded]
    }
    modelInfoMap = info
    catalogLoaded = true
    return ids
  }

  // One inventory, not a per-model negative cache. Explicit models() callers
  // refresh it; simultaneous catalog/metadata consumers share the same request.
  const models = (): Promise<string[]> => {
    const url = endpoint().url
    if (catalogInFlight) return catalogInFlight
    const pending = fetchModels().catch(error => {
      if (endpoint().url === url) catalogRetryAt = Date.now() + 30_000
      throw error
    }).finally(() => {
      if (catalogInFlight === pending) catalogInFlight = undefined
    })
    catalogInFlight = pending
    return pending
  }

  const modelInfo = async (model: string): Promise<ModelInfo> => {
    endpoint()
    if (Date.now() < catalogRetryAt) return { id: model, provider: config.name, contextMax: 0, source: `${config.name}_api_unavailable` }
    // A shared five-minute inventory lifetime also bounds unknown IDs. A UI
    // catalog with many curated absent IDs must not trigger one fetch per ID.
    if (!catalogLoaded || Date.now() - catalogRefreshedAt >= 300_000) {
      try { await models() }
      catch {
        console.warn(`[${config.name}] Model metadata unavailable; capacity and reasoning support remain unknown until a later catalog refresh`)
        return { id: model, provider: config.name, contextMax: 0, source: `${config.name}_api_unavailable` }
      }
    }
    const id = resolveWireModel(model)
    return modelInfoMap.get(id) ?? { id, provider: config.name, contextMax: 0, source: `${config.name}_api_unknown_model` }
  }

  return { chat, stream, models, modelInfo }
}

// OpenAI tool_call.function.arguments is a JSON string. Ollama passes an object.
// A malformed proposal must never become a valid default-argument action.
// Fail before dispatch; do not route the proposal through another model.
const parseArgs = (raw: string, provider?: string, toolName?: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch { throw createLLMRequestError('invalid_tool_arguments', `${provider ?? 'cloud'} returned malformed JSON arguments for ${toolName ?? '<unknown>'}; no call was dispatched`) }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw createLLMRequestError('invalid_tool_arguments', `${provider ?? 'cloud'} returned non-object arguments for ${toolName ?? '<unknown>'}; no call was dispatched`)
  return parsed as Record<string, unknown>
}
