// ============================================================================
// Evaluation — LLM interaction engine with tool loop (ReAct pattern).
//
// evaluate() builds context, calls the LLM, handles native tool calls in a
// loop, and returns a Decision. The `pass` tool allows agents to decline
// responding. All tool calling uses the model's native structured format.
// ============================================================================

import type { AgentResponse, AIAgentConfig } from '../core/types/agent.ts'
import type { ChatRequest, GenerationQuery, LLMCallOptions, LLMProvider, ProviderContinuation } from '../core/types/llm.ts'
import type { EvalEventCore } from '../core/types/agent-eval.ts'
import type { NativeToolCall, ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../core/types/tool.ts'
import type { MessageCause, ToolTraceEntry } from '../core/types/messaging.ts'
import type { ContextResult, FlushInfo } from './context-builder.ts'
import { classifyLLMError } from './error-classify.ts'
import { extractFences } from './fence-extract.ts'
import { parseMapBody, formatMapErrors } from '../core/render-validators/map-schema.ts'
import { parseViewFenceBody, viewRefFor, VIEW_FENCE_LANGUAGE } from '../core/render-validators/view-fence.ts'
import { embeddedViewContentSchema, type EmbeddedViewContent } from '@leitbild/contracts'
import { answerViewIssues } from './answer-consistency.ts'

// Max times the eval loop will ask the LLM to fix an invalid map/geojson
// fence before giving up and posting the broken response (the UI banner
// then takes over). Independent of `maxToolIterations` — a tool-heavy
// agent must not lose fence retries to its tool budget.
// 2 retries observed sufficient in practice: most schema mistakes are fixed
// on the first retry; the second covers cases where the model corrects one
// error and reveals another. Beyond 2, models tend to oscillate. Test
// `evaluation.fence-retry.test.ts` asserts 3 total LLM calls (1 + 2 retries).
export const MAX_FENCE_RETRIES = 2

// Times the eval loop asks the LLM to make an answer agree with the display
// it presents (answer-consistency.ts). One: the issues name each fix, and a
// second round would cost another full answer's latency for a model that
// did not take the first; the corrected answer is still fence-checked.
export const MAX_CONSISTENCY_CORRECTIONS = 1

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId: string
  readonly inReplyTo?: ReadonlyArray<string>
  readonly metrics?: LLMCallMetrics
  // Every tool call this agent made during the turn. Attached only when the
  // agent invoked tools. Forwarded by spawn.onDecision onto the posted Message.
  readonly toolTrace?: ReadonlyArray<ToolTraceEntry>
  // Exact provider-independent request used for the final model call. Kept
  // outside the visible Message and attached to it in the Room's inspection
  // store by spawn.ts.
  readonly generationQuery?: GenerationQuery
  readonly generationTraceId?: string
  // Set by the agent on a requested turn (RequestedTurn.cause); posted with
  // every message the turn produces.
  readonly cause?: MessageCause
}

export type OnDecision = (decision: Decision) => void

// === Native tool call conversion ===

const nativeCallsToToolCalls = (native: ReadonlyArray<NativeToolCall>, round: number): ReadonlyArray<ToolCall> =>
  // Provider IDs may repeat across responses. Actual executions and events
  // use turn-unique IDs; provider IDs remain intact as separate wire metadata.
  native.map((tc, index) => ({ callId: `call_${round}_${index}`, ...(tc.id ? { providerCallId: tc.id } : {}), tool: tc.function.name, arguments: tc.function.arguments }))

// === Tool result injection ===
//
// No artificial cap on tool result size. Fence-emitting tools
// (norway_platforms, the map/mermaid/
// geojson tools) routinely produce 5-50 KB payloads that MUST reach the
// model intact — truncating mid-fence breaks the renderer downstream.
// If a tool genuinely returns runaway output, fix the tool; do not paper
// over it here.

// Render a tool's `data` field for inclusion in the LLM's next turn.
//
// String results pass through verbatim (no JSON.stringify wrapping, which
// would add `"..."` quote-wrapping and escape every newline as `\n`,
// forcing the model to mentally unescape before pasting). This is the
// single most-impactful fix for fence-emitting tools like norway_platforms
// and diagram tools: the fence reaches the model with real newlines
// and no escape clutter.
//
// Object/array results stay compact. Pretty-printing is a Client concern;
// indentation more than doubled large operational payloads in model context.
//
// Other primitives (number, boolean, null) JSON-stringify cleanly.
export const formatToolDataForLLM = (data: unknown): string => {
  if (typeof data === 'string') return data
  // null / undefined → empty string; agents see a blank result instead of
  // the four-character literal "null".
  if (data === null || data === undefined) return ''
  try { return JSON.stringify(data) } catch {
    // Circular or otherwise un-serialisable — fall back to String() so the
    // tool result still reaches the LLM (even if uninformative).
    return String(data)
  }
}

