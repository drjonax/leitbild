// ============================================================================
// wireWorkspaceRuntimeEvents — single source of truth for connecting a AgentsWorkspaceRuntime's
// per-tenant event slots to the WS broadcast layer + the autosaver.
//
// Lives at the boundary between the multi-tenant registry and the WS
// transport. Called once per AgentsWorkspaceRuntime (at construction time today; per
// `onWorkspaceRuntimeCreated` hook of WorkspaceRuntimeRegistry once Phase F4 lands).
//
// What it wires:
//   - 25 system callback slots that previously lived in server.ts and
//     ws-handler.ts. They now broadcast scoped to the originating
//     Workspace via wsManager.broadcastToWorkspace(workspaceId, msg).
//   - Auto-save scheduling on every state-mutating callback.
//
// Why it's here:
//   - Keeps server.ts a pure HTTP/WS transport orchestrator.
//   - Keeps ws-handler.ts focused on connection state + buildSnapshot.
//   - Single edit site when adding a new system event kind.
//   - Phase F4 hooks this into registry.onWorkspaceRuntimeCreated so each lazy-
//     loaded AgentsWorkspaceRuntime gets the same wiring without ad-hoc setup code.
// ============================================================================

import type { AgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import type { ModuleAutoSaver } from '../core/storage/module-snapshots.ts'
import type { WSManager } from './ws-types.ts'
import { asAIAgent } from '../agents/shared.ts'
import type { WorkspaceId } from '@leitbild/contracts'

export const wireWorkspaceRuntimeEvents = (
  system: AgentsWorkspaceRuntime,
  wsManager: WSManager,
  autoSaver: ModuleAutoSaver,
  workspaceId: WorkspaceId,
): (() => void) => {
  // Tag this Workspace as wired in the wsManager — the diagnostics endpoint
  // reads this to surface "Workspace X has its broadcast slots wired" so a
  // future regression of the silent-skip class doesn't go unnoticed.
  wsManager.markWired(workspaceId)
  const sched = (): void => autoSaver.scheduleSave()
  const broadcast = (msg: Parameters<WSManager['broadcastToWorkspace']>[1]): void => {
    wsManager.broadcastToWorkspace(workspaceId, msg)
  }
  const broadcastRoom = (roomId: string, msg: Parameters<WSManager['broadcastToRoom']>[2]): void => {
    wsManager.broadcastToRoom(workspaceId, roomId, msg)
  }

  // Helper resolvers for room/agent name lookup (tolerate missing entities).
  const roomNameFor = (roomId: string): string =>
    system.rooms.getRoom(roomId)?.profile.name ?? roomId
  const agentNameFor = (agentId: string | null | undefined): string | undefined =>
    typeof agentId === 'string' ? system.team.getAgent(agentId)?.name : undefined

  // === Mutating callbacks → broadcast + schedule save ===

  system.setOnMessagePosted((roomId, message) => {
    broadcastRoom(roomId, { type: 'message', message })
    sched()
  })

  system.setOnMessagesRemoved((roomId, messageId) => {
    broadcastRoom(roomId, messageId === undefined
      ? { type: 'messages_cleared', roomName: roomNameFor(roomId) }
      : { type: 'message_deleted', roomName: roomNameFor(roomId), messageId })
    sched()
  })

  system.setOnDeliveryModeChanged((roomId, mode) => {
    const room = system.rooms.getRoom(roomId)
    broadcastRoom(roomId, {
      type: 'delivery_mode_changed',
      roomName: roomNameFor(roomId),
      mode,
      paused: room?.paused ?? false,
    })
    sched()
  })

  system.setOnRoomPacksChanged((roomId, activePacks) => {
    broadcast({ type: 'pack_activation_changed', roomId, activePacks })
    sched()
  })

  const unsubscribeScriptCatalog = system.scriptStore.onChange(() => {
    broadcast({ type: 'script_catalog_changed' })
  })
  const unsubscribeBiometricStop = system.captureRegistry.onAgentStop(captureId => {
    broadcast({ type: 'biometric_capture_stop_requested', captureId, reason: 'agent' })
  })

  system.setOnScriptEvent((roomId, event, detail) => {
    const roomName = roomNameFor(roomId)
    if (event === 'script_started') {
      const d = detail as { scriptId: string; scriptName: string; title: string; premise?: string; totalSteps: number; stepTitle: string; cast: ReadonlyArray<{ id: string; name: string; model: string; kind: 'ai'; persona: string; starts: boolean }>; steps: ReadonlyArray<{ title: string; goal?: string; roles: Record<string, string> }> }
      broadcastRoom(roomId, { type: 'script_started', roomName, ...d })
    } else if (event === 'script_step_advanced') {
      const d = detail as { scriptId: string; stepIndex: number; totalSteps: number; title: string; forced?: boolean }
      broadcastRoom(roomId, { type: 'script_step_advanced', roomName, ...d })
    } else if (event === 'script_readiness_changed') {
      const d = detail as { scriptId: string; readiness: Record<string, boolean>; readyStreak: Record<string, number>; whisperFailures: number; lastWhisper: Record<string, { turn: number; whisper: { ready_to_advance: boolean; notes?: string; addressing?: string; role_update?: string }; usedFallback: boolean; rawResponse?: string; errorReason?: string }> }
      broadcastRoom(roomId, { type: 'script_readiness_changed', roomName, ...d })
    } else if (event === 'script_dialogue_appended') {
      const d = detail as { scriptId: string; stepIndex: number; entry: { speaker: string; content: string; messageId: string; whispersByCast: Record<string, { turn: number; whisper: { ready_to_advance: boolean; notes?: string; addressing?: string; role_update?: string }; usedFallback: boolean; rawResponse?: string; errorReason?: string }> } }
      broadcastRoom(roomId, { type: 'script_dialogue_appended', roomName, ...d })
    } else if (event === 'script_completed') {
      const d = detail as { scriptId: string }
      broadcastRoom(roomId, { type: 'script_completed', roomName, ...d })
    }
    sched()
  })

  // Bookmarks: REST-driven, no WS broadcast (single-user surface; UI refetches).
  system.setOnBookmarksChanged(() => { sched() })

  // Agent-settings edits (persona, model, tools, triggers, name, etc.) —
  // fired by the API/MCP layer after updating an Agent and the
  // triggers routes apply changes. Without this hook, those edits stay in
  // memory until the next message-post triggers a save (or a process crash
  // loses them). REST-driven, no WS broadcast — UI already refetched the
  // Workspace-scoped Agent detail endpoint to render the result.
  system.setOnAgentSettingsChanged(() => { sched() })

  // === Non-mutating callbacks → broadcast only ===

  system.setOnTurnChanged((roomId, agentId, waitingForHuman) => {
    broadcastRoom(roomId, {
      type: 'turn_changed',
      roomName: roomNameFor(roomId),
      agentName: agentNameFor(agentId),
      waitingForHuman,
    })
  })

  system.setOnModeAutoSwitched((roomId, toMode, reason) => {
    broadcastRoom(roomId, {
      type: 'mode_auto_switched',
      roomName: roomNameFor(roomId),
      toMode,
      reason,
    })
  })

  system.setOnRoomCreated((profile) => {
    broadcastRoom(profile.id, { type: 'room_created', profile })
    sched()
  })

  system.setOnRoomDeleted((_roomId, roomName) => {
    broadcastRoom(_roomId, { type: 'room_deleted', roomName })
    sched()
  })

  system.setOnMembershipChanged((roomId, roomName, agentId, agentName, action) => {
    broadcastRoom(roomId, { type: 'membership_changed', roomId, roomName, agentId, agentName, action })
    sched()
  })

  // Counters per (agentName, kind) — let an operator confirm chunk events
  // are actually reaching the broadcaster. Pairs with [llm] in evaluation.ts:
  // disagreement between chunks_emit there and chunk count here pinpoints
  // a wiring break in the proxy chain (lateBinding silent-skip class).
  // Sampled to once per 25 chunks to avoid spamming the journal.
  const broadcastChunkCount = new Map<string, number>()
  system.setOnEvalEvent((scope, event) => {
    if (event.kind === 'chunk') {
      const k = scope.agentId
      const n = (broadcastChunkCount.get(k) ?? 0) + 1
      broadcastChunkCount.set(k, n)
      if (n === 1 || n % 25 === 0) {
        console.log(`[llm-bcast] agent=${scope.agentName} kind=chunk count_so_far=${n}`)
      }
    }
    // Prompt content is never sent through realtime activity. Messages carry
    // a generationTraceId and the inspector fetches the separately stored
    // canonical request only on demand.
    const activity = {
      type: 'agent_activity',
      agentId: scope.agentId,
      agentName: scope.agentName,
      ...(scope.roomId ? { roomId: scope.roomId } : {}),
      event: event.kind === 'context_ready' ? { ...event, messages: [] } : event,
    } as const
    const activeRoomId = scope.roomId ?? system.team.getAgent(scope.agentId)?.state.getContext()
    if (activeRoomId) broadcastRoom(activeRoomId, activity)
    else broadcast(activity)
  })

  // === Provider routing events → toasts ===
  // The shared router fires routing events with an agentId; the registry's
  // reverse index resolves agentId → workspaceId in setProviderEventDispatcher,
  // and the per-Workspace AgentsWorkspaceRuntime's late-bound setOnProvider* slots receive
  // them and re-broadcast scoped to the originating Workspace.

  system.setOnProviderBound((agentId, model, oldProvider, newProvider) => {
    broadcast({
      type: 'provider_bound',
      agentId,
      agentName: agentNameFor(agentId) ?? null,
      model, oldProvider, newProvider,
    })
  })

  // provider_all_failed is intentionally NOT broadcast to the UI. It fires
  // for every router-level model exhaustion — including the common case
  // where LLMService rescues the call by walking the system fallback chain.
  // Broadcasting it produced false-alarm warnings on every successful
  // fallback. The user-visible signals are now:
  //   • model_fallback EvalEvent — soft rescue ("falling back from X to Y")
  //   • agent error message in chat — hard failure (chain exhausted)
  // The setter is left in place so observability sinks (logging) can still
  // subscribe; only the WS broadcast is removed.
  system.setOnProviderAllFailed(() => {
    // Intentional no-op: LLMService may still rescue this router-level
    // failure. Installing the primary callback prevents lateBinding from
    // reporting a false wiring fault while observers continue to receive it.
  })

  system.setOnProviderStreamFailed((agentId, model, provider, reason) => {
    broadcast({
      type: 'provider_stream_failed',
      agentId,
      agentName: agentNameFor(agentId) ?? null,
      model, provider, reason,
    })
  })

  // === Summary + compression ===

  system.setOnSummaryConfigChanged((roomId, config) => {
    const roomName = system.rooms.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcastRoom(roomId, { type: 'summary_config_changed', roomName, config })
    sched()
  })
  system.setOnSummaryRunStarted((roomId, target) => {
    const roomName = system.rooms.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcastRoom(roomId, { type: 'summary_run_started', roomName, target })
  })
  system.setOnSummaryRunDelta((roomId, target, delta) => {
    const roomName = system.rooms.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcastRoom(roomId, { type: 'summary_run_delta', roomName, target, delta })
  })
  system.setOnSummaryRunCompleted((roomId, target, text) => {
    const roomName = system.rooms.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcastRoom(roomId, { type: 'summary_run_completed', roomName, target, text })
  })
  system.setOnSummaryRunFailed((roomId, target, reason) => {
    const roomName = system.rooms.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcastRoom(roomId, { type: 'summary_run_failed', roomName, target, reason })
  })

  // === RAG documents — status transitions broadcast to the bound Workspace ===
  system.setOnDocumentStatusChange((meta) => {
    broadcast({
      type: 'document_status',
      docId: meta.docId,
      filename: meta.filename,
      status: meta.status,
      ...(meta.errorMessage !== undefined ? { errorMessage: meta.errorMessage } : {}),
      ...(meta.chunkCount !== undefined ? { chunkCount: meta.chunkCount } : {}),
      ...(meta.pageCount !== undefined ? { pageCount: meta.pageCount } : {}),
    })
  })

  // === Ollama gateway health (shared across Workspaces; broadcast unscoped) ===
  // Note: ollama gateway is a shared resource (created in DeploymentRuntime once).
  // Health changes go to ALL connected clients regardless of Workspace —
  // that matches the underlying state (one gateway, one health value).
  system.ollama?.onHealthChange((health) => {
    wsManager.broadcastAllWorkspaces({ type: 'ollama_health', health })
  })

  // === Snapshot-restored agents: subscribe at wire time ===
  // Covers ONE specific path: agents already present when wireWorkspaceRuntimeEvents
  // runs. Today that's exclusively snapshot-restored agents — restoreFrom
  // Snapshot runs in buildWorkspaceRuntime BEFORE onWorkspaceRuntimeCreated (runtime-registry.ts:
  // 192-203), so by the time wireWorkspaceRuntimeEvents fires, the snapshot's agents
  // exist on system.team but bypassed the wireAgentTracking spawn-wrapper
  // (which is installed by onWorkspaceRuntimeCreated, also AFTER restore).
  //
  // Future spawns (seed, REST, WS, script-engine, anything programmatic)
  // are covered by wireAgentTracking's spawnAIAgent wrapper. Do NOT add
  // ad-hoc subscribeAgentState calls in route/command handlers — the
  // wrapper is the single source of truth.
  for (const agent of system.team.listAgents()) {
    if (agent.kind === 'ai') wsManager.subscribeAgentState(agent, workspaceId)
  }
  // (asAIAgent is imported for future use by other extracted blocks.)
  void asAIAgent
  return () => {
    unsubscribeScriptCatalog()
    unsubscribeBiometricStop()
  }
}
