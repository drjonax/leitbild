// ============================================================================
// Curated model catalog — a short list of recommended models per provider,
// rendered as the default view in the UI model dropdown. Users can still
// opt into the full provider-reported list via a "Show all" toggle.
//
// Hand-maintained. When provider offerings change, edit here.
// ============================================================================

import type { CloudProviderName } from '../provider-catalog.ts'
import type { ReasoningEffort } from '../../core/types/llm.ts'

export interface CuratedModel {
  readonly id: string
  // Human-readable label shown alongside the id (optional — if omitted, UI
  // uses the id).
  readonly label?: string
  // Function-calling support. `true` / `false` when known; `undefined` means
  // unverified (default-allow). Only mark `false` when the provider is
  // documented to reject `tools:` in the request for this model — the UI
  // shows a warning in the agent inspector's Tools group when this is false.
  readonly supportsTools?: boolean
  // Image-input support. `true` for vision-capable models; `false` for
  // text-only; `undefined` for unverified (falls back to the substring
  // allowlist in src/llm/multimodal.ts). When an agent attaches an image
  // and the model has `supportsImages !== true`, context-builder swaps in
  // a text placeholder and emits a warn-once log line.
  readonly supportsImages?: boolean
  // Reasoning/thinking class. Thinking models emit a separate reasoning
  // channel (reasoning_content / reasoning) and typically have 5-15s
  // time-to-first-content while reasoning. Default-resolver skips them so
  // a fresh user's Helper agent never lands on a thinking model — users
  // who want one pick it explicitly in the agent inspector. Absent ≡ 'fast'.
  readonly kind?: 'fast' | 'thinking'
}

// System-wide model policy. Keep default and fallback choices here so seed
// agents, demos, the model picker, and LLMService do not grow independent
// model-name exceptions. The primary remains bare so the router may use any
// provider that genuinely reports it; fallback refs are pinned because they
// intentionally cross model/provider boundaries.
// Fork (drjonax/leitbild, multiunit plan §6): GPT-6 Luna on the direct OpenAI
// connection, which calls tools only with reasoning off; GPT-6 Sol is the
// quality reference for evals, not the default.
export const DEFAULT_MODEL_ID = 'gpt-6-luna'
// Paired with DEFAULT_MODEL_ID: Room Definition Agents that run the default
// model without their own setting get this effort.
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none'
// OpenAI only, so a failure never reaches another vendor.
export const DEFAULT_MODEL_FALLBACK: ReadonlyArray<string> = [
  'openai:gpt-5.4-mini',
]