const formatToolResult = (result: ToolResult): string => result.success
  ? formatToolDataForLLM(result.data)
  : JSON.stringify({ success: false, error: result.error ?? 'Tool failed', ...(result.data === undefined ? {} : { details: result.data }) })

const messageTokens = (message: ChatRequest['messages'][number]): number =>
  Math.ceil((message.content.length + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0)) / 4)

const continuationModel = (messages: ChatRequest['messages'], preferred: string): string => {
  const continuation = messages.findLast(message => message.continuation)?.continuation
  return continuation ? `${continuation.provider}:${continuation.model}` : preferred
}

const assertCompleteOutput = (finishReason?: string): void => {
  if (finishReason === 'length') throw new Error('incomplete_output: model reached its output limit; this is not a complete answer and no tool calls from this incomplete response were executed')
}

export const fitToolEvidence = (
  context: Array<ChatRequest['messages'][number]>,
  assistant: ChatRequest['messages'][number],
  tools: ReadonlyArray<ChatRequest['messages'][number]>,
  tokenBudget: number | undefined,
  systemTokens = 0,
  // Index of the message that opened this turn; it and everything after it
  // stay even when a later correction became the last user message.
  turnStart = -1,
): { droppedHistory: number; overBudget: boolean } => {
  if (tokenBudget === undefined) {
    context.push(assistant, ...tools)
    return { droppedHistory: 0, overBudget: false }
  }
  const lastUser = turnStart >= 0
    ? Math.min(turnStart, context.findLastIndex(message => message.role === 'user'))
    : context.findLastIndex(message => message.role === 'user')
  context.push(assistant, ...tools)
  let total = systemTokens + context.reduce((sum, message) => sum + messageTokens(message), 0)
  let droppedHistory = 0
  const protectedIndex = lastUser >= 0 ? lastUser : context.length - tools.length - 1
  while (total > tokenBudget && droppedHistory < protectedIndex) {
    // Drop a whole older conversational turn, never orphan native tool results.
    const nextUser = context.findIndex((message,index)=>index>0&&message.role==='user')
    const count = Math.min(nextUser < 0 ? protectedIndex-droppedHistory : nextUser, protectedIndex-droppedHistory)
    if (count <= 0) break
    const removed = context.splice(0,count)
    total -= removed.reduce((sum,message)=>sum+messageTokens(message),0)
    droppedHistory += removed.length
  }
  // Fresh tool evidence is authoritative and may reflect a mutation that has
  // already happened. Never rewrite or truncate it after execution: doing so
  // can make the model repeat a side effect. Retrieval capabilities must bound
  // or paginate their own output. If protected evidence still does not fit,
  // keep it intact and surface a loud warning/provider error.
  return { droppedHistory, overBudget: total > tokenBudget }
}

// === Evaluate — single LLM call with tool loop ===

export interface EvalResult {
  readonly decision: Decision
  readonly flushInfo: FlushInfo
}

// === LLM call shape ===
// LLMService applies cooldown skip, chain walk, network retry, content
// strip, and observability. The agent layer just streams the result. No
// per-agent retry policy.

export interface LLMCallMetrics {
  readonly promptTokens?: number
  /** Input tokens for the most recent model pass; unlike promptTokens this can
   * be compared with one model context window. */
  readonly lastPromptTokens?: number
  readonly completionTokens?: number
  // Prompt-cache hit metrics surfaced through the posted message so cache
  // efficacy is observable in the JSONL log without dashboard inspection.
  readonly cacheCreation?: number
  readonly cacheRead?: number
  readonly cacheMiss?: number
  readonly modelCalls?: number
  readonly contextMax?: number
  readonly provider?: string
  readonly model?: string
}

const sumMetric = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)

const mergeMetrics = (current: LLMCallMetrics, next: LLMCallMetrics): LLMCallMetrics => ({
  ...(sumMetric(current.promptTokens, next.promptTokens) === undefined ? {} : { promptTokens: sumMetric(current.promptTokens, next.promptTokens) }),
  ...((next.promptTokens ?? current.lastPromptTokens) === undefined ? {} : { lastPromptTokens: next.promptTokens ?? current.lastPromptTokens }),
  ...(sumMetric(current.completionTokens, next.completionTokens) === undefined ? {} : { completionTokens: sumMetric(current.completionTokens, next.completionTokens) }),
  ...(sumMetric(current.cacheCreation, next.cacheCreation) === undefined ? {} : { cacheCreation: sumMetric(current.cacheCreation, next.cacheCreation) }),
  ...(sumMetric(current.cacheRead, next.cacheRead) === undefined ? {} : { cacheRead: sumMetric(current.cacheRead, next.cacheRead) }),
  ...(sumMetric(current.cacheMiss, next.cacheMiss) === undefined ? {} : { cacheMiss: sumMetric(current.cacheMiss, next.cacheMiss) }),
  modelCalls: (current.modelCalls ?? 0) + 1,
  ...(next.contextMax ?? current.contextMax ? { contextMax: next.contextMax ?? current.contextMax } : {}),
  ...(next.provider ?? current.provider ? { provider: next.provider ?? current.provider } : {}),
  ...(next.model ?? current.model ? { model: next.model ?? current.model } : {}),
})

