// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Builds the shared runtime, the WorkspaceRuntimeRegistry, the WS manager, the
// janitor, and either the HTTP+WS server or the headless MCP stdio server.
//
// Multi-Workspace: WorkspaceRuntimeRegistry holds N URL-scoped runtimes. Each one is
// lazy-loaded on first request, evicted after LEITBILD_IDLE_MS (default
// 30 min), with separate strict Room and Agent Profile documents.
// Shared runtime: provider router, gateways, ProviderKeys, MCP tools.
//
// === Construction order (matters; do not reshuffle without thinking) ===
//
//   1. DeploymentRuntime  — provider router, gateways, shared registry/store.
//   2. MCP tools      — register into deployment.sharedToolRegistry once.
//   3. Process tools  — pure / network / codegen tools registered once
//                       into shared (gated by LEITBILD_ENABLE_*).
//   4. WorkspaceRuntimeRegistry — onWorkspaceRuntimeCreated hook closes over wsManager (set in 5).
//   5. Pack Manager   — closes over registry + the wsManager assigned in 6;
//                       Agent tools are thin adapters over it.
//   6. wsManager      — assigned BEFORE any registry.getOrLoad runs, so
//                       the hook always sees a defined value. Failure to
//                       respect this is how 5d73a8e happened: any lazily loaded
//                       Workspace whose onWorkspaceRuntimeCreated fired with
//                       wsManager undefined silently skipped wireWorkspaceRuntimeEvents.
//   7. First runtime  — the Workspace Host provisions Modules, then the
//                       URL-scoped request triggers getOrLoad.
//   8. Janitor + timers + HTTP server.
//
// Single wiring path: every loaded Workspace gets its
// broadcasts wired by the same onWorkspaceRuntimeCreated hook. There is NO rescue
// branch elsewhere in this file. If you find yourself reaching for one,
// the lifecycle invariant above is broken — fix it there.
// ============================================================================

