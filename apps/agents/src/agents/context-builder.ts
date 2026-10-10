// ============================================================================
// Context Builder — Assembles LLM context from an Agent's recent Room view.
//
// Two-buffer architecture: room-sourced history (old) + incoming buffer (new).
// Messages in incoming are tagged [NEW] so the LLM can prioritise them.
// After evaluation, flushIncoming moves processed messages out of incoming
// and appends them to the relevant RoomContext in AgentHistory.
//
// Full history belongs to Room; the Agent view is only an evaluation cache.
//
// --- Section assembly order (system prompt) ---
// 1. RoomDirectory prompt + agent persona
// 2. Skills (from getSkills, skill-store) — may be empty
// 3. Active script context (from getScriptContext) — only when in a running script
// 4. Wiki bindings + pack-owned context — empty when none active
// 5. Room participant profiles + room running summary
// Each source can return empty; the assembled prompt skips empty sections.
// Token budgeting is a single pass at the end (contextTokenBudget).
// ============================================================================

import type { AgentHistory, AgentProfile, Message } from '../core/types/messaging.ts'
import type { ChatRequest } from '../core/types/llm.ts'
import type { IncludeContext, IncludePrompts } from '../core/types/agent.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { imagePlaceholder, warnImageDroppedOnce } from '../llm/multimodal.ts'
// Text tool protocol removed — all tools use native tool calling

// === Flush info — describes which incoming messages were consumed ===

export interface FlushInfo {
  readonly ids: Set<string>
  readonly triggerRoomId: string
}

// === Context result — ready for LLM consumption ===

export interface ContextResult {
  readonly messages: ChatRequest['messages']
  readonly flushInfo: FlushInfo
  readonly warnings: ReadonlyArray<string>
  // Canonical ordered instructions, stable blocks first. Conversation
  // messages never duplicate this text as a synthetic system message.
  readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable: boolean }>
  readonly tokenBudget?: number
}

// === Format a single message for LLM context ===

export interface FormattedMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  // Carried through to ChatRequest.messages[].images when the receiving
  // model is multimodal. For non-multimodal models the caller swaps these
  // for placeholder text in `content` and omits this field.
  readonly images?: ReadonlyArray<{ readonly dataUrl: string; readonly mimeType: 'image/png' }>
}

export const formatMessage = (
  msg: Message,
  prefix: string,
  agentId: string,
  resolveName: (senderId: string) => string,
  compressedIds?: ReadonlySet<string>,
  supportsImages?: boolean,
  modelForWarn?: string,
  metricsSink?: { inc: (field: 'multimodalImagesDropped', by?: number) => void },
): FormattedMessage | null => {
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.type === 'pass' || msg.type === 'mute' || msg.type === 'error') return null
  // Attachment handling: when the model is multimodal AND the message
  // carries image attachments, attach them to the formatted message.
  // Otherwise inline a placeholder describing the image so the model
  // still knows something visual was shared.
  const attachments = msg.attachments?.filter(a => a.kind === 'image') ?? []
  const hasImages = attachments.length > 0
  const imageInfo = hasImages && supportsImages
    ? { images: attachments.map(a => ({ dataUrl: a.dataUrl, mimeType: a.mimeType })) }
    : undefined
  const droppingImages = hasImages && !supportsImages
  const imagePlaceholderText = droppingImages
    ? '\n' + attachments.map(a => imagePlaceholder(a)).join('\n')
    : ''
  // Warn-once when we're swapping image bytes for a text placeholder. The
  // warn helps an operator notice when a model not in the catalog allowlist
  // is silently losing image content (e.g. a freshly-launched flagship the
  // catalog doesn't know about yet). See src/llm/multimodal.ts.
  if (droppingImages && modelForWarn) {
    const desc = attachments.map(a => `${a.mimeType} ${a.width}×${a.height}`).join(', ')
    warnImageDroppedOnce(modelForWarn, agentId, attachments.length, desc, metricsSink)
  }

  if (msg.senderId === agentId) {
    const staleRef = compressedIds && msg.inReplyTo?.some(id => compressedIds.has(id))
    const suffix = staleRef ? '\n[↩ context compressed]' : ''
    const evidence = msg.toolTrace?.length ? `\n[Prior work: conversation_read messageId="${msg.id}"; use its executionTurnId for actual tool outcomes when available. Model-request evidence is separate. Historical, not current state.]` : ''
    return { role: 'assistant' as const, content: `${msg.content}${suffix}${imagePlaceholderText}${evidence}`, ...(imageInfo ?? {}) }
  }
  const name = msg.type === 'room_summary' ? 'Room Summary' : resolveName(msg.senderId)
  return { role: 'user' as const, content: `${prefix}[${name}]: ${msg.content}${imagePlaceholderText}`, ...(imageInfo ?? {}) }
}

