// ============================================================================
// LLMService — single gateway every LLM call goes through.
//
// Wraps the ProviderRouter with the cross-cutting policy that every consumer
// (agents, summary, whisper, callSystemLLM) needs:
//
//   1. Pre-call cooldown skip — consult the live monitor snapshot. If the
//      primary's provider is in `backoff` with retryAt > now+1s, route to
//      the first chain element instead of the doomed primary.
//
//   2. Walk-on-fallbackable — single source of truth for the agent-level
//      fallbackable codes. On a transient/account-state error, advance to
//      the next chain element. A fallback element that refuses the request
//      shape is skipped and never becomes the reported failure.
//
//   3. One network-only retry per chain element on bare network errors
//      (ECONNRESET / ETIMEDOUT / EPIPE / generic "fetch failed"). Classified
//      provider errors (auth, rate_limit, quota, etc.) advance immediately.
//
//   4. Stream-content normalisation — strips <think>...</think> blocks so
//      consumers never see internal reasoning leakage.
//
//   5. Structured observability — one `[llm]` log line per call with source,
//      provider, model, tokens, cache_read, duration.
//
//   6. Chain-switch signalling — fires opts.onChainSwitch each time the
//      service advances to a new chain element. Reuses the existing
//      model_fallback event shape at the agent layer.
//
// Surface: a single entry point, `bound(opts)`, returns a standard
// LLMProvider with source/agentId/onChainSwitch baked in. There is NO bare
// chat/stream/models on LLMService — every call must go through `bound()`,
// which forces every site to declare its source.
//
// Chain resolution priority:
//   per-call override   — opts.fallbackChain (rare, code-only)
//   system default      — getSystemChain() at request time (live policy)
//
// Per-call override wins; empty array means "primary only — do not walk".
// An empty system chain means the same: the Providers panel documents it as
// disabling automatic cross-provider recovery, so no chain is derived from
// provider catalogs and model identity holds unless an operator chose one.
// ============================================================================

import type { ChatRequest, ChatResponse, GenerationBilling, LLMProvider, StreamChunk } from '../core/types/llm.ts'
import type { ProviderRouter, RouterCallOptions } from './router.ts'
import type { MonitorState } from './provider-monitor.ts'
import { parsePrefixedModel } from './models/parse-prefix.ts'
import { isAgentFallbackable as classifyIsAgentFallbackable } from '../agents/error-classify.ts'
import { createLLMRequestError, isAbortError, isRouteRefusal } from './errors.ts'

// === Source tagging — every call site declares its identity ===

export type LLMSource = 'agent' | 'comparison' | 'summary' | 'whisper' | 'system'

// === Codes that warrant advancing to the next chain element ===
// Single source of truth. Includes `model_unavailable` because cross-provider
// chains hit different account state (Anthropic credit-out, OpenAI plan-
// restricted model) which the next provider may not share.
export const FALLBACKABLE_AGENT_CODES: ReadonlySet<string> = new Set([
  'rate_limited', 'provider_down', 'network', 'model_unavailable',
])

// === Bind options ===

export interface LLMServiceBindOptions {
  readonly source: LLMSource
  readonly agentId?: string | null
  // Fired once per chain advance. Reused by the agent layer to emit the
  // existing `model_fallback` EvalEvent kind.
  readonly onChainSwitch?: (preferred: string, effective: string, reason: string) => void
  // Per-call-site override. Empty array disables chain walk entirely;
  // undefined falls through to the system default chain.
  readonly fallbackChain?: ReadonlyArray<string>
}

// === Service ===

export interface LLMService {
  // Returns a standard LLMProvider with the supplied options baked in. All
  // resilience (cooldown skip, chain walk, network retry, content strip,
  // observability) is automatic on the returned provider's chat/stream.
  readonly bound: (opts: LLMServiceBindOptions) => LLMProvider
}

// === Implementation ===

