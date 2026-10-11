// ============================================================================
// Integration test: per-agent state subscription is wired for every explicit
// agent creation path and restored snapshots.
//
// REGRESSION CONTEXT
// The bug surfaced after the wiki feature shipped. With wikis bound to a
// room, gemini-2.5-pro tool-loops 5–15 s per turn, exposing dead-air the
// UI used to hide. During that dead-air the user expected the thinking
// indicator. There was none. Why:
//
//   - subscribeAgentState turns agent.state.notifyState() into an
//     `agent_state` WS broadcast. Without it, the UI's $agents store never
//     transitions to 'generating', no thinking indicator is created, and
//     `agent_activity` chunk events arrive at a connected client with
//     nowhere to render.
//
//   - subscribeAgentState was called in 3 places: REST agent-create,
//     WS agent-create, and a one-shot init-loop in wireWorkspaceRuntimeEvents that
//     iterated `system.team.listAgents()` at wire time. The init-loop
//     covered SNAPSHOT-RESTORED agents (which exist before wireWorkspaceRuntimeEvents
//     runs). It did NOT cover agents spawned AFTER wire — including
//     the fresh-Workspace Helper, script-engine cast members, and any
//     programmatic spawn. They silently bypassed subscription.
//
// FIX (bootstrap.ts wireAgentTracking + wire-workspace-runtime-events.ts init-loop)
//   - Per-agent subscription is centralized in the wireAgentTracking spawn
//     wrapper. Every system.spawnAIAgent / spawnHumanAgent / removeAgent
//     call goes through it. Subscribe is idempotent so the wrapper coexists
//     with the snapshot-init-loop in wireWorkspaceRuntimeEvents.
//   - REST + WS handlers no longer call subscribeAgentState themselves.
//
// WHAT THIS TEST PROVES
//   1. A programmatic spawn ends with subscribeAgentState called for the Agent.
//   2. Triggering the agent's eval (via agent.receive with a stub LLM)
//      causes an `agent_state` broadcast scoped to the cookie's
//      workspaceId — the exact chain the UI relies on.
// ============================================================================

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createWSManager } from './ws-handler.ts'
import type { WSManager } from './ws-types.ts'
import { wireWorkspaceRuntimeEvents } from './wire-workspace-runtime-events.ts'
import { wireAgentTracking } from './agent-tracking.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig as baseConfig } from './__fixtures__/stub-gateway.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { ModuleAutoSaver } from '../core/storage/module-snapshots.ts'
import { createAgentsModuleState } from '../core/workspaces/module-state.ts'
import { asAIAgent } from '../agents/shared.ts'
import { newWorkspaceId } from '@leitbild/contracts'

const makeSetup = makeStubSetup
const TEST_AGENT_NAME = 'State Test Agent'

const createTestAgentAndRoom = async (system: Awaited<ReturnType<ReturnType<typeof createWorkspaceRuntimeRegistry>['getOrLoad']>>) => {
  const room = system.rooms.createRoom({ name: 'State Wiring Test', createdBy: 'test' })
  const agent = await system.spawnAIAgent({
    name: TEST_AGENT_NAME,
    model: 'mock-model',
    persona: 'Reply briefly when addressed.',
  })
  await system.addAgentToRoom(agent.id, room.profile.id, 'test')
  return { room, agent }
}

