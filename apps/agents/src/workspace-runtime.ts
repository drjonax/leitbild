// ============================================================================
// Leitbild Agents workspace runtime factory.
//
// createAgentsWorkspaceRuntime() builds one URL-scoped Agents runtime without
// starting a process. The executable entrypoint lives in main.ts.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from './core/types/agent.ts'
import type { DeliverFn, ResolveAgentName, ResolveTagFn } from './core/types/messaging.ts'
import type {
  OnAgentSettingsChanged, OnDeliveryModeChanged,
  OnMembershipChanged, OnMessagePosted, OnModeAutoSwitched,
  OnRoomCreated, OnRoomDeleted, OnSummaryConfigChanged, OnSummaryUpdated, RemoveAgentFromRoomOptions,
  OnTurnChanged,
} from './core/types/room.ts'
import { createRoomDirectory, type RoomDirectory, type RoomDirectoryCallbacks } from './core/rooms/directory.ts'
import { agentsStorageBudget } from './core/storage/admission.ts'
import { workspaceModulePaths } from './core/paths.ts'
import { createExecutionStore, type ExecutionStore } from './core/executions/store.ts'
import { createWorkspaceSettings, type WorkspaceSettings } from './core/workspaces/settings.ts'
import { createBookmarkStore, type BookmarkStore, type OnBookmarksChanged } from './core/workspaces/bookmark-store.ts'
import type { SummaryScheduler, SummaryTarget } from './core/summaries/summary-scheduler.ts'
import { createSummaryEngine } from './core/summaries/summary-engine.ts'
import { effectiveActivePackSet } from './packs/activation.ts'
import { createSummaryScheduler } from './core/summaries/summary-scheduler.ts'
import { createTriggerScheduler, type TriggerScheduler } from './core/triggers/scheduler.ts'
import type { OnEvalEvent } from './core/types/agent-eval.ts'
import { DEFAULTS } from './core/types/constants.ts'
import type { ToolRegistry } from './core/types/tool.ts'
import type { OnProviderBound, OnProviderAllFailed, OnProviderStreamFailed } from './core/types/llm.ts'
import type { ProviderRoutingEvent } from './llm/router.ts'
import { asAIAgent } from './agents/shared.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import type { OllamaGateway } from './llm/gateway.ts'
import type { ProviderRouter } from './llm/router.ts'
import { createLLMService, type LLMService } from './llm/llm-service.ts'
import type { ProviderSetupResult } from './llm/providers-setup.ts'
import type { ProviderConfig } from './llm/providers-config.ts'
import type { ProviderKeys } from './llm/provider-keys.ts'
import { createDeploymentRuntime, type DeploymentRuntime } from './core/deployment-runtime.ts'
import type { LimitMetrics } from './core/limit-metrics.ts'
import type { ProviderGateway } from './llm/provider-gateway.ts'
import { createOverlayToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent, buildToolSupport, effectiveAgentToolSelection, type SpawnOptions } from './agents/spawn.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { createRoomOperations } from './core/room-operations.ts'
import {
  // RoomDirectory-bound built-ins (registered into the per-Workspace overlay).
  // Process-wide built-ins (createPassTool, createGetTimeTool, createWebTools,
  // createTestToolTool, createListSkillsTool, createWriteSkillTool,
  // createWriteToolTool and Pack Manager adapters) live in deployment.sharedToolRegistry —
  // see bootstrap.ts.
  createListRoomsTool,
  createCreateRoomTool, createDeleteRoomTool, createAddToRoomTool, createRemoveFromRoomTool,
  createListAgentsTool, createGetMyContextTool, createSetDeliveryModeTool,
  createPauseRoomTool, createMuteAgentTool, createSetRoomPromptTool,
  createPostToRoomTool, createGetRoomHistoryTool, createConversationReadTool,
  createRecallTool,
  createQueryDocumentsTool,
  createWorkspaceCapabilityTools,
} from './tools/built-in/index.ts'
import { createBiometricsTools, BIOMETRICS_PACK_NAMESPACE } from './tools/built-in/biometric-tools.ts'
import { createWikiLookupTool } from './wikis/wiki-lookup.ts'
import { createEvalBuffer } from './diagnostics/eval-buffer.ts'
import { createCaptureRegistry, type CaptureRegistry } from './core/biometrics/registry.ts'
import { createVectorStore, type VectorStore } from './embed/vector-store.ts'
import { createMemoryIndexer, buildEmbeddingProvidersFromKeys } from './embed/memory-indexer.ts'
import { createDocumentManager, type DocumentManager } from './documents/manager.ts'
import type { DocumentMetadata } from './documents/types.ts'
import { dirname, join } from 'node:path'
import { createComparisons } from './agents/comparisons.ts'
import { requestDisplay } from './agents/display-requests.ts'
import type { DisplayRequestAccepted } from './core/display-request.ts'
// Native-only tool calling — no capability probing needed
import { type SkillStore } from './skills/loader.ts'
import type { ScriptStore } from './core/scripts/script-store.ts'
import { createScriptRunner, type ScriptRunner, type ScriptEventEmitter } from './core/scripts/script-runner.ts'
import { createWriteScriptTool } from './tools/built-in/script-codegen.ts'
import { sharedPaths } from './core/paths.ts'
import type { WorkspaceId } from '@leitbild/contracts'
import type { AgentPackCatalog } from './packs/agent-pack-catalog.ts'

import { createOllamaUrlRegistry, type OllamaUrlRegistry } from './core/ollama-urls.ts'
export type { OllamaUrlRegistry }

import type { LogConfig, LogConfigState, LogEvent, LogSink } from './logging/types.ts'
import { createJsonlFileSink } from './logging/jsonl-sink.ts'
import { matchesKindFilter, validateLogConfig, defaultLogDir, defaultSessionId } from './logging/config.ts'
import {
  mkDeliveryModeChanged, mkEvalEvent,
  mkMembershipChanged, mkMessagePosted, mkModeAutoSwitched,
  mkProviderAllFailed, mkProviderBound, mkProviderStreamFailed,
  mkRoomCreated, mkRoomDeleted, mkSessionEnd, mkSessionStart,
  mkSummaryConfigChanged, mkSummaryRunCompleted, mkSummaryRunFailed,
  mkSummaryRunStarted, mkSummaryUpdated,
} from './logging/event-mapping.ts'

