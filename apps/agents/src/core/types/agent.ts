// Agent types — Agent, AIAgent, state observability, team membership,
// AI configuration, response shape, and message-routing coordination.

import type { Message, MessageCause, MessageTarget, PostParams } from './messaging.ts'
import type { ToolDefinition, ToolExecutor } from './tool.ts'
import type { Room } from './room.ts'
import type { RoomDirectory } from '../rooms/directory.ts'
import type { Trigger } from '../triggers/types.ts'
import type { ReasoningEffort } from './llm.ts'

// === Agent State — subscribe/get pattern for observability ===

export type StateValue = 'idle' | 'generating'

export interface AgentState {
  readonly get: () => StateValue
  readonly getContext: () => string | undefined
  // Wall-clock timestamp (Date.now()) when the current generation started.
  // undefined when state === 'idle'. Surfaces through the WS snapshot so a
  // tab reload mid-generation can render the thinking indicator immediately
  // with the correct elapsed-seconds, instead of waiting for the next
  // notifyState event (which never comes for the in-flight call).
  readonly getStartedAt: () => number | undefined
  readonly subscribe: (fn: StateSubscriber) => () => void
}

export type StateSubscriber = (state: StateValue, agentId: string, context?: string, startedAt?: number) => void

// === Agent — unified interface for AI agents and humans ===

export interface Agent {
  readonly id: string
  readonly name: string
  readonly kind: 'ai' | 'human'
  readonly metadata: Record<string, unknown>
  readonly state: AgentState
  readonly receive: (message: Message) => void
  readonly join: (room: Room) => Promise<void>
  readonly leave: (roomId: string) => void
  readonly inactive?: boolean
  readonly setInactive?: (value: boolean) => void
  // Rename in place. Implemented by humans; AI agents may implement later.
  // Callers should go through team.renameAgent which validates uniqueness +
  // swaps the team's nameIndex; calling setName directly skips that.
  readonly setName?: (newName: string) => void
  readonly getDescription?: () => string
  readonly updateDescription?: (desc: string) => void
  // Capability/role tags — used for [[tag:X]] addressing via team.listByTag.
  readonly getTags?: () => ReadonlyArray<string>
  readonly updateTags?: (tags: ReadonlyArray<string>) => void
  // Triggers — per-agent scheduled prompts. Both AI and human agents support
  // them; the trigger scheduler walks every agent uniformly.
  // CRUD lives on the agent so trigger state stays co-located with the
  // owning entity (and snapshots through the existing serialise path).
  // Dispatch is split: 'post' mode is handled by the scheduler directly via
  // room.post; 'execute' mode is on the AIAgent (humans never execute).
  readonly getTriggers?: () => ReadonlyArray<Trigger>
  readonly addTrigger?: (trigger: Trigger) => void
  readonly updateTrigger?: (id: string, patch: Partial<Trigger>) => boolean
  readonly deleteTrigger?: (id: string) => boolean
  readonly markTriggerFired?: (id: string, when: number) => void
}

// === AIAgent — extended Agent with observability ===

// Per-agent toggles controlling which prompt sections are injected into the
// LLM system message. UI labels map to config keys as:
//   UI "Agent persona"   → `persona`        (the per-agent persona string)
//   UI "Room prompt"     → `room`           (the trigger room's roomPrompt)
//   UI "Workspace prompt" → `workspace`     (Workspace-wide rules)
//   UI "Response format" → `responseFormat` (global responseFormat)
// All default true; undefined at load → preserve current behavior.
export type PromptSection = 'persona' | 'room' | 'workspace' | 'responseFormat' | 'skills' | 'wikis'
export type IncludePrompts = Partial<Record<PromptSection, boolean>>