// 1s sweet spot for "primary is in cooldown and won't recover before we'd
// finish setting up the wire call." Longer than typical network RTT
// (50-200ms) so we don't race the cooldown expiry; shorter than typical
// short-cooldown windows (e.g. provider says "retry in 5s") so we don't
// waste a fallback-chain step when the primary is about to come back.
const COOLDOWN_SKIP_GUARD_MS = 1_000
// 250ms quiet retry on bare network errors (DNS hiccup, connection reset).
// Single retry; classified provider errors (CloudProviderError, etc.) skip
// this path and go straight to fallback. Avoids a ~5-10% spurious-fallback
// rate observed in prod on flaky residential connections.
const NETWORK_RETRY_BACKOFF_MS = 250

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g

// Provider continuation is not interchangeable context. Keep the canonical
// logical route and never send signed/opaque state down a fallback chain.
const continuationRoute = (request: ChatRequest): string | undefined => {
  let route: string | undefined
  let endpointHash: string | undefined
  for (const message of request.messages) {
    if (!message.continuation) continue
    const value = message.continuation
    const next = `${value.provider}:${value.model}`
    if (message.role !== 'assistant' || (route !== undefined && (route !== next || endpointHash !== value.endpointHash))) {
      throw createLLMRequestError('provider_continuation_route_mismatch', 'provider_continuation_route_mismatch: request mixes incompatible continuation routes')
    }
    route = next
    endpointHash = value.endpointHash
  }
  if (route !== undefined && request.model !== route) throw createLLMRequestError('provider_continuation_route_mismatch', 'provider_continuation_route_mismatch: continuation must use its original canonical route')
  return route
}

// Bare network errors that warrant one in-place retry on the same chain
// element before advancing. Classified provider errors (CloudProviderError,
// GatewayError) carry their own code and skip this path.
const isBareNetworkError = (err: unknown): boolean => {
  if (err instanceof Error && (err as { kind?: string }).kind) return false  // structured error
  if (!(err instanceof Error)) return false
  return /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|fetch failed|network/i.test(err.message)
}

