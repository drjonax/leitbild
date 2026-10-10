// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Orchestrates context building (context-builder.ts) and LLM evaluation
// (evaluation.ts) with message buffering and concurrency control.
//
// History architecture: a single AgentHistory struct owns the Agent's bounded
// context view, while Room remains the canonical transcript owner.
//   - rooms: recent per-room context + room profile + last-active timestamp
//   - incoming: shared buffer of unprocessed messages across all rooms
//   - agentProfiles: knowledge about other agents in the system
//
// join() initialises the RoomContext (with profile) before the first message
// arrives, so receive() never needs to handle first-contact lazily.
//
// ID Architecture: The agent generates its own UUID. The LLM sees names only.
// Names are resolved to UUIDs externally by resolveTarget in spawn.ts.
// The agent does NOT hold references to the Room Directory, Team, or routeMessage.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type { AIAgent, AIAgentConfig, IncludeContext, IncludePrompts, PromptSection, ContextSection, RequestedTurn } from '../core/types/agent.ts'
import type { AgentHistory, Message } from '../core/types/messaging.ts'
import type { EvalEvent, EvalEventCore, EvalEventScope } from '../core/types/agent-eval.ts'
import { generateTraceId } from '../core/types/agent-eval.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import { modelSupportsImages } from '../llm/multimodal.ts'
import type { Room } from '../core/types/room.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'
import { buildContext, buildSystemSections, estimateTokens, flushIncoming, type BuildContextDeps, type ContextResult } from './context-builder.ts'
import { evaluate, type EvalResult, type OnDecision } from './evaluation.ts'
import { createConcurrencyManager } from './concurrency.ts'
import type { ModelInfo } from '../core/types/model-info.ts'
import { messageFocus } from '../core/message-focus.ts'
import type { WorkspaceSubjectReference } from '@leitbild/contracts'
import type { ExecutionStore } from '../core/executions/store.ts'

import { computeContextBudget, OUTPUT_RESERVE, SAFETY_MARGIN } from './budget.ts'

// Re-export Decision/OnDecision for consumers
export type { Decision, OnDecision } from './evaluation.ts'

// === Factory Options ===

/** Captured before the first model pass, never reconstructed from the answer. */
export interface AgentTurnStart {
  readonly executionTurnId: string
  readonly roomId: string
  readonly agentId: string
  readonly context: ContextResult
  readonly config: AIAgentConfig
  readonly toolDefinitions: ReadonlyArray<ToolDefinition>
  readonly focusedSubjects: ReadonlyArray<WorkspaceSubjectReference>
  readonly inReplyTo?: ReadonlyArray<string>
  // A requested turn that must present a live view; a comparison replays it so.
  readonly requireView?: boolean
}

export interface AIAgentOptions {
  readonly onTurnStart?: (input: AgentTurnStart) => Promise<void>
  readonly onTurnFinished?: (executionTurnId: string) => void
  readonly executionStore?: ExecutionStore
  readonly executionGrowth?: <T>(bytes: number, work: () => Promise<T>) => Promise<T>
  readonly toolExecutor?: ToolExecutor
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  // Per-eval tool-surface resolver — when provided, the agent calls this
  // before each LLM request and the model sees only pack-filtered tools for
  // the trigger room. Returns null when the room is unknown (agent falls
  // back to the static toolDefinitions). See spawn.ts AgentToolSupport.
  readonly resolveToolDefinitions?: (roomId: string) => ReadonlyArray<ToolDefinition> | null
  readonly getWorkspacePrompt?: () => string
  readonly getResponseFormat?: () => string
  readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>
  readonly getCompressionSummary?: (roomId: string) => Message | undefined
  // Current room membership, resolved to profiles. Used by the Participants
  // context section so an agent sees every peer in its room — not only those
  // whose messages it has already observed.
  readonly getRoomMembers?: (roomId: string) => ReadonlyArray<import('../core/types/messaging.ts').AgentProfile>
  readonly getSkills?: (skillNames: ReadonlyArray<string>, roomId: string) => string
  // Structured access to the same skill set getSkills() formats, so the
  // pre-LLM coherence check can compare declared tools against the actual
  // surface. Returns selected skills after the Room Pack availability gate,
  // with their `allowed-tools` frontmatter declarations.
  readonly getActiveSkillsDeclarations?: (skillNames: ReadonlyArray<string>, roomId: string) => ReadonlyArray<{
    readonly name: string
    readonly declaredTools: ReadonlyArray<string>
  }>
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
  readonly onEvalEvent?: (scope: EvalEventScope, event: EvalEvent) => void
  // Per-call effective-model resolution. When provided, the agent calls this
  // before each LLM request to derive the actual model from the user's
  // preference. Returns the resolved model + whether a fallback was used.
  // Sync to keep the eval hot-path simple; the callback should rely on cached
  // provider state (router.models() snapshot, etc.).
  readonly resolveEffectiveModel?: (preferred: string) => {
    readonly model: string
    readonly fallback: boolean
    readonly reason: string
  }
  // Process-global counter sink (limitMetrics). Threaded through to
  // context-builder so the multimodal placeholder-substitution path can
  // bump `multimodalImagesDropped`. Wired by spawn.ts from shared.limitMetrics.
  readonly metricsSink?: { inc: (field: 'multimodalImagesDropped', by?: number) => void }
}