// Sub-sections inside the generated CONTEXT block. Default all true; undefined
// preserves current behavior. Unlike `PromptSection`, these are fixed-purpose
// informational (not author-written text), so the magnifier shows the text
// that would be injected at request time.
export type ContextSection = 'participants' | 'activity' | 'knownAgents'
export type IncludeContext = Partial<Record<ContextSection, boolean>>

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly updatePersona: (persona: string) => void
  readonly getPersona: () => string
  readonly updateModel: (model: string) => void
  readonly getModel: () => string
  readonly cancelGeneration: () => void
  readonly getTemperature: () => number | undefined
  readonly updateTemperature?: (t: number | undefined) => void
  readonly getHistoryLimit: () => number | undefined
  readonly updateHistoryLimit?: (n: number) => void
  readonly getHistoryTokenBudget: () => number | undefined
  readonly updateHistoryTokenBudget: (tokens: number | undefined) => void
  readonly getThinking: () => boolean
  readonly updateThinking?: (enabled: boolean) => void
  readonly getReasoningEffort: () => ReasoningEffort | undefined
  readonly updateReasoningEffort: (effort: ReasoningEffort | undefined) => void
  readonly getTools: () => ReadonlyArray<string> | undefined
  readonly updateTools?: (tools: ReadonlyArray<string>) => void
  readonly getSkills: () => ReadonlyArray<string>
  readonly updateSkills: (skills: ReadonlyArray<string>) => void
  readonly getFocusedSubjects: (roomId: string) => ReadonlyArray<import('@leitbild/contracts').WorkspaceSubjectReference>
  readonly refreshTools?: (support: {
    toolExecutor?: ToolExecutor
    toolDefinitions?: ReadonlyArray<ToolDefinition>
    resolveToolDefinitions?: (roomId: string) => ReadonlyArray<ToolDefinition> | null
  }) => void
  // Context & Prompts toggles
  readonly getIncludePrompts: () => Required<IncludePrompts>
  readonly updateIncludePrompts: (partial: IncludePrompts) => void
  readonly getIncludeContext: () => Required<IncludeContext>
  readonly updateIncludeContext: (partial: IncludeContext) => void
  readonly getIncludeTools: () => boolean
  readonly updateIncludeTools: (enabled: boolean) => void
  readonly getPromptsEnabled: () => boolean
  readonly updatePromptsEnabled: (enabled: boolean) => void
  readonly getContextEnabled: () => boolean
  readonly updateContextEnabled: (enabled: boolean) => void
  readonly getMaxToolIterations: () => number | undefined
  readonly updateMaxToolIterations: (n: number | undefined) => void
  // Resume a paused tool-iteration check-in (see EvalEventCore
  // `tool_iteration_checkin`). Removes the explicit check-in threshold for
  // the rest of the in-flight turn and lets the Agent decide when to finish. Returns
  // true iff a checkin was actually pending; false means there was
  // nothing to resume (rare race — user clicked after timeout/cancel).
  readonly continueTools?: (roomId: string) => boolean
  // Context preview — runs buildSystemSections for a specific room and
  // returns section-by-section text + token estimate plus budget resolution.
  // Used by the UI panel so every magnifier has ground truth.
  readonly getContextPreview: (roomId: string) => ContextPreview
  // Memory introspection + management
  readonly getHistory?: (roomId: string) => ReadonlyArray<Message>
  readonly getIncoming?: () => ReadonlyArray<Message>
  readonly getMemoryStats?: () => AgentMemoryStats
  readonly clearHistory?: (roomId?: string) => void
  readonly deleteHistoryMessage?: (roomId: string, messageId: string) => boolean
  // Remove a cached profile from this agent's knowledge of other agents.
  // Called by System.removeAgent so surviving agents don't retain a stale
  // "known agents" entry for a deleted participant.
  readonly forgetAgent?: (agentId: string) => void
  // Returns a snapshot of the agent's current configuration (mutable fields resolved).
  // Use this when you need multiple config fields at once (e.g. for serialization).
  readonly getConfig: () => AIAgentConfig
  // Manual-mode primitives (general-purpose, not mode-specific):
  // ingestHistory appends unseen messages to the agent's room history without
  // triggering evaluation or compression; forceEvaluate triggers one eval
  // regardless of the room's delivery mode.
  readonly ingestHistory?: (roomId: string, messages: ReadonlyArray<Message>) => void
  readonly forceEvaluate?: (roomId: string) => void
  // Trigger execute-mode dispatch (AI only; humans never execute).
  // Runs the prompt as a transient trailing user message in a normal eval
  // for `roomId`. The Decision is routed through the agent's existing
  // onDecision callback (so respond posts to the room, pass suppresses,
  // error renders as the typed error bubble). Never throws; logs on
  // internal failure.
  readonly fireTriggerExecute?: (prompt: string, roomId: string) => Promise<void>
  // Asks for one ordinary evaluation in `roomId` (queued like any pending
  // room when the agent is busy) that ends with `turn.instruction`.
  readonly requestTurn?: (roomId: string, turn: RequestedTurn) => RequestedTurnResult
}

// A one-turn request from outside the conversation, such as a display
// request. The instruction is a transient trailing user message: never posted,
// never kept in history. The reply carries `cause` and starts its inReplyTo
// with `inReplyTo`. `requireView` asks the evaluation loop to insist once on
// a live view when the reply presents none.
export interface RequestedTurn {
  readonly instruction: string
  readonly inReplyTo: ReadonlyArray<string>
  readonly cause: MessageCause
  readonly requireView: boolean
}

// `queued`: the turn waits behind the agent's current work. A refusal names
// its rule: another requested turn is pending in the Room, or a script
// directs the Room (its context strategy has no place for the instruction).
export type RequestedTurnResult =
  | { readonly kind: 'accepted'; readonly queued: boolean }
  | { readonly kind: 'refused'; readonly reason: 'pending' | 'script'; readonly message: string }