// === Flush incoming buffer after evaluation ===

export const flushIncoming = (
  info: FlushInfo,
  history: AgentHistory,
  retainedMessages?: number,
): void => {
  if (info.ids.size === 0) return

  const flushed = history.incoming.filter(m => info.ids.has(m.id))
  const remaining = history.incoming.filter(m => !info.ids.has(m.id))
  history.incoming.length = 0
  history.incoming.push(...remaining)

  if (flushed.length > 0) {
    const ctx = history.rooms.get(info.triggerRoomId)
    if (ctx) {
      const next = [...ctx.history, ...flushed]
      ctx.history = retainedMessages === undefined ? next : next.slice(-retainedMessages)
      ctx.lastActiveAt = Date.now()
    }
  }
}

// === Participant list for room context ===

export const getParticipantsForRoom = (
  roomId: string,
  history: AgentHistory,
  agentId: string,
  getRoomMembers?: (roomId: string) => ReadonlyArray<AgentProfile>,
): ReadonlyArray<AgentProfile | string> => {
  const seen = new Map<string, AgentProfile | string>()

  // Preferred source: current room membership. Includes peers the agent
  // has not yet seen speak (so the Participants list doesn't lie by omission).
  if (getRoomMembers) {
    for (const profile of getRoomMembers(roomId)) {
      if (profile.id !== agentId) seen.set(profile.id, profile)
    }
  }

  // Supplement current membership with senders from message history so the
  // context remains complete even when a member has since left the room.
  const ctx = history.rooms.get(roomId)
  const historyMsgs = ctx?.history ?? []
  const fresh = history.incoming.filter(m => m.roomId === roomId)
  for (const msg of [...historyMsgs, ...fresh]) {
    if (msg.senderId === SYSTEM_SENDER_ID || msg.senderId === agentId) continue
    if (seen.has(msg.senderId)) continue
    seen.set(msg.senderId, history.agentProfiles.get(msg.senderId) ?? msg.senderId)
  }

  return [...seen.values()]
}

// === Build deps ===