// One LLM call: either streams chunks to onEvent or falls back to a
// non-streaming chat(). Caller-visible result is identical either way.
const callLLMOnce = async (
  provider: LLMProvider,
  request: ChatRequest,
  onEvent?: (e: EvalEventCore) => void,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls?: ReadonlyArray<NativeToolCall>; continuation?: ProviderContinuation; finishReason?: string; durationMs: number; metrics: LLMCallMetrics }> => {
  const startMs = performance.now()

  if (provider.stream) {
    let content = ''
    let toolCalls: ReadonlyArray<NativeToolCall> | undefined
    let continuation: ProviderContinuation | undefined
    let finishReason: string | undefined
    let metrics: LLMCallMetrics = {}
    for await (const chunk of provider.stream(request, signal)) {
      if (chunk.thinking) onEvent?.({ kind: 'thinking', delta: chunk.thinking })
      if (chunk.slowWarning) {
        const elapsedS = Math.round(chunk.slowWarning.elapsedMs / 1000)
        onEvent?.({
          kind: 'warning',
          message: `Provider "${chunk.slowWarning.provider}" hasn't sent a chunk in ${elapsedS}s — the model may be reasoning or the provider may be slow. Use the Stop button to cancel, or wait. Will switch automatically if the stream stalls completely.`,
        })
      }
      if (chunk.delta) {
        content += chunk.delta
        onEvent?.({ kind: 'chunk', delta: chunk.delta })
      }
      if (chunk.done) {
        if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls
        continuation = chunk.continuation
        finishReason = chunk.finishReason
        metrics = {
          promptTokens: chunk.tokensUsed?.prompt,
          completionTokens: chunk.tokensUsed?.completion,
          ...(chunk.tokensUsed?.cacheCreation !== undefined ? { cacheCreation: chunk.tokensUsed.cacheCreation } : {}),
          ...(chunk.tokensUsed?.cacheRead !== undefined ? { cacheRead: chunk.tokensUsed.cacheRead } : {}),
          ...(chunk.tokensUsed?.cacheMiss !== undefined ? { cacheMiss: chunk.tokensUsed.cacheMiss } : {}),
          contextMax: chunk.contextMax,
          provider: chunk.provider,
          model: chunk.model ?? request.model,
        }
      }
    }
    return { content: content.trim(), toolCalls, ...(continuation ? { continuation } : {}), ...(finishReason ? { finishReason } : {}), durationMs: Math.round(performance.now() - startMs), metrics }
  }

  const response = await provider.chat(request)
  onEvent?.({ kind: 'chunk', delta: response.content })
  return {
    content: response.content,
    toolCalls: response.toolCalls,
    ...(response.continuation ? { continuation: response.continuation } : {}),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    durationMs: response.generationMs,
    metrics: {
      promptTokens: response.tokensUsed.prompt,
      completionTokens: response.tokensUsed.completion,
      ...(response.tokensUsed.cacheCreation !== undefined ? { cacheCreation: response.tokensUsed.cacheCreation } : {}),
      ...(response.tokensUsed.cacheRead !== undefined ? { cacheRead: response.tokensUsed.cacheRead } : {}),
      ...(response.tokensUsed.cacheMiss !== undefined ? { cacheMiss: response.tokensUsed.cacheMiss } : {}),
      contextMax: response.contextMax,
      provider: response.provider,
      model: response.model ?? request.model,
    },
  }
}

// === Fence validation + retry, answer consistency ===
//
// Validate every ```map / ```geojson fence schema and every ```leitbild-view
// reference in the response content. If any are invalid, append a synthetic
// correction prompt to the conversation context and re-call the LLM. Repeat
// up to MAX_FENCE_RETRIES times. Returns the final response content
// (corrected if a retry succeeded; the last attempt's content if all retries
// failed — the UI then shows the error in place of the block). Once the
// fences are valid, an answer that disagrees with the display it presents is
// corrected the same way, at most MAX_CONSISTENCY_CORRECTIONS times.
//
// Mermaid is excluded by design: its parser is browser-only; a server-side
// validator would only catch trivial cases (oversized, completely wrong
// keyword) and miss real syntax errors. Honest scoping > pretend-bulletproof.
const mapFenceErrors = (content: string): ReadonlyArray<string> =>
  extractFences(content, ['map', 'geojson']).flatMap(fence => {
    const result = parseMapBody(fence.body)
    return result.ok ? [] : [`\`\`\`${fence.language}\` block at content line ${fence.startLine} (see the rendering skill for the schema):\n${formatMapErrors(result.errors)}`]
  })