// Strip the primary from the chain and dedup. Empty input returns empty.
const dedupChain = (primary: string, chain: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>([primary])
  const out: string[] = []
  for (const ref of chain) {
    const t = ref.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

// Decide whether to skip the primary based on monitor state.
const shouldSkipPrimary = (
  primaryProvider: string | null,
  monitorSnapshot: Record<string, MonitorState | null>,
  now: number,
): boolean => {
  if (!primaryProvider) return false
  const m = monitorSnapshot[primaryProvider]
  if (!m) return false
  if (m.sub !== 'backoff') return false
  if (m.retryAt === null) return false
  return m.retryAt > now + COOLDOWN_SKIP_GUARD_MS
}

export interface LLMServiceDeps {
  readonly router: ProviderRouter
  // Read at request time so UI edits to the system chain take effect
  // without restart.
  readonly getSystemChain?: () => ReadonlyArray<string> | undefined
  readonly now?: () => number
}

export const createLLMService = (deps: LLMServiceDeps): LLMService => {
  const now = deps.now ?? Date.now
  const router = deps.router
  const getSystemChain = deps.getSystemChain ?? (() => undefined)

  // Reorder candidates: if primary is doomed by monitor state and chain is
  // non-empty, demote primary to last so we still try it if the chain
  // exhausts and the backoff ends mid-flight.
  const buildAttemptOrder = (request: ChatRequest, chain: ReadonlyArray<string>): ReadonlyArray<string> => {
    const { provider: primaryProvider } = parsePrefixedModel(request.model)
    const monitor = router.getMonitorSnapshot()
    const skip = shouldSkipPrimary(primaryProvider, monitor, now())
    if (skip && chain.length > 0) return [...chain, request.model]
    return [request.model, ...chain]
  }

  const logLine = (
    source: LLMSource,
    path: 'chat' | 'stream',
    request: ChatRequest,
    response: { provider?: string; promptTokens?: number; completionTokens?: number; cacheCreation?: number; cacheRead?: number; cacheMiss?: number; durationMs: number; chunksEmit?: number; toolCalls?: number; contentLen?: number; billing?: GenerationBilling },
  ): void => {
    // The provider's own generation record, when it reports one (OpenRouter):
    // what evaluation bills a call at, and which upstream served it.
    const billing = response.billing === undefined ? '' :
      ` generation=${response.billing.generationId ?? '?'} upstream=${response.billing.upstreamProvider ?? '?'} cost_usd=${response.billing.costUsd ?? '?'}`
    console.log(
      `[llm] source=${source} path=${path} provider=${response.provider ?? '?'} ` +
      `model=${request.model} content_len=${response.contentLen ?? '?'} tools=${response.toolCalls ?? 0} ` +
      `prompt_tokens=${response.promptTokens ?? '?'} completion_tokens=${response.completionTokens ?? '?'} ` +
      `cache_read=${response.cacheRead ?? '?'} cache_write=${response.cacheCreation ?? '?'} cache_miss=${response.cacheMiss ?? '?'} chunks_emit=${response.chunksEmit ?? '?'} ` +
      `duration_ms=${response.durationMs}${billing}`,
    )
  }

  const resolveChain = (override: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
    override ?? getSystemChain() ?? []

  // When the chain is spent, the last real failure reaches the caller
  // unchanged: it carries the classification, and a router failure's message
  // already names the cause, the remedy and the other tried routes
  // (router.ts allFailedMessage).
  //
  // A fallback element whose route refuses the request shape before dispatch
  // (errors.ts isRouteRefusal) cannot carry this request, but says nothing
  // about the failure that started the walk: the walk goes on and the refusal
  // never replaces that failure (2026-10-10: OpenRouter's 402 was reported as
  // openai:gpt-5.4-mini's tools refusal). The requested model's own refusal
  // is the request's configuration problem and still ends the walk.
  const isSkippedRefusal = (request: ChatRequest, model: string, err: unknown): boolean =>
    model !== request.model && isRouteRefusal(err)

  const callChat = async (request: ChatRequest, opts: LLMServiceBindOptions): Promise<ChatResponse> => {
    const pinned = continuationRoute(request)
    const chain = dedupChain(request.model, resolveChain(pinned ? [] : opts.fallbackChain))
    const order = pinned ? [pinned] : buildAttemptOrder(request, chain)
    let lastError: unknown
    // Always assigned: request.model is in order and never a skipped refusal.
    let failure: unknown

    for (let idx = 0; idx < order.length; idx++) {
      const model = order[idx]!
      if (idx > 0) opts.onChainSwitch?.(request.model, model, 'preferred_unavailable')
      const attemptRequest = { ...request, model }

      // Up to 2 tries per chain element (1 retry on bare network error only).
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const startMs = performance.now()
        try {
          const routerOpts: RouterCallOptions = {
            ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
          }
          const response = await router.chat(attemptRequest, routerOpts)
          const durationMs = Math.round(performance.now() - startMs)
          logLine(opts.source, 'chat', attemptRequest, {
            provider: response.provider,
            promptTokens: response.tokensUsed.prompt,
            completionTokens: response.tokensUsed.completion,
            cacheCreation: response.tokensUsed.cacheCreation,
            cacheRead: response.tokensUsed.cacheRead,
            cacheMiss: response.tokensUsed.cacheMiss,
            durationMs,
            contentLen: response.content.length,
            toolCalls: response.toolCalls?.length ?? 0,
            ...(response.billing ? { billing: response.billing } : {}),
          })
          return { ...response, content: response.content.replace(THINK_BLOCK_RE, '') }
        } catch (err) {
          lastError = err
          if (tryNo === 0 && isBareNetworkError(err)) {
            await new Promise(r => setTimeout(r, NETWORK_RETRY_BACKOFF_MS))
            continue   // retry same chain element
          }
          break  // advance to next chain element (or finalize)
        }
      }
      if (isSkippedRefusal(request, model, lastError)) continue
      failure = lastError
      if (!classifyIsAgentFallbackable(failure)) break
    }
    throw failure
  }

  const callStream = async function* (
    request: ChatRequest,
    signal: AbortSignal | undefined,
    opts: LLMServiceBindOptions,
  ): AsyncIterable<StreamChunk> {
    const pinned = continuationRoute(request)
    const chain = dedupChain(request.model, resolveChain(pinned ? [] : opts.fallbackChain))
    const order = pinned ? [pinned] : buildAttemptOrder(request, chain)
    let lastError: unknown
    // Always assigned: request.model is in order and never a skipped refusal.
    let failure: unknown

    for (let idx = 0; idx < order.length; idx++) {
      const model = order[idx]!
      if (idx > 0) opts.onChainSwitch?.(request.model, model, 'preferred_unavailable')
      const attemptRequest = { ...request, model }

      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const startMs = performance.now()
        const routerOpts: RouterCallOptions = {
          ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        }
        let chunkCount = 0, contentLen = 0, toolCallCount = 0
        let promptTokens: number | undefined, completionTokens: number | undefined, cacheCreation: number | undefined, cacheRead: number | undefined, cacheMiss: number | undefined
        let providerName: string | undefined
        let billing: GenerationBilling | undefined
        let firstChunkSeen = false
        let pendingThinkBuf = ''     // only flushed AFTER strip; tiny since blocks are bounded

        try {
          const stream = router.stream(attemptRequest, signal, routerOpts)
          for await (const chunk of stream) {
            firstChunkSeen = true
            if (chunk.delta) {
              pendingThinkBuf += chunk.delta
              // Emit only once a complete <think> block has either landed
              // (strip+emit remainder) or we're confident no more is incoming.
              // Pragmatic compromise: keep the buffer to ≤4 KB and emit
              // anything beyond that, stripped of any complete think blocks.
              if (pendingThinkBuf.length > 4096 || !pendingThinkBuf.includes('<think>')) {
                const cleaned = pendingThinkBuf.replace(THINK_BLOCK_RE, '')
                if (cleaned) {
                  contentLen += cleaned.length
                  chunkCount++
                  yield { ...chunk, delta: cleaned }
                }
                pendingThinkBuf = ''
              }
            } else {
              if (chunk.done) {
                // Flush remaining buffer with strip, then emit done.
                const cleaned = pendingThinkBuf.replace(THINK_BLOCK_RE, '')
                if (cleaned) {
                  contentLen += cleaned.length
                  chunkCount++
                  yield { delta: cleaned, done: false }
                }
                pendingThinkBuf = ''
                toolCallCount = chunk.toolCalls?.length ?? 0
                promptTokens = chunk.tokensUsed?.prompt
                completionTokens = chunk.tokensUsed?.completion
                cacheCreation = chunk.tokensUsed?.cacheCreation
                cacheRead = chunk.tokensUsed?.cacheRead
                cacheMiss = chunk.tokensUsed?.cacheMiss
                providerName = chunk.provider
                billing = chunk.billing
              }
              yield chunk
            }
          }
          const durationMs = Math.round(performance.now() - startMs)
          logLine(opts.source, 'stream', attemptRequest, {
            provider: providerName, promptTokens, completionTokens, cacheCreation, cacheRead, cacheMiss,
            durationMs, chunksEmit: chunkCount, toolCalls: toolCallCount, contentLen,
            ...(billing ? { billing } : {}),
          })
          return
        } catch (err) {
          if (isAbortError(err, signal)) throw err
          lastError = err
          // Mid-stream failure: cannot recover — caller already received chunks.
          if (firstChunkSeen) throw err
          if (tryNo === 0 && isBareNetworkError(err)) {
            await new Promise(r => setTimeout(r, NETWORK_RETRY_BACKOFF_MS))
            continue
          }
          break
        }
      }
      if (isSkippedRefusal(request, model, lastError)) continue
      failure = lastError
      if (!classifyIsAgentFallbackable(failure)) break
    }
    throw failure
  }

  return {
    bound: (opts) => ({
      chat: (req) => callChat(req, opts),
      stream: (req, signal) => callStream(req, signal, opts),
      models: () => router.models(),
      // Real routers provide metadata; isolated test providers may not.
      ...(router.modelInfo ? { modelInfo: router.modelInfo } : {}),
    }),
  }
}