export interface ContextPreviewSection {
  readonly key: string
  readonly label: string
  readonly text: string
  readonly tokens: number
  readonly enabled: boolean
  readonly optional: boolean
}

export interface ContextPreview {
  readonly roomId: string
  readonly roomName: string
  readonly sections: ReadonlyArray<ContextPreviewSection>
  readonly modelMax: number   // model's context window; 0 if unknown
  readonly historyEstimate: { readonly messages: number; readonly chars: number }
}

export interface AgentMemoryStats {
  readonly rooms: ReadonlyArray<{
    readonly roomId: string
    readonly roomName: string
    readonly messageCount: number
    readonly lastActiveAt?: number
  }>
  readonly incomingCount: number
  readonly knownAgents: ReadonlyArray<string>
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly addAgent: (agent: Agent) => void
  readonly getAgent: (idOrName: string) => Agent | undefined
  readonly removeAgent: (id: string) => boolean
  // Rename in place. Validates non-empty + unique. Returns null on success
  // or an error string. Callers must broadcast `agent_renamed` themselves
  // to keep open UIs in sync.
  readonly renameAgent: (id: string, newName: string) => string | null
  readonly listAgents: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
  readonly listByTag: (tag: string) => ReadonlyArray<Agent>
}

// === Message router — single coordination function ===

export interface RouterDeps {
  readonly rooms: RoomDirectory
}

export type RouteMessage = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === AI Agent Configuration ===
// No ID field — system generates UUID automatically.

export interface AIAgentConfig {
  readonly name: string
  // Definition-created assistants are owned by their conversation. Ordinary
  // workspace Agents omit this field and survive Room deletion.
  readonly ownerRoomId?: string
  // Stored user preference. Each request resolves an effective provider route
  // without mutating this value.
  readonly model: string
  readonly persona: string
  readonly temperature?: number
  // Deterministic seed forwarded to every LLM call the agent issues, including
  // tool-initiated sub-calls via ToolContext.llm. Coverage is best-effort per
  // provider (Ollama + OpenAI/Groq/Cerebras/OpenRouter/Mistral/SambaNova honor
  // it; Anthropic + Gemini silently discard). See README "Scripted runs".
  readonly seed?: number
  readonly historyLimit?: number
  // Prior-history replay target, not a model capacity or current-tool-evidence cap.
  readonly historyTokenBudget?: number
  readonly tools?: ReadonlyArray<string>        // tool names this agent can use
  readonly skills?: ReadonlyArray<string>       // exact behavioural Skill selection
  readonly maxToolIterations?: number           // optional operator check-in threshold
  readonly tags?: ReadonlyArray<string>         // capability/role tags for [[tag:X]] addressing
  readonly thinking?: boolean                    // enable model CoT (qwen3 thinking mode)
  readonly reasoningEffort?: ReasoningEffort      // omitted = provider default; separate from Ollama thinking
  // Context & Prompts toggles — all default true; undefined preserves current behavior
  readonly includePrompts?: IncludePrompts      // persona/room/workspace/responseFormat/skills/wikis
  readonly includeContext?: IncludeContext      // CONTEXT sub-sections (participants/activity/knownAgents)
  readonly includeTools?: boolean               // master: send tool definitions to LLM (default: true)
  readonly promptsEnabled?: boolean             // master for all per-section prompt toggles (default: true)
  readonly contextEnabled?: boolean             // master for all context sub-section toggles (default: true)
  readonly triggers?: ReadonlyArray<Trigger>    // scheduled prompts; see src/core/triggers/types.ts
}

// === Agent Response (parsed from LLM plain text output) ===

// Error codes for `action: 'error'`. Distinguish LLM/transport failures from
// agent-decision passes so the UI can surface them differently and offer
// targeted remediation (e.g. "Change model" when the provider is unconfigured).
export type AgentResponseErrorCode =
  | 'no_api_key'         // provider has no effective key (env or store)
  | 'model_unavailable'  // model not found / not in subscription / no provider credits
  | 'rate_limited'       // 429 / quota / provider in-flight credit budget
  | 'network'            // transport failure
  | 'provider_down'      // provider returned 5xx / circuit-open / all providers exhausted
  | 'tool_loop_exceeded' // tool iteration cap hit and no partial text
  | 'empty_response'     // LLM returned no content and no tool calls
  | 'tools_unavailable'  // model emitted tool calls but no executor wired
  | 'request_dropped'    // a requested turn could no longer run (RequestedTurn)
  | 'unknown'

export type AgentResponse =
  | {
      readonly action: 'respond'
      readonly content: string
    }
  | {
      readonly action: 'pass'
      readonly reason?: string
    }
  | {
      readonly action: 'error'
      readonly code: AgentResponseErrorCode
      readonly message: string
      readonly providerHint?: string
    }
