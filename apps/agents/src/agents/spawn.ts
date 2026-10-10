// ============================================================================
// Spawn — Wiring functions that create agents and connect them to the system.
// Creates agent → adds to team → joins rooms → posts join messages.
// Wires the onDecision callback to bridge agent decisions to routeMessage.
//
// resolveTarget translates LLM names → internal UUIDs using findByName.
// toolExecutor bridges agent tool calls to the global tool registry.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from '../core/types/agent.ts'
import type { Room } from '../core/types/room.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { WorkspaceSettings } from '../core/workspaces/settings.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { LLMService } from '../llm/llm-service.ts'
import type { MessageTarget } from '../core/types/messaging.ts'
import type { Tool, ToolCall, ToolContext, ToolDefinition, ToolExecutor, ToolRegistry, ToolResult } from '../core/types/tool.ts'
import { owningPackFor } from '../core/types/tool-pack.ts'
import { createAIAgent } from './ai-agent.ts'
import type { AgentTurnStart, Decision } from './ai-agent.ts'
import { callLLM, streamLLM } from './evaluation.ts'
import { addAgentToRoom } from './actions.ts'
import { createToolSurface } from '../tool-surface/index.ts'
import { WORKSPACE_CAPABILITY_TOOL_NAMES } from '../tools/built-in/workspace-capability-tools.ts'
import type { WorkspaceSubjectReference } from '@leitbild/contracts'
import type { ExecutionStore } from '../core/executions/store.ts'

export type ExecutionGrowth = <T>(bytes: number, work: () => Promise<T>) => Promise<T>
export type RunToolOperation = <T>(work: () => Promise<T>) => Promise<T>

interface AgentToolContextRef {
  id: string
  name: string
  currentLLMSettings?: () => Pick<AIAgentConfig, 'model' | 'seed' | 'thinking' | 'reasoningEffort'>
  focusedSubjects?: (roomId: string) => ReadonlyArray<WorkspaceSubjectReference>
}

// --- Tool executor ---

// Tool access has two explicit dimensions: the Agent's exact tool selection
// and, for Pack-owned tools only, the Room's active Pack set.