import { createWorkspaceRuntimeRegistry } from './core/workspaces/runtime-registry.ts'
import { DEFAULTS } from './core/types/constants.ts'
import { loadMCPConfig, registerAllMCPServers } from './integrations/mcp/client.ts'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { loadSkills } from './skills/loader.ts'
import { loadAllPacks } from './packs/loader.ts'
import { asAIAgent } from './agents/shared.ts'
import { warmProviderModels } from './llm/providers-setup.ts'
import { parseLogConfigFromEnv } from './logging/config.ts'
import { sharedPaths } from './core/paths.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { wireWorkspaceRuntimeEvents } from './api/wire-workspace-runtime-events.ts'
import { wireAgentTracking } from './api/agent-tracking.ts'
import { validateBootstrap } from './boot/validate.ts'
import { buildProviderStack, summariseProviders } from './boot/provider-stack.ts'
import { createWSManager } from './api/ws-handler.ts'
// Process-wide tool factories. Anything that doesn't bind to a per-Workspace
// Deployment-scoped tools register into deployment.sharedToolRegistry once at boot, not per
// Workspace — see registerSharedTools below.
import {
  createPassTool, createGetTimeTool, createTestToolTool, createListSkillsTool,
  createWebTools, createWriteSkillTool, createWriteToolTool, createPackTools,
  createPlaceResolveTool, createGeoLookupTool, createGeoAddTool, createGeoRemoveTool, createGeoListCategoriesTool, createGeoListFeaturesTool,
  createProductKnowledgeTools,
} from './tools/built-in/index.ts'
import { createAgentsModuleState } from './core/workspaces/module-state.ts'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createPackManager, type PackManager } from './packs/manager.ts'
import { createWorkspacePackScrubber } from './packs/workspace-pack-scrubber.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')
  const ephemeral = process.env.LEITBILD_EPHEMERAL === '1'
  const workspaceHostUrl = process.env.WORKSPACE_HOST_URL
  if (!headless && workspaceHostUrl === undefined) {
    throw new Error('WORKSPACE_HOST_URL is required: Leitbild is entered through the Workspace Host')
  }

  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // === Provider stack ===
  // All the wiring (config → keys → setup → DeploymentRuntime) lives in one
  // place: src/boot/provider-stack.ts. That's where the bug class fixed
  // in commits f04e61e / d0c1f73 / 3729e50 surfaced; isolating the order
  // keeps the contract obvious.
  const { providerConfig, deployment } = await buildProviderStack()
  const moduleState = createAgentsModuleState()
  const providerSetup = deployment.providerSetup

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Leitbild v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviders(providerConfig))

  // === Boot logging template ===
  // Each per-Workspace system applies this in its onWorkspaceRuntimeCreated hook.
  const bootLogConfig = parseLogConfigFromEnv()

  // === MCP tools — load once at boot ===
  // Each MCP server is a stdio child process. We register the Tool[]
  // definitions directly into deployment.sharedToolRegistry so every per-Workspace
  // overlay can resolve them; the underlying connection is deployment. Also kept
  // on deployment.mcpTools as a list for any consumer that needs the raw set.
  const mcpConfig = await loadMCPConfig(process.env.LEITBILD_MCP_CONFIG)
  let mcpDisconnect = async (): Promise<void> => {}
  if (Object.keys(mcpConfig.mcpServers ?? {}).length > 0) {
    const tempRegistry = createToolRegistry()
    const result = await registerAllMCPServers(tempRegistry, mcpConfig)
    deployment.mcpTools.push(...tempRegistry.list())
    for (const tool of tempRegistry.list()) {
      deployment.sharedToolRegistry.register(tool)
    }
    mcpDisconnect = result.disconnect
  }

  // === Process-wide tool/skill/pack scan — once, into shared ===
  // Single FS scan: external tools, free-standing skills (cwd + leitbild-home),
  // and packs all register into the SHARED registry/store. Per-Workspace
  // Systems wrap this in an overlay (see createAgentsWorkspaceRuntime in workspace-runtime.ts).
  // Replaces the old per-Workspace loaders that ran inside onWorkspaceRuntimeCreated
  // and re-scanned everything for every cookie that hit the server.
  await loadExternalTools(deployment.sharedToolRegistry)
  await loadSkills(resolve(process.cwd(), 'skills'), deployment.sharedSkillStore, deployment.sharedToolRegistry)
  await loadSkills(sharedPaths.skills(), deployment.sharedSkillStore, deployment.sharedToolRegistry)
  const loadedPacks = await loadAllPacks(sharedPaths.packs(), deployment.sharedToolRegistry, deployment.sharedSkillStore)
  deployment.packCatalog.replaceInstalled(loadedPacks.map(result => result.pack))
  await deployment.sharedScriptStore.reload()

  // Bundled packs — compiled into the binary. Each pack's tools register
  // with kind:'pack-owned' + pack:<Pack id> so per-room activation
  // (room.activePacks) actually gates them. The packs themselves are
  // declared in src/packs/bundled.ts (the single source of truth for their
  // manifests and tool loaders).
  //
  // Bundled-pack tools are exempt from the `<pack>_<tool>` registry-key
  // prefix convention that filesystem packs follow (loadToolDirectory
  // applies the prefix; bundled Packs intentionally keep their declared names).
  {
    const { BUNDLED_PACKS } = await import('./packs/bundled.ts')
    for (const pack of BUNDLED_PACKS) {
      const packId = pack.manifest.descriptor.id
      for (const tool of await pack.loadTools()) {
        deployment.sharedToolRegistry.registerWithSource(tool, { kind: 'pack-owned', pack: packId, displayName: tool.name })
      }
    }
  }

  // Pack-owned geodata: scan ~/.leitbild/packs/<ns>/geodata/*.geojson and
  // load into the in-memory pack-source cache. Features are tagged
  // source='pack', pack=<ns> so the room-aware filter can gate them per
  // activePacks. Failures per-pack are logged but don't abort boot —
  // bad geodata in one pack shouldn't sink leitbild.
  {
    const { refreshPackGeodata } = await import('./geo/pack-source.ts')
    const packGeoState = await refreshPackGeodata(sharedPaths.packs())
    if (packGeoState.perPackFeatureCounts.size > 0) {
      const counts = [...packGeoState.perPackFeatureCounts.entries()]
        .map(([ns, n]) => `${ns}=${n}`)
        .join(' ')
      console.log(`[geo/pack] loaded: ${counts}`)
    }
    for (const e of packGeoState.errors) {
      console.warn(`[geo/pack] ${e.pack}/${e.file}: ${e.reason}`)
    }
  }

  // Bundled examples, authored scripts, and Pack scripts now share one
  // Deployment catalog. Script runs remain isolated inside each Workspace.

  // === Process-wide built-in tools (no per-Workspace state) ===
  // Anything that doesn't bind to a per-Workspace RoomDirectory registers ONCE here.
  // RoomDirectory-bound tools (room ops, artifacts, post_to_room, …) stay in
  // createAgentsWorkspaceRuntime and live in the per-Workspace overlay.
  const isDeployMode = !!(process.env.LEITBILD_TOKEN && process.env.LEITBILD_TOKEN.length > 0)
  const flag = (name: string, defaultOn: boolean): boolean => {
    const v = process.env[name]
    if (v === '1') return true
    if (v === '0') return false
    return defaultOn
  }
  const networkToolsEnabled = flag('LEITBILD_ENABLE_NETWORK_TOOLS', !isDeployMode)
  // codegenEnabled gates write_skill + write_tool only — agents writing
  // arbitrary TypeScript into ~/.leitbild/. Default-off in deploy mode is
  // the right call there.
  const codegenEnabled = flag('LEITBILD_ENABLE_CODEGEN', !isDeployMode)
  // packsEnabled gates install/update/uninstall/list_packs and
  // list_available_packs — installing a vetted GitHub pack is a different
  // threat profile (you trust the pack's source) than an agent producing
  // arbitrary TS. Default-on everywhere; operator can flip to 0 to lock
  // the runtime to whatever is on disk at boot.
  const packsEnabled = flag('LEITBILD_ENABLE_PACKS', true)

  deployment.sharedToolRegistry.register(createPassTool())
  deployment.sharedToolRegistry.register(createGetTimeTool())
  deployment.sharedToolRegistry.registerAll(createProductKnowledgeTools())
  deployment.sharedToolRegistry.register(createTestToolTool(deployment.sharedToolRegistry))
  deployment.sharedToolRegistry.register(createListSkillsTool(deployment.sharedSkillStore))
  // Register shared geodata tools against the canonical authoring layout.
  // Forward-bound resolver: registry is created later in this function,
  // but createGeoLookupTool is constructed now. We hand the tool a closure
  // that will read from `registry` at call time — by which point it's been
  // assigned (the closure can't fire before bootstrap completes since the
  // tool registry isn't reachable until that happens).
  const getRoomActivePacksForGeo = (roomId: string): ReadonlyArray<string> | undefined => {
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      const room = sys.rooms.getRoom(roomId)
      if (room) return room.getActivePacks()
    }
    return undefined
  }
  deployment.sharedToolRegistry.register(createPlaceResolveTool())
  deployment.sharedToolRegistry.register(createGeoLookupTool({ getActivePacks: getRoomActivePacksForGeo }))
  deployment.sharedToolRegistry.register(createGeoAddTool())
  deployment.sharedToolRegistry.register(createGeoRemoveTool())
  deployment.sharedToolRegistry.register(createGeoListCategoriesTool())
  deployment.sharedToolRegistry.register(createGeoListFeaturesTool())
  // Optional wiki_lookup is Workspace-bound. It derives manifest sources
  // from the current Room's active Packs; link-only references remain links.

  // Geodata: pack-owned categories load via refreshPackGeodata above.
  // The historical leitbild-geodata GitHub discovery + warm cache were
  // retired in commit Q — packs are now the only distribution mechanism
  // for non-user geodata.

  if (networkToolsEnabled) {
    deployment.sharedToolRegistry.registerAll(createWebTools({
      tavilyApiKey: process.env.TAVILY_API_KEY,
      braveApiKey: process.env.BRAVE_API_KEY,
      googleApiKey: process.env.GOOGLE_CSE_API_KEY,
      googleCseId: process.env.GOOGLE_CSE_ID,
    }))
  }
  if (codegenEnabled) {
    // write_skill writes a SKILL.md file and registers into the shared store —
    // visible across Workspaces immediately. write_tool / pack admin land
    // below, after `registry` exists (they need cross-Workspace refresh).
    deployment.sharedToolRegistry.register(createWriteSkillTool(deployment.sharedSkillStore, sharedPaths.skills()))
  }

  // === Per-agent wiring on spawn/remove ===
  // Implementation lives in src/api/agent-tracking.ts so the regression test
  // (src/api/agent-state-wiring.test.ts) exercises the SAME code that runs
  // in production. Do not duplicate the wrapper logic here.

  // === WorkspaceRuntimeRegistry ===
  // The onWorkspaceRuntimeCreated hook closes over `wsManager` (assigned right after
  // createWorkspaceRuntimeRegistry returns, before any `registry.getOrLoad()` call).
  // The hook always sees a defined value. In headless mode the wsManager is
  // constructed but never accepts upgrades — no WS clients connect.
  // Definite-assignment assertion (`!`) is fine: the assignment site below
  // runs synchronously before any registry consumer code.
  let wsManager!: ReturnType<typeof createWSManager>
  const workspaceEventUnsubscribers = new Map<WorkspaceId, () => void>()

  // === WorkspaceRuntimeRegistry ===
  const registry = createWorkspaceRuntimeRegistry({
    deployment,
    moduleState,
    ...(workspaceHostUrl === undefined ? {} : { workspaceHostUrl }),
    // Lazy validateBootstrap: fires once on the first successful getOrLoad.
    // Replaces the boot-time call against a throwaway boot system. Contract
    // still runs before any traffic actually reaches a System; we just
    // don't materialize an empty Workspace dir for the privilege.
    // The wsManager closure is safe because (a) the let-with-assertion
    // pattern guarantees it's set before any getOrLoad runs, and (b) the
    // onWorkspaceRuntimeCreated hook below calls wireWorkspaceRuntimeEvents synchronously,
    // so by the time onFirstLoad fires the wired-state is already true.
    onFirstLoad: (system, id) => validateBootstrap(system, {
      isWsWired: () => wsManager.isWired(id),
    }),
    onWorkspaceRuntimeCreated: async (system, id, autoSaver) => {
      // No per-Workspace FS scans: external tools, skills, packs and MCP
      // tools all live in deployment.sharedToolRegistry (populated above before
      // the registry was built). Per-Workspace toolRegistry is a thin overlay
      // that adds Workspace-bound built-ins on top. See workspace-runtime.ts createAgentsWorkspaceRuntime.
      // Configure logging from env template.
      try {
        await system.logging.configure(bootLogConfig)
      } catch (err) {
        console.error(`[logging] failed to apply boot config: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Track agents for provider-event routing. Walk existing agents from
      // any snapshot restore; wrap spawn/remove for new ones.
      for (const agent of system.team.listAgents()) {
        registry.attachAgent(agent.id, id)
      }
      wireAgentTracking(system, id, {
        attach: registry.attachAgent,
        detach: registry.detachAgent,
        subscribeAgentState: wsManager.subscribeAgentState,
        unsubscribeAgentState: wsManager.unsubscribeAgentState,
      })
      // Wire WS broadcasts + autosave. wsManager is guaranteed assigned
      // by the time any getOrLoad runs (see the `let wsManager!:` block
      // above). autoSaver is passed in directly because the registry map
      // entry isn't set until buildWorkspaceRuntime returns.
      workspaceEventUnsubscribers.set(id, wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id))
    },
    onWorkspaceRuntimeEvicted: (system, id) => {
      workspaceEventUnsubscribers.get(id)?.()
      workspaceEventUnsubscribers.delete(id)
      // Close WS sessions for this Workspace — they hold dangling references.
      for (const [token, sess] of [...wsManager.sessions]) {
        if (sess.workspaceId !== id) continue
        const ws = wsManager.wsConnections.get(token) as { close?: (code: number, reason?: string) => void } | undefined
        try { ws?.close?.(1001, 'Workspace evicted') } catch { /* ignore */ }
        wsManager.sessions.delete(token)
        wsManager.wsConnections.delete(token)
      }
      // Detach all agents from the reverse index AND drop their state
      // subscriptions. Without the unsubscribeAgentState call, stateUnsubs
      // keeps entries bound to dead agent.state closures from this evicted
      // System; on lazy-reload the snapshot restores agents with the SAME
      // IDs but FRESH state objects, the idempotent guard in
      // subscribeAgentState silently skips re-subscription, and the
      // restored agents' notifyState() calls fire to nowhere — no
      // 'generating' broadcast, no thinking indicator, no streaming
      // visible in the UI even though chunks broadcast fine. The registry
      // eviction/reload integration test protects this boundary.
      for (const a of system.team.listAgents()) {
        registry.detachAgent(a.id)
        wsManager.unsubscribeAgentState(a.id)
      }
    },
  })

  // === Cross-Workspace refresh + pack-change notification ===
  // Tool changes (install_pack, write_tool) need to propagate to every live
  // Workspace, not just the one whose agent triggered the change. The shared
  // toolRegistry is already updated; what we still need is to rebuild each
  // agent's frozen tool-executor and tool-definitions snapshot.
  const crossWorkspaceRefreshAllAgentTools = async (): Promise<void> => {
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      try { await sys.refreshAllAgentTools() } catch (err) {
        console.error(`[refresh] Workspace ${meta.id}:`, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // Drop a [admin] system note into every room with at least one AI agent
  // across every active Workspace. Without this an agent's chat history
  // keeps "tool unavailable" replies from before the install — Gemini and
  // others pattern-match against past output and keep claiming the tool
  // doesn't exist even with the right toolDefinitions in the request.
  const crossWorkspaceNotifyPacksChanged = (info: {
    readonly action: 'installed' | 'updated' | 'uninstalled'
    readonly packId: string
    readonly tools: ReadonlyArray<string>
    readonly skills: ReadonlyArray<string>
  }): void => {
    wsManager.broadcastAllWorkspaces({ type: 'packs_changed' })
    const note = info.action === 'uninstalled'
      ? `[admin] Pack "${info.packId}" was uninstalled. ${info.tools.length} tools and ${info.skills.length} skills are no longer available.`
      : `[admin] Pack "${info.packId}" was ${info.action}. Tools available now: ${info.tools.join(', ') || '(none)'}. Skills: ${info.skills.join(', ') || '(none)'}. Disregard any earlier message claiming these were unavailable.`
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      for (const room of sys.rooms.listAllRooms()) {
        const hasAi = sys.team.listByKind('ai').some(a =>
          sys.rooms.getRoomsForAgent(a.id).some(r => r.profile.id === room.id),
        )
        if (!hasAi) continue
        try {
          sys.routeMessage({ rooms: [room.id] }, {
            senderId: 'system', senderName: 'system',
            content: note, type: 'system',
          })
        } catch { /* ignore — best-effort */ }
      }
    }
  }

  // Now that registry exists, finish wiring shared tools that needed it.
  // Two independent gates: codegenEnabled covers write_tool (arbitrary TS
  // on disk); packsEnabled covers vetted GitHub pack management.
  if (codegenEnabled) {
    deployment.sharedToolRegistry.register(createWriteToolTool(
      deployment.sharedToolRegistry, deployment.sharedSkillStore, crossWorkspaceRefreshAllAgentTools,
    ))
  }
  const crossWorkspaceScrubActivePacks = createWorkspacePackScrubber({
    registry,
    broadcastToWorkspace: (workspaceId, message) => wsManager.broadcastToWorkspace(workspaceId, message),
  })

  // Re-scan pack geodata after install/update/uninstall so new
  // <pack>/geodata/*.geojson contents surface in geo_lookup + the
  // overview UI without a server restart.
  const refreshPackGeodataAfterMutation = async (): Promise<void> => {
    const { refreshPackGeodata } = await import('./geo/pack-source.ts')
    await refreshPackGeodata(sharedPaths.packs())
  }

  const refreshPackScriptsAfterMutation = async (): Promise<void> => {
    await deployment.sharedScriptStore.reload()
  }

  const packManager: PackManager = createPackManager({
    mutationsEnabled: packsEnabled,
    packsDir: sharedPaths.packs(),
    toolRegistry: deployment.sharedToolRegistry,
    skillStore: deployment.sharedSkillStore,
    catalog: deployment.packCatalog,
    refreshAllAgentTools: crossWorkspaceRefreshAllAgentTools,
    notifyPacksChanged: crossWorkspaceNotifyPacksChanged,
    scrubActivePacks: crossWorkspaceScrubActivePacks,
    refreshPackGeodata: refreshPackGeodataAfterMutation,
    refreshPackScripts: refreshPackScriptsAfterMutation,
  })
  if (packsEnabled) {
    deployment.sharedToolRegistry.registerAll(createPackTools(packManager))
  }

  // === wsManager — assigned NOW (before any registry.getOrLoad runs) ===
  // wsManager is registry-aware: buildSnapshot and subscribeAgentState
  // resolve the live System per workspaceId rather than closing over a
  // single boot system. State subscriptions broadcast scoped to the
  // originating Workspace via broadcastToWorkspace.
  // Order matters: this assignment MUST happen before the first getOrLoad,
  // otherwise the onWorkspaceRuntimeCreated hook would observe `wsManager` undefined
  // and silently skip wireWorkspaceRuntimeEvents. Pre-assigning wsManager
  // keeps the hook's wiring path single, with no rescue branch elsewhere.
  wsManager = createWSManager({
    getRuntime: (id) => registry.tryGetLive(id),
    limitMetrics: deployment.limitMetrics,
  })

  // Wire the per-provider monitor heartbeat to the live WS-client count.
  // While at least one client is connected the heartbeats run on their
  // adaptive cadence; with zero clients the heartbeats become no-ops and
  // an idle Leitbild (no open tab) consumes zero requests. Providers were
  // built before WSManager existed, so this is a post-construction wire-up.
  for (const monitor of Object.values(providerSetup.monitors)) {
    monitor.setIsActive(() => wsManager.sessionCount() > 0)
  }

  // === Provider routing event dispatcher (registry-aware) ===
  deployment.setProviderEventDispatcher((event) => {
    if (!event.agentId) return   // events without an agentId can't be routed
    const workspaceId = registry.workspaceForAgent(event.agentId)
    if (!workspaceId) return      // late event for evicted/removed agent
    // tryGetLive returns the in-memory system if it's currently active;
    // does NOT trigger a lazy-load (we don't want a late provider event
    // to resurrect an evicted Workspace just to dispatch one event).
    const sys = registry.tryGetLive(workspaceId)
    if (!sys) return
    try { sys.dispatchProviderEvent(event) } catch { /* drop */ }
  })

  // === Boot the appropriate runtime ===
  if (headless) {
    // Headless: fresh Workspace per process boot. No janitor or eviction.
    const headlessId = newWorkspaceId()
    await moduleState.provision(headlessId)
    const system = await registry.getOrLoad(headlessId)

    // The same Workspace event wiring runs in headless mode. There are no
    // WebSocket sessions to receive its broadcasts, while MCP notifications
    // use their own runtime subscriptions below.

    // Warm provider model caches (best-effort).
    const warmResults = await warmProviderModels(providerSetup.gateways)
    for (const [name, result] of Object.entries(warmResults)) {
      if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
      else console.warn(`  ${name}: warm-up failed — ${result.message}`)
    }

    // Single contract check — every wiring invariant a bug has uncovered
    // gets a line in src/boot/validate.ts. Throwing here fails the boot
    // loud and clear instead of running with broken wiring.
    validateBootstrap(system)

    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system, pkg.version)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')

    // Headless graceful shutdown.
    const shutdown = async (): Promise<void> => {
      const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
      const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
      await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
      if (!ephemeral) {
        try { await registry.shutdown() } catch (err) { console.error('shutdown flush:', err) }
      }
      try { await system.logging.configure({ enabled: false }) } catch { /* noop */ }
      await mcpDisconnect()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  // === HTTP mode ===
  // No boot Workspace. The Leitbild Host provisions Module state;
  // the first URL-scoped application request loads that state. validateBootstrap
  // runs on the first getOrLoad via onFirstLoad above.

  // Warm provider model caches. Awaited synchronously: B3 of the audit
  // requires that warm complete BEFORE we accept traffic, so the router's
  // catalog filter has real data to work with (no optimistic-include).
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
    else console.warn(`  ${name}: warm-up failed — ${result.message}`)
  }

  // Tool surface log — sourced from the shared registry (process-wide).
  // Per-Workspace overlays (Room/Team-bound built-ins) aren't included; those
  // are uniform across Workspaces anyway.
  console.log(`Tools: ${deployment.sharedToolRegistry.list().map(t => t.name).join(', ')}`)

  // Contribution summary. Built-in and authored contributions are always
  // available; only Pack-owned contributions are gated by Room activation.
  {
    const entries = deployment.sharedToolRegistry.listEntries()
    const skillEntries = deployment.sharedSkillStore.list()
    const counts = new Map<string, { tools: number; skills: number }>()
    const bump = (pack: string, kind: 'tools' | 'skills'): void => {
      const slot = counts.get(pack) ?? { tools: 0, skills: 0 }
      slot[kind]++
      counts.set(pack, slot)
    }
    for (const e of entries) {
      switch (e.source.kind) {
        case 'built-in':       bump('built-in', 'tools'); break
        case 'external':       bump('authored', 'tools'); break
        case 'pack-owned':   bump(e.source.pack ?? 'unowned', 'tools'); break
        case 'skill-bundled':  bump(e.source.pack ?? 'unowned', 'tools'); break
      }
    }
    for (const s of skillEntries) bump(s.pack ?? 'authored', 'skills')
    const ordered: ReadonlyArray<readonly [string, { tools: number; skills: number }]> = [
      ['built-in', counts.get('built-in') ?? { tools: 0, skills: 0 }],
      ['authored', counts.get('authored') ?? { tools: 0, skills: 0 }],
      ...[...counts.entries()].filter(([k]) => k !== 'built-in' && k !== 'authored').sort((a, b) => a[0].localeCompare(b[0])),
    ]
    const fmt = ordered.map(([ns, c]) => `${ns}=${c.tools}t/${c.skills}s`).join(' ')
    console.log(`[packs] contribution surface: ${fmt}`)
  }

  // === Explicit trash cleanup + idle runtime eviction ===
  let evictionSweepRunning = false
  const runEvictionSweep = async (): Promise<void> => {
    if (evictionSweepRunning) {
      console.warn('[registry] idle eviction sweep skipped because the previous sweep is still running')
      return
    }
    evictionSweepRunning = true
    try {
      const evicted = await registry.evictIdle()
      if (evicted > 0) console.log(`[registry] idle eviction sweep removed ${evicted} Workspace(s)`)
    } catch (err) {
      console.error(`[registry] evictIdle: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      evictionSweepRunning = false
    }
  }
  const evictTimer = setInterval(() => { void runEvictionSweep() }, 60_000)

  // Stale-session sweep — every hour, drop sessions whose WS has been
  // closed for >7d and remove the inactive human agent from its team.
  // Without this, every disconnected user accumulates forever until the
  // Workspace is evicted.
  const sessionSweepTimer = setInterval(() => {
    try { wsManager.sweepStaleSessions() } catch (err) {
      console.error(`[ws] sweepStaleSessions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, 60 * 60 * 1000)

  // === Diagnostics capability ===
  // Read-only health snapshot. Walks the registry + wsManager state to
  // expose per-Workspace broadcast wiring + last-broadcast timestamps. The
  // signal that catches the silent-skip class of bug we just fixed: an
  // active Workspace with zero broadcasts under live traffic is wrong.
  const diagnostics = {
    snapshot: () => ({
      workspaces: registry.list().map(meta => {
        const sys = registry.tryGetLive(meta.id)
        const aiAgents = sys?.team.listByKind('ai') ?? []
        return {
          id: meta.id,
          wired: wsManager.isWired(meta.id),
          agentCount: aiAgents.length,
          generatingAgentCount: aiAgents.filter(agent => agent.state.get() === 'generating').length,
          lastBroadcastAt: wsManager.lastBroadcastAt(meta.id),
        }
      }),
      wsSessions: wsManager.sessionCount(),
      configuredIdleMs: registry.idleMs(),
      maxLoadedWorkspaces: registry.maxLoadedWorkspaces(),
    }),
  }

  // === HTTP + WS server ===
  // Development launches rebuild missing or stale CSS. Immutable production
  // releases trust the CSS generated by the deployment pipeline because file
  // copy order makes release mtimes unsuitable as a freshness signal. Missing
  // CSS is still rebuilt (or exposed by the runtime fallback banner).
  {
    const { ensureCssBuilt } = await import('./api/ensure-css-built.ts')
    const uiPath = `${import.meta.dir}/ui`
    await ensureCssBuilt({ uiPath, checkStaleness: process.env.NODE_ENV !== 'production' })
  }
  const { createServer } = await import('./api/server.ts')
  createServer({
    registry,
    moduleState,
    wsManager,
    port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
    diagnostics,
    packManager,
    workspaceHostUrl,
  })

  // === Graceful shutdown ===
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down, saving snapshots...')
    clearInterval(evictTimer)
    clearInterval(sessionSweepTimer)
    if (!ephemeral) {
      try { await registry.shutdown() } catch (err) { console.error('Failed to flush snapshots:', err) }
    }
    // Disable logging on every still-live Workspace. Process exit would close
    // the JSONL sinks anyway, but explicit configure({enabled:false}) lets
    // each Workspace flush a clean shutdown line first.
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (sys) try { await sys.logging.configure({ enabled: false }) } catch { /* noop */ }
    }
    await mcpDisconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