// A view fence must name a display this turn actually composed. Evidence of
// earlier turns is not accepted: the answer must present what it just built.
// A display composed in this turn and left out is corrected too: the answer
// would point the operator to a display that is not there.
const viewFenceErrors = (content: string, viewRefs: ReadonlySet<string>): ReadonlyArray<string> => {
  const fences = extractFences(content, [VIEW_FENCE_LANGUAGE])
  if (fences.length === 0) {
    const latest = [...viewRefs].at(-1)
    return latest === undefined ? [] : [`This turn composed a display (viewRef ${latest}) but the response does not present it. End the response with the \`${VIEW_FENCE_LANGUAGE}\` block (view ${latest}), or, if that display does not answer the question, say so in one sentence and never refer to it as shown.`]
  }
  const errors: string[] = []
  if (fences.length > 1) errors.push(`Show at most one display per answer; the response has ${fences.length} \`${VIEW_FENCE_LANGUAGE}\` blocks.`)
  for (const fence of fences) {
    const parsed = parseViewFenceBody(fence.body)
    if (parsed.kind === 'invalid') { errors.push(`\`${VIEW_FENCE_LANGUAGE}\` block at content line ${fence.startLine}: ${parsed.error}`); continue }
    const ref = viewRefFor(parsed.ref.callId, parsed.ref.key)
    if (!viewRefs.has(ref)) {
      errors.push(`\`${VIEW_FENCE_LANGUAGE}\` block at content line ${fence.startLine}: ${ref} is not a display composed in this turn. Paste the viewRef returned by world.process-plant.display.compose, or remove the block if no display was composed.`)
    }
  }
  return errors
}

// A turn that must present a live view (RequestedTurn.requireView) and
// answered without composing one is asked once more inside the tool loop, so
// the model can still compose it. A second answer without one stands.
const REQUIRED_VIEW_CORRECTION = `The reader asked for a live display, and this response presents none. If you have not composed one yet, compose it now and end the response with its \`${VIEW_FENCE_LANGUAGE}\` block. If no display can be produced, reply with one sentence saying why.`

const validateResponseFences = (content: string, viewRefs: ReadonlySet<string>): { ok: boolean; errors: string } => {
  const errors = [...mapFenceErrors(content), ...viewFenceErrors(content, viewRefs)]
  return { ok: errors.length === 0, errors: errors.join('\n\n') }
}

/** viewRefs that successful workspace_call results in this turn made presentable. */
export const collectViewRefs = (into: Set<string>, tool: string, result: ToolResult): void => {
  if (tool !== 'workspace_call' || !result.success) return
  const entries = (result.data as { results?: unknown } | undefined)?.results
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    const viewRef = (entry as { viewRef?: unknown } | null)?.viewRef
    if (typeof viewRef === 'string') into.add(viewRef)
  }
}

/** What the Modules said each view composed in this turn shows, by viewRef. */
export const collectViewContents = (into: Map<string, EmbeddedViewContent>, tool: string, result: ToolResult): void => {
  if (tool !== 'workspace_call' || !result.success) return
  const entries = (result.data as { results?: unknown } | undefined)?.results
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    const { viewRef, data } = (entry ?? {}) as { viewRef?: unknown; data?: unknown }
    if (typeof viewRef !== 'string' || typeof data !== 'object' || data === null || !('viewContent' in data)) continue
    // A Module that publishes content must publish it valid: a broken
    // contract fails the turn loudly rather than skipping the check.
    into.set(viewRef, embeddedViewContentSchema.parse((data as { viewContent: unknown }).viewContent))
  }
}

// Where an answer and the display it presents disagree. A view whose Module
// says nothing of what it shows (a unit overview) is not checked: there is
// nothing to compare the answer with.
const presentedViewIssues = (content: string, viewContents: ReadonlyMap<string, EmbeddedViewContent>): ReadonlyArray<string> => {
  const fence = extractFences(content, [VIEW_FENCE_LANGUAGE])[0]
  if (fence === undefined) return []
  const parsed = parseViewFenceBody(fence.body)
  if (parsed.kind === 'invalid') return []
  const view = viewContents.get(viewRefFor(parsed.ref.callId, parsed.ref.key))
  return view === undefined ? [] : answerViewIssues(content, view)
}