export const createToolExecutor = (
  registry: ToolRegistry,
  allowedTools: ReadonlyArray<string>,
  context: ToolContext,
  getRoomActivation?: GetRoomActivation,
  getFocusedSubjects?: (roomId: string) => ReadonlyArray<WorkspaceSubjectReference>,
  executionStore?: ExecutionStore,
  executionGrowth?: ExecutionGrowth,
  runToolOperation?: RunToolOperation,
): ToolExecutor => {
  const allowed = new Set(allowedTools)

  return async (calls: ReadonlyArray<ToolCall>, roomId?: string, signal?: AbortSignal, executionTurnId?: string): Promise<ReadonlyArray<ToolResult>> => {
    const results: ToolResult[] = []
    const callContext: ToolContext = roomId
      ? { ...context, roomId, focusedSubjects: getFocusedSubjects?.(roomId) ?? [] }
      : context

    // Two access gates: Agent Tool Selection and, where applicable, Room
    // Pack activation. NO skill-level whitelist: skill
    // `allowed-tools` is documentary only (see README + ai-agent.ts
    // coherence check). Earlier versions of this executor enforced
    // the skill whitelist at runtime — that contradicted the README,
    // produced silent tool_loop_exceeded errors in rooms with
    // restrictively-declared skills (biometric-awareness in particular),
    // and overloaded "skill metadata" with "permission policy."
    // Removed 2026-05-12; see the PR that deletes spawn-allowed-tools.test.ts.
    for (const call of calls) {
      signal?.throwIfAborted()
      // Standalone/test executors intentionally need no persistent Workspace.
      // Runtime executors must have a turn identity before any dispatch.
      if (executionStore && (!executionTurnId || !call.callId)) throw new Error('Execution turn and call identity are required before dispatch')
      if (executionStore) {
        const attempt = async (): Promise<void> => {
          signal?.throwIfAborted()
          executionStore.recordAttempt(executionTurnId!, {
            id: call.callId!, tool: call.tool, arguments: call.arguments,
            ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}), startedAt: Date.now(),
          })
        }
        // One SQLite page is conservatively reserved for row/index overhead;
        // the actual file size remains the budget authority on next admission.
        if (executionGrowth) await executionGrowth(new TextEncoder().encode(JSON.stringify(call)).byteLength + 4096, attempt)
        else await attempt() // Isolated in-memory tests have no Workspace budget.
      }
      const retainOutcome = (result: ToolResult): ToolResult => {
        // Never quota-reject known evidence after an action already happened.
        executionStore?.recordOutcome(executionTurnId!, call.callId!, result)
        return result
      }
      // Rejections name the exact dimension that needs changing. The operator's mental
      // model is "I see this tool in the inspector → it should work." When
      // it doesn't, the message must name what to change: the agent's
      // allowlist OR the room's pack activation.
      if (!allowed.has(call.tool)) {
        results.push(retainOutcome({ success: false, error: `Tool "${call.tool}" is not in this Agent's tool selection` }))
        continue
      }

      const entry = registry.getEntry(call.tool)
      if (!entry) {
        results.push(retainOutcome({ success: false, error: `Tool "${call.tool}" is not registered` }))
        continue
      }
      const owningPack = owningPackFor(entry)
      const room = roomId === undefined || getRoomActivation === undefined
        ? undefined
        : getRoomActivation(roomId)
      if (owningPack !== undefined && room !== undefined && !room.getActivePacks().includes(owningPack)) {
        results.push(retainOutcome({ success: false, error: `Tool "${call.tool}" belongs to Pack "${owningPack}", which is not active in this Room` }))
        continue
      }

      const controller = new AbortController()
      const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const timer = setTimeout(() => controller.abort(new Error(`Tool "${call.tool}" timed out after 30s; inspect state before retrying a command`)), 30_000)
      let rejectAbort: () => void = () => {}
      let dispatched = false
      try {
        const cancelled = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(callSignal.reason)
          callSignal.addEventListener('abort', rejectAbort, { once: true })
          if (callSignal.aborted) rejectAbort()
        })
        const dispatch = async (): Promise<ToolResult> => {
          // Admission/cancellation before dispatch is not a tool outcome.
          // In particular, a queued Workspace operation may already be stale.
          callSignal.throwIfAborted()
          let result: ToolResult
          dispatched = true
          try { result = await entry.tool.execute(call.arguments, { ...callContext, signal: callSignal, ...(call.callId === undefined ? {} : { executionCallId: call.callId }) }) }
          catch (err) {
            console.error(`[tool] "${call.tool}" execution failed:`, err)
            result = { success: false, error: err instanceof Error ? err.message : 'Tool execution failed' }
          }
          return retainOutcome(result)
        }
        // Existing Workspace lifetime ownership must outlive the abort race:
        // an uncooperative tool still needs its store when its real result arrives.
        const execution = Promise.resolve().then(() => runToolOperation ? runToolOperation(dispatch) : dispatch())
        void execution.catch(error => {
          // Pre-dispatch cancellation has no result to retain. Errors after
          // actual dispatch must still be visible after the abort race ends.
          if (callSignal.aborted && dispatched) console.error(`[tool] "${call.tool}" late outcome could not be retained:`, error)
        })
        // If cancellation wins, the real promise still records its eventual
        // result. A timeout itself is not evidence the action did not happen.
        const result = await Promise.race([execution, cancelled])
        results.push(result)
      } catch (err) {
        if (!callSignal.aborted) throw err // Persistence failures must stop dispatch, not pretend to be tool outcomes.
        const reason = `Tool "${call.tool}" interrupted; outcome is unknown. Inspect retained evidence and current state before retrying.`
        executionStore?.finishTurn(executionTurnId!, 'interrupted', reason)
        // Do not dispatch another call from this response after interruption.
        throw new Error(reason)
      } finally {
        clearTimeout(timer)
        callSignal.removeEventListener('abort', rejectAbort)
      }
    }

    return results
  }
}

// Test seam — executor isn't part of the public spawn API but is the
// load-bearing piece for the two-gate tool access check (agent's spawn-time
// allowlist + per-room pack activation). Exported so tests can construct
// an executor directly without standing up an agent.
export const __testSeam = { createToolExecutor }

