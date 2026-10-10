import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdir, mkdtemp, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { TileType } from 'pmtiles'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'
import { actorIdSchema, nowIso, type SimulationRunId, type SimulationRunEvent } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createHealthDetails, createServer, staticContentTypeForPath } from '../src/core/api/server.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createSimulationRunRealtimeManager, type RealtimeEventBatchMessage, type RealtimeOutboundMessage } from '../src/core/api/realtime.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { createManualIdleTimer, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { assignCommandKind } from '../src/packs/ambulance/commands.ts'

interface CapturedRealtimeClient {
  readonly events: SimulationRunEvent[]
  readonly eventMessages: RealtimeEventBatchMessage[]
  readonly readyMessages: string[]
}

const operatorActor: Actor = {
  id: actorIdSchema.parse('actor:operator'),
  label: 'Test operator',
  role: 'operator',
}

const captureRealtimeMessage = (
  targetClient: CapturedRealtimeClient,
  message: RealtimeOutboundMessage,
): void => {
  if (message.type !== 'events') return
  targetClient.eventMessages.push(message)
  targetClient.events.push(...message.events)
}

const waitForMovingObjectEvent = async (
  client: CapturedRealtimeClient,
  objectId: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for moving object event: ${objectId}`))
    }, 10_000)

    const poll = (): void => {
      const moving = client.events.some(event =>
        event.type === 'object.upserted'
        && event.object?.id === objectId
        && (event.object.spatial?.position?.speedMps ?? 0) > 0)
      if (!moving) {
        setTimeout(poll, 25)
        return
      }
      clearTimeout(timeout)
      resolve()
    }
    poll()
  })
}

describe('server health', () => {
  test('routes both regional and overview tiles through the artifact handler', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-map-routes-'))
    const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: [] })
    const server = createServer({ workspaces, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: dataDir } })
    try {
      for (const source of ['current', 'overview']) {
        const response = await fetch(`http://127.0.0.1:${server.port}/map/tiles/${source}/0/0/0.mvt`)
        expect(response.status).toBe(503) // Missing artifact, not an unregistered route.
        expect(await response.json()).toMatchObject({ error: 'vector map artifact unavailable' })
      }
      await mkdir(join(dataDir, 'current'))
      const tileBytes = new Uint8Array(4_096).map((_, index) => index % 7)
      await Bun.write(join(dataDir, 'current', 'norway.pmtiles'), writePmtilesArchive({
        tiles: [{ z: 0, x: 0, y: 0, data: tileBytes }],
        tileType: TileType.Mvt,
        bounds: { minLon: -180, minLat: -85, maxLon: 180, maxLat: 85 },
        center: { lon: 0, lat: 0, zoom: 0 },
      }))
      // The HTTP server must pass the module's own gzip coding through unchanged.
      const coded = await fetch(`http://127.0.0.1:${server.port}/map/tiles/current/0/0/0.mvt`, {
        headers: { 'Accept-Encoding': 'gzip' },
        decompress: false,
      })
      expect(coded.headers.get('content-encoding')).toBe('gzip')
      expect(coded.headers.get('vary')).toBe('Accept-Encoding')
      expect(new Uint8Array(gunzipSync(new Uint8Array(await coded.arrayBuffer())))).toEqual(tileBytes)
      await mkdir(join(dataDir, 'overview'))
      await Bun.write(join(dataDir, 'overview', 'current.pmtiles'), '0123456789')
      const ranged = await fetch(`http://127.0.0.1:${server.port}/map/tiles/overview.pmtiles`, { headers: { Range: 'bytes=2-5' } })
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-length')).toBe('4')
      expect(await ranged.text()).toBe('2345')
      const fontDir = join(dataDir, 'fonts', 'Noto Sans Regular')
      await mkdir(fontDir, { recursive: true })
      await Bun.write(join(fontDir, '0-255.pbf'), new Uint8Array([10, 0]))
      const style = await fetch(`http://127.0.0.1:${server.port}/map/style.json`).then(response => response.json()) as { glyphs: string }
      expect(style.glyphs).toMatch(/^\/map\/fonts\/\{fontstack\}\/\{range\}\.pbf\?build=\d+$/)
      const glyph = await fetch(`http://127.0.0.1:${server.port}${style.glyphs.replace('{fontstack}', 'Noto%20Sans%20Regular').replace('{range}', '0-255')}`)
      expect(glyph.headers.get('content-type')).toBe('application/x-protobuf')
      expect(new Uint8Array(await glyph.arrayBuffer())).toEqual(new Uint8Array([10, 0]))
    } finally { await server.stop(); await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
  })
  test('serves the light embed page for embedded views and the app page for other Workspace routes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-embed-route-'))
    const uiDistPath = join(dataDir, 'ui')
    await mkdir(uiDistPath)
    await Bun.write(join(uiDistPath, 'index.html'), 'app page')
    await Bun.write(join(uiDistPath, 'embed.html'), 'embed page')
    const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: [] })
    const server = createServer({ workspaces, port: 0, bindHost: '127.0.0.1', uiDistPath, mapArtifacts: { rootDir: dataDir } })
    try {
      const workspaceId = newWorkspaceId()
      const embed = await fetch(`http://127.0.0.1:${server.port}/workspaces/${workspaceId}/world/embed/process-plant.display`)
      expect(await embed.text()).toBe('embed page')
      expect(embed.headers.get('cache-control')).toBe('no-cache')
      const app = await fetch(`http://127.0.0.1:${server.port}/workspaces/${workspaceId}/world/runs/run-1`)
      expect(await app.text()).toBe('app page')
    } finally { await server.stop(); await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
  })

  test('serves module worker assets with a JavaScript MIME type', () => {
    expect(staticContentTypeForPath('/assets/maplibre-gl-worker-hash.mjs')).toBe('application/javascript')
    expect(staticContentTypeForPath('/assets/OperationalMap-hash.js')).toBe('application/javascript')
    expect(staticContentTypeForPath('/assets/index-hash.css')).toBe('text/css')
    expect(staticContentTypeForPath('/assets/leitbild-symbols.svg')).toBe('image/svg+xml')
    expect(staticContentTypeForPath('/assets/unknown.bin')).toBe('application/octet-stream')
  })

  test('reports process, storage, simulation run, and realtime details', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-health-test-'))
    const mapRoot = await mkdtemp(join(tmpdir(), 'leitbild-map-health-test-'))
    const releaseDir = join(mapRoot, 'releases', 'leitbild-osm-norway', 'health-build')
    const glyphDir = join(mapRoot, 'fonts', 'Noto Sans Regular')
    await mkdir(releaseDir, { recursive: true })
    await mkdir(glyphDir, { recursive: true })
    await Bun.write(join(releaseDir, 'norway.pmtiles'), 'pmtiles')
    await Bun.write(join(glyphDir, '0-255.pbf'), 'glyphs')
    await symlink(releaseDir, join(mapRoot, 'current'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const runtime = await registry.create({ scenarioId: 'test-response' })
    try {
      const details = await createHealthDetails({ registry, mapArtifacts: { rootDir: mapRoot } })

      expect(details.ok).toBe(true)
      expect(details.process.memory.rssBytes).toBeGreaterThan(0)
      expect(details.registry.dataDir).toContain(`/workspaces/${registry.workspaceId}/world`)
      expect(details.registry.storage.totalBytes).toBeGreaterThan(0)
      expect(details.registry.simulationRuns).toContainEqual(expect.objectContaining({
        id: runtime.id,
        scenarioId: 'test-response',
        loaded: true,
        objectCount: responseScenario.initialObjects.length,
        snapshotSeq: runtime.snapshot().seq,
      }))
      expect(details.realtime.websocketClientCount).toBe(0)
      expect(details.realtime.subscribedSimulationRunCount).toBe(0)
      expect(details.mapArtifacts.status).toBe('ready')
      expect(details.mapArtifacts.activeBuildId).toBe('health-build')
      expect(details.mapArtifacts.currentPmtiles.sizeBytes).toBeGreaterThan(0)
      expect(details.mapArtifacts.glyphProbe.available).toBe(true)
      expect(details.mapArtifacts.terrain.available).toBe(false)
      expect(details.mapArtifacts.terrain.tileTemplate).toBe('/map/terrain/current/{z}/{x}/{y}.png')
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('resubscribes realtime clients after a simulation run reset recreates the runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-realtime-test-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const client: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtimeBeforeReset = await registry.create({ scenarioId: 'test-response' })
      simulationRunId = runtimeBeforeReset.id
      realtime.addClient(simulationRunId, client)
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)
      expect(client.readyMessages).toContain('test-response')

      await registry.reset(simulationRunId)
      const resetEvent = client.events.find(event => event.type === 'simulationRun.reset')
      expect(resetEvent).toMatchObject({
        type: 'simulationRun.reset',
        previousScenarioId: 'test-response',
        scenarioId: 'test-response',
      })
      realtime.reconcile()
      expect(client.readyMessages.filter(id => id === 'test-response')).toHaveLength(2)

      const runtime = registry.get(simulationRunId)
      if (!runtime) throw new Error('expected simulation run runtime after reset')
      const outcome = await runtime.invokeCapability(operatorActor, {
        capabilityId: assignCommandKind,
        input: { unitId: 'amb:a12', incidentId: 'incident:gronland-unattended', patientIds: runtime.snapshot().objects.filter(object => (object.packData as { type?: string; incidentId?: string }).type === 'patient' && (object.packData as { incidentId?: string }).incidentId === 'incident:gronland-unattended').slice(0, 1).map(object => object.id) },
      })
      expect(outcome.kind).toBe('command')
      if (outcome.kind !== 'command') throw new Error('expected command Capability result')
      expect(outcome.result.ok).toBe(true)

      await registry.setExecution(simulationRunId, { pace: 'maximum' })
      await waitForMovingObjectEvent(client, 'amb:a12')
      const postResetEventMessages = client.eventMessages.filter(message =>
        !message.events.some(event => event.type === 'simulationRun.reset'),
      )
      expect(postResetEventMessages.every(message => message.scenarioId === 'test-response')).toBe(true)
      await registry.setExecution(simulationRunId, { playback: 'paused', pace: 'realtime' })
      realtime.removeClient(simulationRunId, client)
      expect(realtime.status().subscribedSimulationRunCount).toBe(0)
      expect(registry.get(simulationRunId)).toBe(runtime)
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })

  test('sends realtime ready to every client that joins an already-subscribed simulation run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-second-client-test-'))
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const firstClient: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const secondClient: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtime = await registry.create({ scenarioId: 'test-response' })
      simulationRunId = runtime.id
      realtime.addClient(simulationRunId, firstClient)
      expect(firstClient.readyMessages).toEqual(['test-response'])
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)

      realtime.addClient(simulationRunId, secondClient)
      expect(secondClient.readyMessages).toEqual(['test-response'])
      expect(firstClient.readyMessages).toEqual(['test-response'])
      expect(realtime.status().websocketClientCount).toBe(2)
      expect(realtime.status().subscribedSimulationRunCount).toBe(1)

      await registry.reset(simulationRunId)
      realtime.reconcile()
      expect(firstClient.readyMessages).toEqual(['test-response', 'test-response'])
      expect(secondClient.readyMessages).toEqual(['test-response', 'test-response'])
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })

  test('does not snapshot the runtime for pure realtime broadcasts', () => {
    const simulationRunId = 'run-runtime-realtime-cache-test' as SimulationRunId
    const handlers = new Set<Parameters<NonNullable<ReturnType<SimulationRunRegistry['get']>>['subscribe']>[0]>()
    let snapshotSeq = 7
    let snapshotCalls = 0
    const runtime = {
      snapshot: () => {
        snapshotCalls += 1
        return {
          objects: [],
          seq: snapshotSeq,
          scenario: { scenarioId: 'scenario:realtime-cache' },
        }
      },
      subscribe: (handler: Parameters<NonNullable<ReturnType<SimulationRunRegistry['get']>>['subscribe']>[0]) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as NonNullable<ReturnType<SimulationRunRegistry['get']>>
    const registry = {
      get: (id: SimulationRunId) => id === simulationRunId ? runtime : null,
      acquireLease: () => () => {},
    } as unknown as SimulationRunRegistry
    const messages: RealtimeOutboundMessage[] = []
    const realtime = createSimulationRunRealtimeManager<{ readonly id: string }>({
      registry,
      send: (_client, message) => {
        messages.push(message)
      },
      sendReady: () => {},
    })

    realtime.addClient(simulationRunId, { id: 'client:1' })
    const setupSnapshotCalls = snapshotCalls
    for (const handler of handlers) {
      handler({
        type: 'event.notification',
        events: [],
        realtimeMessages: [{ type: 'test.motion', at: nowIso(), payload: { x: 1 } }],
      })
    }
    expect(snapshotCalls).toBe(setupSnapshotCalls)
    expect(messages.at(-1)).toMatchObject({
      type: 'runtime.realtime',
      snapshotSeq: 7,
    })

    snapshotSeq = 8
    for (const handler of handlers) {
      handler({
        type: 'event.notification',
        events: [{ type: 'test.event', seq: 8, at: nowIso() } as unknown as SimulationRunEvent],
      })
    }
    expect(snapshotCalls).toBe(setupSnapshotCalls + 1)
    expect(messages.at(-1)).toMatchObject({
      type: 'events',
      snapshotSeq: 8,
    })
    realtime.stop()
  })

  test('closes idle runtimes after the last realtime client leaves', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-server-idle-client-test-'))
    const idle = createManualIdleTimer()
    const registry = createSimulationRunRegistry({
      dataDir,
      workspaceId: newWorkspaceId(),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      idleRuntimeCloseDelayMs: 5,
      idleRuntimeCloseTimer: idle.arm,
      runtimeAdapters: [
        createLocalAmbulancePackRuntimeAdapter({ routing: createDirectRoutingAdapter() }),
        createLocalWeatherPackRuntimeAdapter(),
      ],
    })
    const client: CapturedRealtimeClient = { events: [], eventMessages: [], readyMessages: [] }
    const realtime = createSimulationRunRealtimeManager<CapturedRealtimeClient>({
      registry,
      send: captureRealtimeMessage,
      sendReady: (targetClient, message) => {
        targetClient.readyMessages.push(message.scenarioId ?? '')
      },
    })
    let simulationRunId: SimulationRunId | undefined
    try {
      const runtime = await registry.create({ scenarioId: 'test-response' })
      simulationRunId = runtime.id
      realtime.addClient(simulationRunId, client)
      expect(registry.get(simulationRunId)).toBe(runtime)

      await idle.advance(5)
      expect(registry.get(simulationRunId)).toBe(runtime)

      realtime.removeClient(simulationRunId, client)
      await idle.advance(5)
      expect(registry.get(simulationRunId)).toBeUndefined()
      expect(realtime.status().websocketClientCount).toBe(0)
      expect(realtime.status().subscribedSimulationRunCount).toBe(0)
    } finally {
      realtime.stop()
      if (simulationRunId) await registry.close(simulationRunId)
    }
  })
})
