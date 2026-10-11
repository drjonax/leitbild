// ============================================================================
// Integration test: lazily loaded Workspaces get full broadcast wiring.
//
// The bug fixed in 5d73a8e was that wireWorkspaceRuntimeEvents was silently skipped
// for lazily loaded Workspaces because onWorkspaceRuntimeCreated ran before the registry's
// internal map.set() — autoSaverFor(id) returned null, the `if (autoSaver)`
// guard short-circuited, and every lazily loaded Workspace booted with
// setOnEvalEvent / setOnMessagePosted / state.subscribe all unwired.
//
// This test proves end-to-end that a Workspace loaded via the registry
// path (the registry load path) has live broadcast wiring: posting a
// message into one of its rooms fans out via wsManager.broadcastToRoom
// scoped to that Workspace.
//
// First assertion is the harness sanity check: the system's snapshot has
// at least one room. If that fails the test setup is broken and we'd be
// chasing a phantom in the next assertions.
// ============================================================================

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { createWorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { createWSManager } from './ws-handler.ts'
import type { WSManager } from './ws-types.ts'
import { wireWorkspaceRuntimeEvents } from './wire-workspace-runtime-events.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig as baseConfig } from './__fixtures__/stub-gateway.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { newWorkspaceId } from '@leitbild/contracts'
import { createAgentsModuleState } from '../core/workspaces/module-state.ts'
import { roomRoutes } from './routes/rooms.ts'
import type { RouteContext } from './routes/types.ts'

const makeSetup = makeStubSetup

describe('lazy Workspace broadcast wiring (regression for 5d73a8e)', () => {
  let homeDir: string

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.LEITBILD_HOME
  })

  test('routeMessage in a loaded Workspace reaches room-scoped broadcast', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-streaming-'))
    process.env.LEITBILD_HOME = homeDir

    const shared = createDeploymentRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    // Forward-declared wsManager — the registry's onWorkspaceRuntimeCreated closes over
    // this. The bootstrap pattern relies on wsManager being assigned before
    // any registry.getOrLoad() runs.
    let wsManager!: WSManager
    const broadcasts: Array<{ workspaceId: string; msg: WSOutbound }> = []

    const moduleState = createAgentsModuleState()
    const registry = createWorkspaceRuntimeRegistry({
      deployment: shared,
      moduleState,
      onWorkspaceRuntimeCreated: async (system, id, autoSaver) => {
        // The exact same call that bootstrap.ts makes — this is the wiring
        // the bug skipped.
        wireWorkspaceRuntimeEvents(system, wsManager, autoSaver, id)
      },
    })

    // Construct wsManager AFTER registry but BEFORE the first getOrLoad.
    // Wrap broadcastToWorkspace to record what would have hit the WS.
    const baseWs = createWSManager({ getRuntime: (id) => registry.tryGetLive(id) })
    wsManager = {
      ...baseWs,
      broadcastToWorkspace: (workspaceId, msg) => {
        broadcasts.push({ workspaceId, msg })
        baseWs.broadcastToWorkspace(workspaceId, msg)
      },
      broadcastToRoom: (workspaceId, roomId, msg) => {
        void roomId
        broadcasts.push({ workspaceId, msg })
        baseWs.broadcastToRoom(workspaceId, roomId, msg)
      },
    }

    // The bug only manifested for Workspaces loaded after process start. Use
    // an explicit cookie-shaped id (16 chars, lowercase alphanumeric) so we
    // exercise that exact path.
    const cookieId = newWorkspaceId()
    await moduleState.provision(cookieId)
    const sys = await registry.getOrLoad(cookieId)

    const room = sys.rooms.createRoom({ name: 'Wiring Test', createdBy: 'test' })

    // Trigger a message that fires onMessagePosted. This is the chain the
    // bug broke: room.post -> onMessagePosted (via lateBinding proxy) ->
    // wireWorkspaceRuntimeEvents-installed callback -> broadcastToRoom.
    sys.routeMessage(
      { rooms: [room.profile.id] },
      { senderId: 'system', senderName: 'system', content: 'test note', type: 'system' },
    )

    // The broadcast must have reached our instrumented broadcastToWorkspace,
    // scoped to our URL Workspace id. Pre-fix behavior: zero entries.
    const our = broadcasts.filter(b => b.workspaceId === cookieId)
    expect(our.length).toBeGreaterThan(0)
    expect(our.some(b => b.msg.type === 'message')).toBe(true)
    // Human HTTP activation uses the same owner operation as the capability,
    // including broadcast and scheduled persistence rather than route-only UI wiring.
    const packsEndpoint = `/rooms/${room.profile.id}/packs`
    const packsRoute = roomRoutes.find(route => route.method === 'PUT' && route.pattern.test(packsEndpoint))!
    const knownPack = sys.packCatalog.list()[0]!.id
    const packsResponse = await packsRoute.handler(new Request(`http://localhost${packsEndpoint}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activePacks: [knownPack, knownPack] }),
    }), packsEndpoint.match(packsRoute.pattern)!, { system: sys } as RouteContext)
    expect(packsResponse.status).toBe(200)
    expect(await packsResponse.json()).toEqual({ activePacks: [knownPack] })
    expect(broadcasts.filter(b => b.msg.type === 'pack_activation_changed')).toEqual([
      { workspaceId: cookieId, msg: { type: 'pack_activation_changed', roomId: room.profile.id, activePacks: [knownPack] } },
    ])
    await registry.evictOne(cookieId)
    const restored = await registry.getOrLoad(cookieId)
    expect(restored.rooms.getRoom(room.profile.id)!.getActivePacks()).toEqual([knownPack])
    await registry.shutdown()
  })

  test('REST deletion broadcasts and schedules durable message and execution cleanup', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'leitbild-delete-wiring-'))
    process.env.LEITBILD_HOME = homeDir
    const moduleState = createAgentsModuleState()
    const id = newWorkspaceId()
    await moduleState.provision(id)
    const broadcasts: WSOutbound[] = []
    let saves = 0
    let wsManager!: WSManager
    const registry = createWorkspaceRuntimeRegistry({
      deployment: createDeploymentRuntime({ providerConfig: baseConfig, providerSetup: makeSetup(makeStubGateway()) }), moduleState,
      onWorkspaceRuntimeCreated: (system, workspaceId, saver) => {
        wireWorkspaceRuntimeEvents(system, wsManager, { ...saver, scheduleSave: () => { saves++; saver.scheduleSave() } }, workspaceId)
      },
    })
    wsManager = { ...createWSManager({ getRuntime: workspaceId => registry.tryGetLive(workspaceId) }),
      broadcastToRoom: (_workspaceId, _roomId, message) => { broadcasts.push(message) },
    }
    try {
      const system = await registry.getOrLoad(id)
      const room = system.rooms.createRoom({ name: 'Delete', createdBy: 'test' })
      const message = room.post({ senderId: 'test', type: 'chat', content: 'exact content' })
      system.executionStore.beginTurn({ id: 'turn', roomId: room.profile.id, agentId: 'test', startedAt: 1 })
      system.executionStore.linkMessage('turn', message.id)
      const count = saves
      const endpoint = `/rooms/${room.profile.id}/messages/${message.id}`
      const route = roomRoutes.find(route => route.method === 'DELETE' && route.pattern.test(endpoint))!
      const response = await route.handler(new Request(`http://localhost${endpoint}`, { method: 'DELETE' }), endpoint.match(route.pattern)!, { system } as RouteContext)
      expect(response.status).toBe(200)
      expect(saves).toBe(count + 1)
      expect(broadcasts.filter(message => message.type === 'message_deleted')).toHaveLength(1)
      expect(system.executionStore.listTurns(room.profile.id)).toEqual([])
      room.post({ senderId: 'test', type: 'chat', content: 'clear this' })
      const beforeClear = saves
      room.clearMessages()
      expect(saves).toBe(beforeClear + 1)
      expect(broadcasts.filter(message => message.type === 'messages_cleared')).toHaveLength(1)
      await registry.evictOne(id)
      const reloaded = await registry.getOrLoad(id)
      // Restoring the human identity can post a fresh join notice; deleted chat must not return.
      expect(reloaded.rooms.getRoom(room.profile.id)!.getRetainedMessages().filter(message => message.type === 'chat')).toEqual([])
      expect(reloaded.executionStore.listTurns(room.profile.id)).toEqual([])
    } finally { await registry.shutdown() }
  })
})