// --- Tool support resolution ---
// Extracted so it is independently named and testable.
// Uses an agentRef (filled after agent creation) so the lazy ToolContext
// captures the agent's id/name without a circular dependency.

export interface AgentToolSupport {
  readonly toolExecutor?: ToolExecutor
  // Static tool definitions — the maximal set across all rooms. Used as a
  // fallback when no resolver is wired (tests, MCP-only mode, room not
  // found). Pack-aware spawns also set resolveToolDefinitions, which the
  // agent prefers per eval.
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  // Per-eval tool surface resolver. Filters definitions + executor allow-set
  // by the active packs in `roomId`. Returns null when the room is unknown
  // (caller falls back to the static toolDefinitions).
  //
  // The LLM sees only selected tools whose owning Packs are active.
  readonly resolveToolDefinitions?: (roomId: string) => ReadonlyArray<ToolDefinition> | null
}

const warnMissingTools = (agentName: string, requested: ReadonlyArray<string>, registry: ToolRegistry): void => {
  const missing = requested.filter(n => !registry.has(n))
  if (missing.length > 0)
    console.warn(`[spawn] Agent "${agentName}": tools not found in registry: ${missing.join(', ')}`)
}

// Resolves a room → pack-activation view. Used by the per-eval tool surface
// resolver to filter the static tool list down to tools whose owning pack is
// active in the current room. Returns undefined when the room is unknown
// (caller falls through to the static toolDefinitions).
export type GetRoomActivation = (roomId: string) =>
  | { readonly getActivePacks: () => ReadonlyArray<string> }
  | undefined

// Build tool support — always uses native tool calling.
// The pass tool is auto-injected so all agents can decline to respond.
// Live Agent settings also apply to tool-initiated model calls, including
// after edits and tool refresh. Tool-authored prompts remain independent.
//
// `getRoomActivation`, when provided, enables the per-room tool-surface
// filter (the bloat fix): the resolver reads the room's active packs and
// the LLM only sees definitions owned by those packs. Without it, the
// behavior is unchanged from pre-pack days.
export const buildToolSupport = async (
  toolNames: ReadonlyArray<string>,
  registry: ToolRegistry,
  agentRef: AgentToolContextRef,
  llmProvider: LLMProvider,
  getRoomActivation?: GetRoomActivation,
  executionStore?: ExecutionStore,
  executionGrowth?: ExecutionGrowth,
  runToolOperation?: RunToolOperation,
): Promise<AgentToolSupport> => {
  // Always include the pass tool (auto-injected for all agents)
  const allToolNames = toolNames.includes('pass') ? toolNames : [...toolNames, 'pass']

  const availableTools = allToolNames
    .map(name => registry.get(name))
    .filter((t): t is Tool => t !== undefined)

  if (availableTools.length === 0) return {}

  const currentLLMSettings = () => {
    if (!agentRef.currentLLMSettings) throw new Error('Calling Agent model settings are unavailable')
    const settings = agentRef.currentLLMSettings()
    return {
      model: settings.model,
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(settings.thinking !== undefined ? { think: settings.thinking } : {}),
      ...(settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {}),
    }
  }
  const lazyContext: ToolContext = {
    get callerId() { return agentRef.id },
    get callerName() { return agentRef.name },
    llm: (request) => callLLM(llmProvider, {
      ...request,
      ...currentLLMSettings(),
    }),
    llmStream: (request) => streamLLM(llmProvider, {
      ...request,
      ...currentLLMSettings(),
    }),
  }
  const surface = createToolSurface({
    registry,
    requestedTools: allToolNames,
    getRoomActivation,
  })
  const executor = createToolExecutor(
    registry,
    allToolNames,
    lazyContext,
    getRoomActivation,
    roomId => agentRef.focusedSubjects?.(roomId) ?? [],
    executionStore,
    executionGrowth,
    runToolOperation,
  )

  // Initial projection has no Room context. Each evaluation reads activation.
  const support: { -readonly [K in keyof AgentToolSupport]: AgentToolSupport[K] } = {
    toolExecutor: executor,
    toolDefinitions: surface.project(undefined),
  }

  if (getRoomActivation) {
    // A missing Room yields null for headless/test callers using static tools.
    support.resolveToolDefinitions = (roomId: string): ReadonlyArray<ToolDefinition> | null => {
      if (!getRoomActivation(roomId)) return null
      return surface.project(roomId)
    }
  }

  return support
}

