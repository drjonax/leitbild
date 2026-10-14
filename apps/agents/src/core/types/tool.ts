// Tool framework types — tool contract, registry, execution surface, and
// native tool-calling interoperability with LLM providers. Leaf module.

export interface ToolCall {
  readonly callId?: string
  readonly providerCallId?: string
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export interface ToolResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
  // Lines for the person, in order, that the turn posts to its Room as the
  // calling Agent's own progress messages (Message.progress) as soon as this
  // result returns (workspace_call `say`). Never part of what the model reads.
  readonly progress?: ReadonlyArray<string>
}

// Options for tool-internal LLM calls — model is inherited from the calling agent.
export interface ToolLLMRequest {
  readonly systemPrompt?: string
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly jsonMode?: boolean
}

export interface ToolContext {
  readonly comparison?: {
    readonly resourceKeys: ReadonlyArray<string>
    readonly definitionKeys: ReadonlyArray<string>
    readonly messageIds: ReadonlyArray<string>
    readonly turnIds: ReadonlyArray<string>
  }
  readonly signal?: AbortSignal
  /** Execution-evidence id of this call within the current turn; absent for standalone executors. */
  readonly executionCallId?: string
  readonly callerId: string
  readonly callerName: string
  readonly roomId?: string          // current trigger room ID — available when tool is called from a room context
  readonly focusedSubjects?: ReadonlyArray<import('@leitbild/contracts').WorkspaceSubjectReference> // transient subjects in the caller's current browser view
  readonly llm?: (request: ToolLLMRequest) => Promise<string>  // model/reasoning/seed inherited from current Agent settings
  readonly llmStream?: (request: ToolLLMRequest) => AsyncIterable<string>  // streaming variant — yields raw deltas
}

export interface Tool {
  readonly name: string
  // LLM-facing prose. Single imperative clause; second sentence only for a
  // non-obvious constraint or cross-tool dependency. If the return shape
  // carries a contract the LLM must act on (e.g. paste a fence verbatim),
  // fold that sentence here — `returns` is UI-only. See src/llm/tool-capability.ts
  // header for the full style contract.
  readonly description: string
  // UI hints rendered in the tool-detail modal for humans inspecting a
  // tool. NOT sent to the LLM (pre-2026-05 they were appended to
  // description; cost audit determined the prose duplicated info the
  // model gets from the first tool result anyway).
  readonly usage?: string
  readonly returns?: string
  readonly parameters: Record<string, unknown>  // JSON Schema for LLM
  readonly execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

// Where a registered tool came from. Used by the detail endpoint and hot-reload.
//   'built-in'      — compiled into the binary; no filesystem path, no source serving
//   'external'      — loaded from ./tools, ~/.leitbild/tools, or $LEITBILD_TOOLS_DIR
//   'skill-bundled' — loaded from <skillsDir>/<skill>/tools/ (also via write_tool)
//   'pack-owned'  — loaded from ~/.leitbild/packs/<pack>/tools/; registry key
//                     is namespaced as `<pack>_<displayName>` to prevent
//                     cross-pack collisions while keeping the LLM-facing name
//                     valid under the OpenAI/Anthropic tool-name regex.
export type ToolSourceKind = 'built-in' | 'external' | 'skill-bundled' | 'pack-owned'

export interface ToolSourceMeta {
  readonly kind: ToolSourceKind
  readonly path?: string         // absolute filesystem path (omitted for built-ins)
  readonly skill?: string        // owning skill name (skill-bundled only)
  readonly pack?: string         // owning pack namespace (pack-owned only)
  readonly displayName?: string  // unprefixed name (pack-owned only — registry key is `<pack>_<displayName>`)
}

export interface ToolRegistryEntry {
  readonly tool: Tool
  readonly source: ToolSourceMeta
}

export interface ToolRegistry {
  readonly register: (tool: Tool) => void
  readonly registerAll: (tools: ReadonlyArray<Tool>) => void
  readonly registerWithSource: (tool: Tool, source: ToolSourceMeta) => void
  readonly unregister: (name: string) => boolean
  readonly unregisterByPack: (pack: string) => ReadonlyArray<string>
  readonly get: (name: string) => Tool | undefined
  readonly getEntry: (name: string) => ToolRegistryEntry | undefined
  readonly has: (name: string) => boolean
  readonly list: () => ReadonlyArray<Tool>
  readonly listEntries: () => ReadonlyArray<ToolRegistryEntry>
}

export type ToolExecutor = (calls: ReadonlyArray<ToolCall>, roomId?: string, signal?: AbortSignal, executionTurnId?: string) => Promise<ReadonlyArray<ToolResult>>

// === Native tool calling (OpenAI/Ollama-compatible) ===

export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

export interface NativeToolCall {
  readonly id?: string
  readonly function: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
}
