import { describe, expect, test, spyOn } from 'bun:test'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { ActorId, AdapterId, CommandEnvelope, SimulationRunId, SimulationRunEvent, PackId, ObjectId, OperationalObject } from '../src/core/model/index.ts'
import { commandResultSchema, geoPointFromLonLat, meters, nowIso } from '../src/core/model/index.ts'
import type { PackRuntimeConnection, PackRuntimeEmission, PackRuntimeEventHandler, PackRuntimeEventHistory } from '../src/simulation/protocol.ts'
import { createJsonlEventLog } from '../src/core/simulation-runs/event-log.ts'
import { createSimulationRunSnapshotStore, type SimulationRunSnapshotStore } from '../src/core/simulation-runs/snapshot-store.ts'
import { createSimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { defineSimulationCommandCapability } from '../src/simulation/capabilities.ts'
import { worldCoreCapabilities } from '../src/simulation/core-capabilities.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'

const simulationRunId = 'run-persistence-policy-test' as SimulationRunId
const objectId = 'object:test-mobile' as ObjectId
const testScenario = { id: 'scenario:test-persistence', startsAt: nowIso(), agentRestrictions: { operationIds: [], objects: [] } }

const makeObject = (config?: {
  readonly point?: ReturnType<typeof geoPointFromLonLat>
  readonly status?: string
  readonly revision?: number
  readonly packData?: unknown
}): OperationalObject => {
  const at = nowIso()
  return {
    id: objectId,
    kind: 'mobile_entity',
    packId: 'packId:test' as PackId,
    label: 'Test Mobile',
    lifecycle: 'active',
    revision: config?.revision ?? 0,
    spatial: {
      position: {
        point: config?.point ?? geoPointFromLonLat(10.7, 59.9),
        headingDeg: 0,
        speedMps: 0,
        accuracyM: meters(5),
        observedAt: at,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: config?.status ?? 'available',
      priority: 'normal',
      mode: 'simulated',
    },
    ...(config?.packData === undefined ? {} : { packData: config.packData }),
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: 'adapter:test' as AdapterId,
      externalId: objectId,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
  }
}

const createControlledRuntimeConnection = (
  initialObject: OperationalObject,
  config: {
    readonly commandEventHistory?: (command: CommandEnvelope) => PackRuntimeEventHistory
    readonly sendCommand?: PackRuntimeConnection['sendCommand']
  } = {},
): {
  readonly connection: PackRuntimeConnection
  readonly emit: (events: ReadonlyArray<Parameters<PackRuntimeEventHandler>[0]['events'][number]>) => void
} => {
  const handlers = new Set<PackRuntimeEventHandler>()
  return {
    connection: {
      getSnapshot: async () => ({
        simulationRunId,
        objects: [initialObject],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: config.sendCommand ?? (async command => ({
        ok: false,
        commandId: command.id,
        rejectedAt: nowIso(),
        reason: 'test connection does not accept commands',
      })),
      ...(config.commandEventHistory === undefined ? {} : { commandEventHistory: config.commandEventHistory }),
      invokeQuery: async () => { throw new Error('test connection does not accept query Capabilities') },
      observeCommittedEvents: async () => {},
      setClock: async () => {},
      close: async () => {
        handlers.clear()
      },
    },
    emit: (events) => {
      const emission: PackRuntimeEmission = {
        type: 'event.emission',
        events,
        emittedAt: nowIso(),
        runtimeId: 'test-runtime',
      }
      for (const handler of handlers) handler(emission)
    },
  }
}

const operatorActor = {
  id: 'actor:persistence-test-operator' as ActorId,
  label: 'Persistence Test Operator',
  role: 'operator' as const,
}

const readEventLog = async (path: string): Promise<ReadonlyArray<SimulationRunEvent>> => {
  try {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as SimulationRunEvent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

const waitFor = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('simulation run persistence policy', () => {
  for (const failure of ['before-append', 'after-append', 'partial-append', 'snapshot', 'quarantine'] as const) {
    test(`uncertain ${failure} failure stops publication and reports recovery state`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'run-commit-failure-'))
      const path = join(dataDir, 'events.jsonl')
      const journal = createJsonlEventLog(path)
      const snapshots = createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') })
      const controlled = createControlledRuntimeConnection(makeObject())
      const runtime = await createSimulationRunRuntime({
        id: simulationRunId, scenario: testScenario, runtimeConnection: controlled.connection,
        runtimeCapabilities: worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
        eventLog: { ...journal, appendMany: async events => {
          if (!events.some(event => event.type === 'object.deleted')) return await journal.appendMany(events)
          if (failure === 'snapshot') return await journal.appendMany(events)
          if (failure === 'after-append') await journal.appendMany(events)
          if (failure === 'partial-append') await appendFile(path, '{"incomplete":', 'utf8')
          throw new Error('injected journal write failure')
        } },
        snapshotStore: { ...snapshots,
          quarantine: failure === 'quarantine' ? async () => { throw new Error('injected quarantine failure') } : snapshots.quarantine,
          save: async snapshot => {
            if (failure === 'snapshot' && snapshot.objects.length === 0) throw new Error('injected snapshot failure')
            await snapshots.save(snapshot)
          },
        },
      })
      const notifications: SimulationRunEvent[] = []
      runtime.subscribe(message => { if (message.type === 'event.notification') notifications.push(...message.events) })
      const outcome = await runtime.invokeCapability(operatorActor, { capabilityId: 'world.object.delete', input: { objectId } }).catch(error => error)
      expect(outcome).toMatchObject({ code: 'simulation_run_commit_uncertain' })
      expect(outcome.message).toContain(failure === 'snapshot' ? 'snapshot failure' : 'journal write failure')
      expect(runtime.snapshot().objects).toHaveLength(failure === 'snapshot' ? 0 : 1)
      expect(runtime.snapshot().clock?.paused).toBe(true)
      expect(runtime.events().some(event => event.type === 'object.deleted')).toBe(failure === 'snapshot')
      expect(notifications.some(event => event.type === 'object.deleted')).toBe(false)
      expect(runtime.health()).toContainEqual(expect.objectContaining({ runtimeId: 'world.core', state: 'failed' }))
      await expect(runtime.setClock({ paused: false })).rejects.toThrow('fail-stopped')
      await expect(runtime.invokeCapability(operatorActor, { capabilityId: 'world.object.delete', input: { objectId } })).rejects.toThrow()
      const persistedBeforeClose = await readFile(join(dataDir, 'snapshot.json'), 'utf8')
      await runtime.close()
      expect(await readFile(join(dataDir, 'snapshot.json'), 'utf8')).toBe(persistedBeforeClose)
      const reopened = createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') })
      if (failure === 'quarantine') {
        expect(outcome.message).toContain('restart safety is unproven')
        expect(runtime.health().at(-1)?.lastFailure?.message).toContain('quarantine could not be persisted')
      } else await expect(reopened.load()).rejects.toThrow('requires recovery')
      if (failure === 'partial-append') await expect(journal.readAll()).rejects.toThrow('invalid event log JSON')
      else expect((await journal.readAll()).some(event => event.type === 'object.deleted')).toBe(failure === 'snapshot' || failure === 'after-append')
    })
  }

  for (const throughHub of [false, true]) test(`committed observer failure quarantines recovery through ${throughHub ? 'Hub' : 'direct connection'}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'run-observer-failure-'))
    const journal = createJsonlEventLog(join(dataDir, 'events.jsonl'))
    const snapshots = createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') })
    const base = createControlledRuntimeConnection(makeObject()).connection
    const observer = { ...base, observeCommittedEvents: (events: readonly SimulationRunEvent[]): Promise<void> => {
      if (events.some(event => event.type === 'object.deleted')) throw new Error('synchronous observer failure')
      return Promise.resolve()
    } }
    const runtimeConnection = throughHub ? await createRuntimeHub([{
      id: 'test-runtime', packId: 'packId:test', version: '1', clock: 'none', capabilities: [], connect: async () => observer,
    }]).connect({ simulationRunId, scenario: { scenarioId: testScenario.id, runtimeIds: ['test-runtime'], connections: [], initialObjects: [makeObject()], world: { startsAt: testScenario.startsAt, environment: {} }, runtimeConfig: {} } }) : observer
    const runtime = await createSimulationRunRuntime({ id: simulationRunId, scenario: testScenario, runtimeConnection,
      runtimeCapabilities: worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
      eventLog: journal, snapshotStore: snapshots,
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(runtime.invokeCapability(operatorActor, { capabilityId: 'world.object.delete', input: { objectId } })).rejects.toMatchObject({ code: 'simulation_run_observer_failed', message: expect.stringContaining('Events committed') })
      expect(runtime.snapshot().objects).toHaveLength(0)
      expect((await journal.readAll()).some(event => event.type === 'object.deleted')).toBe(true)
      await runtime.close()
      await expect(snapshots.load()).rejects.toThrow('requires recovery')
    } finally { errors.mockRestore() }
  })

  for (const failure of ['snapshot', 'private']) test(`a final close ${failure} failure persists recovery quarantine after private cleanup`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'run-close-failure-'))
    const snapshots = createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') })
    const controlled = createControlledRuntimeConnection(makeObject())
    let failSave = false
    let closed = false
    const runtime = await createSimulationRunRuntime({ id: simulationRunId, scenario: testScenario,
      runtimeConnection: { ...controlled.connection, close: async () => { closed = true; await controlled.connection.close(); if (failure === 'private') throw new Error('private save failed') } },
      eventLog: createJsonlEventLog(join(dataDir, 'events.jsonl')),
      snapshotStore: { ...snapshots, save: async snapshot => { if (failSave) throw new Error('close save failed'); await snapshots.save(snapshot) } },
    })
    controlled.emit([{ type: 'object.upserted', at: nowIso(), object: makeObject({ revision: 1 }), provenance: { source: 'simulator' }, history: 'snapshot-only' }])
    await waitFor(async () => runtime.snapshot().objects[0]?.revision === 1, 'projected update')
    failSave = failure === 'snapshot'
    await expect(runtime.close()).rejects.toThrow('Simulation Run close failed')
    expect(closed).toBe(true)
    await expect(snapshots.load()).rejects.toThrow('requires recovery')
  })

  test('a throwing notification subscriber cannot turn a committed deletion into rejection', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'run-subscriber-failure-'))
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId, scenario: testScenario, runtimeConnection: createControlledRuntimeConnection(makeObject()).connection,
      runtimeCapabilities: worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
      eventLog: createJsonlEventLog(join(dataDir, 'events.jsonl')),
      snapshotStore: createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') }),
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    runtime.subscribe(() => { throw new Error('subscriber failed') })
    try {
      expect(await runtime.invokeCapability(operatorActor, { capabilityId: 'world.object.delete', input: { objectId } })).toMatchObject({ kind: 'command', result: { ok: true } })
      expect(runtime.snapshot().objects).toHaveLength(0)
      expect(runtime.health().some(entry => entry.state === 'failed')).toBe(false)
    } finally { errors.mockRestore(); await runtime.close() }
  })

  test('applies volatile object updates to snapshots without retaining them in the durable journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const movedObject = makeObject({
      point: geoPointFromLonLat(10.71, 59.91),
      revision: 1,
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: movedObject,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: movedObject.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === movedObject.revision,
      'volatile object update',
    )

    expect(runtime.snapshot().objects.find(object => object.id === objectId)?.spatial.position?.point.coordinates)
      .toEqual(movedObject.spatial.position?.point.coordinates)
    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    const assignedObject = makeObject({
      point: geoPointFromLonLat(10.71, 59.91),
      status: 'assigned',
      revision: 2,
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: assignedObject,
      at: nowIso(),
      provenance: assignedObject.provenance,
      history: 'record',
    }])
    await waitFor(
      async () => (await readEventLog(eventLogPath)).length === 1,
      'durable object update',
    )

    expect(runtime.events().map(event => event.type)).toEqual(['object.upserted'])
    expect(await readEventLog(eventLogPath)).toHaveLength(1)
    await runtime.close()
  })

  test('uses explicit runtime history policy instead of interpreting Pack data fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject({
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-a',
        projection: {
          summary: 'starting',
          updatedAt: nowIso(),
        },
      },
    })
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
    })

    const projectionUpdate = makeObject({
      revision: 1,
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-a',
        projection: {
          summary: 'running',
          updatedAt: nowIso(),
        },
      },
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: projectionUpdate,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: projectionUpdate.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === projectionUpdate.revision,
      'projection-only object update',
    )

    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    const packTruthUpdate = makeObject({
      revision: 2,
      packData: {
        type: 'test-unit',
        schemaVersion: 1,
        plantId: 'system-b',
        projection: {
          summary: 'running',
          updatedAt: nowIso(),
        },
      },
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: packTruthUpdate,
      at: nowIso(),
      provenance: packTruthUpdate.provenance,
      history: 'record',
    }])
    await waitFor(
      async () => (await readEventLog(eventLogPath)).length === 1,
      'durable non-projection pack data update',
    )

    expect(runtime.events().map(event => event.type)).toEqual(['object.upserted'])
    expect(await readEventLog(eventLogPath)).toHaveLength(1)
    await runtime.close()
  })

  // The journal rule (plan v3.1 §2.2, V7) overrides a Pack's snapshot-only history for a state change only.
  test('journals a snapshot-only runtime upsert that changes status, priority, lifecycle or alerts, and nothing else', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const runtimeConnection = createControlledRuntimeConnection(makeObject({ packData: { frequencyHz: 50 } }))
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({ simulationRunId, path: join(dataDir, 'snapshot.json') }),
    })
    const alert = { id: 'a1', kind: 'frequency', severity: 'warning' as const, message: 'Frequency low', raisedAt: nowIso(), acknowledged: false }
    const steps: ReadonlyArray<readonly [OperationalObject, boolean]> = [
      [makeObject({ revision: 1, packData: { frequencyHz: 49.9 } }), false],
      [makeObject({ revision: 2, status: 'constrained', packData: { frequencyHz: 49.8 } }), true],
      [makeObject({ revision: 3, status: 'constrained', point: geoPointFromLonLat(10.71, 59.91), packData: { frequencyHz: 49.7 } }), false],
      [{ ...makeObject({ revision: 4, status: 'constrained' }), alerts: [alert] }, true],
      [{ ...makeObject({ revision: 5, status: 'constrained' }), alerts: [alert] }, false],
      [{ ...makeObject({ revision: 6, status: 'constrained' }), alerts: [{ ...alert, acknowledged: true }] }, true],
      [{ ...makeObject({ revision: 7, status: 'constrained' }), operational: { status: 'constrained', priority: 'high', mode: 'simulated' } }, true],
      [{ ...makeObject({ revision: 8, status: 'constrained' }), lifecycle: 'resolved', operational: { status: 'constrained', priority: 'high', mode: 'simulated' } }, true],
    ]
    let durable = 0
    for (const [object, journalled] of steps) {
      runtimeConnection.emit([{ type: 'object.upserted', object, at: nowIso(), history: 'snapshot-only', provenance: object.provenance }])
      await waitFor(async () => runtime.snapshot().objects.find(candidate => candidate.id === objectId)?.revision === object.revision, `revision ${object.revision}`)
      if (journalled) durable += 1
      expect([object.revision, runtime.events().length]).toEqual([object.revision, durable])
    }
    expect((await readEventLog(eventLogPath)).map(event => event.type === 'object.upserted' ? event.object.revision : -1)).toEqual([2, 4, 6, 7, 8])
    await runtime.close()
  })

  test('keeps projected command lifecycle events out of the durable journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject, {
      commandEventHistory: command => command.kind === 'world.test.fast-control' ? 'snapshot-only' : 'record',
      sendCommand: async command => ({
        ok: true,
        commandId: command.id,
        acceptedAt: nowIso(),
      }),
    })
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore: createSimulationRunSnapshotStore({
        simulationRunId,
        path: join(dataDir, 'snapshot.json'),
      }),
      runtimeCapabilities: [{
        packId: 'packId:test',
        runtimeId: 'runtime:test',
        capability: defineSimulationCommandCapability({
          id: 'world.test.fast-control',
          title: 'Test fast control',
          description: 'Exercises projected command lifecycle persistence.',
          idempotent: false,
          input: z.object({}).strict(),
          output: commandResultSchema,
          buildCommand: input => ({ targetObjectIds: [objectId], payload: input }),
        }),
      }],
    })

    const outcome = await runtime.invokeCapability(operatorActor, {
      capabilityId: 'world.test.fast-control',
      input: {},
    })

    expect(outcome.kind).toBe('command')
    if (outcome.kind !== 'command') throw new Error('expected command Capability result')
    expect(outcome.result.ok).toBe(true)
    expect(runtime.events()).toHaveLength(0)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)
    expect(runtime.metrics().publishedEvents.projectedEvents).toBe(2)
    await runtime.close()
  })

  test('flushes projected snapshots on close instead of writing every runtime projection immediately', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-test-'))
    const eventLogPath = join(dataDir, 'events.jsonl')
    const initialObject = makeObject()
    const runtimeConnection = createControlledRuntimeConnection(initialObject)
    const savedSnapshots: unknown[] = []
    const snapshotStore: SimulationRunSnapshotStore = {
      load: async () => null,
      quarantine: async () => {},
      save: async (snapshot) => {
        savedSnapshots.push(snapshot)
      },
    }
    const runtime = await createSimulationRunRuntime({
      id: simulationRunId,
      scenario: testScenario,
      runtimeConnection: runtimeConnection.connection,
      eventLog: createJsonlEventLog(eventLogPath),
      snapshotStore,
    })
    expect(savedSnapshots).toHaveLength(1)

    const projectedObject = makeObject({
      revision: 1,
      point: geoPointFromLonLat(10.72, 59.92),
    })
    runtimeConnection.emit([{
      type: 'object.upserted',
      object: projectedObject,
      at: nowIso(),
      history: 'snapshot-only',
      provenance: projectedObject.provenance,
    }])
    await waitFor(
      async () => runtime.snapshot().objects.find(object => object.id === objectId)?.revision === projectedObject.revision,
      'projected snapshot throttle update',
    )

    expect(savedSnapshots).toHaveLength(1)
    expect(await readEventLog(eventLogPath)).toHaveLength(0)

    await runtime.close()
    expect(savedSnapshots).toHaveLength(2)
    const lastSnapshot = savedSnapshots.at(-1) as { readonly objects: ReadonlyArray<OperationalObject> } | undefined
    expect(lastSnapshot?.objects.find(object => object.id === objectId)?.revision).toBe(1)
  })
})