export interface BuildContextDeps {
  readonly agentId: string
  readonly persona: string
  readonly workspacePrompt?: string
  readonly responseFormat?: string
  readonly history: AgentHistory
  // Per-room skills section. Implementation looks up the room by id and
  // filters Pack-owned skills by scope ∩ room.activePacks; authored skills
  // have no Pack owner and remain available independently.
  readonly getSkills?: (roomId: string) => string
  // Returns the per-room wikis catalog text (index.md + scope.md per bound
  // wiki), or '' when nothing is bound. Section gated by IncludePrompts.wikis.
  readonly getWikisCatalog?: (roomId: string) => string
  // Script-mode bypass. When this returns a value (cast member in an
  // active run), the agent's context is built ENTIRELY from these
  // pieces — Workspace prompt, room context, message history are suppressed.
  //
  // The systemDoc (structural document — header, cast, step list, current
  // step's roles/goal/pressure) becomes the system prompt. The dialogue
  // entries are rendered as proper user/assistant messages so the model
  // treats them as conversation, not as a doc-to-continue. A final user
  // turn says "speak your next line".
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>
  readonly getCompressionSummary?: (roomId: string) => Message | undefined
  // Current room membership resolver. When provided, the Participants
  // context section lists every member of the room — not only those whose
  // messages the agent has observed.
  readonly getRoomMembers?: (roomId: string) => ReadonlyArray<AgentProfile>
  readonly includePrompts?: IncludePrompts       // undefined = all on; missing keys = on
  readonly includeContext?: IncludeContext       // CONTEXT sub-section toggles
  readonly promptsEnabled?: boolean              // group master for includePrompts; false forces all off
  readonly contextEnabled?: boolean              // group master for includeContext; false forces all off
  readonly contextTokenBudget?: number           // token budget for system+history (derived from model window)
  // V0.15: when true, messages with image attachments forward the images
  // to the LLM as multimodal content parts. When false, images are replaced
  // with a text placeholder explaining what's attached so the model can ask
  // the user to describe. Set by ai-agent.ts based on modelSupportsImages().
  readonly supportsImages?: boolean
  // The fully-resolved model id for this eval. Passed through so the
  // multimodal placeholder substitution can emit a warn-once log line when
  // image content is dropped — operator sees `[multimodal] model=X caller=Y
  // dropped N image(s)…` in journalctl so silent loss is audible. Optional
  // for tests; absent ⇒ no warn fires.
  readonly modelForWarn?: string
  // Process-global counter sink (limitMetrics). When provided, the
  // placeholder-substitution path bumps `multimodalImagesDropped` so
  // /api/system/health surfaces cumulative drops alongside the warn-once
  // journal lines. Optional for tests.
  readonly metricsSink?: { inc: (field: 'multimodalImagesDropped', by?: number) => void }
  // One requested turn's instruction (core/types/agent.ts RequestedTurn).
  // Ends the context as a transient user message; never enters history.
  readonly turnInstruction?: string
}

const resolveIncludes = (inc: IncludePrompts | undefined): Required<IncludePrompts> => ({
  persona: inc?.persona ?? true,
  room: inc?.room ?? true,
  workspace: inc?.workspace ?? true,
  responseFormat: inc?.responseFormat ?? true,
  skills: inc?.skills ?? true,
  wikis: inc?.wikis ?? true,
})

const resolveIncludeContext = (inc: IncludeContext | undefined): Required<IncludeContext> => ({
  participants: inc?.participants ?? true,
  activity: inc?.activity ?? true,
  knownAgents: inc?.knownAgents ?? true,
})

// === Private section builders ===

const buildParticipantsSection = (
  participants: ReadonlyArray<AgentProfile | string>,
): string => {
  const lines = participants.map(p => {
    if (typeof p === 'string') return `- ${p}`
    const tagStr = p.tags && p.tags.length > 0 ? ` [tags: ${p.tags.join(', ')}]` : ''
    return `- ${p.name} (${p.kind})${tagStr}`
  })
  return `Other participants:\n${lines.join('\n')}`
}

const buildActivitySection = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): string => {
  // NOTE: timestamps intentionally omitted. Relative times ("5 minutes ago")
  // change every minute and break prompt-prefix caching (both Gemini implicit
  // and Anthropic explicit). If the agent needs recency, surface it through
  // the incoming/history messages — those already carry timestamps and sit
  // *after* the cacheable prefix.
  const activityLines: string[] = []
  for (const [roomId, ctx] of deps.history.rooms) {
    if (roomId === triggerRoomId) continue
    activityLines.push(`- ${ctx.profile.name} [id: ${roomId}]`)
  }
  if (activityLines.length === 0) return ''
  return `Your other rooms:\n${activityLines.join('\n')}`
}

// === System-message section model ===
// Each section is the atomic unit of the LLM system message: a labelled block
// of text that is either included or suppressed. `buildSystemSections` is the
// single source of truth — the context-preview API and the serialized prompt
// both derive from it.
export interface SystemSection {
  readonly key: SystemSectionKey
  readonly label: string
  readonly text: string
  readonly enabled: boolean
  readonly optional: boolean   // gated by a user toggle (false = always emitted)
}