export interface AgentsWorkspaceRuntime {
  readonly comparisons: import('./agents/comparisons.ts').Comparisons
  readonly executionStore: ExecutionStore
  readonly setOnMessagesRemoved: (cb: NonNullable<RoomDirectoryCallbacks['onMessagesRemoved']>) => void
  readonly createRoom: (config: Parameters<RoomDirectory['createRoomSafe']>[0]) => Promise<ReturnType<RoomDirectory['createRoomSafe']>>
  readonly rooms: RoomDirectory
  readonly settings: WorkspaceSettings
  readonly bookmarks: BookmarkStore
  // Ephemeral biometric state is isolated with the Workspace runtime and is
  // cleared on Room removal and runtime eviction.
  readonly captureRegistry: CaptureRegistry
  readonly team: Team
  readonly routeMessage: RouteMessage
  // Provider-neutral LLM access. All agents and callSystemLLM go through here.
  readonly llm: ProviderRouter
  // Higher-level wrapper around `llm` that owns cross-cutting concerns:
  // pre-call cooldown skip, fallback-chain walking (with system default
  // policy), unified observability, and source tagging. New code SHOULD
  // call llmService rather than llm directly so resilience is automatic.
  readonly llmService: LLMService
  // Cross-provider LLM policy (system default fallback chain). Mutable —
  // UI reads/writes this; LLMService consults it at request time.
  readonly providerPolicy: import('./llm/providers-store.ts').ProviderPolicyStore
  // Direct Ollama gateway (present iff Ollama is a configured provider).
  // Used by the Ollama dashboard UI for ps/loadModel; not for routing.
  readonly ollama: OllamaGateway | undefined
  readonly providerConfig: ProviderConfig
  // Mutable registry of current API keys, read by gateways at request time.
  // Used by the providers admin endpoints to apply key changes without restart.
  readonly providerKeys: ProviderKeys
  // Per-provider gateways — exposed so admin endpoints can refresh model
  // caches when keys change.
  readonly gateways: Record<string, ProviderGateway>
  // Per-provider monitors — single source of truth for routing eligibility
  // and the recent-failures log surfaced in the providers admin UI.
  readonly monitors: Record<string, import('./llm/provider-monitor.ts').ProviderMonitor>
  // Refresh the cached available-models snapshot used by per-call effective-
  // model resolution. Called at boot and after any provider config change so
  // agents picking up a fallback get the latest list (no boot-time freeze).
  readonly refreshAvailableModels: () => Promise<void>
  // Per-Workspace ring buffer of recent agent evals — fuel for
  // /api/diagnostics/evals/*. Subscribes via addEvalEventListener so
  // it coexists with the wire-workspace-runtime-events broadcaster.
  readonly evalBuffer: import('./diagnostics/eval-buffer.ts').EvalBuffer
  readonly toolRegistry: ToolRegistry
  readonly packCatalog: AgentPackCatalog
  // Refresh every AI agent's ToolExecutor / ToolDefinitions to reflect the
  // current registry. Called by the tool-rescan endpoint and by write_tool.
  readonly refreshAllAgentTools: () => Promise<void>
  readonly skillStore: SkillStore
  readonly skillsDir: string
  readonly scriptStore: ScriptStore
  readonly scriptsDir: string
  readonly scriptRunner: ScriptRunner
  readonly setOnScriptEvent: (cb: ScriptEventEmitter) => void
  // Multi-subscriber observer slot (lateBinding.add). Returns an unsubscribe.
  readonly addScriptEventListener: (cb: ScriptEventEmitter) => () => void
  readonly knowledgeDir: string
  readonly providersStorePath: string
  // Trigger scheduler — REST handlers call invalidate() after mutating an
  // agent's trigger list so the cached "any triggers exist" flag stays
  // accurate and the timer starts/stops correctly. See lever 2 in
  // src/core/triggers/scheduler.ts.
  readonly triggerScheduler: import('./core/triggers/scheduler.ts').TriggerScheduler
  // OllamaUrls editor — no-op when Ollama isn't configured.
  readonly ollamaUrls: OllamaUrlRegistry
  readonly removeAgent: (id: string) => boolean
  readonly removeRoom: (roomId: string) => boolean
  // Clear every room and agent from the running Workspace. Used by the
  // `reset_system` MCP tool in the experiment runner's persistent-process
  // mode so a single subprocess can serve many independent runs. Leaves the
  // tool registry, skill store, provider router, and snapshot wiring alone —
  // only the per-conversation state is reset. In-flight AI generations get a
  // bounded `whenIdle(5000)` + `cancelGeneration()` before the agent is
  // removed so results from cancelled runs don't post into the next run.
  readonly resetState: () => Promise<{ readonly rooms: number; readonly agents: number }>
  readonly addAgentToRoom: (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
  readonly removeAgentFromRoom: (agentId: string, roomId: string, removedBy?: string, options?: RemoveAgentFromRoomOptions) => void
  readonly spawnAIAgent: (config: AIAgentConfig, options?: SpawnOptions) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend, options?: { overrideId?: string }) => Promise<HumanAgent>
  // Manual-mode activation: catch the agent up and force one eval.
  readonly activateAgentInRoom: (agentId: string, roomId: string) => { ok: boolean; queued: boolean; reason?: string }
  // Asks the author of an answer to show it as a live display (see
  // core/display-request.ts). Throws DisplayRequestRefusal naming the rule.
  readonly requestDisplay: (roomId: string, messageId: string, requesterId: string) => DisplayRequestAccepted
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnModeAutoSwitched: (callback: OnModeAutoSwitched) => void
  readonly setOnRoomCreated: (callback: OnRoomCreated) => void
  readonly setOnRoomDeleted: (callback: OnRoomDeleted) => void
  readonly setOnMembershipChanged: (callback: OnMembershipChanged) => void
  readonly setOnBookmarksChanged: (callback: OnBookmarksChanged) => void
  readonly setOnAgentSettingsChanged: (callback: OnAgentSettingsChanged) => void
  // Notify subscribers that an agent's persisted settings (persona, model,
  // tools, triggers, name, etc.) just changed. Called by the API/MCP layer
  // after applying mutations; wire-workspace-runtime-events translates this into a
  // scheduleSave so edits don't stay in memory until the next message-post.
  readonly notifyAgentSettingsChanged: () => void
  readonly setOnEvalEvent: (callback: OnEvalEvent) => void
  // Multi-subscriber observer slot (lateBinding.add). Returns an unsubscribe.
  readonly addEvalEventListener: (cb: OnEvalEvent) => () => void
  readonly setOnProviderBound: (callback: OnProviderBound) => void
  readonly setOnProviderAllFailed: (callback: OnProviderAllFailed) => void
  readonly setOnProviderStreamFailed: (callback: OnProviderStreamFailed) => void
  // Dispatch entry point for the provider router (wired by bootstrap via
  // router.onRoutingEvent(system.dispatchProviderEvent)).
  readonly dispatchProviderEvent: (event: ProviderRoutingEvent) => void
  // Summary + compression scheduler (per-room). Exposed so REST/WS can call
  // triggerNow() for manual regenerate.
  readonly summaryScheduler: SummaryScheduler
  readonly setOnSummaryRunStarted: (cb: (roomId: string, target: SummaryTarget) => void) => void
  readonly setOnSummaryRunDelta: (cb: (roomId: string, target: SummaryTarget, delta: string) => void) => void
  readonly setOnSummaryRunCompleted: (cb: (roomId: string, target: SummaryTarget, text: string) => void) => void
  readonly setOnSummaryRunFailed: (cb: (roomId: string, target: SummaryTarget, reason: string) => void) => void
  readonly setOnSummaryConfigChanged: (cb: OnSummaryConfigChanged) => void
  // RAG: per-Workspace document corpus. Present iff options.vectorsFile was
  // provided by Workspace boot; undefined in focused runtime tests.
  readonly documents?: DocumentManager
  readonly setOnDocumentStatusChange: (cb: (meta: DocumentMetadata) => void) => void