export const effectiveAgentToolSelection = (config: AIAgentConfig): ReadonlyArray<string> => {
  const selectedTools = config.tools ?? []
  return [...new Set([...selectedTools, ...WORKSPACE_CAPABILITY_TOOL_NAMES, 'conversation_read'])]
}

const resolveAgentTools = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolRegistry: ToolRegistry | undefined,
  agentRef: AgentToolContextRef,
  getRoomActivation?: GetRoomActivation,
  executionStore?: ExecutionStore,
  executionGrowth?: ExecutionGrowth,
  runToolOperation?: RunToolOperation,
): Promise<AgentToolSupport> => {
  if (!toolRegistry) return {}
  const requestedTools = effectiveAgentToolSelection(config)

  if (requestedTools.length > 0) {
    warnMissingTools(config.name, requestedTools, toolRegistry)
  }

  return buildToolSupport(
    requestedTools,
    toolRegistry,
    agentRef,
    llmProvider,
    getRoomActivation,
    executionStore,
    executionGrowth,
    runToolOperation,
  )
}

// --- Spawn AI Agent ---

export interface SpawnOptions {
  readonly onTurnStart?: (input: AgentTurnStart) => Promise<void>
  readonly onTurnFinished?: (executionTurnId: string) => void
  readonly onTurnMessageLinked?: (input: {
    readonly executionTurnId: string
    readonly roomId: string
    readonly messageId: string
  }) => void
  readonly executionStore?: ExecutionStore
  readonly executionGrowth?: ExecutionGrowth
  readonly runToolOperation?: RunToolOperation
  readonly overrideId?: string
  readonly getSkills?: (skillNames: ReadonlyArray<string>, roomId: string) => string
  readonly getActiveSkillsDeclarations?: (skillNames: ReadonlyArray<string>, roomId: string) => ReadonlyArray<{
    readonly name: string
    readonly declaredTools: ReadonlyArray<string>
  }>
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
  readonly onEvalEvent?: import('../core/types/agent-eval.ts').OnEvalEvent
  // Per-room pack-activation resolver. When provided, the LLM tool surface
  // is filtered per eval to tools owned by packs active in the trigger
  // room. Built-in and authored tools have no Pack owner. This is the structural
  // fix for tool-context bloat — without it, every agent sees every tool
  // the registry has registered.
  readonly getRoomActivation?: GetRoomActivation
  // Per-call effective-model resolver. Forwarded verbatim into createAIAgent's
  // options so each eval picks an effective model from the user's preferred +
  // currently-available providers, without ever mutating the agent's stored
  // model.
  readonly resolveEffectiveModel?: (preferred: string) => {
    readonly model: string
    readonly fallback: boolean
    readonly reason: string
  }
  // Process-global counter sink (shared.limitMetrics). Forwarded into
  // createAIAgent's options so the multimodal placeholder-substitution
  // path can bump multimodalImagesDropped for /api/system/health.
  readonly metricsSink?: { inc: (field: 'multimodalImagesDropped', by?: number) => void }
}