const consistencyCorrection = (issues: ReadonlyArray<string>): string =>
  `The answer and the display it presents disagree, and the operator reads them together:\n${issues.map(issue => `- ${issue}`).join('\n')}\n\n` +
  `Re-emit the FULL corrected response with the same \`${VIEW_FENCE_LANGUAGE}\` block. Cite values and watch items only as the display shows them, or mark one "(not shown)"; ` +
  'name what the display leads with; give its time span as the display draws it. Keep the assessment and actions.'

const correctResponse = async (
  initialContent: string,
  viewRefs: ReadonlySet<string>,
  viewContents: ReadonlyMap<string, EmbeddedViewContent>,
  context: Array<ChatRequest['messages'][number]>,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  signal: AbortSignal | undefined,
  onEvent: ((event: EvalEventCore) => void) | undefined,
  systemBlocks: ContextResult['systemBlocks'],
  toolDefinitions: ReadonlyArray<ToolDefinition> | undefined,
  addGenerationMs: (ms: number) => void,
  addMetrics: (m: LLMCallMetrics) => void,
  captureRequest: (request: ChatRequest) => void,
  initialContinuation?: ProviderContinuation,
): Promise<string> => {
  let content = initialContent
  let continuation = initialContinuation
  let fenceRetries = 0
  let consistencyCorrections = 0
  for (;;) {
    const validation = validateResponseFences(content, viewRefs)
    let correction: string
    if (!validation.ok) {
      if (fenceRetries === MAX_FENCE_RETRIES) break
      fenceRetries++
      correction =
        `Your previous response contained one or more invalid fenced blocks:\n\n${validation.errors}\n\n` +
        `Re-emit the FULL corrected response (keep the surrounding prose, fix or remove the listed blocks).`
    } else {
      // Valid fences: does the answer agree with the display it presents?
      const issues = consistencyCorrections === MAX_CONSISTENCY_CORRECTIONS ? [] : presentedViewIssues(content, viewContents)
      if (issues.length === 0) return content
      consistencyCorrections++
      correction = consistencyCorrection(issues)
    }
    // Append the response + a precise correction prompt. The next LLM call
    // will see (a) what it just emitted, (b) why it must change,
    // (c) instruction to re-emit a corrected version.
    context.push({ role: 'assistant' as const, content, ...(continuation ? { continuation } : {}) })
    context.push({ role: 'user' as const, content: correction })
    if (signal?.aborted) return content
    const request: ChatRequest = {
      model: continuationModel(context, config.model),
      messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      temperature: config.temperature,
      ...(config.seed !== undefined ? { seed: config.seed } : {}),
      tools: toolDefinitions,
      think: config.thinking,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(systemBlocks ? { systemBlocks } : {}),
    }
    captureRequest(request)
    const stream = await callLLMOnce(llmProvider, request, onEvent, signal)
    addGenerationMs(stream.durationMs)
    addMetrics(stream.metrics)
    assertCompleteOutput(stream.finishReason)
    continuation = stream.continuation
    content = stream.content.trim()
    if (content.length === 0) {
      // Empty correction attempt — give up and return the prior content.
      return initialContent
    }
  }
  // Exhausted retries — return the last attempt as-is. The UI's per-fence
  // validation banner will render the errors to the user, who can prompt
  // for another correction manually.
  return content
}

// === Main evaluation loop ===

export interface EvalOptions {
  readonly executionTurnId?: string
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly inReplyTo?: ReadonlyArray<string>
  // The turn must present a live view; see REQUIRED_VIEW_CORRECTION.
  readonly requireView?: boolean
  readonly onEvent?: (event: EvalEventCore) => void
  readonly signal?: AbortSignal
  // Optional operator-configured tool-iteration check-in. Returns true to
  // continue this turn without another quota, or false to stop (user clicked
  // Stop, abandonment timeout fired, or cancellation was signalled). Agents
  // without an explicit threshold rely on their
  // retrieval guidance and normal cancellation rather than a hidden quota.
  readonly requestToolCheckin?: (info: {
    readonly iterations: number
    readonly recentTools: ReadonlyArray<{ readonly tool: string; readonly success: boolean }>
  }) => Promise<boolean>
}