  // --- Observational logging (opt-in; off by default) ---
  // Subscribe an observer to every event kind supported by src/logging.
  // Returns an unsubscribe function. Used by the file-sink wiring in
  // bootstrap and by the runtime-reconfigure path (system.logging).
  readonly addEventObserver: (observer: LogEventObserver) => () => void
  readonly logging: LoggingHandle

  // --- Process-global limit/cap counters (held on DeploymentRuntime) ---
  // Same Workspace across every AgentsWorkspaceRuntime in this process; surfaced via
  // GET /api/system/limits.
  readonly limitMetrics: LimitMetrics
}

// --- Logging handle — runtime on/off + location/session/kind control ---

export type LogEventObserver = (event: LogEvent) => void

export interface LoggingHandle {
  readonly get: () => LogConfigState
  // Swap the active sink. Drains + closes the previous sink, optionally
  // opens a new one (if enabled). Emits session.end on the old sink and
  // session.start on the new one for bracketing. Rejects on invalid config.
  readonly configure: (partial: Partial<LogConfig>) => Promise<void>
}

export interface CreateAgentsWorkspaceRuntimeOptions {
  /** Workspace registry supplies a durable path. Ephemeral standalone/test runtimes use memory. */
  readonly executionsFile?: string
  /** Registry-owned admissions (including autonomous tools) must drain on removal. */
  readonly runWorkspaceOperation?: <T>(work: () => Promise<T>) => Promise<T>
  // Pre-built deployment runtime. When passed, createAgentsWorkspaceRuntime skips internal
  // provider construction and uses these. WorkspaceRuntimeRegistry passes
  // one deployment runtime to many workspace runtime factories.
  readonly deployment?: DeploymentRuntime
  // Standalone/test path: when deployment is absent, build it locally.
  readonly providerConfig?: ProviderConfig
  readonly providerSetup?: ProviderSetupResult
  // Diagnostic label used in unsubscribed-callback warnings (lateBinding).
  // Threaded by the registry; tests/headless paths can omit (becomes "?").
  readonly workspaceLabel?: string
  // Host context is configured as one pair. Focused tests may omit both.
  readonly workspaceId?: WorkspaceId
  readonly workspaceHostUrl?: string
  // Per-Workspace vector store path (RAG features). When set, createAgentsWorkspaceRuntime
  // wires the memory indexer + recall tool. Omitted in focused runtime tests
  // that do not have a Workspace ID; RAG features are no-op there.
  readonly vectorsFile?: string
}