export const spawnAIAgent = async (
  config: AIAgentConfig,
  llmService: LLMService,
  rooms: RoomDirectory,
  settings: WorkspaceSettings,
  team: Team,
  routeMessage: RouteMessage,
  toolRegistry?: ToolRegistry,
  spawnOptions?: SpawnOptions,
): Promise<AIAgent> => {
  // Bind once per agent: source='agent', agentId baked in, chain-switch
  // events surface via onEvalEvent as the existing model_fallback kind.
  // agentId is fixed up-front so the bound provider can carry it before
  // createAIAgent is called (resolveAgentTools needs the provider too).
  const agentId = spawnOptions?.overrideId ?? crypto.randomUUID()
  // Per-agent one-shot dedup: emit model_fallback only when the effective
  // target CHANGES (or after recovery — preferred served successfully). A
  // primary stuck in backoff would otherwise emit a notice on every eval.
  // The per-(agentId, provider) WS dedup window is 5s; this layer is
  // additionally per-target so a long outage produces ONE notice, not one
  // per call.
  let lastFallbackTarget: string | null = null
  const onChainSwitch = spawnOptions?.onEvalEvent
    ? (preferred: string, effective: string, reason: string) => {
        if (lastFallbackTarget === effective) return
        lastFallbackTarget = effective
        spawnOptions.onEvalEvent!(
          { agentId, agentName: config.name },
          { kind: 'model_fallback', preferred, effective, reason },
        )
      }
    : undefined
  const llmProvider: LLMProvider = llmService.bound({
    source: 'agent',
    agentId,
    ...(onChainSwitch ? { onChainSwitch } : {}),
  })
  // Validate name before any expensive work — prevents orphaned agent creation on collision
  if (team.getAgent(config.name)) {
    throw new Error(`Agent name "${config.name}" is already taken`)
  }

  const onDecision = (decision: Decision): void => {
    const target: MessageTarget = { rooms: [decision.triggerRoomId] }
    // Metrics — tokens, contextMax, provider — flow as typed optional fields
    // on the posted message. Undefined fields are omitted to keep snapshots
    // compact and to satisfy the exactOptionalPropertyTypes tsconfig.
    const m = decision.metrics ?? {}
    const telemetry = {
      ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
      ...(m.lastPromptTokens !== undefined ? { lastPromptTokens: m.lastPromptTokens } : {}),
      ...(m.completionTokens !== undefined ? { completionTokens: m.completionTokens } : {}),
      ...(m.cacheCreation !== undefined ? { cacheCreation: m.cacheCreation } : {}),
      ...(m.cacheRead !== undefined ? { cacheRead: m.cacheRead } : {}),
      ...(m.cacheMiss !== undefined ? { cacheMiss: m.cacheMiss } : {}),
      ...(m.modelCalls !== undefined ? { modelCalls: m.modelCalls } : {}),
      ...(m.contextMax !== undefined && m.contextMax > 0 ? { contextMax: m.contextMax } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.model ? { model: m.model } : {}),
    }
    const postAndAttachQuery = (params: Parameters<typeof routeMessage>[1]): void => {
      const posted = routeMessage(target, params)
      if (decision.generationTraceId && spawnOptions?.executionStore) {
        for (const message of posted) spawnOptions.executionStore.linkMessage(decision.generationTraceId, message.id)
      }
      if (decision.generationTraceId && spawnOptions?.onTurnMessageLinked) {
        for (const message of posted) {
          try {
            spawnOptions.onTurnMessageLinked({
              executionTurnId: decision.generationTraceId,
              roomId: message.roomId,
              messageId: message.id,
            })
          } catch (error) {
            // The ordinary message has already been delivered. Never turn a
            // failed optional comparison attachment into a duplicate reply.
            console.error(`[${config.name}] Could not attach model-comparison evidence to message ${message.id}:`, error)
          }
        }
      }
      if (!decision.generationQuery || !decision.generationTraceId) return
      for (const message of posted) {
        rooms.getRoom(message.roomId)?.setGenerationQuery(
          message.id,
          decision.generationTraceId,
          decision.generationQuery,
        )
      }
    }

    if (decision.response.action === 'respond') {
      postAndAttachQuery({
        senderId: agent.id,
        senderName: agent.name,
        content: decision.response.content,
        type: 'chat',
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...(decision.cause ? { cause: decision.cause } : {}),
        ...(decision.generationTraceId ? { generationTraceId: decision.generationTraceId } : {}),
        ...telemetry,
        ...(decision.toolTrace && decision.toolTrace.length > 0 ? { toolTrace: decision.toolTrace } : {}),
      })
    } else if (decision.response.action === 'pass') {
      // Post pass as a visible message so humans can see agent decisions
      const reason = decision.response.reason ?? 'nothing to add'
      postAndAttachQuery({
        senderId: agent.id,
        senderName: agent.name,
        content: `[pass] ${reason}`,
        type: 'pass',
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...(decision.cause ? { cause: decision.cause } : {}),
        ...(decision.generationTraceId ? { generationTraceId: decision.generationTraceId } : {}),
        ...telemetry,
        ...(decision.toolTrace && decision.toolTrace.length > 0 ? { toolTrace: decision.toolTrace } : {}),
      })
    } else {
      // action: 'error' — LLM/transport failure, distinct from a pass decision.
      // Renders as a red chip in the UI; the errorCode drives any "Change model"
      // affordance. NEVER conflate with `pass` — pass is an agent decision,
      // error is a system failure the user should see and act on.
      const err = decision.response
      postAndAttachQuery({
        senderId: agent.id,
        senderName: agent.name,
        content: `[error: ${err.code}] ${err.message}`,
        type: 'error',
        errorCode: err.code,
        ...(err.providerHint ? { errorProvider: err.providerHint } : {}),
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...(decision.cause ? { cause: decision.cause } : {}),
        ...(decision.generationTraceId ? { generationTraceId: decision.generationTraceId } : {}),
        ...telemetry,
        ...(decision.toolTrace && decision.toolTrace.length > 0 ? { toolTrace: decision.toolTrace } : {}),
      })
    }
  }

  // Resolve tool support — agentRef filled after agent creation (lazy context)
  const agentRef: AgentToolContextRef = { id: '', name: '' }
  const toolSupport = await resolveAgentTools(
    config,
    llmProvider,
    toolRegistry,
    agentRef,
    spawnOptions?.getRoomActivation,
    spawnOptions?.executionStore,
    spawnOptions?.executionGrowth,
    spawnOptions?.runToolOperation,
  )

  const agent = createAIAgent(config, llmProvider, onDecision, {
    ...toolSupport,
    ...(spawnOptions?.onTurnStart ? { onTurnStart: spawnOptions.onTurnStart } : {}),
    ...(spawnOptions?.onTurnFinished ? { onTurnFinished: spawnOptions.onTurnFinished } : {}),
    ...(spawnOptions?.executionStore ? { executionStore: spawnOptions.executionStore } : {}),
    ...(spawnOptions?.executionGrowth ? { executionGrowth: spawnOptions.executionGrowth } : {}),
    getWorkspacePrompt: settings.getPrompt,
    getResponseFormat: settings.getResponseFormat,
    getCompressedIds: (roomId: string) => rooms.getRoom(roomId)?.getCompressedIds() ?? new Set(),
    getCompressionSummary: (roomId: string) => rooms.getRoom(roomId)?.getCurrentCompressionMessage(),
    getRoomMembers: (roomId: string) => {
      const room = rooms.getRoom(roomId)
      if (!room) return []
      const profiles: Array<import('../core/types/messaging.ts').AgentProfile> = []
      for (const id of room.getParticipantIds()) {
        const a = team.getAgent(id)
        if (a) profiles.push({ id: a.id, name: a.name, kind: a.kind, ...(a.metadata?.tags ? { tags: a.metadata.tags as ReadonlyArray<string> } : {}) })
      }
      return profiles
    },
    getSkills: spawnOptions?.getSkills,
    ...(spawnOptions?.getActiveSkillsDeclarations ? { getActiveSkillsDeclarations: spawnOptions.getActiveSkillsDeclarations } : {}),
    getScriptContext: spawnOptions?.getScriptContext,
    onEvalEvent: spawnOptions?.onEvalEvent,
    ...(spawnOptions?.resolveEffectiveModel ? { resolveEffectiveModel: spawnOptions.resolveEffectiveModel } : {}),
    ...(spawnOptions?.metricsSink ? { metricsSink: spawnOptions.metricsSink } : {}),
  }, agentId)

  // Fill agentRef so the lazy ToolContext in resolveAgentTools resolves correctly
  agentRef.id = agent.id
  agentRef.name = agent.name
  agentRef.currentLLMSettings = agent.getConfig
  agentRef.focusedSubjects = agent.getFocusedSubjects

  team.addAgent(agent)

  return agent
}

export const spawnHumanAgent = async (
  agent: Agent,
  rooms: RoomDirectory,
  team: Team,
  routeMessage: RouteMessage,
  roomsToJoin?: ReadonlyArray<Room>,
): Promise<Agent> => {
  team.addAgent(agent)

  const targetRooms = roomsToJoin ?? rooms.listAllRooms().map(
    profile => rooms.getRoom(profile.id),
  ).filter((r): r is Room => r !== undefined)

  await Promise.all(targetRooms.map(room =>
    addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, rooms),
  ))

  return agent
}