export type SystemSectionKey =
  | 'workspace' | 'room' | 'persona' | 'responseFormat' | 'skills' | 'wikis'
  | 'ctx_intro'           // "You are in room X" — always emitted
  | 'ctx_flow'
  | 'ctx_participants'
  | 'ctx_activity'
  | 'ctx_knownAgents'

// Convention: each SystemSection is single-purpose. When adding a new
// always-on "how to use the system" hint (rendering, tool reminders,
// prompt-writing tips, etc.), add a new `ctx_*` key to the
// SystemSectionKey union and emit a new out.push(...) here — do NOT
// append text to an existing section. Existing sections drift into
// junk drawers when we keep extending them. (A prior `ctx_newHint`
// that mixed [NEW] semantics with rendering guidance was the
// regression that motivated this rule.)
export const buildSystemSections = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ReadonlyArray<SystemSection> => {
  const promptsEnabled = deps.promptsEnabled ?? true
  const contextEnabled = deps.contextEnabled ?? true
  const includes = promptsEnabled
    ? resolveIncludes(deps.includePrompts)
    : { persona: false, room: false, workspace: false, responseFormat: false, skills: false, wikis: false }
  const ctxIncludes = contextEnabled
    ? resolveIncludeContext(deps.includeContext)
    : { participants: false, activity: false, knownAgents: false }
  const roomCtx = deps.history.rooms.get(triggerRoomId)
  const out: SystemSection[] = []

  out.push({
    key: 'workspace',
    label: 'WORKSPACE RULES',
    text: deps.workspacePrompt ?? '',
    enabled: includes.workspace && !!deps.workspacePrompt,
    optional: true,
  })

  out.push({
    key: 'room',
    label: `ROOM: ${roomCtx?.profile.name ?? ''}`,
    text: roomCtx?.profile.roomPrompt ?? '',
    enabled: includes.room && !!roomCtx?.profile.roomPrompt,
    optional: true,
  })

  out.push({
    key: 'persona',
    label: 'YOUR IDENTITY',
    text: deps.persona,
    enabled: includes.persona,
    optional: true,
  })

  const skillsText = deps.getSkills ? deps.getSkills(triggerRoomId) : ''
  out.push({
    key: 'skills',
    label: 'SKILLS',
    text: skillsText,
    enabled: includes.skills && !!skillsText,
    optional: true,
  })

  const wikisText = deps.getWikisCatalog ? deps.getWikisCatalog(triggerRoomId) : ''
  out.push({
    key: 'wikis',
    label: 'WIKIS',
    text: wikisText,
    enabled: includes.wikis && !!wikisText,
    optional: true,
  })

  // (Dialogue for cast members in an active script run is handled by
  // ScriptStrategy in buildContext, NOT as a SystemSection here.)

  // CONTEXT sub-sections. `ctx_intro` is always-on scaffolding; the
  // others are toggleable.
  out.push({
    key: 'ctx_intro',
    label: 'CONTEXT_INTRO',
    text: roomCtx ? `You are in room ${roomCtx.profile.name} [id: ${triggerRoomId}].` : '',
    enabled: !!roomCtx,
    optional: false,
  })

  const participants = getParticipantsForRoom(triggerRoomId, deps.history, deps.agentId, deps.getRoomMembers)
  out.push({
    key: 'ctx_participants',
    label: 'Participants',
    text: participants.length > 0 ? buildParticipantsSection(participants) : '',
    enabled: ctxIncludes.participants && participants.length > 0,
    optional: true,
  })

  const activityEligible = deps.history.rooms.size > 1
  out.push({
    key: 'ctx_activity',
    label: 'Activity',
    text: activityEligible ? buildActivitySection(deps, triggerRoomId) : '',
    enabled: ctxIncludes.activity && activityEligible,
    optional: true,
  })

  const knownAgents = [...deps.history.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  const knownText = knownAgents.length > 0
    ? `Known agents: ${knownAgents.map(a => `${a.name} (${a.kind})`).join(', ')}`
    : ''
  out.push({
    key: 'ctx_knownAgents',
    label: 'Known agents',
    text: knownText,
    enabled: ctxIncludes.knownAgents && !!knownText,
    optional: true,
  })

  out.push({
    key: 'responseFormat',
    label: 'RESPONSE FORMAT',
    text: deps.responseFormat ?? '',
    enabled: includes.responseFormat && !!deps.responseFormat,
    optional: true,
  })

  return out
}

// Assemble the final system-message string from enabled sections.
// Prompt-level sections are wrapped in `<leitbild:tag>…</leitbild:tag>` fences;
// CONTEXT sub-sections share a single `<leitbild:context>` wrapper with stable
// children first (preserves the cache-prefix shape on Gemini implicit and
// Anthropic explicit caching). The `leitbild:` namespace prefix prevents the
// model from echoing fences back into output and removes ambiguity with any
// generic `<context>` or `<rules>` text in user-supplied persona / room
// prompts.
const CTX_STABLE_KEYS: ReadonlyArray<SystemSectionKey> = [
  'ctx_intro',
]
const CTX_VARIABLE_KEYS: ReadonlyArray<SystemSectionKey> = [
  'ctx_knownAgents', 'ctx_participants', 'ctx_activity', 'ctx_flow',
]

// Map a SystemSection to the XML tag used to fence it. Tag names are
// canonical (lower_snake_case), namespaced under `leitbild:`. Adding a new
// prompt-level section means adding it here.
const TAG_FOR_PROMPT_KEY: Record<'workspace' | 'room' | 'persona' | 'skills' | 'wikis' | 'responseFormat', string> = {
  workspace: 'leitbild:workspace_rules',
  room: 'leitbild:room',
  persona: 'leitbild:identity',
  skills: 'leitbild:skills',
  wikis: 'leitbild:wikis',
  responseFormat: 'leitbild:response_format',
}
const CTX_TAG = 'leitbild:context'

// Minimal XML attribute-value escape for room name. We only need to make
// the value safe inside double quotes — control chars don't appear in room
// names (validated upstream), so & " < > are sufficient.
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Produce the system prompt as an ordered list of blocks with a `cacheable`
// flag. Stable blocks (WORKSPACE/ROOM/IDENTITY/SKILLS/RESPONSE_FORMAT + stable
// CONTEXT subsections) are cacheable; the variable CONTEXT subsections are
// not. The `<leitbild:context>` fence opens in the stable block (when stable
// children exist) and closes in the variable block — the final concatenation
// is balanced in every combination.
const buildSystemBlocks = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ReadonlyArray<{ text: string; cacheable: boolean }> => {
  const sections = buildSystemSections(deps, triggerRoomId).filter(s => s.enabled)
  const byKey = new Map<SystemSectionKey, string>()
  for (const s of sections) byKey.set(s.key, s.text)

  // Stable top-level prompt sections, in order.
  const promptOrder: ReadonlyArray<keyof typeof TAG_FOR_PROMPT_KEY> = [
    'workspace', 'room', 'persona', 'skills', 'wikis', 'responseFormat',
  ]
  const stableLines: string[] = []
  const roomCtx = deps.history.rooms.get(triggerRoomId)
  for (const key of promptOrder) {
    const text = byKey.get(key)
    if (text === undefined) continue
    const tag = TAG_FOR_PROMPT_KEY[key]
    const open = key === 'room' && roomCtx
      ? `<${tag} name="${escapeAttr(roomCtx.profile.name)}">`
      : `<${tag}>`
    stableLines.push(`${open}\n${text}\n</${tag}>`)
  }
  // Stable CONTEXT subsections.
  const stableCtx: string[] = []
  for (const key of CTX_STABLE_KEYS) {
    const text = byKey.get(key)
    if (text) stableCtx.push(text)
  }
  // Variable CONTEXT subsections.
  const variableCtx: string[] = []
  for (const key of CTX_VARIABLE_KEYS) {
    const text = byKey.get(key)
    if (text) variableCtx.push(text)
  }

  const blocks: Array<{ text: string; cacheable: boolean }> = []
  const haveCtx = stableCtx.length > 0 || variableCtx.length > 0
  const stableCtxBlock = stableCtx.length > 0
    ? `<${CTX_TAG}>\n${stableCtx.join('\n\n')}`  // open here; close in variable block (or below)
    : ''
  const stablePart = [...stableLines, stableCtxBlock].filter(Boolean).join('\n\n')

  if (variableCtx.length === 0 && stableCtx.length > 0) {
    // No variable subsections — close CONTEXT in the stable block.
    blocks.push({ text: `${stablePart}\n</${CTX_TAG}>`, cacheable: true })
    return blocks
  }
  if (stablePart) blocks.push({ text: stablePart, cacheable: true })

  if (variableCtx.length > 0) {
    // If stable opened CONTEXT, just append + close. Otherwise open + close here.
    const opened = stableCtx.length > 0
    const text = opened
      ? `${variableCtx.join('\n\n')}\n</${CTX_TAG}>`
      : `<${CTX_TAG}>\n${variableCtx.join('\n\n')}\n</${CTX_TAG}>`
    blocks.push({ text, cacheable: false })
  } else if (!haveCtx && stablePart === '') {
    // no-op: nothing to emit
  }

  return blocks
}

// === Token estimation ===
// Rough heuristic: ~4 characters per token for English text.
// Tool definitions with JSON schema are denser; this is a conservative estimate.

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

// === Build full LLM context ===

// Fallback context budget — only used when `deps.contextTokenBudget` is
// unset (tests, headless callers). Runtime always sets contextTokenBudget
// from the resolved model window in ai-agent.ts. 64K is a safe modern
// floor; tiny-context models (qwen3 4b @ 8K) self-clip when num_ctx fills.
const DEFAULT_MAX_CONTEXT_TOKENS = 64_000

// === Strategy interface ===
//
// Two paths feed an agent's eval loop today: the standard multi-section
// system prompt + windowed history (Normal), and the script-runner bypass
// where cast members get a structural living document + role-tagged
// dialogue (Script). Each path owns three responsibilities — system blocks,
// history messages, and a trailing instruction. They share NO logic;
// splitting them here lets buildContext be a thin orchestrator and lets
// future modes (rehearsal, playback, prompt-eval harness) plug in without
// adding another `if (foo) return …` early fork.
//
// Known limitation — strategies are MONOLITHIC. A hypothetical mode that
// wanted "scripted with persona section enabled" would need a third
// strategy that selectively calls buildSystemSections(). Don't solve
// speculatively; the trigger to revisit is a real partial-overlap mode.
export interface ContextStrategy {
  readonly buildSystemBlocks: () => ReadonlyArray<{ text: string; cacheable: boolean }>
  readonly buildHistoryMessages: () => {
    messages: ReadonlyArray<ChatRequest['messages'][number]>
    flushIds: Set<string>                        // mutable; orchestrator transfers ownership
    warnings: ReadonlyArray<string>
  }
  readonly buildTrailingInstruction: () => ChatRequest['messages'][number] | null
}

// === Strategy: Normal — standard agent eval ===

const createNormalStrategy = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ContextStrategy => {
  let cachedSystemBlocks: ReadonlyArray<{ text: string; cacheable: boolean }> | undefined
  const buildSystemBlocksFn = (): ReadonlyArray<{ text: string; cacheable: boolean }> =>
    cachedSystemBlocks ??= buildSystemBlocks(deps, triggerRoomId)

  const buildHistoryMessagesFn = (): {
    messages: ReadonlyArray<ChatRequest['messages'][number]>
    flushIds: Set<string>
    warnings: ReadonlyArray<string>
  } => {
    const maxContextTokens = deps.contextTokenBudget ?? DEFAULT_MAX_CONTEXT_TOKENS
    const flushIds = new Set<string>()
    const warnings: string[] = []

    const ctx = deps.history.rooms.get(triggerRoomId)
    const allRaw = ctx?.history ?? []
    const freshRaw = deps.history.incoming.filter(m => m.roomId === triggerRoomId)
    const roomCompressedIds = deps.getCompressedIds?.(triggerRoomId)
    // Compression has consumed these pending inputs. Retaining them in the
    // incoming queue would keep scheduling evaluations with invisible work.
    for (const message of freshRaw) if (roomCompressedIds?.has(message.id)) flushIds.add(message.id)
    const all = allRaw.filter(message => !roomCompressedIds?.has(message.id))
    const old = all.length > deps.historyLimit ? all.slice(-deps.historyLimit) : [...all]
    // Existing Agents keep a bounded cache. Read the live compression view so
    // they stop replaying folded messages without losing the current summary.
    const summary = deps.getCompressionSummary?.(triggerRoomId)
    if (summary && !old.some(message => message.id === summary.id)) old.unshift(summary)
    const fresh = freshRaw.filter(message => !roomCompressedIds?.has(message.id))

    const formattedOld: ChatRequest['messages'][number][] = []
    for (const msg of old) {
      const formatted = formatMessage(msg, '', deps.agentId, deps.resolveName, roomCompressedIds, deps.supportsImages, deps.modelForWarn, deps.metricsSink)
      if (formatted) formattedOld.push(formatted)
    }

    const formattedFresh: Array<{ formatted: ChatRequest['messages'][number]; id: string }> = []
    for (const msg of fresh) {
      const formatted = formatMessage(msg, '[NEW] ', deps.agentId, deps.resolveName, roomCompressedIds, deps.supportsImages, deps.modelForWarn, deps.metricsSink)
      if (formatted) formattedFresh.push({ formatted, id: msg.id })
    }

    // Trim layers: (1) historyLimit count slice above; (2) token budget below.
    // System + fresh are mandatory; trim old messages from the front to fit.
    const systemContent = buildSystemBlocksFn().map(b => b.text).filter(Boolean).join('\n\n')
    const systemTokens = estimateTokens(systemContent)
    const freshTokens = formattedFresh.reduce((sum, f) => sum + estimateTokens(f.formatted.content), 0)
    const instructionTokens = deps.turnInstruction === undefined ? 0 : estimateTokens(deps.turnInstruction)
    const budgetForOld = maxContextTokens - systemTokens - freshTokens - instructionTokens

    let trimmedOld = [...formattedOld]
    if (budgetForOld > 0) {
      let oldTokens = formattedOld.reduce((sum, m) => sum + estimateTokens(m.content), 0)
      while (trimmedOld.length > 0 && oldTokens > budgetForOld) {
        const removed = trimmedOld.shift()
        if (removed) oldTokens -= estimateTokens(removed.content)
      }
      if (trimmedOld.length < formattedOld.length) {
        const dropped = formattedOld.length - trimmedOld.length
        warnings.push(`Context trimmed: dropped ${dropped} old messages to fit ${maxContextTokens} token budget`)
      }
    } else {
      trimmedOld = []
      if (formattedOld.length > 0) {
        warnings.push(`Context budget exceeded by system+fresh alone — all old messages dropped`)
      }
    }

    const messages: ChatRequest['messages'][number][] = [...trimmedOld]
    for (const f of formattedFresh) {
      messages.push(f.formatted)
      flushIds.add(f.id)
    }
    return { messages, flushIds, warnings }
  }

  return {
    buildSystemBlocks: buildSystemBlocksFn,
    buildHistoryMessages: buildHistoryMessagesFn,
    buildTrailingInstruction: () => deps.turnInstruction === undefined ? null : { role: 'user', content: deps.turnInstruction },
  }
}

// === Strategy: Script — cast member in an active script run ===
//
// The system prompt is the structural living-script document (header, cast,
// step list with current step's roles+goal+pressure — NO dialogue inline).
// Per-step dialogue is rendered as role-tagged user/assistant messages so
// the model treats it as conversation, not as a doc to autocomplete from.
// A trailing user turn explicitly says "speak your next line".
//
// Why split dialogue out of the system prompt: when it lived inline as
// markdown, models autocompleted from the most recent line (we saw Sam
// parrot Alex's prior turn verbatim). Role-tagged messages make it
// unambiguous what's past dialogue vs. what's the request.

const createScriptStrategy = (
  deps: BuildContextDeps,
  triggerRoomId: string,
  ownName: string,
  scriptCtx: { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> },
): ContextStrategy => ({
  buildSystemBlocks: () => [{ text: scriptCtx.systemDoc, cacheable: false }],

  buildHistoryMessages: () => {
    const flushIds = new Set<string>()
    for (const m of deps.history.incoming) {
      if (m.roomId === triggerRoomId) flushIds.add(m.id)
    }
    const messages: ChatRequest['messages'][number][] = []
    for (const entry of scriptCtx.dialogue) {
      if (entry.speaker === ownName) {
        messages.push({ role: 'assistant', content: entry.content })
      } else {
        // not a system block — see strategy header for the "Sam parroted Alex" rationale.
        // Plain "{name} said:" prefix; user-role already conveys "someone else spoke".
        messages.push({ role: 'user', content: `${entry.speaker} said: ${entry.content}` })
      }
    }
    return { messages, flushIds, warnings: [] }
  },

  // Final user turn instructing the model to speak — see strategy header
  // for why this is needed alongside role-tagged dialogue.
  buildTrailingInstruction: () => ({
    role: 'user',
    content: `It is your turn. Speak your next line as ${ownName}. Reply with dialogue only — no markdown, no narration, no stage directions. Stay in character. Do not repeat or continue any prior speaker's words.`,
  }),
})

// === Strategy selector — single decision point ===

const selectStrategy = (deps: BuildContextDeps, triggerRoomId: string): ContextStrategy => {
  const ownName = deps.resolveName(deps.agentId)
  // getScriptContextForAgent is read-only but invokes renderLivingScript;
  // call once and stash the result on the strategy closure so a future
  // change to ScriptStrategy doesn't accidentally re-render.
  const scriptCtx = deps.getScriptContext?.(triggerRoomId, ownName)
  // A script replaces the whole context and ends it with its own line cue;
  // a requested turn's instruction has no place there. requestTurn refuses
  // scripted rooms, so this only fires if a script started in between.
  if (scriptCtx && deps.turnInstruction !== undefined) throw new Error('A requested turn cannot run while a script directs this room')
  return scriptCtx
    ? createScriptStrategy(deps, triggerRoomId, ownName, scriptCtx)
    : createNormalStrategy(deps, triggerRoomId)
}

// === Orchestrator — picks a strategy, runs the three stages, assembles ===

export const buildContext = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ContextResult => {
  const strategy = selectStrategy(deps, triggerRoomId)
  const systemBlocks = strategy.buildSystemBlocks()
  const { messages: historyMessages, flushIds, warnings } = strategy.buildHistoryMessages()
  const trailing = strategy.buildTrailingInstruction()

  const messages: ChatRequest['messages'][number][] = [
    ...historyMessages,
    ...(trailing ? [trailing] : []),
  ]
  return {
    messages,
    flushInfo: { ids: flushIds, triggerRoomId },
    warnings,
    systemBlocks,
    tokenBudget: deps.contextTokenBudget,
  }
}

// Test seam — exported so tests can construct strategies directly without
// going through the orchestrator. Not part of the public agent surface.
export const __strategyTestSeam = { createNormalStrategy, createScriptStrategy, selectStrategy }