export const createAgentsWorkspaceRuntime = (options: CreateAgentsWorkspaceRuntimeOptions = {}): AgentsWorkspaceRuntime => {
  if ((options.workspaceId === undefined) !== (options.workspaceHostUrl === undefined)) {
    throw new Error('workspaceId and workspaceHostUrl must be configured together')
  }
  // Either reuse a deployment runtime or build one inline for focused tests.
  const deploymentWasGiven = options.deployment !== undefined
  const deployment: DeploymentRuntime = options.deployment ?? createDeploymentRuntime({
    ...(options.providerConfig ? { providerConfig: options.providerConfig } : {}),
    ...(options.providerSetup ? { providerSetup: options.providerSetup } : {}),
  })
  const { providerConfig, providerKeys, providerSetup } = deployment
  const { router: llm, ollama, ollamaRaw, gateways, monitors } = providerSetup
  const executionStore = createExecutionStore(options.executionsFile ?? ':memory:')
  try {
    const executionGrowth = <T>(bytes: number, work: () => Promise<T>): Promise<T> => {
      // Ephemeral standalone factories have no persisted Workspace storage.
      if (options.executionsFile === undefined) return work()
      return agentsStorageBudget().withGrowth(dirname(options.executionsFile), bytes, work)
    }

    // LLMService — single gateway for every LLM call. Owns cooldown skip,
    // fallback-chain walk (with system default policy), unified [llm] log
    // line, source tagging. See src/llm/llm-service.ts for the contract.
    // The default chain comes from deployment.providerPolicy, backed by the
    // canonical providers.json in production; read at request time so
    // UI edits propagate without restart.
    const llmService: LLMService = createLLMService({
      router: llm,
      getSystemChain: () => deployment.providerPolicy.getModelFallback(),
    })

    const team = createTeam()

    const deliver: DeliverFn = (agentId, message) => {
      team.getAgent(agentId)?.receive(message)
    }

    // `set` preserves the existing primary-consumer semantics (one typed
    // subscriber — WS broadcast or MCP notifications). `add` is the multi-
    // subscriber escape hatch added for observational logging (v1 second
    // consumer). The proxy dispatches to the primary first, then observers;
    // each observer is wrapped in try/catch so one failing observer doesn't
    // stop the others. Observers iterate over a snapshot so unsubscribe
    // during dispatch is safe.
    //
    // Warn-once on missing subscriber: when `proxy(...)` fires before
    // `set(...)` has been called AND no observers are registered, log one
    // console.warn the first time per (slot name, workspaceLabel) pair so a
    // wiring miss is visible immediately. Subsequent dropped events stay
    // silent. The bug fixed in 5d73a8e was invisible for three days because
    // there was no signal at all when the wiring was skipped.
    const workspaceLabel = options.workspaceLabel ?? '?'
    const lateBinding = <T extends (...args: never[]) => void>(slotName: string): {
      proxy: T
      set: (cb: T) => void
      add: (cb: T) => () => void
    } => {
      let real: T | undefined
      const observers: T[] = []
      let warnedNoSubscriber = false
      const proxy = ((...args: Parameters<T>) => {
        if (real) {
          try { real(...args) } catch (err) {
            console.error(`[lateBinding] primary callback threw: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else if (observers.length === 0 && !warnedNoSubscriber) {
          warnedNoSubscriber = true
          console.warn(`[lateBinding] ${slotName} has no subscriber for Workspace ${workspaceLabel} — first event dropped, subsequent dropped silently`)
        }
        const snapshot = [...observers]
        for (const cb of snapshot) {
          try { cb(...args) } catch (err) {
            console.error(`[lateBinding] observer threw: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }) as T
      return {
        proxy,
        set: (cb: T) => { real = cb },
        add: (cb: T) => {
          observers.push(cb)
          return () => {
            const i = observers.indexOf(cb)
            if (i >= 0) observers.splice(i, 1)
          }
        },
      }
    }

    // 21 typed lateBinding slots. See AGENTS.md "Rejected refactors" before
    // proposing an event-bus replacement or createAgentsWorkspaceRuntime split.
    const messagePosted = lateBinding<OnMessagePosted>('messagePosted')
    const messagesRemoved = lateBinding<NonNullable<RoomDirectoryCallbacks['onMessagesRemoved']>>('messagesRemoved')
    const turnChanged = lateBinding<OnTurnChanged>('turnChanged')
    const deliveryModeChanged = lateBinding<OnDeliveryModeChanged>('deliveryModeChanged')
    const roomCreated = lateBinding<OnRoomCreated>('roomCreated')
    const roomDeleted = lateBinding<OnRoomDeleted>('roomDeleted')
    const membershipChanged = lateBinding<OnMembershipChanged>('membershipChanged')
    const bookmarksChanged = lateBinding<OnBookmarksChanged>('bookmarksChanged')
    const agentSettingsChanged = lateBinding<OnAgentSettingsChanged>('agentSettingsChanged')
    const modeAutoSwitched = lateBinding<OnModeAutoSwitched>('modeAutoSwitched')
    const evalEvent = lateBinding<OnEvalEvent>('evalEvent')
    const providerBound = lateBinding<OnProviderBound>('providerBound')
    const providerAllFailed = lateBinding<OnProviderAllFailed>('providerAllFailed')
    const providerStreamFailed = lateBinding<OnProviderStreamFailed>('providerStreamFailed')
    const summaryConfigChanged = lateBinding<OnSummaryConfigChanged>('summaryConfigChanged')
    const summaryUpdated = lateBinding<OnSummaryUpdated>('summaryUpdated')
    const summaryRunStarted = lateBinding<(roomId: string, target: SummaryTarget) => void>('summaryRunStarted')
    const summaryRunDelta = lateBinding<(roomId: string, target: SummaryTarget, delta: string) => void>('summaryRunDelta')
    const summaryRunCompleted = lateBinding<(roomId: string, target: SummaryTarget, text: string) => void>('summaryRunCompleted')
    const summaryRunFailed = lateBinding<(roomId: string, target: SummaryTarget, reason: string) => void>('summaryRunFailed')
    const scriptEvent = lateBinding<ScriptEventEmitter>('scriptEvent')
    const captureRegistry = createCaptureRegistry()

    // Diagnostics ring buffer — subscribes to the multi-subscriber eval-event
    // channel so it coexists with the wire-workspace-runtime-events broadcaster.
    const evalBuffer = createEvalBuffer()
    evalBuffer.attach(evalEvent.add)

    // Forward-declared (matches schedulerRef pattern). RoomDirectoryCallbacks.onScriptMessage closes over this.
    let scriptRunnerRef: ScriptRunner | undefined

    const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id
    const resolveTag: ResolveTagFn = (tag) => team.listByTag(tag).map(a => a.id)
    const resolveKind = (id: string): 'ai' | 'human' | undefined => team.getAgent(id)?.kind

    const ollamaUrls: OllamaUrlRegistry = createOllamaUrlRegistry(ollamaRaw, ollama)

    // Forward-declared: the summary scheduler is built after `rooms`, but the
    // rooms's onMessagePosted callback needs to feed into it. We bridge with a
    // mutable slot that's set after construction.
    let schedulerRef: SummaryScheduler | undefined

    const roomCallbacks: RoomDirectoryCallbacks = {
      deliver,
      resolveAgentName,
      resolveTag,
      resolveKind,
      onMessagePosted: (roomId, message) => {
        messagePosted.proxy(roomId, message)
        schedulerRef?.onMessagePosted(roomId, message)
      },
      beforeMessageRemoval: (roomId, messageId) => {
        comparisons.removeMessages(roomId, messageId)
        if (messageId === undefined) {
          cancelGenerationsInRoom(roomId)
          executionStore.deleteRoom(roomId)
        } else executionStore.deleteMessage(roomId, messageId)
      },
      onMessagesRemoved: messagesRemoved.proxy,
      onScriptMessage: (roomId, message) => scriptRunnerRef?.onRoomMessage(roomId, message),
      onTurnChanged: turnChanged.proxy,
      onDeliveryModeChanged: deliveryModeChanged.proxy,
      onRoomCreated: roomCreated.proxy,
      onRoomDeleted: (roomId, roomName) => {
        captureRegistry.clearForRoom(roomId)
        roomDeleted.proxy(roomId, roomName)
        schedulerRef?.onRoomRemoved(roomId)
      },
      onManualModeEntered: (roomId: string) => { cancelGenerationsInRoom(roomId) },
      onModeAutoSwitched: modeAutoSwitched.proxy,
      onSummaryConfigChanged: (roomId, config) => {
        summaryConfigChanged.proxy(roomId, config)
        schedulerRef?.onConfigChanged(roomId)
      },
      onSummaryUpdated: summaryUpdated.proxy,
    }
    const rooms = createRoomDirectory(roomCallbacks)
    const createRoom: AgentsWorkspaceRuntime['createRoom'] = async config => {
      const root = options.workspaceId === undefined ? sharedPaths.root() : workspaceModulePaths(options.workspaceId).agents.root
      // Reserve initial metadata headroom; ongoing conversations remain authoritative
      // and are never silently discarded by optional-observation retention.
      const work = () => agentsStorageBudget().withGrowth(root, 64 * 1024 + Buffer.byteLength(JSON.stringify(config)), async () => rooms.createRoomSafe(config))
      // Standalone/headless runtimes have no evicting Workspace registry.
      return options.runWorkspaceOperation ? options.runWorkspaceOperation(work) : work()
    }
    const settings = createWorkspaceSettings()
    const bookmarks = createBookmarkStore(bookmarksChanged.proxy)
    const routeMessage = createMessageRouter({ rooms, limitMetrics: deployment.limitMetrics })
    // Per-Workspace overlay over the process-shared tool registry. Pack tools,
    // skill-bundled tools, external tools, MCP tools and the codegen suite
    // live in shared (registered once at boot). Only rooms-bound built-ins
    // (room ops, post_to_room, write_script) register into the overlay below.
    const toolRegistry = createOverlayToolRegistry(deployment.sharedToolRegistry)
    const comparisons = createComparisons({rooms,executions:executionStore,registry:toolRegistry,llm:llmService,growth:executionGrowth,
      ...(options.workspaceId ? {workspaceId:options.workspaceId}:{}),
      ...(options.workspaceHostUrl ? {hostUrl:options.workspaceHostUrl}:{}),
      ...(options.executionsFile ? {root:join(dirname(options.executionsFile),'comparisons')}:{}),
      ...(options.runWorkspaceOperation ? {runOperation:options.runWorkspaceOperation}:{}),
    })

    // Summary engine + scheduler — default model is the first AI agent's model,
    // or a fallback when none exists yet.
    const defaultSummaryModel = (): string => {
      const firstAi = team.listByKind('ai')[0]
      const model = firstAi ? (firstAi as AIAgent).getModel?.() : undefined
      return model ?? 'llama3.2'
    }
    // RAG: per-Workspace vector store + memory indexer. The store is lazy —
    // first .add() opens / appends to the JSONL file. Without options.vectorsFile
    // (e.g. focused tests) the store and tool are not wired.
    const vectorStore: VectorStore | undefined = options.vectorsFile
      ? createVectorStore(options.vectorsFile)
      : undefined
    const memoryIndexer = vectorStore
      ? createMemoryIndexer({
          vectorStore,
          getProviders: () => buildEmbeddingProvidersFromKeys(providerKeys),
          getRoomName: (roomId) => rooms.getRoom(roomId)?.profile.name,
        })
      : undefined

    // RAG: document corpus manager. Lives at <Workspace>/documents/. The
    // manager is fire-and-forget on indexing; status transitions are
    // pushed to subscribers via this late-binding slot (bootstrap wires
    // it to broadcastToWorkspace for WS push).
    const documentLateBinding: { onStatusChange: (m: DocumentMetadata) => void } = {
      onStatusChange: () => { /* no-op until set */ },
    }
    const documents: DocumentManager | undefined = (vectorStore && options.vectorsFile)
      ? createDocumentManager({
          // documents/ sits as a sibling of vectors.jsonl under the Workspace root
          rootDir: `${dirname(options.vectorsFile)}/documents`,
          vectorStore,
          providerKeys,
          onStatusChange: (meta) => documentLateBinding.onStatusChange(meta),
        })
      : undefined
    // Lazy initial load — scans on-disk metadata + resumes any pending jobs
    // left behind by a process restart. Fire-and-forget; the upload route is
    // gated on documents being present, but reads can race with this load
    // and just see fewer rows until it finishes.
    if (documents) void documents.load()

    const summaryEngine = createSummaryEngine({
      llm: llmService.bound({ source: 'summary' }),
      defaultModel: defaultSummaryModel,
      ...(memoryIndexer ? { onCompressionStart: memoryIndexer.handleCompressionStart } : {}),
    })
    const summaryScheduler = createSummaryScheduler({
      engine: summaryEngine,
      getRoom: (id) => rooms.getRoom(id),
      onRunStarted: (roomId, target) => summaryRunStarted.proxy(roomId, target),
      onRunDelta: (roomId, target, delta) => summaryRunDelta.proxy(roomId, target, delta),
      onRunCompleted: (roomId, target, text) => summaryRunCompleted.proxy(roomId, target, text),
      onRunFailed: (roomId, target, reason) => summaryRunFailed.proxy(roomId, target, reason),
    })
    schedulerRef = summaryScheduler

    // Trigger scheduler — per-agent scheduled prompts. Idle when no triggers
    // exist (lever 1+2 in createTriggerScheduler); restarts on first add.
    const triggerScheduler: TriggerScheduler = createTriggerScheduler({
      team,
      rooms,
      startScript: (roomId, name) =>
        scriptRunnerRef
          ? scriptRunnerRef.start(roomId, name)
          : Promise.resolve({ ok: false, reason: 'scriptRunner not yet wired' }),
      isScriptRunningInRoom: (roomId) => scriptRunnerRef?.getRun(roomId) !== undefined,
    })

    // AgentsWorkspaceRuntime-level membership operations — extracted to core/room-operations.ts.
    const roomOps = createRoomOperations({
      team,
      rooms,
      routeMessage,
      onMembershipChanged: (...args) => membershipChanged.proxy(...args),
      triggerScheduler,
    })
    const systemAddAgentToRoom = roomOps.addAgentToRoom
    const systemRemoveAgentFromRoom = roomOps.removeAgentFromRoom
    const systemRemoveRoom = roomOps.removeRoom
    const cancelGenerationsInRoom = roomOps.cancelGenerationsInRoom

    // Explicit one-turn activation for manual mode. Catches the agent up on
    // messages it hasn't seen, then forces a single evaluation. If the agent
    // is busy generating elsewhere, `tryEvaluate` queues internally — callers
    // surface the `queued: true` result as a UI toast.
    const activateAgentInRoom = (
      agentId: string,
      roomId: string,
    ): { ok: boolean; queued: boolean; reason?: string } => {
      const room = rooms.getRoom(roomId)
      if (!room) return { ok: false, queued: false, reason: 'room not found' }
      if (room.deliveryMode !== 'manual') {
        return { ok: false, queued: false, reason: 'room is not in manual mode' }
      }
      const agent = team.getAgent(agentId)
      if (!agent || agent.kind !== 'ai') {
        return { ok: false, queued: false, reason: 'agent is not an AI agent in this room' }
      }
      if (!room.hasMember(agentId)) {
        return { ok: false, queued: false, reason: 'agent is not a member of this room' }
      }
      if (room.isMuted(agentId)) {
        return { ok: false, queued: false, reason: 'agent is muted' }
      }
      const ai = asAIAgent(agent)
      if (!ai || !ai.ingestHistory || !ai.forceEvaluate) {
        return { ok: false, queued: false, reason: 'agent does not support manual activation' }
      }
      const recent = room.getRecent((ai.getHistoryLimit() ?? DEFAULTS.historyLimit) * 2)
      ai.ingestHistory(roomId, recent)
      const queued = agent.state.get() === 'generating' && agent.state.getContext() !== roomId
      ai.forceEvaluate(roomId)
      return { ok: true, queued }
    }

    // Reset all per-conversation state. See interface doc for what's preserved.
    // For each AI agent: bounded whenIdle(5000) + cancelGeneration so in-flight
    // tool loops or streams don't later post into a freshly-reset room. Human
    // agents have no generation loop so they're removed directly.
    const resetState = async (): Promise<{ rooms: number; agents: number }> => {
      const agents = team.listAgents()
      let agentCount = 0
      for (const agent of agents) {
        const ai = asAIAgent(agent)
        if (ai) {
          try {
            await ai.whenIdle(5000)
          } catch {
            // whenIdle rejects on timeout — proceed with a forced cancel.
          }
          try { ai.cancelGeneration() } catch { /* best-effort */ }
        }
        if (removeAgent(agent.id)) agentCount++
      }
      const roomProfiles = rooms.listAllRooms()
      let roomCount = 0
      for (const profile of roomProfiles) {
        if (systemRemoveRoom(profile.id)) roomCount++
      }
      return { rooms: roomCount, agents: agentCount }
    }

    const removeAgent = (id: string): boolean => {
      const agent = team.getAgent(id)
      if (!agent) return false
      for (const profile of rooms.listAllRooms()) {
        const room = rooms.getRoom(profile.id)
        if (room?.hasMember(id)) {
          systemRemoveAgentFromRoom(id, profile.id)
        }
      }
      const removed = team.removeAgent(id)
      // Prune this ID from every surviving AI agent's "known agents" cache so
      // it doesn't linger as a phantom entry after deletion.
      if (removed) {
        for (const other of team.listByKind('ai')) {
          const ai = asAIAgent(other)
          ai?.forgetAgent?.(id)
        }
        // Triggers live on the agent — they go with it. The scheduler's
        // anyTriggers cache might be stale; refresh it.
        triggerScheduler.invalidate()
      }
      return removed
    }

    // Register Room/Team-bound built-in tools into the per-Workspace overlay.
    // Process-wide tools (pass, get_time, web *, test_tool, list_skills,
    // write_skill / write_tool, install_pack et al, MCP tools, external tools,
    // skill-bundled tools, pack-owned tools) live in deployment.sharedToolRegistry
    // and are registered once at boot — see bootstrap.ts.
    toolRegistry.registerAll([
      // Room management — bound to per-Workspace rooms
      createListRoomsTool(rooms),
      createCreateRoomTool(createRoom, systemAddAgentToRoom),
      createDeleteRoomTool(systemRemoveRoom, rooms),
      createSetRoomPromptTool(rooms),
      createPauseRoomTool(rooms),
      createSetDeliveryModeTool(rooms),
      createAddToRoomTool(team, rooms, systemAddAgentToRoom),
      createRemoveFromRoomTool(team, rooms, systemRemoveAgentFromRoom),
      // Agent tools — bound to per-Workspace team / rooms
      createListAgentsTool(team),
      createMuteAgentTool(team, rooms),
      createGetMyContextTool(team, rooms),
      // Utility tools — bound to per-Workspace rooms
      createGetRoomHistoryTool(rooms),
      createConversationReadTool(rooms, executionStore),
      createWikiLookupTool({ getSources: roomId => {
        const room = rooms.getRoom(roomId)
        if (!room) return undefined
        const active = effectiveActivePackSet(room)
        return deployment.packCatalog.list().filter(pack => active.has(pack.id))
          .flatMap(pack => pack.wikis.map(wiki => ({ packId: pack.id, wiki })))
      } }),
      createPostToRoomTool(rooms),
      // RAG: recall tool — only registered when this Workspace has a vector
      // store (i.e. options.vectorsFile was provided). Focused runtime tests
      // do not get it; agents see a clean tool list without
      // a non-functional `recall`.
      ...(vectorStore ? [createRecallTool({ vectorStore, providerKeys, rooms })] : []),
      ...(vectorStore ? [createQueryDocumentsTool({ vectorStore, providerKeys })] : []),
    ])

    // Cross-Module interaction is Host-routed. Room Scope is the durable access
    // boundary; target Modules enforce their own current run restrictions.
    if (options.workspaceId !== undefined && options.workspaceHostUrl !== undefined) {
      toolRegistry.registerAll(createWorkspaceCapabilityTools({
        workspaceId: options.workspaceId,
        hostBaseUrl: options.workspaceHostUrl,
        getRoomScope: roomId => rooms.getRoom(roomId)?.profile.scope,
      }))
    }

    // Biometrics tools — implementation lives in core (needs RoomDirectory + capture
    // registry), but registered with source.pack='biometrics' so the per-room
    // activePacks filter (effectiveActivePackSet) gates them exactly like a
    // pack-owned tool. Users discover and activate biometrics via the
    // leitbild-biometrics pack repo; activating it in a room makes these
    // tools visible to agents in that room. See docs in
    // src/tools/built-in/biometric-tools.ts for the rationale.
    for (const tool of createBiometricsTools({ rooms, registry: captureRegistry })) {
      toolRegistry.registerWithSource(tool, { kind: 'pack-owned', pack: BIOMETRICS_PACK_NAMESPACE })
    }

    // Skill and script catalogs are deployment-scoped Pack contributions.
    // Agent selection and Room Pack activation determine which Skills are effective.
    const skillsDir = sharedPaths.skills()
    const scriptsDir = sharedPaths.scripts()
    const skillStore = deployment.sharedSkillStore
    const scriptStore = deployment.sharedScriptStore

    // Agent Skill Selection is exact. Room Pack activation is an independent
    // availability gate for Pack-owned skills, just as it is for Pack tools.
    const selectedSkillsForRoom = (skillNames: ReadonlyArray<string>, roomId: string) => {
      const room = rooms.getRoom(roomId)
      if (!room) return []
      const active = effectiveActivePackSet(room)
      return skillNames.flatMap(name => {
        const skill = skillStore.get(name)
        return skill !== undefined && (skill.pack === undefined || active.has(skill.pack)) ? [skill] : []
      })
    }
    const getSkillsForRoom = (skillNames: ReadonlyArray<string>, roomId: string): string => {
      const visible = selectedSkillsForRoom(skillNames, roomId)
      if (visible.length === 0) return ''
      return visible.map(s => `[${s.name}] ${s.description}\n${s.body}`).join('\n\n---\n\n')
    }

    // Structured access to the same filtered skill set — drives the
    // pre-LLM coherence check in ai-agent.ts. Each skill's `allowed-tools`
    // frontmatter declarations are surfaced as `declaredTools` so the
    // agent can compare against the actual tool surface and emit a
    // coherence warning when the prompt promises a tool that isn't there.
    const getActiveSkillsDeclarationsForRoom = (skillNames: ReadonlyArray<string>, roomId: string): ReadonlyArray<{
      readonly name: string
      readonly declaredTools: ReadonlyArray<string>
    }> => {
      return selectedSkillsForRoom(skillNames, roomId)
        .filter(s => s.allowedToolNames.length > 0)
        .map(s => ({ name: s.name, declaredTools: s.allowedToolNames }))
    }

    const refreshAllAgentTools = async (): Promise<void> => {
      for (const agent of team.listByKind('ai')) {
        const ai = agent as AIAgent
        if (!ai.refreshTools) continue
        const toolNames = effectiveAgentToolSelection(ai.getConfig())
        const support = await buildToolSupport(
          toolNames, toolRegistry,
          {
            id: ai.id,
            name: ai.name,
            currentLLMSettings: () => ai.getConfig(),
            focusedSubjects: roomId => ai.getFocusedSubjects(roomId),
          },
          llm,
          // Pack-aware filter must survive a hot reload — without re-passing
          // it here, refreshing tools (e.g. after install_pack) would silently
          // erase the resolver and revert the agent to seeing every tool.
          (roomId: string) => rooms.getRoom(roomId),
          executionStore,
          executionGrowth,
          options.runWorkspaceOperation,
        )
        ai.refreshTools(support)
      }
    }

    // write_script updates the deployment-scoped authored script catalog.
    toolRegistry.register(createWriteScriptTool(scriptStore, () => { /* onChange already broadcasts */ }))

    // Forward-ref so the runner can call AgentsWorkspaceRuntime.* without a build-order cycle.
    const systemRef: { current: AgentsWorkspaceRuntime | undefined } = { current: undefined }
    const scriptRunner = createScriptRunner({
      getRuntime: () => systemRef.current as AgentsWorkspaceRuntime,
      emit: (roomId, event, detail) => scriptEvent.proxy(roomId, event, detail),
    })
    // Wire the runner into the room callback declared up-front.
    scriptRunnerRef = scriptRunner

    // Cascade-stop active scripts when their room is deleted. Without this,
    // the run sits in scriptRunner.runs forever holding ScriptRun + dialogue
    // history (no further messages arrive in a deleted room, so the
    // findMissingCast defensive abort never fires).
    roomDeleted.add((roomId) => { void scriptRunner.stop(roomId) })

    // --- Effective-model cache (derive-on-read) ---
    // Cache of currently-available models from llm.models(), refreshed in the
    // background. Used by every agent's per-call effective-model resolver so the
    // hot path stays sync. Misses (cache empty / preferred unavailable) fall
    // through to the first available model in router order — the resolver
    // surfaces the failure as a typed error if even that is unreachable.
    let availableModelsCache: ReadonlyArray<string> = []
    const refreshAvailableModels = async (): Promise<void> => {
      try {
        const fromRouter = await llm.models()
        const fromOllama = ollama?.getHealth().availableModels ?? []
        // Router returns prefixed (`name:model`); Ollama health returns unprefixed.
        // Keep both so an Ollama model's unprefixed id
        // resolves alongside `groq:llama-3.3-70b-versatile`.
        availableModelsCache = [...fromRouter, ...fromOllama]
      } catch (err) {
        // Preserve the last known-good cache, but keep discovery failures
        // actionable in the journal instead of silently claiming availability.
        console.warn(`[models] failed to refresh effective-model cache: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Single resolution path. The agent stores the user's preferred model as a
    // bare alias (`claude-haiku-4-5`, `gemini-2.5-pro`) or a pinned form
    // (`groq:llama-3.3-70b-versatile`). We pass that through verbatim — the
    // router decides eligibility by candidate-walk and the anthropic adapter
    // translates aliases→dated canonicals on the wire.
    //
    // Two outcomes only:
    //   - blank preferred (cold-boot, fresh user): substitute first-available
    //     so the very first eval doesn't hard-fail before they pick a model.
    //   - non-blank: pass through. If the model isn't actually routable, the
    //     router surfaces `provider_all_failed` with `not_listed` — visible
    //     error, not a silent swap to a different model.
    const resolveEffectiveModel: SpawnOptions['resolveEffectiveModel'] = (preferred) => {
      if (!preferred || preferred.trim() === '') {
        return {
          model: availableModelsCache[0] ?? '',
          fallback: true,
          reason: 'preferred_blank',
        }
      }
      return { model: preferred, fallback: false, reason: 'preferred_available' }
    }

    const runToolOperation = options.runWorkspaceOperation
    const boundSpawnAIAgent = (config: AIAgentConfig, options?: SpawnOptions) =>
      spawnAIAgent(config, llmService, rooms, settings, team, routeMessage, toolRegistry, {
        ...options,
        executionStore,
        executionGrowth,
        onTurnStart: comparisons.capture,
        onTurnMessageLinked: comparisons.link,
        onTurnFinished: comparisons.discard,
        ...(runToolOperation ? { runToolOperation } : {}),
        getSkills: getSkillsForRoom,
        getActiveSkillsDeclarations: getActiveSkillsDeclarationsForRoom,
        getScriptContext: (roomId, agentName) => scriptRunner.getScriptContextForAgent(roomId, agentName),
        // Pack-aware tool surface filter — the LLM only sees tools owned by
        // packs active in the trigger room. Returns the Room directly; the
        // resolver only needs getActivePacks().
        getRoomActivation: (roomId: string) => rooms.getRoom(roomId),
        onEvalEvent: evalEvent.proxy,
        resolveEffectiveModel,
        // Process-global counter sink — context-builder bumps
        // multimodalImagesDropped whenever it swaps image bytes for a text
        // placeholder. Surfaces in /api/system/health.
        metricsSink: deployment.limitMetrics,
      })

    // Provider-routing-event listener lives on the shared router (see
    // createDeploymentRuntime). The dispatcher is normally set by WorkspaceRuntimeRegistry
    // (multi-Workspace) — but when this AgentsWorkspaceRuntime is built directly in tests,
    // we set the dispatcher to forward
    // events to *this* AgentsWorkspaceRuntime's late-bound subscribers. Multi-Workspace
    // boot overrides this when registry sets its own dispatcher.

    const boundSpawnHumanAgent = async (
      config: HumanAgentConfig,
      send: TransportSend,
      options?: { overrideId?: string },
    ): Promise<HumanAgent> => {
      const agent = createHumanAgent(config, send, options?.overrideId)
      await spawnHumanAgent(agent, rooms, team, routeMessage)
      return agent
    }

    // === Event observer wiring ===
    // `addEventObserver` subscribes a single callback to every late-bound slot
    // the logging system cares about. Each native-callback signature is
    // translated into a unified LogEvent envelope via src/logging/event-mapping.
    // Returns an aggregate unsubscribe.
    const addEventObserver = (
      observer: (event: LogEvent) => void,
      sessionIdRef: { readonly current: string },
    ): (() => void) => {
      const sid = () => sessionIdRef.current
      const safe = (makeEvent: () => LogEvent) => {
        try { observer(makeEvent()) } catch { /* observer errors already caught in proxy */ }
      }
      const unsubs: Array<() => void> = [
        messagePosted.add((roomId, message) => safe(() => mkMessagePosted(sid(), roomId, message))),
        deliveryModeChanged.add((roomId, mode) => safe(() => mkDeliveryModeChanged(sid(), roomId, mode))),
        modeAutoSwitched.add((roomId, toMode, reason) => safe(() => mkModeAutoSwitched(sid(), roomId, toMode, reason))),
        roomCreated.add((profile) => safe(() => mkRoomCreated(sid(), profile))),
        roomDeleted.add((roomId, roomName) => safe(() => mkRoomDeleted(sid(), roomId, roomName))),
        membershipChanged.add((roomId, roomName, agentId, agentName, action) =>
          safe(() => mkMembershipChanged(sid(), roomId, roomName, agentId, agentName, action))),
        evalEvent.add((scope, event) => safe(() => mkEvalEvent(sid(), scope.agentName, event))),
        providerBound.add((agentId, model, oldProvider, newProvider) =>
          safe(() => mkProviderBound(sid(), agentId, model, oldProvider, newProvider))),
        providerAllFailed.add((agentId, model, attempts, summary) =>
          safe(() => mkProviderAllFailed(sid(), agentId, model, attempts, summary))),
        providerStreamFailed.add((agentId, model, provider, reason) =>
          safe(() => mkProviderStreamFailed(sid(), agentId, model, provider, reason))),
        summaryConfigChanged.add((roomId, config) => safe(() => mkSummaryConfigChanged(sid(), roomId, config))),
        summaryUpdated.add((roomId, target) => safe(() => mkSummaryUpdated(sid(), roomId, target))),
        summaryRunStarted.add((roomId, target) => safe(() => mkSummaryRunStarted(sid(), roomId, target))),
        summaryRunCompleted.add((roomId, target, text) => safe(() => mkSummaryRunCompleted(sid(), roomId, target, text))),
        summaryRunFailed.add((roomId, target, reason) => safe(() => mkSummaryRunFailed(sid(), roomId, target, reason))),
      ]
      return () => { for (const u of unsubs) u() }
    }

    // === Logging handle — runtime on/off + relocate + resession ===
    // One active sink + one active kind filter at any time. `configure` is
    // the single mutator; it drains the old sink, reopens as needed, and
    // refreshes the filter atomically. Env-var boot seeds initial state.
    const loggingState: { config: LogConfig; sink: LogSink | null; unsub: (() => void) | null; sessionRef: { current: string } } = {
      config: { enabled: false, dir: defaultLogDir(), sessionId: defaultSessionId(), kinds: ['*'] },
      sink: null,
      unsub: null,
      sessionRef: { current: '' },
    }

    const logging: LoggingHandle = {
      get: (): LogConfigState => ({
        ...loggingState.config,
        currentFile: loggingState.sink?.stats().currentFile ?? null,
        stats: loggingState.sink?.stats() ?? { eventCount: 0, droppedCount: 0, queuedCount: 0, currentFile: null, currentFileBytes: 0 },
      }),
      configure: async (partial: Partial<LogConfig>): Promise<void> => {
        validateLogConfig(partial)
        const next: LogConfig = {
          enabled: partial.enabled ?? loggingState.config.enabled,
          dir: partial.dir ?? loggingState.config.dir,
          sessionId: partial.sessionId ?? loggingState.config.sessionId,
          kinds: partial.kinds ?? loggingState.config.kinds,
        }

        // Tear down current sink (if any). session.end bracket before flush.
        if (loggingState.sink) {
          try { loggingState.sink.write(mkSessionEnd(loggingState.config.sessionId, 'reconfigure')) } catch { /* best-effort */ }
          try { await loggingState.sink.close() } catch { /* sink already errored */ }
          loggingState.sink = null
        }
        if (loggingState.unsub) {
          loggingState.unsub()
          loggingState.unsub = null
        }

        loggingState.config = next
        loggingState.sessionRef.current = next.sessionId

        if (!next.enabled) return

        // Open new sink. Failure bubbles up; caller (REST/MCP) returns 400.
        // B1: awaited so the sink's seedBytes() completes before the first
        // write — without it, the rotation check skipped on a pre-existing
        // file and the log grew past the configured cap.
        const sink = await createJsonlFileSink({ dir: next.dir, sessionId: next.sessionId })
        const filtered = (event: LogEvent) => {
          if (matchesKindFilter(event.kind, next.kinds)) sink.write(event)
        }
        loggingState.unsub = addEventObserver(filtered, loggingState.sessionRef)
        sink.write(mkSessionStart(next.sessionId, { dir: next.dir, kinds: next.kinds }))
        loggingState.sink = sink
      },
    }

    // Focused runtime-test path: forward provider routing events to
    // *this* AgentsWorkspaceRuntime. Workspace boot replaces this dispatcher via
    // WorkspaceRuntimeRegistry → deployment.setProviderEventDispatcher.
    if (!deploymentWasGiven) {
      deployment.setProviderEventDispatcher((event) => {
        if (event.type === 'provider_bound') {
          providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
        } else if (event.type === 'provider_all_failed') {
          providerAllFailed.proxy(event.agentId, event.model, event.attempts, { primaryCode: event.primaryCode, primaryReason: event.primaryReason, remediation: event.remediation })
        } else {
          providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
        }
      })
    }

    const system: AgentsWorkspaceRuntime = {
      rooms, createRoom, settings, bookmarks, team, routeMessage, executionStore, comparisons,
      llm, llmService, ollama, providerConfig, providerKeys, gateways, monitors,
      providerPolicy: deployment.providerPolicy,
      refreshAvailableModels,
      captureRegistry,
      packCatalog: deployment.packCatalog,
      evalBuffer,
      toolRegistry, refreshAllAgentTools, skillStore, skillsDir,
      scriptStore, scriptsDir,
      scriptRunner,
      setOnScriptEvent: scriptEvent.set,
      addScriptEventListener: scriptEvent.add,
      knowledgeDir: sharedPaths.knowledge(),
      providersStorePath: sharedPaths.providers(),
      triggerScheduler,
      ollamaUrls,
      removeAgent,
      removeRoom: systemRemoveRoom,
      resetState,
      addAgentToRoom: systemAddAgentToRoom,
      removeAgentFromRoom: systemRemoveAgentFromRoom,
      spawnAIAgent: boundSpawnAIAgent,
      spawnHumanAgent: boundSpawnHumanAgent,
      activateAgentInRoom,
      requestDisplay: (roomId, messageId, requesterId) => requestDisplay({
        rooms, team, isScriptRunning: roomId => scriptRunnerRef?.getRun(roomId) !== undefined,
      }, roomId, messageId, requesterId),
      setOnMessagePosted: messagePosted.set,
      setOnMessagesRemoved: messagesRemoved.set,
      setOnTurnChanged: turnChanged.set,
      setOnDeliveryModeChanged: deliveryModeChanged.set,
      setOnModeAutoSwitched: modeAutoSwitched.set,
      setOnRoomCreated: roomCreated.set,
      setOnRoomDeleted: roomDeleted.set,
      setOnMembershipChanged: membershipChanged.set,
      setOnBookmarksChanged: bookmarksChanged.set,
      setOnAgentSettingsChanged: agentSettingsChanged.set,
      notifyAgentSettingsChanged: () => agentSettingsChanged.proxy(),
      setOnEvalEvent: evalEvent.set,
      addEvalEventListener: evalEvent.add,
      setOnProviderBound: providerBound.set,
      setOnProviderAllFailed: providerAllFailed.set,
      setOnProviderStreamFailed: providerStreamFailed.set,
      dispatchProviderEvent: (event) => {
        if (event.type === 'provider_bound') {
          providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
        } else if (event.type === 'provider_all_failed') {
          providerAllFailed.proxy(event.agentId, event.model, event.attempts, { primaryCode: event.primaryCode, primaryReason: event.primaryReason, remediation: event.remediation })
        } else {
          providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
        }
      },
      summaryScheduler,
      setOnSummaryRunStarted: summaryRunStarted.set,
      setOnSummaryRunDelta: summaryRunDelta.set,
      setOnSummaryRunCompleted: summaryRunCompleted.set,
      setOnSummaryRunFailed: summaryRunFailed.set,
      setOnSummaryConfigChanged: summaryConfigChanged.set,
      ...(documents ? { documents } : {}),
      setOnDocumentStatusChange: (cb) => { documentLateBinding.onStatusChange = cb },
      addEventObserver: (observer) => addEventObserver(observer, loggingState.sessionRef),
      logging,
      limitMetrics: deployment.limitMetrics,
    }
    systemRef.current = system
    // Kick off the cache refresh. Race with the very first eval is benign —
    // an empty cache returns `{ model: preferred, ... }` and the router can
    // route bare cloud names by trying each provider in order. The cache
    // accelerates subsequent calls and enables proper fallback when a
    // provider goes down mid-session.
    void refreshAvailableModels()
    return system
  } catch (error) {
    // The registry cannot dispose a runtime that never finished construction.
    executionStore.close()
    throw error
  }
}