// Messages that ask the agent for an answer; the others only join its view.
const triggersEvaluation = (message: Message): boolean =>
  message.type !== 'system' && message.type !== 'join' && message.type !== 'leave' && message.type !== 'pass' && message.type !== 'error'

// === Factory ===

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
  options?: AIAgentOptions,
  overrideId?: string,
): AIAgent => {
  const agentId = overrideId ?? crypto.randomUUID()

  // Single unified history structure — all agent state in one place
  const agentHistory: AgentHistory = {
    rooms: new Map(),
    incoming: [],
    agentProfiles: new Map(),
  }
  const focusedSubjectsByRoom = new Map<string, ReadonlyArray<WorkspaceSubjectReference>>()

  const cm = createConcurrencyManager(agentId)

  let currentPersona: string = config.persona
  let currentModel: string = config.model
  let currentTemperature: number | undefined = config.temperature
  let currentThinking: boolean = config.thinking ?? false
  let currentReasoningEffort = config.reasoningEffort
  let currentHistoryTokenBudget = config.historyTokenBudget
  let historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  let toolExecutor = options?.toolExecutor
  let toolDefinitions = options?.toolDefinitions
  let resolveToolDefinitions = options?.resolveToolDefinitions
  let currentTools: ReadonlyArray<string> | undefined = config.tools
  let currentSkills: ReadonlyArray<string> = config.skills ?? []
  let currentTags: ReadonlyArray<string> = config.tags ?? []
  let currentTriggers: ReadonlyArray<import('../core/triggers/types.ts').Trigger> = config.triggers ?? []
  // Context & Prompts toggles — resolve defaults to preserve current behavior
  const includePromptsState: Required<IncludePrompts> = {
    persona: config.includePrompts?.persona ?? true,
    room: config.includePrompts?.room ?? true,
    workspace: config.includePrompts?.workspace ?? true,
    responseFormat: config.includePrompts?.responseFormat ?? true,
    skills: config.includePrompts?.skills ?? true,
    wikis: config.includePrompts?.wikis ?? true,
  }
  const includeContextState: Required<IncludeContext> = {
    participants: config.includeContext?.participants ?? true,
    activity: config.includeContext?.activity ?? true,
    knownAgents: config.includeContext?.knownAgents ?? true,
  }
  let includeTools: boolean = config.includeTools ?? true
  let promptsEnabled: boolean = config.promptsEnabled ?? true
  let contextEnabled: boolean = config.contextEnabled ?? true
  let maxToolIterationsCfg: number | undefined = config.maxToolIterations
  // Mutable settings are projected explicitly below. Keep the originally
  // supplied threshold out of the base spread so clearing it is durable.
  const { maxToolIterations: _initialToolIterationThreshold, ...baseConfig } = config

  const effectiveToolsForRoom = (roomId: string): ReadonlyArray<ToolDefinition> | undefined => {
    if (!includeTools) return undefined
    const resolved = resolveToolDefinitions?.(roomId) ?? null
    return resolved ?? toolDefinitions
  }

  const resolveContextTokenBudget = (effectiveModel: string, definitions: ReadonlyArray<ToolDefinition> | undefined): number => {
    const contextMax = describedModel?.requested === effectiveModel ? describedModel.info.contextMax : 0
    const toolDefs = (definitions ?? []).map(td => ({
      name: td.function.name,
      description: td.function.description,
      parameters: td.function.parameters,
    }))
    const result = computeContextBudget(
      { contextMax, toolDefinitions: toolDefs, ...(currentHistoryTokenBudget === undefined ? {} : { historyTokenBudget: currentHistoryTokenBudget }) },
      estimateTokens,
    )
    return result.budget
  }

  let describedModel: { requested: string; info: ModelInfo } | undefined
  const resolveModelMax = (): number => describedModel?.requested === currentModel ? describedModel.info.contextMax : 0
  const getWorkspacePrompt = options?.getWorkspacePrompt
  const getResponseFormat = options?.getResponseFormat
  const getCompressedIds = options?.getCompressedIds
  const getRoomMembers = options?.getRoomMembers
  const getSkills = options?.getSkills
  const getActiveSkillsDeclarations = options?.getActiveSkillsDeclarations
  const getScriptContext = options?.getScriptContext
  const onEvalEvent = options?.onEvalEvent
  const resolveEffective = options?.resolveEffectiveModel

  // One-shot notice tracking for model fallback. Key = effective-model id we
  // last fell back to; cleared the moment the agent successfully resolves to
  // its preferred model again, so a subsequent outage re-emits the notice.
  let lastFallbackTarget: string | null = null

  // Active abort controller for stream cancellation
  let activeAbortController: AbortController | null = null

  // Tool-iteration check-in registry. Keyed by triggerRoomId — at most one
  // in-flight eval per room means at most one pending checkin per room.
  // The resolver takes a boolean: true hands this turn back to the Agent
  // without another quota; false stops after user cancellation or abandonment.
  //
  // Set LEITBILD_TOOL_CHECKIN_ABANDON_MS=0 to disable the pause entirely
  // (headless / batch / test mode): evaluation stops at maxToolIterations.
  const pendingCheckins = new Map<string, (continueTurn: boolean) => void>()
  // Requested turns (requestTurn): waiting for their room's next evaluation,
  // and rooms whose requested turn is running. At most one of either per
  // room. Waiting ones are dropped with all pending work by cancelGeneration.
  const requestedTurns = new Map<string, RequestedTurn>()
  const runningRequests = new Set<string>()
  const parsedAbandonMs = Number.parseInt(process.env.LEITBILD_TOOL_CHECKIN_ABANDON_MS ?? '', 10)
  const abandonMs = Number.isFinite(parsedAbandonMs) && parsedAbandonMs >= 0
    ? parsedAbandonMs
    : 10 * 60_000  // 10 minutes default
  const checkinEnabled = abandonMs > 0

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === agentId) return config.name
    return agentHistory.agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- Context deps ---

  const contextDeps = (effectiveModel: string, definitions: ReadonlyArray<ToolDefinition> | undefined, turnInstruction?: string): BuildContextDeps => ({
    agentId,
    persona: currentPersona,
    workspacePrompt: getWorkspacePrompt?.(),
    responseFormat: getResponseFormat?.(),
    history: agentHistory,
    historyLimit,
    resolveName,
    getSkills: getSkills === undefined ? undefined : roomId => getSkills(currentSkills, roomId),
    getScriptContext,
    includePrompts: includePromptsState,
    includeContext: includeContextState,
    promptsEnabled,
    contextEnabled,
    contextTokenBudget: resolveContextTokenBudget(effectiveModel, definitions),
    getCompressedIds: (roomId: string) => getCompressedIds?.(roomId) ?? new Set<string>(),
    getCompressionSummary: options?.getCompressionSummary,
    getRoomMembers,
    supportsImages: modelSupportsImages(effectiveModel),
    modelForWarn: effectiveModel,
    metricsSink: options?.metricsSink,
    ...(turnInstruction === undefined ? {} : { turnInstruction }),
  })
  // buildContext walks five sources to assemble the LLM context. Order in
  // src/agents/context-builder.ts top header. Quick map of sources here so
  // a debugger can find the cost without spelunking:
  //   • skills      → getSkills() (skill-store)
  //   • script ctx  → getScriptContext() (script-runner, only in running scripts)
  //   • room hist   → AgentHistory window (historyLimit-sized)
  //   • members     → getRoomMembers (participant profiles + running summary)
  //   • compression → getCompressedIds (folded into single room_summary)

  // --- Evaluation loop: per-room generation with pending queue ---

  const notifyTurnFinished = (executionTurnId: string): void => {
    if (!options?.onTurnFinished) return
    try {
      options.onTurnFinished(executionTurnId)
    } catch (error) {
      console.error(`[${config.name}] Could not release model-comparison capture for turn ${executionTurnId}:`, error)
    }
  }

  // After an agent responds (not pass), delay pending re-evaluation by this amount.
  // This lets other agents' responses coalesce into a single re-evaluation rather than
  // triggering N separate evals. Major reduction in LLM calls for broadcast rooms.
  const EVAL_COOLDOWN_MS = 500

  // Per-evaluate run. The fallback chain walk (across providers/models) is
  // owned by LLMService — it sees the live system policy chain and walks on
  // fallbackable errors mid-stream. Agents do NOT carry their own per-agent
  // chain. The only resilience knob the agent layer adds is the effective-
  // model resolver (current model availability check) below.
  const runEvaluate = async (
    contextResult: ContextResult,
    effectiveModel: string,
    triggerRoomId: string,
    signal: AbortSignal,
    traceId: string,
    evalToolDefs: ReadonlyArray<ToolDefinition> | undefined,
    inReplyTo?: ReadonlyArray<string>,
    requireView?: boolean,
  ): Promise<EvalResult> => {
    const evalConfig = {
      ...baseConfig,
      model: effectiveModel,
      persona: currentPersona,
      temperature: currentTemperature,
      thinking: currentThinking,
      reasoningEffort: currentReasoningEffort,
      historyLimit,
      ...(maxToolIterationsCfg !== undefined ? { maxToolIterations: maxToolIterationsCfg } : {}),
    }
    const evalToolExec = includeTools ? toolExecutor : undefined
    // Stamp traceId onto every event from the inner evaluate loop before
    // forwarding. Internal sites work with EvalEventCore (no traceId
    // plumbing); subscribers see a full EvalEvent.
    const evalEventCb = onEvalEvent
      ? (event: EvalEventCore) => onEvalEvent(
          { agentId, agentName: config.name, roomId: triggerRoomId },
          { ...event, traceId } as EvalEvent,
        )
      : undefined
    // Tool-iteration check-in wiring. Returns a Promise the evaluate loop
    // awaits; the room's pending checkin Map below is keyed by roomId so
    // the agent-level continueTools() can resolve it from the HTTP route.
    // Abandonment timeout bounds state-machine leak when the user never
    // clicks anything (default 10min, env-overridable).
    const requestToolCheckin = (info: { iterations: number; recentTools: ReadonlyArray<{ tool: string; success: boolean }> }): Promise<boolean> => {
      void info  // info already mirrored in the tool_iteration_checkin event onEvent fired
      return new Promise<boolean>(resolve => {
        let resolved = false
        const finish = (continueTurn: boolean): void => {
          if (resolved) return
          resolved = true
          pendingCheckins.delete(triggerRoomId)
          if (timer) clearTimeout(timer)
          if (signal.aborted) resolve(false); else resolve(continueTurn)
        }
        const timer = setTimeout(() => finish(false), abandonMs)
        signal.addEventListener('abort', () => finish(false), { once: true })
        pendingCheckins.set(triggerRoomId, finish)
      })
    }
    const evalOpts = {
      executionTurnId: traceId,
      ...(evalToolDefs ? { toolDefinitions: evalToolDefs } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(requireView ? { requireView } : {}),
      ...(evalEventCb ? { onEvent: evalEventCb } : {}),
      signal,
      ...(checkinEnabled && maxToolIterationsCfg !== undefined ? { requestToolCheckin } : {}),
    }
    if (options?.onTurnStart) {
      signal.throwIfAborted()
      try {
        await options.onTurnStart(structuredClone({
          executionTurnId: traceId,
          roomId: triggerRoomId,
          agentId,
          context: contextResult,
          config: evalConfig,
          toolDefinitions: evalToolDefs ?? [],
          focusedSubjects: focusedSubjectsByRoom.get(triggerRoomId) ?? [],
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(requireView ? { requireView } : {}),
        }))
      } catch (error) {
        // Comparison evidence is optional; its failure must not break ordinary
        // generation. Report it explicitly and leave this turn unavailable for replay.
        const message = `Could not retain the starting input for model comparison: ${error instanceof Error ? error.message : String(error)}`
        console.error(`[${config.name}] ${message}`)
        evalEventCb?.({ kind: 'warning', message })
      }
      signal.throwIfAborted()
    }
    const store = options?.executionStore
    if (!store) return evaluate(
      contextResult, evalConfig, llmProvider, evalToolExec,
      maxToolIterationsCfg, triggerRoomId, evalOpts,
    ) // Standalone/test agents have no persistent Workspace runtime.
    const begin = async (): Promise<void> => {
      signal.throwIfAborted()
      store.beginTurn({ id: traceId, roomId: triggerRoomId, agentId, startedAt: Date.now() })
    }
    if (options?.executionGrowth) await options.executionGrowth(4096, begin)
    else await begin() // In-memory tests have no Workspace storage policy.
    const interrupted = (): void => {
      try { store.finishTurn(traceId, 'interrupted', 'Generation cancelled; calls without a durable result have unknown outcomes') }
      catch (error) { console.error(`[${config.name}] Could not retain cancellation status:`, error) }
    }
    signal.addEventListener('abort', interrupted, { once: true })
    if (signal.aborted) interrupted()
    try {
      const result = await evaluate(
        contextResult, evalConfig, llmProvider, evalToolExec,
        maxToolIterationsCfg, triggerRoomId, evalOpts,
      )
      store.finishTurn(traceId, signal.aborted ? 'interrupted' : result.decision.response.action === 'error' ? 'failed' : 'completed',
        result.decision.response.action === 'error' ? result.decision.response.message : undefined)
      return result
    } catch (error) {
      store.finishTurn(traceId, signal.aborted ? 'interrupted' : 'failed', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      signal.removeEventListener('abort', interrupted)
    }
  }

  // A waiting requested turn runs once the room's own questions are answered:
  // they get an ordinary turn first, so a requested reply never swallows them.
  // One that a script now directs is dropped with a posted reason, because the
  // script's context has no place for its instruction.
  const takeRequestedTurn = (roomId: string): RequestedTurn | undefined => {
    const turn = requestedTurns.get(roomId)
    if (turn === undefined) return undefined
    if (agentHistory.incoming.some(message => message.roomId === roomId && triggersEvaluation(message))) return undefined
    requestedTurns.delete(roomId)
    if (getScriptContext?.(roomId, resolveName(agentId))) {
      onDecision({
        response: { action: 'error', code: 'request_dropped', message: 'A script started directing this room before the requested turn ran; ask again when it ends.' },
        generationMs: 0, triggerRoomId: roomId, inReplyTo: turn.inReplyTo, cause: turn.cause,
      })
      return undefined
    }
    runningRequests.add(roomId)
    return turn
  }

  const tryEvaluate = (triggerRoomId: string): void => {
    if (cm.isBusy()) {
      cm.addPending(triggerRoomId)
      return
    }

    cm.startGeneration(triggerRoomId)
    cm.notifyState('generating', triggerRoomId)
    const requested = takeRequestedTurn(triggerRoomId)

    // Use the newest transient focus carried by this pending turn. It lives
    // only for tool context; it never enters the prompt history or snapshots.
    const triggerMessage = [...agentHistory.incoming].reverse().find(message => message.roomId === triggerRoomId)
    const turnFocus = triggerMessage === undefined ? undefined : messageFocus(triggerMessage)
    if (turnFocus === undefined) focusedSubjectsByRoom.delete(triggerRoomId)
    else focusedSubjectsByRoom.set(triggerRoomId, turnFocus)

    // One traceId per evaluate() call — every EvalEvent for this eval
    // carries it so subscribers (the diagnostics ring buffer + UI) can
    // correlate per-eval state without polling.
    const traceId = generateTraceId()
    const emit = onEvalEvent
      ? (event: EvalEventCore) => onEvalEvent(
          { agentId, agentName: config.name, roomId: triggerRoomId },
          { ...event, traceId } as EvalEvent,
        )
      : undefined

    const epoch = cm.epochAtStart()

    // Resolve effective model per call. `currentModel` is the user's intent
    // (preferred); the resolver decides whether to fall through to a default
    // when the preferred provider isn't currently usable. Identity if no
    // resolver was wired (tests, MCP-only mode).
    const resolved = resolveEffective
      ? resolveEffective(currentModel)
      : { model: currentModel, fallback: false, reason: 'preferred_available' }
    const effectiveModel = resolved.model
    if (resolved.fallback && effectiveModel !== currentModel) {
      // One-shot per fallback target — re-emit only when the target changes
      // (which it does when the preferred model recovers and then breaks again).
      if (lastFallbackTarget !== effectiveModel && emit) {
        emit({
          kind: 'model_fallback',
          preferred: currentModel,
          effective: effectiveModel,
          reason: resolved.reason,
        })
      }
      lastFallbackTarget = effectiveModel
    } else if (!resolved.fallback) {
      lastFallbackTarget = null
    }

    const abortController = new AbortController()
    activeAbortController = abortController
    // epoch guards: each cancelGeneration() increments generationEpoch so stale
    // in-flight results from a prior generation cycle are silently discarded.
    const run = async (): Promise<void> => {
      let wasRespond = false
      try {
        const info = await llmProvider.modelInfo?.(effectiveModel)
        if (!cm.isEpochCurrent(epoch) || abortController.signal.aborted) return
        describedModel = { requested: effectiveModel, info: info ?? { id: effectiveModel, provider: 'unknown', contextMax: 0, source: 'unavailable' } }
        const effectiveToolDefs = effectiveToolsForRoom(triggerRoomId)
        const initialContext = buildContext(contextDeps(effectiveModel, effectiveToolDefs, requested?.instruction), triggerRoomId)
        // Only prior replay uses the working target. During a tool turn, keep
        // complete new evidence and fit older history to actual known capacity.
        const toolTokens = estimateTokens(JSON.stringify(effectiveToolDefs ?? []))
        const contextResult: ContextResult = { ...initialContext,
          tokenBudget: info && info.contextMax > 0 ? Math.max(0, info.contextMax - toolTokens - OUTPUT_RESERVE - SAFETY_MARGIN) : undefined,
        }
        // A requested turn replies first to what it was asked about.
        const replyIds = [...new Set([...(requested?.inReplyTo ?? []), ...contextResult.flushInfo.ids])]
        const inReplyTo = replyIds.length > 0 ? replyIds : undefined
        // Pack-aware tool count for the context_ready event — same resolution
        // path the eval will take, so the UI's tool-count badge matches what
        // the LLM actually sees.
        // Emit context_ready + any context builder warnings before LLM call
        if (emit) {
          emit({
            kind: 'context_ready',
            messages: contextResult.messages,
            model: effectiveModel,
            temperature: currentTemperature,
            toolCount: effectiveToolDefs?.length ?? 0,
          })
          for (const w of contextResult.warnings) {
            emit({ kind: 'warning', message: w })
          }
          // Skill / tool surface coherence check: if an active skill declares
          // `allowed-tools: [...]` in its frontmatter, every tool it lists
          // should be in the LLM-facing surface — otherwise the prompt and
          // tool list contradict each other and models rationalise refusal
          // (the prod biometrics symptom). Coherence warnings show up in the
          // diagnostic API immediately. Not a hard gate — the skill text
          // wins as a recommendation, but the agent may still call other
          // tools. The warning makes the mismatch visible.
          if (getActiveSkillsDeclarations && effectiveToolDefs) {
            const surfaceNames = new Set(effectiveToolDefs.map(d => d.function.name))
            const skills = getActiveSkillsDeclarations(currentSkills, triggerRoomId)
            for (const skill of skills) {
              const missing = skill.declaredTools.filter(t => !surfaceNames.has(t))
              if (missing.length > 0) {
                emit({
                  kind: 'warning',
                  message: `Skill "${skill.name}" declares tools not in the LLM surface: ${missing.join(', ')}. Check pack activation in this room.`,
                })
              }
            }
          }
        }
        const { decision, flushInfo } = await runEvaluate(
          contextResult, effectiveModel, triggerRoomId, abortController.signal, traceId, effectiveToolDefs, inReplyTo, requested?.requireView,
        )
        if (!cm.isEpochCurrent(epoch)) return  // cancelled — discard stale result

        wasRespond = decision.response.action === 'respond'

        // Flush incoming always — on both respond and pass.
        // On pass, the agent has consciously evaluated these messages; they belong in history.
        flushIncoming(flushInfo, agentHistory, historyLimit)
        onDecision({ ...decision, generationTraceId: traceId, ...(requested ? { cause: requested.cause } : {}) })
      } catch (err) {
        if (!cm.isEpochCurrent(epoch)) return  // cancelled, ignore error
        // Unexpected throw — evaluate() catches LLM-layer errors and converts
        // them to action='error' decisions, so this branch is rare (programmer
        // error, OOM, etc.). Without a synthetic decision, the agent silently
        // goes idle: thinking indicator vanishes, no message, no toast.
        // Surface it as an error decision so the user sees something.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[${config.name}] Evaluation error:`, err)
        try {
          onDecision({
            response: {
              action: 'error',
              code: 'unknown',
              message: `Unexpected evaluation error: ${message}`,
            },
            generationMs: 0,
            triggerRoomId,
            generationTraceId: traceId,
            ...(requested ? { inReplyTo: requested.inReplyTo, cause: requested.cause } : {}),
          })
        } catch (decisionErr) {
          console.error(`[${config.name}] onDecision threw while reporting eval error:`, decisionErr)
        }
      } finally {
        if (requested) runningRequests.delete(triggerRoomId)
        notifyTurnFinished(traceId)
        if (cm.isEpochCurrent(epoch)) {
          // A requested turn that waited behind this room's questions runs next.
          if (requestedTurns.has(triggerRoomId)) cm.addPending(triggerRoomId)
          cm.endGeneration(triggerRoomId)
          // Check for pending work: same room first, then any other room
          const nextRoom = cm.consumePending(triggerRoomId)
            ? triggerRoomId
            : cm.nextPending() ?? undefined
          if (nextRoom) {
            if (nextRoom !== triggerRoomId) cm.consumePending(nextRoom)
            // After a respond, delay re-evaluation to let other agents' messages coalesce
            if (wasRespond) {
              setTimeout(() => {
                if (cm.isEpochCurrent(epoch)) tryEvaluate(nextRoom)
              }, EVAL_COOLDOWN_MS)
            } else {
              tryEvaluate(nextRoom)
            }
          }
        }
      }
    }
    void run()
  }

  // --- Receive ---
  // All messages have a roomId. Own messages go straight to room history for
  // re-evaluation continuity without triggering a new eval.

  const receive = (message: Message): void => {
    extractProfile(message, agentId, agentHistory.agentProfiles)

    if (message.senderId === agentId) {
      const ctx = agentHistory.rooms.get(message.roomId)
      if (ctx) ctx.history = [...ctx.history, message].slice(-historyLimit)
      return
    }

    agentHistory.incoming.push(message)

    if (!triggersEvaluation(message)) return

    tryEvaluate(message.roomId)
  }

  // --- Join ---
  // Initialises RoomContext BEFORE any messages are delivered. Joining is a
  // local operation: the Room already owns a compressed canonical transcript,
  // so opening an assistant must not spend an extra model call summarising it.

  const join = async (room: Room): Promise<void> => {
    // Initialise context — profile available here, before messages arrive.
    // Use a getter so the stored profile tracks the Room live (room name and
    // roomPrompt can change after the agent joins; stale snapshots broke the
    // Context panel's room-prompt preview).
    agentHistory.rooms.set(room.profile.id, {
      get profile() { return room.profile },
      history: room.getRecent(historyLimit),
      lastActiveAt: undefined,
    })

    const recent = room.getRecent(historyLimit)
    for (const msg of recent) {
      extractProfile(msg, agentId, agentHistory.agentProfiles)
    }
  }

  // Live metadata — mutated by updateTags so team.listByTag sees current
  // values without needing to rebuild the agent.
  const liveMetadata: Record<string, unknown> = { model: currentModel, tags: currentTags }

  return {
    id: agentId,
    name: config.name,
    kind: 'ai',
    metadata: liveMetadata,
    state: cm.state,
    receive,
    join,
    leave: (roomId: string): void => {
      agentHistory.rooms.delete(roomId)
    },
    whenIdle: cm.whenIdle,
    getTags: () => currentTags,
    updateTags: (tags: ReadonlyArray<string>) => {
      currentTags = tags
      liveMetadata.tags = tags
    },
    updatePersona: (persona: string) => { currentPersona = persona },
    getPersona: () => currentPersona,
    updateModel: (model: string) => { currentModel = model },
    getModel: () => currentModel,
    getTemperature: () => currentTemperature,
    updateTemperature: (t: number | undefined) => { currentTemperature = t },
    getHistoryLimit: () => historyLimit,
    updateHistoryLimit: (n: number) => {
      historyLimit = n
      for (const ctx of agentHistory.rooms.values()) ctx.history = ctx.history.slice(-historyLimit)
    },
    getThinking: () => currentThinking,
    updateThinking: (enabled: boolean) => { currentThinking = enabled },
    getReasoningEffort: () => currentReasoningEffort,
    updateReasoningEffort: (effort) => { currentReasoningEffort = effort },
    getHistoryTokenBudget: () => currentHistoryTokenBudget,
    updateHistoryTokenBudget: (tokens) => { currentHistoryTokenBudget = tokens },
    getTools: () => currentTools,
    updateTools: (tools: ReadonlyArray<string>) => { currentTools = tools },
    getSkills: () => currentSkills,
    updateSkills: (skills: ReadonlyArray<string>) => { currentSkills = [...skills] },
    getFocusedSubjects: (roomId: string) => focusedSubjectsByRoom.get(roomId) ?? [],
    getIncludePrompts: () => ({ ...includePromptsState }),
    updateIncludePrompts: (partial: IncludePrompts) => {
      for (const key of Object.keys(partial) as PromptSection[]) {
        const v = partial[key]
        if (typeof v === 'boolean') includePromptsState[key] = v
      }
    },
    getIncludeContext: () => ({ ...includeContextState }),
    updateIncludeContext: (partial: IncludeContext) => {
      for (const key of Object.keys(partial) as ContextSection[]) {
        const v = partial[key]
        if (typeof v === 'boolean') includeContextState[key] = v
      }
    },
    getIncludeTools: () => includeTools,
    updateIncludeTools: (enabled: boolean) => { includeTools = enabled },
    getPromptsEnabled: () => promptsEnabled,
    updatePromptsEnabled: (enabled: boolean) => { promptsEnabled = enabled },
    getContextEnabled: () => contextEnabled,
    updateContextEnabled: (enabled: boolean) => { contextEnabled = enabled },
    getMaxToolIterations: () => maxToolIterationsCfg,
    updateMaxToolIterations: (n: number | undefined) => {
      maxToolIterationsCfg = (typeof n === 'number' && n > 0) ? n : undefined
    },
    getContextPreview: (roomId: string) => {
      const defs = effectiveToolsForRoom(roomId)
      const deps = contextDeps(currentModel, defs)
      const sections = buildSystemSections(deps, roomId)
      const roomCtx = agentHistory.rooms.get(roomId)
      const previewSections = sections.map(s => ({
        key: s.key,
        label: s.label,
        text: s.text,
        tokens: estimateTokens(s.text),
        enabled: s.enabled,
        optional: s.optional,
      }))
      // History estimate: rough char count over the post-trim window.
      const history = roomCtx?.history ?? []
      const windowed = history.length > historyLimit ? history.slice(-historyLimit) : history
      const historyChars = windowed.reduce((sum, m) => sum + m.content.length, 0)
      return {
        roomId,
        roomName: roomCtx?.profile.name ?? '',
        sections: previewSections,
        modelMax: resolveModelMax(),
        historyEstimate: { messages: windowed.length, chars: historyChars },
      }
    },
    getConfig: () => ({
      ...baseConfig,
      model: currentModel,
      persona: currentPersona,
      temperature: currentTemperature,
      historyLimit,
      historyTokenBudget: currentHistoryTokenBudget,
      thinking: currentThinking,
      reasoningEffort: currentReasoningEffort,
      tools: currentTools,
      skills: currentSkills,
      tags: currentTags,
      includePrompts: { ...includePromptsState },
      includeContext: { ...includeContextState },
      includeTools,
      promptsEnabled,
      contextEnabled,
      ...(maxToolIterationsCfg !== undefined ? { maxToolIterations: maxToolIterationsCfg } : {}),
      ...(currentTriggers.length > 0 ? { triggers: [...currentTriggers] } : {}),
    }),
    cancelGeneration: () => { activeAbortController?.abort(); activeAbortController = null; requestedTurns.clear(); cm.cancelAll() },
    requestTurn: (roomId: string, turn: RequestedTurn) => {
      if (requestedTurns.has(roomId) || runningRequests.has(roomId)) return { kind: 'refused', reason: 'pending', message: `${config.name} is already working on a request in this room; ask again when its reply arrives` }
      if (getScriptContext?.(roomId, resolveName(agentId))) return { kind: 'refused', reason: 'script', message: 'A script directs this room; requested turns wait until it ends' }
      const queued = cm.isBusy()
      requestedTurns.set(roomId, turn)
      tryEvaluate(roomId)
      return { kind: 'accepted', queued }
    },
    continueTools: (roomId: string): boolean => {
      const pending = pendingCheckins.get(roomId)
      if (!pending) return false
      pending(true)
      return true
    },
    refreshTools: (support) => {
      if (support.toolExecutor !== undefined) toolExecutor = support.toolExecutor
      if (support.toolDefinitions !== undefined) toolDefinitions = support.toolDefinitions
      if (support.resolveToolDefinitions !== undefined) resolveToolDefinitions = support.resolveToolDefinitions
    },
    // Manual-mode primitive: append unseen messages to the room's history
    // without triggering eval or compression. `extractProfile` still runs so
    // peer profile awareness stays current. No-op for rooms the agent isn't
    // in — relies on a prior `join()`.
    ingestHistory: (roomId: string, messages: ReadonlyArray<Message>): void => {
      const ctx = agentHistory.rooms.get(roomId)
      if (!ctx) return
      const seen = new Set(ctx.history.map(m => m.id))
      for (const msg of messages) {
        if (seen.has(msg.id)) continue
        extractProfile(msg, agentId, agentHistory.agentProfiles)
        ctx.history = [...ctx.history, msg].slice(-historyLimit)
        seen.add(msg.id)
      }
    },
    // Manual-mode primitive: force one evaluation for the given room, bypassing
    // the room's delivery-mode check. If the agent is busy elsewhere, the
    // concurrency manager queues this via its own pending list.
    forceEvaluate: (roomId: string): void => {
      tryEvaluate(roomId)
    },
    getHistory: (roomId: string) => [...(agentHistory.rooms.get(roomId)?.history ?? [])],
    getIncoming: () => [...agentHistory.incoming],
    getMemoryStats: () => ({
      rooms: [...agentHistory.rooms.entries()].map(([roomId, ctx]) => ({
        roomId,
        roomName: ctx.profile.name,
        messageCount: ctx.history.length,
        lastActiveAt: ctx.lastActiveAt,
      })),
      incomingCount: agentHistory.incoming.length,
      knownAgents: [...new Set([...agentHistory.agentProfiles.values()].map(p => p.name))],
    }),
    clearHistory: (roomId?: string) => {
      if (roomId) {
        const ctx = agentHistory.rooms.get(roomId)
        if (ctx) ctx.history = []
        const remaining = agentHistory.incoming.filter(m => m.roomId !== roomId)
        agentHistory.incoming.length = 0
        agentHistory.incoming.push(...remaining)
      } else {
        for (const ctx of agentHistory.rooms.values()) ctx.history = []
        agentHistory.incoming.length = 0
      }
    },
    forgetAgent: (removedAgentId: string) => {
      // Drop the cached profile so this agent no longer lists the removed
      // participant under "Known agents". Messages that referenced the ID
      // remain in history (with the sender name now resolving to raw id),
      // but that's acceptable — history is immutable record.
      agentHistory.agentProfiles.delete(removedAgentId)
    },
    deleteHistoryMessage: (roomId: string, messageId: string) => {
      const ctx = agentHistory.rooms.get(roomId)
      if (!ctx) return false
      const idx = ctx.history.findIndex(m => m.id === messageId)
      if (idx === -1) return false
      ctx.history = [...ctx.history.slice(0, idx), ...ctx.history.slice(idx + 1)]
      return true
    },
    // --- Triggers ---
    getTriggers: () => currentTriggers,
    addTrigger: (t) => { currentTriggers = [...currentTriggers, t] },
    updateTrigger: (id, patch) => {
      const idx = currentTriggers.findIndex(x => x.id === id)
      if (idx < 0) return false
      const next = [...currentTriggers]
      next[idx] = { ...next[idx]!, ...patch, id }
      currentTriggers = next
      return true
    },
    deleteTrigger: (id) => {
      const before = currentTriggers.length
      currentTriggers = currentTriggers.filter(x => x.id !== id)
      return currentTriggers.length < before
    },
    markTriggerFired: (id, when) => {
      const idx = currentTriggers.findIndex(x => x.id === id)
      if (idx < 0) return
      const next = [...currentTriggers]
      next[idx] = { ...next[idx]!, lastFiredAt: when }
      currentTriggers = next
    },
    // Trigger execute-mode dispatch. Runs the prompt as a transient trailing
    // user message in a normal eval. Pending incoming user messages are held
    // aside (NOT consumed by the trigger) and re-queued after the trigger
    // eval completes — so a user post mid-trigger still gets processed.
    // The trigger prompt is never persisted: not in incoming, not in room
    // history. action='pass' suppresses posting (handles "report only changes").
    fireTriggerExecute: async (prompt: string, roomId: string): Promise<void> => {
      if (cm.isBusy()) return  // defensive; scheduler should have skipped

      const heldIncoming = agentHistory.incoming.splice(0, agentHistory.incoming.length)
      cm.startGeneration(roomId)
      cm.notifyState('generating', roomId)

      const epoch = cm.epochAtStart()
      const abortController = new AbortController()
      activeAbortController = abortController
      const triggerTraceId = generateTraceId()

      try {
        // Resolve effective model (mirrors tryEvaluate).
        const resolved = resolveEffective
          ? resolveEffective(currentModel)
          : { model: currentModel, fallback: false, reason: 'preferred_available' as const }
        const effectiveModel = resolved.model

        const effectiveToolDefs = effectiveToolsForRoom(roomId)
        const baseCtx = buildContext(contextDeps(effectiveModel, effectiveToolDefs), roomId)
        // Append the trigger prompt as a transient trailing user message.
        // Not in incoming, so flushIncoming has nothing to do; the prompt
        // never lands in room history.
        const messages = [
          ...baseCtx.messages,
          { role: 'user' as const, content: prompt },
        ]
        const contextResult = {
          ...baseCtx,
          messages,
          flushInfo: { ids: new Set<string>(), triggerRoomId: roomId },
        }

        const { decision } = await runEvaluate(
          contextResult, effectiveModel, roomId, abortController.signal, triggerTraceId, effectiveToolDefs,
        )
        if (!cm.isEpochCurrent(epoch)) return  // cancelled
        onDecision({ ...decision, generationTraceId: triggerTraceId })
      } catch (err) {
        if (cm.isEpochCurrent(epoch)) {
          console.error(`[${config.name}] trigger execute failed:`, err)
        }
      } finally {
        notifyTurnFinished(triggerTraceId)
        // Restore held incoming at the front; new arrivals during eval are
        // already at the back. Order preserved: held first, then new.
        if (heldIncoming.length > 0) {
          agentHistory.incoming.unshift(...heldIncoming)
        }
        if (cm.isEpochCurrent(epoch)) {
          cm.endGeneration(roomId)
          // Resume queued work: rooms that asked while the trigger ran (a
          // requested turn has no incoming message), then held messages.
          const next = cm.nextPending() ?? agentHistory.incoming[0]?.roomId
          if (next !== undefined) {
            cm.consumePending(next)
            tryEvaluate(next)
          }
        }
      }
    },
  }
}