export const evaluate = async (
  contextResult: ContextResult,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolExecutor: ToolExecutor | undefined,
  maxToolIterations: number | undefined,
  triggerRoomId: string,
  options?: EvalOptions,
): Promise<EvalResult> => {
  const context: Array<ChatRequest['messages'][number]> = [...contextResult.messages]
  let totalGenerationMs = 0
  let metrics: LLMCallMetrics = { modelCalls: 0 }
  const { toolDefinitions, inReplyTo, requireView, onEvent, signal, requestToolCheckin } = options ?? {}
  // Optional mutable operator threshold. Undefined means there is no hidden
  // engine quota; the Agent decides when it has enough evidence.
  let effectiveMaxIterations = maxToolIterations

  // Accumulates one entry per tool call across every loop iteration. Attached
  // to the final Decision — lets downstream consumers (export_room, UI)
  // reconstruct what the agent actually did before answering.
  const toolTrace: Array<ToolTraceEntry> = []
  const viewRefs = new Set<string>()
  let viewInsisted = false
  // The message that opened the turn (a requested turn's instruction, or the
  // newest question); shifts left as older history is dropped.
  let turnStart = context.findLastIndex(message => message.role === 'user')
  // Rounds spent insisting on a view call the model again without a tool
  // round of the agent's own; they do not count against its iteration limit.
  let insistRounds = 0
  const viewContents = new Map<string, EmbeddedViewContent>()
  let lastGenerationQuery: GenerationQuery | undefined
  const captureRequest = (request: ChatRequest): void => {
    // ChatRequest is JSON-shaped. Clone at the call boundary so subsequent
    // tool-loop context mutation cannot rewrite the audit record.
    lastGenerationQuery = JSON.parse(JSON.stringify(request)) as GenerationQuery
  }

  // Cap preview at 200 chars — this is a debugging/analysis aid for the
  // UI trace panel, not context fed to the LLM, and arbitrarily long
  // previews would bloat every message blob the UI ships.
  const PREVIEW_MAX = 200
  const previewFor = (result: ToolResult): string => {
    const raw = result.success
      ? JSON.stringify(result.data ?? null)
      : (result.error ?? '')
    return raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw
  }
  const operationOutcomesFor = (tool: string, result: ToolResult): ToolTraceEntry['operationOutcomes'] => {
    if (tool !== 'workspace_call' || !result.success || !result.data || typeof result.data !== 'object') return undefined
    const results = (result.data as { results?: unknown }).results
    if (!Array.isArray(results)) return undefined
    const outcomes = results.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const raw = value as Record<string, unknown>
      if (typeof raw.key !== 'string' || typeof raw.operationId !== 'string' || typeof raw.success !== 'boolean') return []
      return [{ key: raw.key, operationId: raw.operationId, success: raw.success }]
    })
    return outcomes.length === 0 ? undefined : outcomes
  }
  const traceArguments = (tool: string, value: Record<string, unknown>): Pick<ToolTraceEntry, 'argumentKeys' | 'argumentBytes' | 'operationIds' | 'target'> => {
    const serialized = JSON.stringify(value)
    const calls = Array.isArray(value.calls) ? value.calls.filter(call => call && typeof call === 'object') as ReadonlyArray<Record<string, unknown>> : []
    const rawTarget = calls[0]?.target ?? value.target
    const targetValue = typeof rawTarget === 'object' && rawTarget !== null && 'ref' in rawTarget
      ? (rawTarget as Record<string, unknown>).ref
      : rawTarget
    const target = typeof targetValue === 'object' && targetValue !== null
      ? ['moduleId', 'type', 'id', 'revisionId']
        .flatMap(key => typeof (targetValue as Record<string, unknown>)[key] === 'string' ? [(targetValue as Record<string, unknown>)[key] as string] : [])
        .join('/')
      : undefined
    return {
      argumentKeys: Object.keys(value).slice(0, 32),
      argumentBytes: new TextEncoder().encode(serialized).byteLength,
      ...(tool === 'workspace_call'
        ? { operationIds: calls.flatMap(call => typeof call.operationId === 'string' ? [call.operationId] : []) }
        : {}),
      ...(target ? { target } : {}),
    }
  }

  const makeResult = (decision: Decision): EvalResult => {
    // Emit `eval_completed` exactly once per evaluate() call. This is the
    // single source of truth for "this agent is done" — anything that
    // previously polled agent.state can rely on this firing on every
    // terminal path because every `return` in evaluate() routes through
    // makeResult.
    onEvent?.({ kind: 'eval_completed', outcome: decision.response.action })
    return {
      decision: {
        ...(inReplyTo && inReplyTo.length > 0 ? { ...decision, inReplyTo } : decision),
        metrics,
        ...(toolTrace.length > 0 ? { toolTrace: [...toolTrace] } : {}),
        ...(lastGenerationQuery ? { generationQuery: lastGenerationQuery } : {}),
      },
      flushInfo: contextResult.flushInfo,
    }
  }

  // Track the latest non-empty text the model emitted across tool rounds.
  // When the loop hits maxToolIterations we surface this to the user along
  // with the pass reason, instead of replacing the streamed text with a bare
  // [pass] message — that was a bad UX where you'd see the agent typing,
  // then watch its message get deleted and replaced with a terse error.
  let lastAssistantText = ''

  try {
    for (let toolRound = 0; ; toolRound++) {
      const request: ChatRequest = {
        model: continuationModel(context, config.model),
        messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        temperature: config.temperature,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        tools: toolDefinitions,
        think: config.thinking,
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(contextResult.systemBlocks ? { systemBlocks: contextResult.systemBlocks } : {}),
      }

      captureRequest(request)
      const streamResult = await callLLMOnce(llmProvider, request, onEvent, signal)
      totalGenerationMs += streamResult.durationMs
      metrics = mergeMetrics(metrics, streamResult.metrics)
      assertCompleteOutput(streamResult.finishReason)

      // Native tool calls
      if (streamResult.toolCalls && streamResult.toolCalls.length > 0) {
        // Hold on to any text the model emitted before/alongside the tool
        // calls — the user just watched it stream in. If we end up exhausting
        // iterations, this is what we restore so the chat doesn't blank out.
        if (streamResult.content && streamResult.content.trim().length > 0) {
          lastAssistantText = streamResult.content.trim()
        }
        const calls = nativeCallsToToolCalls(streamResult.toolCalls, toolRound)

        // pass tool → return pass decision without executing
        if (calls.length === 1 && calls[0]!.tool === 'pass') {
          return makeResult({ response: { action: 'pass', reason: (calls[0]!.arguments.reason as string) ?? 'nothing to add' }, generationMs: totalGenerationMs, triggerRoomId })
        }

        if (!toolExecutor) {
          return makeResult({
            response: { action: 'error', code: 'tools_unavailable', message: 'Model emitted tool calls but no executor is wired' },
            generationMs: totalGenerationMs,
            triggerRoomId,
          })
        }

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          onEvent?.({ kind: 'tool_start', tool: call.tool, callId: call.callId ?? String(i) })
        }
        const results = await toolExecutor(calls, triggerRoomId, signal, options?.executionTurnId)
        for (let i = 0; i < results.length; i++) {
          const call = calls[i]
          const result = results[i]
          if (!call || !result) continue
          collectViewRefs(viewRefs, call.tool, result)
          collectViewContents(viewContents, call.tool, result)
          const operationOutcomes = operationOutcomesFor(call.tool, result)
          const traceSuccess = result.success && (operationOutcomes?.every(outcome => outcome.success) ?? true)
          onEvent?.({ kind: 'tool_result', tool: call.tool, callId: call.callId ?? String(i), success: traceSuccess, preview: traceSuccess ? undefined : result.error ?? 'One or more requested operations failed' })
          const serializedResult = formatToolResult(result)
          toolTrace.push({
            tool: call.tool,
            ...traceArguments(call.tool, call.arguments),
            success: traceSuccess,
            resultBytes: new TextEncoder().encode(serializedResult).byteLength,
            ...(operationOutcomes === undefined ? {} : { operationOutcomes }),
            resultPreview: previewFor(result),
          })
        }
        // Provider wire IDs have provider-specific constraints (for example,
        // Mistral's nine alphanumeric characters). Execution IDs are separate.
        const wireCalls = streamResult.toolCalls.map((call, index) => ({ ...call, id: call.id ?? calls[index]!.callId! }))
        const assistantToolMessage: ChatRequest['messages'][number] = { role: 'assistant', content: streamResult.content, toolCalls: wireCalls, ...(streamResult.continuation ? { continuation: streamResult.continuation } : {}) }
        const toolMessages: Array<ChatRequest['messages'][number]> = []
        for (let i = 0; i < results.length; i++) {
          const call = calls[i]
          const result = results[i]
          if (!call || !result) continue
          toolMessages.push({ role: 'tool', toolCallId: wireCalls[i]!.id, name: call.tool, content: formatToolResult(result) })
        }
        const systemTokens = Math.ceil((contextResult.systemBlocks?.map(block=>block.text).join('\n\n').length ?? 0)/4)
        const fit = fitToolEvidence(context, assistantToolMessage, toolMessages, contextResult.tokenBudget, systemTokens, turnStart)
        turnStart -= fit.droppedHistory
        if (fit.overBudget) onEvent?.({ kind: 'warning', message: 'Current request and tool evidence exceed the model context budget. Evidence was preserved intact; use a narrower or paginated read.' })
        if (fit.droppedHistory > 0) onEvent?.({ kind: 'warning', message: `Dropped ${fit.droppedHistory} oldest context messages to retain current tool evidence.` })

        const iterations = toolRound + 1 - insistRounds
        if (effectiveMaxIterations !== undefined && iterations > effectiveMaxIterations) {
          if (requestToolCheckin) {
            const recentTools = toolTrace.slice(-3).map(t => ({ tool: t.tool, success: t.success }))
            onEvent?.({
              kind: 'tool_iteration_checkin',
              iterations,
              roomId: triggerRoomId,
              recentTools,
            })
            const shouldContinue = await requestToolCheckin({ iterations, recentTools })
            if (!shouldContinue) break
            // A human explicitly chose to continue this turn. Hand control
            // back to the Agent instead of imposing another arbitrary block.
            effectiveMaxIterations = undefined
          } else {
            break
          }
        }
        continue
      }

      // No tool calls → response text is the message.
      const content = streamResult.content.trim()
      if (content.length === 0) {
        return makeResult({
          response: { action: 'error', code: 'empty_response', message: 'LLM returned no content and no tool calls' },
          generationMs: totalGenerationMs,
          triggerRoomId,
        })
      }
      if (requireView && !viewInsisted && viewRefs.size === 0) {
        viewInsisted = true
        insistRounds++
        context.push({ role: 'assistant', content, ...(streamResult.continuation ? { continuation: streamResult.continuation } : {}) })
        context.push({ role: 'user', content: REQUIRED_VIEW_CORRECTION })
        continue
      }
      // Fence retry loop: validate ```map / ```geojson schemas and that every
      // ```leitbild-view names a display composed in this turn, then that the
      // answer agrees with the display it presents. If invalid,
      // append a synthetic correction prompt to context and re-call the LLM
      // up to MAX_FENCE_RETRIES times. Each retry streams live (the user sees
      // the rewrite); only the final response is committed via makeResult.
      // Retry budget is independent of toolRound — fence retries don't
      // consume tool-iteration budget.
      //
      // Mermaid is not validated here on purpose: its parser is browser-only
      // and a server-side validator would be a smell-test, not a real check.
      const finalContent = await correctResponse(
        content,
        viewRefs,
        viewContents,
        context,
        config,
        llmProvider,
        signal,
        onEvent,
        contextResult.systemBlocks,
        toolDefinitions,
        (ms) => { totalGenerationMs += ms },
        (m) => {
          metrics = mergeMetrics(metrics, m)
        },
        captureRequest,
        streamResult.continuation,
      )
      return makeResult({ response: { action: 'respond', content: finalContent }, generationMs: totalGenerationMs, triggerRoomId })
    }

    // Max iterations reached. If the model produced any visible text along
    // the way, deliver it with a footer instead of replacing it with a bare
    // pass. Without this, the user sees streamed text disappear and a terse
    // [pass] error take its place.
    const loopReason = `Tool call loop reached the configured ${effectiveMaxIterations} iteration threshold`
    if (lastAssistantText.length > 0) {
      return makeResult({
        response: {
          action: 'respond',
          content: `${lastAssistantText}\n\n_⚠ ${loopReason} — partial result._`,
        },
        generationMs: totalGenerationMs,
        triggerRoomId,
      })
    }
    return makeResult({
      response: { action: 'error', code: 'tool_loop_exceeded', message: loopReason },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
  } catch (err) {
    // A routed failure's message already names its cause and remedy
    // (router.ts allFailedMessage); LLMService rethrows it unchanged.
    const classified = classifyLLMError(err)
    onEvent?.({ kind: 'warning', message: classified.message })
    return makeResult({
      response: {
        action: 'error',
        code: classified.code,
        message: classified.message,
        ...(classified.providerHint ? { providerHint: classified.providerHint } : {}),
      },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
  }
}

// === Standalone LLM call ===
// Single-shot call with no agent state, no history management, no protocol parsing.
// Returns raw model output. Use jsonMode for structured extraction.
// Tool loop support is planned for a future phase — for now, tools are not supported.

export const callLLM = async (
  provider: LLMProvider,
  options: LLMCallOptions,
): Promise<string> => {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  for (const m of options.messages) messages.push(m)
  const response = await provider.chat({
    model: options.model,
    messages,
    temperature: options.temperature,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    jsonMode: options.jsonMode,
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.think !== undefined ? { think: options.think } : {}),
  })
  assertCompleteOutput(response.finishReason)
  return response.content
}

// Streaming variant — yields raw deltas as they arrive. Falls back to callLLM if
// the provider does not support streaming, emitting the full response as one chunk.
export const streamLLM = async function* (
  provider: LLMProvider,
  options: LLMCallOptions,
): AsyncGenerator<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })
  for (const m of options.messages) messages.push(m)

  const request = {
    model: options.model,
    messages,
    temperature: options.temperature,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    jsonMode: options.jsonMode,
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.think !== undefined ? { think: options.think } : {}),
  }

  if (provider.stream) {
    for await (const chunk of provider.stream(request)) {
      if (chunk.done) assertCompleteOutput(chunk.finishReason)
      if (chunk.delta) yield chunk.delta
    }
  } else {
    // Provider doesn't support streaming — emit full response as a single delta
    const response = await provider.chat(request)
    assertCompleteOutput(response.finishReason)
    yield response.content
  }
}