// Keyed by provider name. Order within an array is the display order.
// The FIRST entry per provider is considered the provider's "pick" — used
// when computing the server-side default model if no other hint is available.
export const CURATED_MODELS: Record<string, ReadonlyArray<CuratedModel>> = {
  anthropic: [
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5 (cheap, fast)', supportsImages: true },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5 (balanced)',   supportsImages: true },
  ],
  openai: [
    // The default first. isNewOpenAIFamily in openai-compatible-wire.ts
    // routes gpt-5.x and gpt-6.x through max_completion_tokens and drops
    // temperature.
    { id: DEFAULT_MODEL_ID, label: '6 Luna (default)',                  supportsTools: true, supportsImages: true },
    { id: 'gpt-6-sol',     label: '6 Sol (quality reference)',          supportsTools: true, supportsImages: true },
    { id: 'gpt-6.1-sol',   label: '6.1 Sol (stronger, slower)',         supportsTools: true, supportsImages: true },
    { id: 'gpt-6-astra',   label: '6 Astra (frontier)',                 supportsTools: true, supportsImages: true },
    { id: 'gpt-5.4',       label: '5.4 (previous default)',             supportsTools: true, supportsImages: true },
    { id: 'gpt-5.4-mini',  label: '5.4 mini (fast fallback)',           supportsTools: true, supportsImages: true },
    { id: 'gpt-4o-mini',   label: '4o-mini (legacy, cheap)',            supportsTools: true, supportsImages: true },
  ],
  kimi: [
    // moonshot-v1-* first: non-thinking models. The kimi-k2.x family
    // always emits `reasoning_content` (no off-switch — verified that
    // `reasoning_effort: minimal` and `enable_thinking: false` are both
    // ignored). Leitbild doesn't surface OAI-compat `reasoning_content`
    // yet, so k2.x responses look truncated/empty when reasoning eats
    // the token budget. k2.x stays reachable via "Show all" in the UI.
    { id: 'moonshot-v1-128k', label: '128k (default)', supportsTools: true, supportsImages: false },
    { id: 'moonshot-v1-32k',  label: '32k',            supportsTools: true, supportsImages: false },
    { id: 'moonshot-v1-8k',   label: '8k (fast fallback)', supportsTools: true, supportsImages: false },
  ],
  gemini: [
    // Flash first: Pro's capacity has been chronically tight (frequent 503
    // "high demand" responses) and Flash is comparable for short replies.
    // Pro stays available — agents that explicitly want Pro pick it via
    // the inspector. Cross-provider rescue requires an explicit
    // `modelFallback` chain on the agent (no implicit equivalence map).
    { id: 'gemini-3.6-flash',      label: '3.6 Flash (current stable)', supportsTools: true, supportsImages: true },
    { id: 'gemini-3.5-flash',      label: '3.5 Flash (stable)',         supportsTools: true, supportsImages: true },
    { id: 'gemini-3.1-flash-lite', label: '3.1 Flash-Lite (efficient)', supportsTools: true, supportsImages: true },
    { id: 'gemini-2.5-flash',      label: '2.5 Flash (legacy)',         supportsTools: true, supportsImages: true },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (fast)',    supportsImages: false },
    { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B (fastest)',  supportsImages: false },
  ],
  cerebras: [
    { id: 'qwen-3-235b-a22b-instruct-2507', label: 'Qwen 3 235B',   supportsImages: false },
    { id: 'llama3.1-8b',                    label: 'Llama 3.1 8B',  supportsImages: false },
  ],
  mistral: [
    { id: 'mistral-small-latest',  label: 'Small (cheap)',   supportsImages: false },
    { id: 'mistral-medium-latest', label: 'Medium',          supportsImages: false },
    { id: 'mistral-large-latest',  label: 'Large (premium)', supportsImages: false },
  ],
  openrouter: [
    { id: DEFAULT_MODEL_ID,                       label: 'OpenAI 6 Luna (default)', supportsTools: true, supportsImages: true },
    { id: 'gpt-6-sol',                          label: 'OpenAI 6 Sol',          supportsTools: true, supportsImages: true },
    { id: 'gpt-6.1-sol',                        label: 'OpenAI 6.1 Sol',        supportsTools: true, supportsImages: true },
    { id: 'gpt-5.4',                            label: 'OpenAI 5.4 (previous)', supportsTools: true, supportsImages: true },
    { id: 'deepseek/deepseek-chat',             label: 'DeepSeek V3 (cheap)', supportsImages: false },
    { id: 'meta-llama/llama-3.3-70b-instruct',  label: 'Llama 3.3 70B',       supportsImages: false },
  ],
  sambanova: [
    { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', supportsImages: false },
  ],
}

// Preferred default picks for a fresh system, in order. Used by /api/models
// when no last-used model is available, and by the seed flow.
//
// OpenRouter first because it is the preferred gateway for the curated
// default; direct provider keys remain available as router fallbacks.
// Gemini stays prioritized above Anthropic after OpenAI because its free tier
// remains the most generous fallback for developers without an OpenAI key.
export const DEFAULT_PREFERENCE_ORDER: ReadonlyArray<CloudProviderName | 'ollama'> = [
  'openrouter', 'openai', 'gemini', 'anthropic', 'groq', 'cerebras',
]

export const isCuratedModel = (provider: string, modelId: string): boolean => {
  const list = CURATED_MODELS[provider]
  if (!list) return false
  return list.some(m => m.id === modelId)
}

// Return tool-capability for a model reference, or `undefined` when unknown.
// Accepts both prefixed (`provider:modelId`) and bare (`modelId`) refs.
// Unknown is default-allow — the UI only warns on an explicit `false`.
export const modelSupportsTools = (modelRef: string): boolean | undefined => {
  const colonIdx = modelRef.indexOf(':')
  const [provider, modelId] = colonIdx > 0
    ? [modelRef.slice(0, colonIdx), modelRef.slice(colonIdx + 1)]
    : [undefined, modelRef]
  const search = (list: ReadonlyArray<CuratedModel> | undefined): boolean | undefined => {
    const hit = list?.find(m => m.id === modelId)
    return hit?.supportsTools
  }
  if (provider) return search(CURATED_MODELS[provider])
  // No prefix — scan all providers, return the first explicit verdict.
  for (const list of Object.values(CURATED_MODELS)) {
    const v = search(list)
    if (v !== undefined) return v
  }
  return undefined
}

// Return image-input capability for a model reference, or `undefined` when
// uncatalogued. Same lookup shape as modelSupportsTools — accepts prefixed
// or bare refs, scans the catalog for an explicit verdict. Multimodal
// detection consults this FIRST and only falls back to the substring
// allowlist when the catalog has no opinion. See src/llm/multimodal.ts.
export const modelSupportsImagesFromCatalog = (modelRef: string): boolean | undefined => {
  const colonIdx = modelRef.indexOf(':')
  const [provider, modelId] = colonIdx > 0
    ? [modelRef.slice(0, colonIdx), modelRef.slice(colonIdx + 1)]
    : [undefined, modelRef]
  const search = (list: ReadonlyArray<CuratedModel> | undefined): boolean | undefined => {
    const hit = list?.find(m => m.id === modelId)
    return hit?.supportsImages
  }
  if (provider) return search(CURATED_MODELS[provider])
  for (const list of Object.values(CURATED_MODELS)) {
    const v = search(list)
    if (v !== undefined) return v
  }
  return undefined
}
