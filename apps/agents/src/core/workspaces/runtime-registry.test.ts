import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from './runtime-registry.ts'
import { createDeploymentRuntime } from '../deployment-runtime.ts'
import { workspaceModulePaths } from '../paths.ts'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createAgentsModuleState, type AgentsModuleState } from './module-state.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../api/__fixtures__/stub-gateway.ts'
import { asAIAgent } from '../../agents/shared.ts'

// Phase D registry tests use the LEITBILD_HOME env var to redirect all paths
// into a per-test tmpdir. The shared runtime is built with no providers
// (single-Ollama mode, but Ollama URL never hit) so tests are network-free.

describe('WorkspaceRuntimeRegistry', () => {
  let originalHome: string | undefined
  let homeDir: string
  let registry: WorkspaceRuntimeRegistry
  let moduleState: AgentsModuleState

  const provision = async (id: WorkspaceId): Promise<void> => {
    await moduleState.provision(id)
  }

  beforeEach(async () => {
    originalHome = process.env.LEITBILD_HOME
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-registry-'))
    process.env.LEITBILD_HOME = homeDir
    // PROVIDER=ollama keeps shared runtime quiet — no cloud gateways built.
    process.env.PROVIDER = 'ollama'
    // Disable first-run seeding — these tests assert empty-RoomDirectory semantics.
    process.env.LEITBILD_SEED_WORKSPACE = '0'
    const shared = createDeploymentRuntime()
    moduleState = createAgentsModuleState()
    registry = createWorkspaceRuntimeRegistry({ deployment: shared, moduleState, idleMs: 1_000_000 })  // long idle so no auto-evict in unit tests
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = originalHome
    delete process.env.PROVIDER
    delete process.env.LEITBILD_SEED_WORKSPACE
    await rm(homeDir, { recursive: true, force: true })
  })

  // --- People directories ---

  it('evicts idle People directories even when a runtime eviction in the same sweep fails', async () => {
    const loaded = newWorkspaceId()
    const people = newWorkspaceId()
    await provision(loaded)
    await provision(people)
    await registry.peopleFor(people)
    await registry.getOrLoad(loaded)
    const flush = spyOn(registry.autoSaverFor(loaded)!, 'flush').mockImplementation(async () => { throw new Error('snapshot flush failed') })
    try {
      await expect(registry.evictIdle(Date.now() + 2_000_000)).rejects.toThrow('snapshot flush failed')
    } finally { flush.mockRestore() }
    expect(registry.peopleStatus()).toMatchObject({ openDirectories: 0, directoriesEvicted: 1 })
    expect(registry.tryGetLive(people)).toBeUndefined()
  })

  // --- Validity ---

  it('new Room admission fails before mutation and old runtimes cannot create after eviction', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const runtime = await registry.getOrLoad(id)
    const previous = process.env.LEITBILD_STORAGE_MAX_BYTES
    process.env.LEITBILD_STORAGE_MAX_BYTES = '1'
    try {
      await expect(runtime.createRoom({ name: 'Too large', createdBy: 'system' })).rejects.toThrow('budget reached')
      expect(runtime.rooms.listAllRooms()).toHaveLength(0)
      await registry.evictOne(id)
      await expect(runtime.createRoom({ name: 'Stale', createdBy: 'system' })).rejects.toThrow('no longer active')
    } finally {
      if (previous === undefined) delete process.env.LEITBILD_STORAGE_MAX_BYTES
      else process.env.LEITBILD_STORAGE_MAX_BYTES = previous
    }
  })

  it('drains accepted definition work before removal and closes stale library references', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const library = registry.definitionsFor(id)
    const records = await library.list()
    const source = (await library.currentRevision(records[0]!.id))!.document
    let resume!: () => void, entered!: () => void
    const gate = new Promise<void>(r => { resume = r })
    const started = new Promise<void>(r => { entered = r })
    const saving = registry.withWorkspace(id, async () => {
      entered(); await gate
      return library.create({ ...source, id: 'pending-definition', title: 'Pending' })
    })
    await started
    let removed = false
    const deleting = registry.remove(id).then(() => { removed = true })
    await Bun.sleep(10)
    expect(removed).toBe(false)
    resume()
    await saving; await deleting
    expect(await moduleState.has(id)).toBe(false)
    await expect(library.create({ ...source, id: 'late-definition' })).rejects.toThrow('closing')
    await expect(stat(workspaceModulePaths(id).agents.root)).rejects.toThrow()
  })

  it('does not evict a Workspace with an ordinary request in progress', async () => {
    const id = newWorkspaceId()
    await provision(id)
    await registry.getOrLoad(id)
    await registry.withWorkspace(id, async () => {
      expect(await registry.evictIdle(Date.now() + 2_000_000)).toBe(0)
      expect(registry.tryGetLive(id)).toBeDefined()
    })
    expect(await registry.evictIdle(Date.now() + 2_000_000)).toBe(1)
  })

  it('disposes startup resources when the construction hook fails', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const disposed: WorkspaceId[] = []
    let opened: Awaited<ReturnType<typeof registry.getOrLoad>> | undefined
    const failed = createWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState,
      onWorkspaceRuntimeCreated: system => { opened = system; throw new Error('startup hook failed') },
      onWorkspaceRuntimeEvicted: (_system, workspaceId) => { disposed.push(workspaceId) },
    })
    await expect(failed.getOrLoad(id)).rejects.toThrow('startup hook failed')
    expect(disposed).toEqual([id])
    expect(failed.list()).toEqual([])
    expect(() => opened!.executionStore.listTurns('room')).toThrow()
    await failed.shutdown()
  })

  it('owns one durable execution store per loaded Workspace and closes it on eviction', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const runtime = await registry.getOrLoad(id)
    const room = runtime.rooms.createRoom({ name: 'Evidence', createdBy: 'test' })
    const message = room.post({ senderId: 'test', type: 'chat', content: 'Retain exact work' })
    const store = runtime.executionStore
    store.beginTurn({ id: 'done', roomId: room.profile.id, agentId: 'test', startedAt: 1 })
    store.recordAttempt('done', { id: 'call', tool: 'read', arguments: { ref: 'asset' }, startedAt: 2 })
    store.recordOutcome('done', 'call', { success: true, data: { value: 42 } })
    store.finishTurn('done', 'completed')
    store.linkMessage('done', message.id)
    store.beginTurn({ id: 'unknown', roomId: room.profile.id, agentId: 'test', startedAt: 3 })
    store.recordAttempt('unknown', { id: 'call', tool: 'act', arguments: {}, startedAt: 4 })
    await registry.evictOne(id)
    expect(() => store.listTurns(room.profile.id)).toThrow()
    const reloaded = await registry.getOrLoad(id)
    expect(reloaded.executionStore).not.toBe(store)
    expect(reloaded.executionStore.getCall(room.profile.id, 'done', 'call')?.result).toEqual({ success: true, data: { value: 42 } })
    expect(reloaded.executionStore.getTurn(room.profile.id, 'unknown')?.status).toBe('interrupted')
    const restoredRoom = reloaded.rooms.getRoom(room.profile.id)!
    expect(restoredRoom.deleteMessage(message.id)).toBe(true)
    expect(reloaded.executionStore.getTurn(room.profile.id, 'done')).toBeUndefined()
    expect(reloaded.executionStore.getTurn(room.profile.id, 'unknown')).toBeDefined()
    restoredRoom.clearMessages()
    expect(reloaded.executionStore.listTurns(room.profile.id)).toEqual([])
    reloaded.executionStore.beginTurn({ id: 'removed-room', roomId: room.profile.id, agentId: 'test', startedAt: 5 })
    reloaded.removeRoom(room.profile.id)
    expect(reloaded.executionStore.listTurns(room.profile.id)).toEqual([])
    await registry.evictOne(id)
    const final = await registry.getOrLoad(id)
    expect(final.rooms.getRoom(room.profile.id)).toBeUndefined()
    expect(final.executionStore.listTurns(room.profile.id)).toEqual([])
  })

  it.each(['reload', 'delete'] as const)('cancelled Agent retains a real tool lifetime through %s', async ending => {
    const id = newWorkspaceId()
    await provision(id)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const provider = { ...makeStubGateway(), stream: async function* () {
      yield { delta: '', done: true, toolCalls: [{ id: 'Ab123Cd45', function: { name: 'hold_for_test', arguments: {} } }], tokensUsed: { prompt: 1, completion: 1 } }
    } }
    const actual = createWorkspaceRuntimeRegistry({ moduleState, idleMs: 1,
      deployment: createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(provider) }),
    })
    try {
      const system = await actual.getOrLoad(id)
      system.toolRegistry.register({ name: 'hold_for_test', description: 'Lifecycle test', parameters: {}, execute: async () => {
        entered(); await released; return { success: true, data: { completedAfterCancellation: true } }
      } })
      const room = system.rooms.createRoom({ name: 'Execution lifetime', createdBy: 'test' })
      const agent = asAIAgent(await system.spawnAIAgent({ name: 'Agent', model: 'mock-model', persona: '', tools: ['hold_for_test'] }))!
      room.addMember(agent.id)
      await agent.join(room)
      // The hot-refresh path must preserve runtime ownership as well as initial spawn.
      await system.refreshAllAgentTools()
      agent.receive(room.post({ senderId: 'human', type: 'chat', content: 'perform operation' }))
      await started
      agent.cancelGeneration()
      await agent.whenIdle()
      await expect(actual.evictOne(id)).rejects.toThrow('active requests')
      expect(await actual.evictIdle(Date.now() + 1_000_000)).toBe(0)
      const turn = system.executionStore.listTurns(room.profile.id)[0]!
      expect(turn.status).toBe('interrupted')
      expect(system.executionStore.getCall(room.profile.id, turn.id, 'call_0_0')?.result).toBeUndefined()
      if (ending === 'delete') {
        let deleted = false
        const removing = actual.remove(id).then(() => { deleted = true })
        await Bun.sleep(5)
        expect(deleted).toBe(false)
        release()
        await removing
        expect(await moduleState.has(id)).toBe(false)
        await expect(stat(workspaceModulePaths(id).agents.root)).rejects.toThrow()
        return
      }
      release()
      // A request scope closes only after actual execution AND its outcome commit.
      await actual.shutdown()
      const reload = createWorkspaceRuntimeRegistry({ moduleState, deployment: createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(provider) }) })
      try {
        const reopened = await reload.getOrLoad(id)
        expect(reopened.executionStore.getCall(room.profile.id, turn.id, 'call_0_0')?.result).toEqual({ success: true, data: { completedAfterCancellation: true } })
        expect(reopened.executionStore.getTurn(room.profile.id, turn.id)?.status).toBe('interrupted')
      } finally { await reload.shutdown() }
    } finally { release(); await actual.shutdown() }
  })

  it('removing a Workspace cancels a running model comparison instead of waiting for the model', async () => {
    const id = newWorkspaceId()
    await provision(id)
    let streams = 0
    let comparisonEntered!: () => void
    const comparisonStarted = new Promise<void>(resolve => { comparisonEntered = resolve })
    let comparisonCancelled = false
    // Test-only model: the Agent's own turn answers; the comparison's model call
    // answers only by failing when its signal aborts, as a slow real model would.
    const provider = { ...makeStubGateway(),
      modelInfo: async (model: string) => ({ id: model, provider: 'stub', contextMax: 100_000, source: 'fixture' }),
      stream: async function* (_request: unknown, signal?: AbortSignal) {
        if (++streams === 1) {
          yield { delta: 'Original answer.', done: true, tokensUsed: { prompt: 1, completion: 1 } }
          return
        }
        comparisonEntered()
        await new Promise<never>((_, reject) => {
          if (!signal) return reject(new Error('Comparison model call carries no abort signal'))
          signal.addEventListener('abort', () => { comparisonCancelled = true; reject(signal.reason) }, { once: true })
        })
      } }
    const actual = createWorkspaceRuntimeRegistry({ moduleState, idleMs: 1_000_000,
      deployment: createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(provider) }),
    })
    try {
      const system = await actual.getOrLoad(id)
      const room = system.rooms.createRoom({ name: 'Comparison lifetime', createdBy: 'test' })
      const agent = asAIAgent(await system.spawnAIAgent({ name: 'Agent', model: 'mock-model', persona: '', tools: [] }))!
      room.addMember(agent.id)
      await agent.join(room)
      agent.receive(room.post({ senderId: 'human', type: 'chat', content: 'Assess the plant.' }))
      const until = performance.now() + 10_000
      while (!room.getRetainedMessages().some(message => message.senderId === agent.id) && performance.now() < until) await Bun.sleep(5)
      await agent.whenIdle()
      const original = room.getRetainedMessages().find(message => message.senderId === agent.id)!
      const started = await system.comparisons.start(room.profile.id, original.id, 'stub:mock-model')
      expect(started.status).toBe('running')
      await comparisonStarted
      let deadline: Timer | undefined
      const outcome = await Promise.race([
        actual.remove(id).then(() => 'removed' as const),
        new Promise<'still waiting'>(resolve => { deadline = setTimeout(() => resolve('still waiting'), 10_000) }),
      ])
      clearTimeout(deadline)
      expect(outcome).toBe('removed')
      // The job was cancelled, and removal waited for it to end.
      expect(comparisonCancelled).toBe(true)
      expect(await moduleState.has(id)).toBe(false)
      await expect(stat(workspaceModulePaths(id).agents.root)).rejects.toThrow()
    } finally { await actual.shutdown() }
  }, 30_000)

  it('does not evict autonomous summary work for idle or capacity', async () => {
    const busy = createWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState, maxLoadedWorkspaces: 1, idleMs: 1 })
    const a = newWorkspaceId(), b = newWorkspaceId()
    await provision(a); await provision(b)
    try {
      const system = await busy.getOrLoad(a)
      system.rooms.createRoomSafe({ name: 'scheduled', createdBy: 'system' })
      const room = system.rooms.getRoom(system.rooms.listAllRooms()[0]!.id)!
      room.setSummaryConfig({ ...room.summaryConfig, summary: { ...room.summaryConfig.summary, enabled: true, schedule: { kind: 'time', everySeconds: 3600 } } })
      expect(await busy.evictIdle(Date.now() + 10_000)).toBe(0)
      await expect(busy.getOrLoad(b)).rejects.toThrow('occupied by active work')
      expect(busy.tryGetLive(a)).toBe(system)
      expect(busy.tryGetLive(b)).toBeUndefined()
    } finally { await busy.shutdown() }
  })

  it('rejects invalid Workspace ids at runtime', async () => {
    await expect(registry.getOrLoad('bad' as WorkspaceId)).rejects.toThrow(/invalid Workspace id/)
    await expect(registry.getOrLoad('../etc/passwd' as WorkspaceId)).rejects.toThrow(/invalid Workspace id/)
  })

  // --- Round-trip + caching ---

  it('round-trip: same id returns same system', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const a = await registry.getOrLoad(id)
    const b = await registry.getOrLoad(id)
    expect(a).toBe(b)
  })

  it('seeds only the human identity in a newly provisioned Agents Workspace', async () => {
    const id = newWorkspaceId()
    await provision(id)
    delete process.env.LEITBILD_SEED_WORKSPACE
    const seeded = await registry.getOrLoad(id)
    expect(seeded.rooms.listAllRooms()).toEqual([])
    expect(seeded.team.listAgents().map(actor => [actor.name, actor.kind])).toEqual([['You', 'human']])
  })

  it('different ids return different systems', async () => {
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    const a = await registry.getOrLoad(idA)
    const b = await registry.getOrLoad(idB)
    expect(a).not.toBe(b)
  })

  // --- Concurrency ---

  it('concurrent getOrLoad on same id resolves to one system (pendingLoads dedupe)', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const [a, b, c] = await Promise.all([
      registry.getOrLoad(id),
      registry.getOrLoad(id),
      registry.getOrLoad(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  // --- Eviction round-trip ---

  it('evicts then lazy-reloads with state preserved', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys1 = await registry.getOrLoad(id)
    sys1.rooms.createRoomSafe({ name: 'evict-test-room', createdBy: 'system' })
    expect(sys1.rooms.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)

    // Snapshot file shouldn't exist yet (autosaver debounced 5 s).
    // Eviction's flush forces a save.
    await registry.evictOne(id)
    expect(registry.list().some(m => m.id === id)).toBe(false)

    // Snapshot file should exist on disk now.
    const stats = await stat(workspaceModulePaths(id).rooms.snapshot)
    expect(stats.size).toBeGreaterThan(0)

    // Lazy reload — fresh system, but room restored from disk.
    const sys2 = await registry.getOrLoad(id)
    expect(sys2).not.toBe(sys1)
    expect(sys2.rooms.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)
  })

  // --- Evict-while-active race ---

  it('request mid-eviction awaits the eviction then loads fresh from disk', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys1 = await registry.getOrLoad(id)
    sys1.rooms.createRoomSafe({ name: 'race-room', createdBy: 'system' })

    // Kick off evict but don't await yet.
    const evicting = registry.evictOne(id)

    // Concurrent request — must await the eviction, then return a fresh
    // Workspace loaded from the just-flushed snapshot.
    const [, sys2] = await Promise.all([evicting, registry.getOrLoad(id)])

    expect(sys2).not.toBe(sys1)
    expect(sys2.rooms.listAllRooms().some(r => r.name ==='race-room')).toBe(true)
  })

  // --- Idempotent eviction ---

  it('evictOne is idempotent for unknown id', async () => {
    await registry.evictOne(newWorkspaceId())   // never created
    // No throw, no side effects.
    expect(registry.list().length).toBe(0)
  })

  it('two concurrent evictOne calls share a single eviction', async () => {
    const id = newWorkspaceId()
    await provision(id)
    await registry.getOrLoad(id)
    const [a, b] = await Promise.all([registry.evictOne(id), registry.evictOne(id)])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(registry.list().some(m => m.id === id)).toBe(false)
  })

  // --- Idle eviction ---

  it('evictIdle drops Workspaces older than idleMs', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      idleMs: 50,
    })
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    await reg.getOrLoad(idA)
    await new Promise(r => setTimeout(r, 80))
    await reg.getOrLoad(idB)        // freshly touched

    // Judge idleness as of B's touch: A has been idle for at least the 80 ms
    // slept, B for none, however long a loaded machine takes to load B.
    const touchedB = reg.list().find(m => m.id === idB)!.lastTouchedAt
    const evictedCount = await reg.evictIdle(touchedB)
    expect(evictedCount).toBe(1)
    expect(reg.list().some(m => m.id === idA)).toBe(false)
    expect(reg.list().some(m => m.id === idB)).toBe(true)
    await reg.shutdown()
  })

  it('enforces the loaded-Workspace capacity by evicting least-recently-used state', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      idleMs: 1_000_000,
      maxLoadedWorkspaces: 2,
    })
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    const idC = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    await provision(idC)
    const a = await reg.getOrLoad(idA)
    a.rooms.createRoomSafe({ name: 'capacity-state', createdBy: 'system' })
    await new Promise(resolve => setTimeout(resolve, 2))
    await reg.getOrLoad(idB)
    await new Promise(resolve => setTimeout(resolve, 2))
    await reg.getOrLoad(idC)

    expect(reg.list().map(meta => meta.id).sort()).toEqual([idB, idC].sort())
    expect(reg.maxLoadedWorkspaces()).toBe(2)

    const restored = await reg.getOrLoad(idA)
    expect(restored.rooms.listAllRooms().some(room => room.name === 'capacity-state')).toBe(true)
    expect(reg.list().length).toBe(2)
    await reg.shutdown()
  })

  it('keeps the capacity bound when cold loads complete concurrently', async () => {
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      maxLoadedWorkspaces: 1,
    })
    const ids = [newWorkspaceId(), newWorkspaceId(), newWorkspaceId()]
    await Promise.all(ids.map(provision))

    await Promise.all(ids.map(id => reg.getOrLoad(id)))

    expect(reg.list()).toHaveLength(1)
    await reg.shutdown()
  })

  // --- exists ---

  it('exists is true after disk persistence', async () => {
    const id = newWorkspaceId()
    await provision(id)
    const sys = await registry.getOrLoad(id)
    sys.rooms.createRoomSafe({ name: 'exists-test', createdBy: 'system' })
    await registry.evictOne(id)
    expect(await registry.exists(id)).toBe(true)
  })

  it('exists is false for never-created id', async () => {
    expect(await registry.exists(newWorkspaceId())).toBe(false)
  })

  it('rejects loading an unprovisioned Workspace', async () => {
    await expect(registry.getOrLoad(newWorkspaceId())).rejects.toThrow('Agents Workspace not provisioned')
  })

  // --- list / meta ---

  it('list reflects current in-memory state', async () => {
    const id = newWorkspaceId()
    await provision(id)
    expect(registry.list()).toEqual([])
    await registry.getOrLoad(id)
    const meta = registry.list()
    expect(meta.length).toBe(1)
    expect(meta[0]?.id).toBe(id)
    expect(meta[0]?.state).toBe('active')
  })

  // --- Shutdown ---

  it('shutdown flushes every active Workspace', async () => {
    const idA = newWorkspaceId()
    const idB = newWorkspaceId()
    await provision(idA)
    await provision(idB)
    const sa = await registry.getOrLoad(idA)
    const sb = await registry.getOrLoad(idB)
    sa.rooms.createRoomSafe({ name: 'shut-a', createdBy: 'system' })
    sb.rooms.createRoomSafe({ name: 'shut-b', createdBy: 'system' })

    await registry.shutdown()
    expect(registry.list()).toEqual([])
    await stat(workspaceModulePaths(idA).rooms.snapshot)
    await stat(workspaceModulePaths(idB).rooms.snapshot)
  })

  // --- Hooks ---

  it('onWorkspaceRuntimeCreated fires once per fresh load', async () => {
    const calls: string[] = []
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      onWorkspaceRuntimeCreated: (_sys, id) => { calls.push(id) },
    })
    const id = newWorkspaceId()
    await provision(id)
    await reg.getOrLoad(id)
    await reg.getOrLoad(id)        // same Workspace — no second hook
    expect(calls).toEqual([id])
    await reg.evictOne(id)
    await reg.getOrLoad(id)        // post-evict reload — second hook
    expect(calls).toEqual([id, id])
    await reg.shutdown()
  })

  it('onWorkspaceRuntimeEvicted fires before the system is dropped', async () => {
    const calls: string[] = []
    const reg = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime(),
      moduleState,
      onWorkspaceRuntimeEvicted: (_sys, id) => calls.push(id),
    })
    const id = newWorkspaceId()
    await provision(id)
    await reg.getOrLoad(id)
    await reg.evictOne(id)
    expect(calls).toEqual([id])
    await reg.shutdown()
  })
})