describe('per-agent state subscription is wired for every spawn path', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-agent-state-'))
    process.env.LEITBILD_HOME = homeDir
  })

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('programmatically spawned agent: subscribeAgentState is called and broadcasts arrive', async () => {
    const shared = createDeploymentRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager
    // Synthetic broadcast log — the test's subscribe-callback emits the
    // SAME shape that wsManager.subscribeAgentState would emit, so we can
    // verify the spawn-wrapper drives the chain end-to-end without relying
    // on wsManager's internal closure (which captures baseWs.broadcastTo
    // Workspace and is invisible to outer instrumentation).
    const broadcasts: Array<{ workspaceId: string; msg: WSOutbound }> = []
    const subscribed: Array<{ agentId: string; agentName: string; workspaceId: string }> = []

    const moduleState = createAgentsModuleState()
    const registry = createWorkspaceRuntimeRegistry({
      deployment: shared,
      moduleState,
      onWorkspaceRuntimeCreated: async (system, id, autoSaver: ModuleAutoSaver) => {
        // Simulate bootstrap.ts's first async step (logging.configure).
        // This releases a microtask so the test also proves runtime setup awaits
        // tracking installation before callers can explicitly spawn an Agent.
        await new Promise(r => setImmediate(r))

        wireAgentTracking(system, id, {
          attach: registry.attachAgent,
          detach: registry.detachAgent,
          subscribeAgentState: (agent, instId) => {
            // Record + install a state.subscribe that mirrors what
            // wsManager.subscribeAgentState does internally. Asserting on
            // `broadcasts` then proves: (a) the wrapper invoked us for
            // the seeded agent, and (b) state transitions actually flow.
            if (agent.kind !== 'ai') return
            subscribed.push({ agentId: agent.id, agentName: agent.name, workspaceId: instId })
            const agentName = agent.name
            agent.state.subscribe((state, _agentId, context) => {
              broadcasts.push({
                workspaceId: instId,
                msg: { type: 'agent_state', agentId: agent.id, agentName, state, ...(context !== undefined ? { context } : {}) },
              })
            })
          },
          unsubscribeAgentState: () => { /* exercised by the second test */ },
        })
        wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      },
    })

    const baseWs = createWSManager({ getRuntime: (id) => registry.tryGetLive(id) })
    wsManager = baseWs

    const cookieId = newWorkspaceId()
    await moduleState.provision(cookieId)
    const sys = await registry.getOrLoad(cookieId)

    expect(sys.rooms.listAllRooms()).toEqual([])
    expect(sys.team.listAgents().filter(agent => agent.kind === 'ai')).toEqual([])
    const { room, agent } = await createTestAgentAndRoom(sys)

    // 2. Per-agent subscription must have been routed through the wrapper.
    // Pre-fix: zero entries — the only places that called subscribeAgentState
    // were REST/WS handlers (none ran here) and the wireWorkspaceRuntimeEvents init-
    // loop (which iterated team BEFORE seed spawned Helper).
    const subscription = subscribed.filter(s => s.agentId === agent.id && s.workspaceId === cookieId)
    expect(subscription).toHaveLength(1)

    // 3. End-to-end: trigger Helper's eval via the same path the UI uses
    // (post a message, addressed to Helper). The stub LLM returns instantly,
    // so the agent transitions generating → idle. Both transitions should
    // produce `agent_state` broadcasts scoped to OUR cookie's Workspace.
    sys.routeMessage(
      { rooms: [room.profile.id] },
      { senderId: 'system', senderName: 'system', content: `[[${TEST_AGENT_NAME}]] ping`, type: 'chat' },
    )

    // The eval is async (it goes through the stub LLM); its state events have
    // all been broadcast once the agent is idle again.
    await asAIAgent(agent)!.whenIdle()
    const stateEvents = broadcasts.filter(b =>
      b.workspaceId === cookieId && b.msg.type === 'agent_state' &&
      (b.msg as { agentName?: string }).agentName === TEST_AGENT_NAME,
    )
    if (stateEvents.length === 0) {
      // Diagnostic: dump what DID broadcast for Helper or this Workspace.
      const types = broadcasts.filter(b => b.workspaceId === cookieId).map(b => b.msg.type)
      throw new Error(`No agent_state broadcasts for ${TEST_AGENT_NAME}. Got ${broadcasts.length} broadcasts total; types for cookieId: [${types.join(', ')}]`)
    }
    const generating = stateEvents.find(b => (b.msg as { state?: string }).state === 'generating')
    expect(generating).toBeDefined()
  })

  test('removeAgent path: unsubscribeAgentState is called by the wrapper', async () => {
    const shared = createDeploymentRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager
    const unsubscribed: string[] = []

    const moduleState = createAgentsModuleState()
    const registry = createWorkspaceRuntimeRegistry({
      deployment: shared,
      moduleState,
      onWorkspaceRuntimeCreated: async (system, id, autoSaver: ModuleAutoSaver) => {
        wireAgentTracking(system, id, {
          attach: registry.attachAgent,
          detach: registry.detachAgent,
          subscribeAgentState: wsManager.subscribeAgentState,
          unsubscribeAgentState: (agentId) => {
            unsubscribed.push(agentId)
            wsManager.unsubscribeAgentState(agentId)
          },
        })
        wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      },
    })

    const baseWs = createWSManager({ getRuntime: (id) => registry.tryGetLive(id) })
    wsManager = baseWs

    const workspaceId = newWorkspaceId()
    await moduleState.provision(workspaceId)
    const sys = await registry.getOrLoad(workspaceId)
    const { agent } = await createTestAgentAndRoom(sys)

    sys.removeAgent(agent.id)
    expect(unsubscribed).toContain(agent.id)
  })

  test('evict + reload cycle: agent_state broadcasts still arrive for snapshot-restored agents', async () => {
    // Regression for the "responses pop in fully formed, no thinking
    // indicator" bug on leitbild.app. Cause: onWorkspaceRuntimeEvicted closed WS
    // sessions but did not call wsManager.unsubscribeAgentState for the
    // evicted agents. stateUnsubs (a process-global Map keyed by
    // agent.id) kept entries bound to the dead agent.state closures.
    // On lazy-reload, restoreFromSnapshot restored agents with the SAME
    // ids but FRESH state objects; subscribeAgentState's idempotent
    // guard saw stateUnsubs.has(id) === true and silently skipped
    // re-subscription. The reloaded agents' notifyState() fired to
    // nowhere — no 'generating' broadcast, no thinking indicator,
    // even though chunk broadcasts worked fine. Fix in bootstrap.ts
    // onWorkspaceRuntimeEvicted: also unsubscribe each agent.
    const shared = createDeploymentRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager

    const moduleState = createAgentsModuleState()
    const registry = createWorkspaceRuntimeRegistry({
      deployment: shared,
      idleMs: 10_000_000, // disable idle eviction; we'll evict explicitly
      drainMs: 100,
      moduleState,
      onWorkspaceRuntimeCreated: async (system, id, autoSaver: ModuleAutoSaver) => {
        wireAgentTracking(system, id, {
          attach: registry.attachAgent,
          detach: registry.detachAgent,
          subscribeAgentState: wsManager.subscribeAgentState,
          unsubscribeAgentState: wsManager.unsubscribeAgentState,
        })
        wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      },
      onWorkspaceRuntimeEvicted: (system, _id) => {
        // Mirror bootstrap.ts: detach + unsubscribe every agent so
        // stateUnsubs doesn't carry stale closures across reload.
        // If the unsubscribeAgentState call below is removed, the
        // post-reload assertion in this test fails — that is the
        // regression this test pins.
        for (const a of system.team.listAgents()) {
          registry.detachAgent(a.id)
          wsManager.unsubscribeAgentState(a.id)
        }
      },
    })

    wsManager = createWSManager({ getRuntime: (id) => registry.tryGetLive(id) })

    // Register a fake WS session/connection so broadcastToWorkspace has
    // something to send to. The fake records every message it receives.
    const wsMessages: string[] = []
    const fakeToken = 'fake-session-token'
    const cookieIdInstance = newWorkspaceId()
    await moduleState.provision(cookieIdInstance)
    wsManager.sessions.set(fakeToken, {
      workspaceId: cookieIdInstance,
      // The other ClientSession fields aren't read by broadcastToWorkspace;
      // only workspaceId is used to filter. Cast satisfies the structural
      // type without committing to fields the test doesn't care about.
    } as unknown as Parameters<typeof wsManager.sessions.set>[1])
    wsManager.wsConnections.set(fakeToken, {
      send: (data: string) => { wsMessages.push(data) },
      close: () => {},
      getBufferedAmount: () => 0,
    } as unknown as Parameters<typeof wsManager.wsConnections.set>[1])

    const cookieId = cookieIdInstance

    // First load: explicitly create an Agent and Room, then let autosave
    // persist them so the reload path restores the same Agent id.
    const sys1 = await registry.getOrLoad(cookieId)
    const { room: room1, agent: helper1 } = await createTestAgentAndRoom(sys1)
    const helperId = helper1.id
    expect(helper1.name).toBe(TEST_AGENT_NAME)

    // Trigger eval pre-evict — confirm baseline that broadcasts work.
    sys1.routeMessage(
      { rooms: [room1.profile.id] },
      { senderId: 'system', senderName: 'system', content: '[[AI]] ping1', type: 'chat' },
    )
    const isGenerating = (data: string): boolean => {
      try {
        const m = JSON.parse(data) as { type?: string; state?: string; agentName?: string }
        return m.type === 'agent_state' && m.state === 'generating' && m.agentName === TEST_AGENT_NAME
      } catch { return false }
    }
    // Let the agent settle to idle so eviction drains rather than cancels it.
    await asAIAgent(helper1)!.whenIdle()
    expect(wsMessages.filter(isGenerating).length).toBeGreaterThan(0)

    // Evict the Workspace runtime, which flushes its snapshot. stateUnsubs
    // MUST be cleared for helperId; without the fix, it persists across the reload.
    // The answer's comparison record is saved in a Workspace operation that
    // can outlast the turn, and eviction refuses while one runs.
    for (;;) {
      try { await registry.evictOne(cookieId); break }
      catch (error) { if ((error as { code?: string }).code !== 'workspace_busy') throw error }
      await Bun.sleep(5)
    }

    // Lazy-reload: snapshot restores Helper with the SAME id.
    const sys2 = await registry.getOrLoad(cookieId)
    const helper2 = sys2.team.listAgents().find(a => a.kind === 'ai')!
    expect(helper2.id).toBe(helperId)
    // Critical assertion: this is a DIFFERENT object than helper1.
    expect(helper2).not.toBe(helper1)

    // Cut off pre-evict broadcasts to count only post-reload events.
    const beforeReloadCount = wsMessages.length

    // Trigger eval on the reloaded Helper. Without the fix, no
    // agent_state broadcast arrives — the reloaded helper2.state has
    // no subscriber because stateUnsubs.has(helperId) was true and
    // subscribeAgentState silently skipped.
    const room2 = sys2.rooms.listAllRooms().find(room => room.name === 'State Wiring Test')!
    sys2.routeMessage(
      { rooms: [room2.id] },
      { senderId: 'system', senderName: 'system', content: '[[AI]] ping2', type: 'chat' },
    )

    await asAIAgent(helper2)!.whenIdle()
    const postReloadGenerating = wsMessages.slice(beforeReloadCount).filter(isGenerating)
    if (postReloadGenerating.length === 0) {
      const types = wsMessages.slice(beforeReloadCount).map(d => {
        try { const m = JSON.parse(d) as { type?: string; state?: string }; return `${m.type}/${m.state ?? '-'}` } catch { return '?' }
      })
      throw new Error(`No 'generating' broadcast post-reload. Got ${wsMessages.length - beforeReloadCount} messages: [${types.join(', ')}] — onWorkspaceRuntimeEvicted likely didn't unsubscribeAgentState.`)
    }
    expect(postReloadGenerating.length).toBeGreaterThan(0)
  })
})
