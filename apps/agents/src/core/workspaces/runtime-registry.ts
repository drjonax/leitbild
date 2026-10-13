import { createRoomDefinitionLibrary, type RoomDefinitionLibrary } from "../definitions/room-definition-library.ts"
import { createOperationScope } from '@leitbild/module-runtime'
// ============================================================================
// WorkspaceRuntimeRegistry — per-tenant RoomDirectory lifecycle keyed by Workspace ID.
//
// One process holds many Workspaces; each has one lazy Agents runtime with
// separate Room and Agent persistence documents. The registry lazy-loads from disk,
// keeps the AgentsWorkspaceRuntime in memory while active, and evicts idle ones after
// LEITBILD_IDLE_MS (default 30 min) by flushing snapshot + dropping the
// in-memory reference. Subsequent requests lazy-reload from disk.
//
// Concurrency contract:
//   - `pendingLoads` dedupes concurrent first-time loads of the same id.
//   - In-map entries can be in `state: 'active' | 'evicting'`.
//     New requests during eviction await the eviction completion, then
//     load fresh from disk.
//   - All maps are mutated only on the event loop thread (single-threaded
//     JS); no locks needed. The discipline is: never `await` between a
//     state read and a state write that depends on it.
//
// Public surface:
//   getOrLoad(id)           — single source of truth; touches lastTouchedAt
//   peopleFor(id)           — the Workspace's People directory; never loads the runtime
//   evictOne(id)            — graceful: drain → flush → drop. Idempotent.
//   evictIdle(now, idleMs)  — periodic sweep
//   exists(id)              — disk OR memory
//   list()                  — readonly meta for admin
//   shutdown()              — flush all + clear
//
// What lives outside the registry's concern:
//   - Module marker and snapshot path resolution (core/paths.ts)
//   - Per-Workspace event-callback wiring (wireWorkspaceRuntimeEvents)
//   - Janitor (Workspace-cleanup.ts) — operates on disk only
//
// === buildWorkspaceRuntime ordering (subtle; was the source of 5d73a8e) ===
// Inside buildWorkspaceRuntime(id):
//   1. createAgentsWorkspaceRuntime(...)           — new in-memory AgentsWorkspaceRuntime, no events wired.
//   2. loadSnapshot + restoreFromSnapshot  — agents rehydrated.
//   3. buildAutoSaver              — debounced snapshot writer.
//   4. opts.onWorkspaceRuntimeCreated(...)   — caller's wiring runs HERE.
//   5. seedWorkspaceIdentity(system) (if no snapshot) — You only.
//   6. return { system, autoSaver }
// THEN in getOrLoad:
//   7. map.set(id, entry)          — registry knows about the system.
//
// Steps 4 runs BEFORE step 7. Inside the hook, `registry.autoSaverFor(id)`
// returns null (the entry isn't in the map yet) and `tryGetLive(id)` returns
// undefined. Anything the hook needs that depends on per-id state must be
// passed in directly — that's why onWorkspaceRuntimeCreated takes (system, id, autoSaver)
// as arguments, not just (system, id). Resist any refactor that moves
// "look up the saver from the registry" into the hook.
// ============================================================================

import type { AgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import type { DeploymentRuntime } from '../deployment-runtime.ts'
import { createAgentsWorkspaceRuntime } from '../../workspace-runtime.ts'
import {
  createModuleAutoSaver,
  loadWorkspaceModuleSnapshots,
  restoreWorkspaceModuleSnapshots,
  type ModuleAutoSaver,
} from '../storage/module-snapshots.ts'
import { workspaceModulePaths, isValidWorkspaceId, sharedPaths } from '../paths.ts'
import { readdir, stat } from 'node:fs/promises'
import { asAIAgent } from '../../agents/shared.ts'
import { seedWorkspaceIdentity } from './seed-workspace.ts'
import type { WorkspaceId } from '@leitbild/contracts'
import type { AgentsModuleState } from './module-state.ts'
import { createPeopleDirectory, type PeopleDirectory } from '../people/people-directory.ts'
import { createPeopleMetrics, type PeopleMetrics, type PeopleMetricsSnapshot } from '../people/people-metrics.ts'
import { createWaiterBudget } from '../people/presence.ts'
import { agentsStorageBudget } from '../storage/admission.ts'

// --- Defaults & env ---

const DEFAULT_IDLE_MS = 30 * 60_000   // 30 min
const DEFAULT_DRAIN_MS = 5_000
// The production service has a 2 GiB cgroup cap. A seeded Workspace currently
// costs roughly 1 MiB, so 128 leaves ample room for shared provider/catalog/UI
// state and transient generation spikes while still supporting far more
// concurrent rooms than the sandbox normally sees.
const DEFAULT_MAX_LOADED_WORKSPACES = 128

const idleMsFromEnv = (): number => {
  const v = process.env.LEITBILD_IDLE_MS
  if (!v) return DEFAULT_IDLE_MS
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS
}

const maxLoadedWorkspacesFromEnv = (): number => {
  const v = process.env.LEITBILD_MAX_LOADED_WORKSPACES
  if (!v) return DEFAULT_MAX_LOADED_WORKSPACES
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_LOADED_WORKSPACES
}

// --- Types ---

export interface WorkspaceRuntimeMeta {
  readonly id: WorkspaceId
  readonly lastTouchedAt: number
  readonly state: 'active' | 'evicting' | 'save-failed'
}

/** Aggregate People counters plus live gauges, for operator diagnostics. */
export interface PeopleStatus extends PeopleMetricsSnapshot {
  readonly openDirectories: number
  readonly waiters: number
  readonly liveScreens: number
}

export interface WorkspaceModuleOnDisk {
  readonly id: WorkspaceId
  readonly snapshotMtimeMs: number   // 0 if snapshot file is missing
  readonly snapshotSizeBytes: number // 0 if snapshot file is missing
}

interface WorkspaceRuntimeEntry {
  readonly system: AgentsWorkspaceRuntime
  readonly autoSaver: ModuleAutoSaver
  lastTouchedAt: number
  state: 'active' | 'evicting' | 'save-failed'
  evictionPromise?: Promise<void>               // present iff state='evicting'
}

export interface WorkspaceRuntimeRegistryOptions {
  readonly deployment: DeploymentRuntime
  readonly moduleState: AgentsModuleState
  readonly workspaceHostUrl?: string
  readonly idleMs?: number                      // override default 30 min
  readonly drainMs?: number                     // override default 5s
  readonly maxLoadedWorkspaces?: number          // hard LRU safety bound
  // Hook called immediately after a fresh AgentsWorkspaceRuntime is constructed (either
  // first load or post-eviction reload). Bootstrap wires WS broadcasts here.
  // The autoSaver is passed in directly because the registry's map entry
  // isn't set until AFTER this hook returns — so registry.autoSaverFor(id)
  // would return null inside the hook. Subtle and was the source of a
  // long-running bug where streaming events never reached lazily loaded Workspaces.
  //
  // The hook is awaited. It MUST complete (wireAgentTracking +
  // wireWorkspaceRuntimeEvents installed) before identity seeding runs.
  // the seeded AI bypasses the spawn-wrapper and never gets per-agent
  // hooks (state subscription, attachAgent). Returning Promise<void> is
  // mandatory for any hook that does async work.
  readonly onWorkspaceRuntimeCreated?: (runtime: AgentsWorkspaceRuntime, id: WorkspaceId, autoSaver: ModuleAutoSaver) => Promise<void> | void
  // Hook called immediately before a AgentsWorkspaceRuntime is dropped from memory.
  // Bootstrap removes the WS callback wiring here.
  readonly onWorkspaceRuntimeEvicted?: (runtime: AgentsWorkspaceRuntime, id: WorkspaceId) => void
  // Fires exactly once, after the first successful getOrLoad in this
  // process. Replaces the boot-time validateBootstrap call: the contract
  // check still runs before any traffic actually reaches a AgentsWorkspaceRuntime, but
  // we don't materialize a throwaway boot Workspace just to validate.
  // Receives the Workspace id so contract checks can verify per-Workspace
  // wiring (e.g. wsManager.isWired(id)).
  readonly onFirstLoad?: (runtime: AgentsWorkspaceRuntime, id: WorkspaceId) => void
}

export interface WorkspaceRuntimeRegistry {
  readonly withWorkspace: <T>(id: WorkspaceId, work: () => Promise<T>) => Promise<T>
  readonly definitionsFor: (id: WorkspaceId) => RoomDefinitionLibrary
  // The People of a Workspace, independent of its Agents runtime: opening it
  // checks the Module marker once and never calls getOrLoad.
  readonly peopleFor: (id: WorkspaceId) => Promise<PeopleDirectory>
  readonly peopleMetrics: PeopleMetrics
  readonly peopleStatus: () => PeopleStatus
  readonly getOrLoad: (id: WorkspaceId) => Promise<AgentsWorkspaceRuntime>
  readonly evictOne: (id: WorkspaceId) => Promise<void>
  readonly remove: (id: WorkspaceId) => Promise<void>
  readonly evictIdle: (now?: number) => Promise<number>
  readonly exists: (id: WorkspaceId) => Promise<boolean>
  readonly list: () => ReadonlyArray<WorkspaceRuntimeMeta>
  // Enumerate every valid Workspace directory under LEITBILD_HOME/workspaces,
  // returning snapshot mtime + size. Includes Workspaces not currently in memory.
  readonly listOnDisk: () => Promise<ReadonlyArray<WorkspaceModuleOnDisk>>
  readonly shutdown: () => Promise<void>
  // For tests + boundary handlers that need to know the configured timer.
  readonly idleMs: () => number
  readonly maxLoadedWorkspaces: () => number
  // Boundary access to the in-memory autosaver for an active Workspace.
  // wireWorkspaceRuntimeEvents needs it to schedule saves from broadcast callbacks.
  // Returns null if the Workspace is not currently in memory.
  readonly autoSaverFor: (id: WorkspaceId) => ModuleAutoSaver | null
  // In-memory only lookup. Returns the live AgentsWorkspaceRuntime for `id` if it is
  // currently loaded and active (not evicting), else undefined.
  //
  // SILENTLY returns undefined for evicted/unloaded Workspaces. Every
  // existing caller depends on this — late provider events drop, WS
  // snapshot building closes the socket with 4001, cross-Workspace fan-
  // outs skip the missing Workspace. If you need a hard error or you
  // need to materialize the system, use `getOrLoad` instead. Adding a
  // call site that quietly skips when the answer should be "load this"
  // is how silent-skip bugs hide — see AGENTS.md "no silent skips on
  // optional dependencies."
  readonly tryGetLive: (id: WorkspaceId) => AgentsWorkspaceRuntime | undefined
  // Agent → Workspace reverse index for provider routing events. Bootstrap
  // wires shared.setProviderEventDispatcher to use this.
  readonly attachAgent: (agentId: string, workspaceId: WorkspaceId) => void
  readonly detachAgent: (agentId: string) => void
  readonly workspaceForAgent: (agentId: string) => WorkspaceId | undefined
}

// ============================================================================

export const createWorkspaceRuntimeRegistry = (opts: WorkspaceRuntimeRegistryOptions): WorkspaceRuntimeRegistry => {
  // Definition writes must share one queue even across Room-runtime eviction.
  // Keeping this lightweight service separate also keeps catalog reads lazy.
  const definitionLibraries = new Map<WorkspaceId, RoomDefinitionLibrary>()
  const workspaceOperations = new Map<WorkspaceId, ReturnType<typeof createOperationScope>>()
  const withWorkspace = async <T>(id: WorkspaceId, work: () => Promise<T>): Promise<T> => {
    if (shuttingDown || removing.has(id)) throw Object.assign(new Error('Agents Workspace is closing'), { code: 'workspace_closing' })
    let operations = workspaceOperations.get(id)
    if (!operations) { operations = createOperationScope(`Agents Workspace ${id}`); workspaceOperations.set(id, operations) }
    return await operations.run(async () => {
      if (!await opts.moduleState.has(id)) throw new Error(`Workspace not found: ${id}`)
      return await work()
    })
  }
  const definitionsFor = (id: WorkspaceId): RoomDefinitionLibrary => {
    if (shuttingDown || removing.has(id)) throw Object.assign(new Error('Agents Workspace is closing'), { code: 'workspace_closing' })
    let library = definitionLibraries.get(id)
    if (!library) {
      library = createRoomDefinitionLibrary(id)
      definitionLibraries.set(id, library)
    }
    return library
  }
  // People directories open per Workspace on first use and share one waiter
  // budget and one set of aggregate counters across the process.
  const peopleDirectories = new Map<WorkspaceId, PeopleDirectory>()
  const pendingPeople = new Map<WorkspaceId, Promise<PeopleDirectory>>()
  const peopleMetrics = createPeopleMetrics()
  const peopleWaiterBudget = createWaiterBudget()
  const workspaceClosing = (): Error => Object.assign(new Error('Agents Workspace is closing'), { code: 'workspace_closing' })
  const peopleFor = async (id: WorkspaceId): Promise<PeopleDirectory> => {
    if (shuttingDown || removing.has(id)) throw workspaceClosing()
    const open = peopleDirectories.get(id)
    if (open) return open
    const pending = pendingPeople.get(id)
    if (pending) return await pending
    const opening = (async (): Promise<PeopleDirectory> => {
      if (!await opts.moduleState.has(id)) throw new Error(`Workspace not found: ${id}`)
      // Removal or shutdown may have begun while the marker was read. From
      // here to the map insert nothing yields, so a removed Workspace's
      // directory is never recreated by opening its store.
      if (shuttingDown || removing.has(id)) throw workspaceClosing()
      const paths = workspaceModulePaths(id)
      const directory = createPeopleDirectory({
        workspaceId: id,
        path: paths.agents.people,
        metrics: peopleMetrics,
        waiterBudget: peopleWaiterBudget,
        admitGrowth: (bytes, work) => agentsStorageBudget().withGrowth(paths.agents.root, bytes, work),
      })
      peopleDirectories.set(id, directory)
      return directory
    })().finally(() => pendingPeople.delete(id))
    pendingPeople.set(id, opening)
    return await opening
  }
  // Answers every waiting sync and closes the store before its files go.
  const closePeople = async (id: WorkspaceId): Promise<void> => {
    const pending = pendingPeople.get(id)
    // An opening that fails reports to its own caller; closing only needs it settled.
    if (pending) await pending.then(() => undefined, () => undefined)
    const directory = peopleDirectories.get(id)
    // No directory: nobody used People in this Workspace since it was last closed.
    if (directory === undefined) return
    peopleDirectories.delete(id)
    directory.close()
  }
  const peopleStatus = (): PeopleStatus => {
    let waiters = 0
    let liveScreens = 0
    for (const directory of peopleDirectories.values()) {
      const stats = directory.stats()
      waiters += stats.waiters
      liveScreens += stats.liveScreens
    }
    return { ...peopleMetrics.snapshot(), openDirectories: peopleDirectories.size, waiters, liveScreens }
  }
  const idleMs = opts.idleMs ?? idleMsFromEnv()
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS
  const maxLoadedWorkspaces = opts.maxLoadedWorkspaces ?? maxLoadedWorkspacesFromEnv()
  if (!Number.isSafeInteger(maxLoadedWorkspaces) || maxLoadedWorkspaces <= 0) {
    throw new Error(`[registry] maxLoadedWorkspaces must be a positive integer; got ${String(maxLoadedWorkspaces)}`)
  }
  const map = new Map<WorkspaceId, WorkspaceRuntimeEntry>()
  const pendingLoads = new Map<WorkspaceId, Promise<AgentsWorkspaceRuntime>>()
  const removing = new Map<WorkspaceId, Promise<void>>()
  let shuttingDown = false
  // Reverse index for provider event routing. Populated when an agent
  // is spawned in an Workspace; cleared on agent removal or Workspace evict.
  const agentWorkspaceMap = new Map<string, WorkspaceId>()

  // --- Internals ---

  // A5: two-phase drain.
  //   Phase 1 — race natural idle vs drainMs timeout. Most evals finish well
  //   under the limit; this is the happy path.
  //   Phase 2 — anything still generating (slow LLM, network hang) gets
  //   cancelled. cancelGeneration aborts the AbortController and clears the
  //   active flag synchronously; whenIdle resolves on the next microtask.
  //   A short final wait (100ms) converges. Without this, an agent stuck in
  //   eval would have its result land in the now-evicted system as a ghost
  //   message on next reload.
  const drainAgents = async (system: AgentsWorkspaceRuntime): Promise<void> => {
    const timeout = new Promise<void>(res => setTimeout(res, drainMs))
    const aiAgents = system.team.listAgents()
      .flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
    await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
    // Cancel anything still generating after the timeout.
    let cancelled = 0
    for (const a of aiAgents) {
      if (a.state.get() === 'generating') {
        a.cancelGeneration()
        cancelled++
      }
    }
    if (cancelled > 0) {
      const finalTimeout = new Promise<void>(res => setTimeout(res, 100))
      await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), finalTimeout])))
    }
  }

  // Build the per-Workspace autosaver. Callback wiring (which schedules
  // save on each mutation) lives in src/api/wire-workspace-runtime-events.ts, which
  // gets the saver via autoSaverFor(id). The onWorkspaceRuntimeCreated hook calls
  // wireWorkspaceRuntimeEvents — that's the single source of save scheduling.
  // Build a fresh AgentsWorkspaceRuntime for `id`, restoring from snapshot if present.
  // Durable execution storage opens only with a live Workspace runtime,
  // never from static requests or definition catalog browsing.
  //
  // The Host addresses a provisioned Workspace explicitly. Static requests
  // and definition catalog reads do not instantiate its Agents runtime.
  const buildWorkspaceRuntime = async (id: WorkspaceId): Promise<{ system: AgentsWorkspaceRuntime; autoSaver: ModuleAutoSaver }> => {
    const paths = workspaceModulePaths(id)
    if (!await opts.moduleState.has(id)) throw new Error(`Agents Workspace not provisioned: ${id}`)
    const system = createAgentsWorkspaceRuntime({
      deployment: opts.deployment,
      workspaceLabel: id,
      runWorkspaceOperation: work => withWorkspace(id, async () => {
        if (map.get(id)?.system !== system || map.get(id)?.state !== 'active') throw Object.assign(new Error('Agents Workspace runtime is no longer active'), { code: 'workspace_closing' })
        return await work()
      }),
      ...(opts.workspaceHostUrl === undefined ? {} : { workspaceId: id, workspaceHostUrl: opts.workspaceHostUrl }),
      vectorsFile: paths.agents.vectors,
      executionsFile: paths.agents.executions,
    })

    let autoSaver: ModuleAutoSaver | undefined
    try {
      // Rooms and Agent runtime data remain separate strict documents inside
      // the Agents Module. Corrupt or obsolete state fails the load.
      const snapshots = await loadWorkspaceModuleSnapshots(paths)
      await restoreWorkspaceModuleSnapshots(system, snapshots)

      autoSaver = createModuleAutoSaver(system, paths)

      // Notify the registry's caller (e.g. WS broadcast wiring). autoSaver
      // is passed explicitly because the map entry isn't installed until
      // buildWorkspaceRuntime returns; an autoSaverFor(id) lookup inside the hook
      // would return null.
      //
      // AWAITED on purpose: the hook installs wireAgentTracking (the spawn
      // wrapper that installs per-agent state subscriptions, provider-event
      // attach, etc.) and wireWorkspaceRuntimeEvents (the system-wide WS broadcast
      // subscribers). The hook is async because of logging.configure and must
      // complete before any seeded identity is created.
      await opts.onWorkspaceRuntimeCreated?.(system, id, autoSaver)

      // First-run seeding creates only the human identity. Rooms and AI Agents
      // are explicit Resources and never implicit Workspace defaults.
      const shouldSeed = snapshots.rooms === null
        && snapshots.agents === null
        && process.env.LEITBILD_SEED_WORKSPACE !== '0'
      if (shouldSeed) {
        await seedWorkspaceIdentity(system)
        await autoSaver.flush()
      }

      return { system, autoSaver }
    } catch (error) {
      await disposeUninstalled(system, id, autoSaver)
      throw error
    }
  }

  // Construction and capacity admission share the same resource ownership rule.
  // An uninstalled runtime must not retain producers, callback wiring or log timers.
  const disposeUninstalled = async (system: AgentsWorkspaceRuntime, id: WorkspaceId, autoSaver?: ModuleAutoSaver): Promise<void> => {
    try {
      system.triggerScheduler.stop()
      system.summaryScheduler.dispose()
      // Absent in a runtime without a Workspace Host.
      system.proposalResumes?.dispose()
      await Promise.all(system.scriptRunner.listRuns().map(run => system.scriptRunner.stop(run.roomId)))
      await drainAgents(system)
      await autoSaver?.dispose()
      await system.logging.configure({ enabled: false })
      system.captureRegistry.clearAll()
      opts.onWorkspaceRuntimeEvicted?.(system, id)
      for (const [agentId, workspaceId] of agentWorkspaceMap) if (workspaceId === id) agentWorkspaceMap.delete(agentId)
    } finally {
      await system.comparisons.close()
      system.executionStore.close()
    }
  }

  const ownsAutonomousWork = (system: AgentsWorkspaceRuntime): boolean =>
    system.scriptRunner.listRuns().some(run => !run.ended)
    || system.team.listAgents().some(agent => agent.state.get() === 'generating' || agent.getTriggers?.().some(trigger => trigger.enabled))
    || system.rooms.listAllRooms().some(profile => {
      const room = system.rooms.getRoom(profile.id)
      if (!room) throw new Error(`Listed Room is missing: ${profile.id}`)
      return system.summaryScheduler.isRunning(profile.id, 'summary')
        || system.summaryScheduler.isRunning(profile.id, 'compression')
        || [room.summaryConfig.summary, room.summaryConfig.compression].some(config => config.enabled && config.schedule.kind === 'time')
    })

  // --- Public API ---

  let firstLoadFired = false
  const fireFirstLoadOnce = (system: AgentsWorkspaceRuntime, id: WorkspaceId): void => {
    if (firstLoadFired) return
    firstLoadFired = true
    try { opts.onFirstLoad?.(system, id) } catch (err) {
      // Re-throw — the onFirstLoad contract check is meant to crash boot
      // when wiring is broken. Suppressing it would resurrect the silent-
      // skip class of bug the contract guards.
      firstLoadFired = false
      throw err
    }
  }

  const evictForCapacity = async (): Promise<number> => {
    const excess = map.size - maxLoadedWorkspaces + 1
    if (excess <= 0) return 0
    const targets = [...map.entries()]
      .filter(([id, entry]) => entry.state === 'active' && !workspaceOperations.get(id)?.activeCount() && !ownsAutonomousWork(entry.system))
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)
      .slice(0, excess)
      .map(([id]) => id)
    if (targets.length < excess) throw Object.assign(new Error('Agents runtime capacity is occupied by active work'), { code: 'workspace_capacity_exceeded' })
    await Promise.all(targets.map(evictOne))
    return targets.length
  }

  // Cold loads build independently, then serialize only the capacity check
  // and map insertion. Without this short queue, two completed loads can both
  // observe one free slot and push the registry past its configured bound.
  let capacityMutation = Promise.resolve()
  const installLoadedEntry = async (id: WorkspaceId, entry: WorkspaceRuntimeEntry): Promise<number> => {
    let evicted = 0
    const operation = capacityMutation.then(async () => {
      evicted = await evictForCapacity()
      map.set(id, entry)
    })
    capacityMutation = operation.then(() => undefined, () => undefined)
    await operation
    return evicted
  }

  const getOrLoad = async (id: WorkspaceId): Promise<AgentsWorkspaceRuntime> => {
    if (shuttingDown || removing.has(id)) throw new Error('Agents Workspace is closing')
    if (!isValidWorkspaceId(id)) {
      throw new Error(`[registry] invalid Workspace id: ${id}`)
    }

    // Fast path: in-map and not evicting.
    const existing = map.get(id)
    if (existing?.state === 'save-failed') {
      await evictOne(id)
      return getOrLoad(id)
    }
    if (existing && existing.state === 'active') {
      existing.lastTouchedAt = Date.now()
      fireFirstLoadOnce(existing.system, id)
      return existing.system
    }

    // Mid-eviction: wait for it to complete, then re-enter for a fresh load.
    if (existing && existing.state === 'evicting' && existing.evictionPromise) {
      await existing.evictionPromise
      return getOrLoad(id)
    }

    // Pending first-load by another caller: await same promise.
    const pending = pendingLoads.get(id)
    if (pending) return pending

    // Cold path: register the pending promise, do the work, transfer to map.
    const loadPromise = (async (): Promise<AgentsWorkspaceRuntime> => {
      try {
        const { system, autoSaver } = await buildWorkspaceRuntime(id)
        const entry: WorkspaceRuntimeEntry = {
          system,
          autoSaver,
          lastTouchedAt: Date.now(),
          state: 'active',
        }
        let evicted: number
        try {
          evicted = await installLoadedEntry(id, entry)
          fireFirstLoadOnce(system, id)
        } catch (error) {
          map.delete(id)
          await disposeUninstalled(system, id, autoSaver)
          throw error
        }
        if (evicted > 0) {
          console.warn(`[registry] capacity ${maxLoadedWorkspaces} reached; evicted ${evicted} least-recently-used Workspace(s)`)
        }
        return system
      } finally {
        pendingLoads.delete(id)
      }
    })()
    pendingLoads.set(id, loadPromise)
    return loadPromise
  }

  // Idempotent: calling evictOne twice (or while another caller is also
  // evicting) returns the same in-flight promise.
  const evictOne = async (id: WorkspaceId): Promise<void> => {
    const loading = pendingLoads.get(id)
    if (loading) await loading
    const entry = map.get(id)
    if (!entry) return
    if (workspaceOperations.get(id)?.activeCount()) throw Object.assign(new Error('Agents Workspace has active requests'), { code: 'workspace_busy' })
    if (entry.state === 'evicting' && entry.evictionPromise) {
      return entry.evictionPromise
    }

    const evictionPromise = (async (): Promise<void> => {
      try {
        // Quiesce producers before draining consumers and publishing the final generation.
        entry.system.triggerScheduler.stop()
        entry.system.summaryScheduler.dispose()
        // Absent in a runtime without a Workspace Host.
        entry.system.proposalResumes?.dispose()
        await Promise.all(entry.system.scriptRunner.listRuns().map(run => entry.system.scriptRunner.stop(run.roomId)))
        await drainAgents(entry.system)
        await entry.autoSaver.flush()
        await entry.system.logging.configure({ enabled: false })
        opts.onWorkspaceRuntimeEvicted?.(entry.system, id)
        entry.system.captureRegistry.clearAll()
        await entry.autoSaver.dispose()
        await entry.system.comparisons.close()
        entry.system.executionStore.close()
        map.delete(id)
        for (const [agentId, workspaceId] of agentWorkspaceMap) if (workspaceId === id) agentWorkspaceMap.delete(agentId)
      } catch (error) {
        // Preserve the quiesced runtime for an explicit retry after a close/save failure.
        entry.state = 'save-failed'
        entry.evictionPromise = undefined
        throw error
      }
    })()

    entry.state = 'evicting'
    entry.evictionPromise = evictionPromise
    return evictionPromise
  }

  const evictIdle = async (now: number = Date.now()): Promise<number> => {
    const targets: WorkspaceId[] = []
    for (const [id, entry] of map) {
      if (entry.state === 'active' && !workspaceOperations.get(id)?.activeCount() && !ownsAutonomousWork(entry.system) && now - entry.lastTouchedAt > idleMs) {
        targets.push(id)
      }
    }
    await Promise.all(targets.map(evictOne))
    for (const [id, directory] of peopleDirectories) {
      if (directory.canEvict(now, idleMs)) {
        peopleDirectories.delete(id)
        directory.close()
        peopleMetrics.inc('directoriesEvicted')
      }
    }
    return targets.length
  }

  const exists = async (id: WorkspaceId): Promise<boolean> => {
    if (!isValidWorkspaceId(id)) return false
    if (map.has(id)) return true
    return await opts.moduleState.has(id)
  }

  const list = (): ReadonlyArray<WorkspaceRuntimeMeta> =>
    [...map.entries()].map(([id, e]) => ({
      id,
      lastTouchedAt: e.lastTouchedAt,
      state: e.state,
    }))

  const listOnDisk = async (): Promise<ReadonlyArray<WorkspaceModuleOnDisk>> => {
    const root = sharedPaths.workspacesRoot()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] // First boot.
      throw error
    }
    const out: WorkspaceModuleOnDisk[] = []
    for (const name of entries) {
      // Skip anything that is not a canonical Workspace id.
      if (!isValidWorkspaceId(name)) continue
      let mtimeMs = 0
      let sizeBytes = 0
      const paths = workspaceModulePaths(name)
      for (const path of [paths.rooms.snapshot, paths.agents.snapshot]) {
        try {
          const current = await stat(path)
          mtimeMs = Math.max(mtimeMs, current.mtimeMs)
          sizeBytes += current.size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      out.push({ id: name, snapshotMtimeMs: mtimeMs, snapshotSizeBytes: sizeBytes })
    }
    return out
  }

  // Final flush of every active Workspace. Called from the SIGINT/SIGTERM
  // handler in bootstrap.ts (replaces the single-system flush).
  const shutdown = async (): Promise<void> => {
    shuttingDown = true
    // People first: waiting syncs answer at once instead of holding shutdown.
    await Promise.all([...new Set([...pendingPeople.keys(), ...peopleDirectories.keys()])].map(closePeople))
    // Comparisons own admitted work too. Cancel before waiting for operation
    // leases, otherwise shutdown waits for whole model tasks to finish.
    await Promise.all([...map.values()].map(entry => entry.system.comparisons.close()))
    await Promise.all([...workspaceOperations.values()].map(scope => scope.close()))
    await Promise.all([...definitionLibraries.values()].map(library => library.close()))
    await Promise.allSettled([...pendingLoads.values()])
    const ids = [...map.keys()]
    await Promise.all(ids.map(evictOne))
  }

  const autoSaverFor = (id: WorkspaceId): ModuleAutoSaver | null => {
    const entry = map.get(id)
    return entry ? entry.autoSaver : null
  }

  const attachAgent = (agentId: string, workspaceId: WorkspaceId): void => {
    agentWorkspaceMap.set(agentId, workspaceId)
  }
  const detachAgent = (agentId: string): void => {
    agentWorkspaceMap.delete(agentId)
  }
  const workspaceForAgent = (agentId: string): WorkspaceId | undefined =>
    agentWorkspaceMap.get(agentId)

  const tryGetLive = (id: WorkspaceId): AgentsWorkspaceRuntime | undefined => {
    const entry = map.get(id)
    if (!entry || entry.state !== 'active') return undefined
    return entry.system
  }

  return {
    withWorkspace,
    getOrLoad,
    definitionsFor,
    peopleFor,
    peopleMetrics,
    peopleStatus,
    evictOne,
    remove: id => {
      const existing = removing.get(id)
      if (existing) return existing
      const removingWorkspace = (async () => {
        await closePeople(id)
        await workspaceOperations.get(id)?.close()
        await definitionLibraries.get(id)?.close()
        await evictOne(id)
        await opts.moduleState.remove(id)
        definitionLibraries.delete(id)
        workspaceOperations.delete(id)
      })().finally(() => removing.delete(id))
      removing.set(id, removingWorkspace)
      return removingWorkspace
    },
    evictIdle,
    exists,
    list,
    listOnDisk,
    shutdown,
    idleMs: () => idleMs,
    maxLoadedWorkspaces: () => maxLoadedWorkspaces,
    autoSaverFor,
    tryGetLive,
    attachAgent,
    detachAgent,
    workspaceForAgent,
  }
}
