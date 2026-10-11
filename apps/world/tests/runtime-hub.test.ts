import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import type {
  ActorId,
  CommandEnvelope,
  CommandId,
  SimulationRunId,
  IsoTimestamp,
  SimulationClockState,
  ObjectId,
  PackId,
  OperationalObject,
  SimulationRunEvent,
} from '../src/core/model/index.ts'
import { operationalObjectSchema, simulationRunEventSchema } from '../src/core/model/index.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEmission,
} from '../src/simulation/protocol.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../src/simulation/capabilities.ts'
import { capabilityRejection } from '../src/simulation/capability-rejection.ts'

interface StubAdapter extends PackRuntimeAdapter {
  readonly connectCount: () => number
  readonly closeCount: () => number
  readonly emit: (emission: PackRuntimeEmission) => void
}

const rejectedCommand = (command: CommandEnvelope) => ({
  ok: false as const,
  commandId: command.id,
  rejectedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
  reason: 'stub rejects commands',
})

const createStubAdapter = (
  id: string,
  packId: string,
  commandKind: string,
  options: { readonly queryKind?: string; readonly queryFailures?: number; readonly queryError?: () => Error } = {},
): StubAdapter => {
  let connectCount = 0
  let closeCount = 0
  let queryFailures = options.queryFailures ?? 0
  const handlers = new Set<(emission: PackRuntimeEmission) => void>()
  const adapter: PackRuntimeAdapter = {
    id,
    version: '1.0.0',
    packId,
    clock: 'none',
    capabilities: [
      defineSimulationCommandCapability({
        id: commandKind,
        title: commandKind,
        description: `Test command ${commandKind}`,
        idempotent: false,
        input: z.object({}).passthrough(),
        output: z.object({}).passthrough(),
        buildCommand: input => ({ targetObjectIds: [], payload: input }),
      }),
      ...(options.queryKind === undefined ? [] : [defineSimulationQueryCapability({
        id: options.queryKind,
        title: options.queryKind,
        description: `Test query ${options.queryKind}`,
        input: z.object({}).strict(),
        output: z.object({ adapterId: z.string() }).strict(),
      })]),
    ],
    connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
      connectCount += 1
      return {
        getSnapshot: async () => ({
          simulationRunId: config.simulationRunId,
          objects: [],
          capturedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
        }),
        subscribe: handler => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        sendCommand: async command => rejectedCommand(command),
        invokeQuery: async () => {
          if (queryFailures > 0) {
            queryFailures -= 1
            throw options.queryError?.() ?? new Error('stub query failure')
          }
          return { adapterId: id }
        },
        observeCommittedEvents: async () => undefined,
        setClock: async (_clock: SimulationClockState) => undefined,
        close: async () => {
          closeCount += 1
        },
      }
    },
  }
  return {
    ...adapter,
    connectCount: () => connectCount,
    closeCount: () => closeCount,
    emit: emission => {
      for (const handler of handlers) handler(emission)
    },
  }
}

const command = (kind: string): CommandEnvelope => ({
  id: `command:${kind}` as CommandId,
  simulationRunId: 'run-test' as SimulationRunId,
  actorId: 'actor:test' as ActorId,
  kind,
  targetObjectIds: [],
  payload: {},
  issuedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp,
})

const connectionConfig = (runtimeIds: ReadonlyArray<string>): PackRuntimeConnectionConfig => ({
  simulationRunId: 'run-test' as SimulationRunId,
  scenario: {
    scenarioId: 'scenario:test',
    runtimeIds,
    connections: [],
    world: { startsAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp, environment: { mode: 'test' } },
    initialObjects: [],
    runtimeConfig: {},
  },
})

const withConnection = (adapter: StubAdapter, extend: (connection: PackRuntimeConnection, config: PackRuntimeConnectionConfig) => PackRuntimeConnection): StubAdapter => ({
  ...adapter,
  connect: async config => extend(await adapter.connect(config), config),
})
const testObject = (packId: string, revision = 1): OperationalObject => operationalObjectSchema.parse({
  id: `object:${packId}`, packId, kind: 'facility', label: packId, lifecycle: 'active', revision,
  spatial: { frame: { kind: 'wgs84' } }, operational: { status: 'ready', priority: 'normal', mode: 'simulated' },
  alerts: [], provenance: { source: 'simulator' }, packData: {},
  timestamps: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
}) as OperationalObject
const committedUpsert = (object: OperationalObject, seq: number): SimulationRunEvent => simulationRunEventSchema.parse({
  id: `event:${seq}`, seq, simulationRunId: 'run-test', type: 'object.upserted', object,
  at: '2026-01-01T00:00:00Z', provenance: object.provenance,
}) as SimulationRunEvent

describe('createRuntimeHub', () => {
  test('connects only scenario-declared runtimes', async () => {
    const active = createStubAdapter('active.runtime', 'active-pack', 'world.active.command')
    const inactive = createStubAdapter('inactive.runtime', 'inactive-pack', 'world.inactive.command')
    const hub = createRuntimeHub([active, inactive])

    const connection = await hub.connect({
      simulationRunId: 'run-test' as SimulationRunId,
      scenario: {
        scenarioId: 'scenario:test',
        runtimeIds: ['active.runtime'],
        connections: [],
        world: { startsAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp, environment: { mode: 'test' } },
        initialObjects: [],
        runtimeConfigByRuntimeId: {},
        runtimeConfig: {},
      },
    })

    expect(active.connectCount()).toBe(1)
    expect(inactive.connectCount()).toBe(0)

    const inactiveCommand = await connection.sendCommand(command('inactive.command'))
    expect(inactiveCommand.ok).toBe(false)
    if (!inactiveCommand.ok) expect(inactiveCommand.reason).toMatch(/no pack runtime accepts/)

    await connection.close()
  })

  test('rejects ambiguous active command routes before connecting runtimes', async () => {
    const first = createStubAdapter('first.runtime', 'first-pack', 'world.shared.command')
    const second = createStubAdapter('second.runtime', 'second-pack', 'world.shared.command')
    const hub = createRuntimeHub([first, second])

    await expect(hub.connect(connectionConfig([first.id, second.id]))).rejects.toThrow('duplicate command route')
    expect(first.connectCount()).toBe(0)
    expect(second.connectCount()).toBe(0)
  })

  test('drops emissions that claim another runtime or Pack identity', async () => {
    const adapter = createStubAdapter('trusted.runtime', 'trusted-pack', 'world.trusted.command')
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))
    const received: PackRuntimeEmission[] = []
    connection.subscribe(emission => received.push(emission))
    const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
    const baseEmission: PackRuntimeEmission = {
      type: 'event.emission',
      emittedAt: at,
      runtimeId: 'other.runtime',
      events: [],
    }

    adapter.emit(baseEmission)
    adapter.emit({
      ...baseEmission,
      runtimeId: 'trusted.runtime',
      events: [{
        type: 'object.upserted',
        at,
        history: 'record',
        provenance: { source: 'simulator' },
        object: {
          id: 'object:foreign' as ObjectId,
          kind: 'facility',
          packId: 'foreign-pack' as PackId,
          label: 'Foreign',
          lifecycle: 'active',
          revision: 0,
          spatial: { frame: { kind: 'wgs84' } },
          operational: { status: 'ready', priority: 'normal', mode: 'simulated' },
          alerts: [],
          provenance: { source: 'simulator' },
          timestamps: { createdAt: at, updatedAt: at },
          packData: {},
        },
      }],
    })

    expect(received).toEqual([])
    await connection.close()
    expect(adapter.closeCount()).toBe(1)
  })

  test('reports runtime failures and recovery without hiding the failure count', async () => {
    const adapter = createStubAdapter('health.runtime', 'health-pack', 'world.health.command', {
      queryKind: 'world.health.status',
      queryFailures: 1,
    })
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))

    await expect(connection.invokeQuery({ capabilityId: 'world.health.status', input: {} }))
      .rejects.toThrow('stub query failure')
    expect(connection.health?.()).toEqual([expect.objectContaining({
      runtimeId: 'health.runtime',
      state: 'degraded',
      failureCount: 1,
      lastFailure: expect.objectContaining({ operation: 'world.health.status', message: 'stub query failure' }),
    })])

    expect(await connection.invokeQuery({ capabilityId: 'world.health.status', input: {} })).toEqual({ adapterId: 'health.runtime' })
    expect(connection.health?.()).toEqual([expect.objectContaining({
      runtimeId: 'health.runtime',
      state: 'ready',
      failureCount: 1,
    })])
    await connection.close()
  })

  test('returns expected query rejections without falsely degrading runtime health', async () => {
    const adapter = createStubAdapter('healthy.runtime', 'healthy-pack', 'world.healthy.command', {
      queryKind: 'world.healthy.status',
      queryFailures: 1,
      queryError: () => capabilityRejection('capability_target_not_found', 'Target not found'),
    })
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))

    await expect(connection.invokeQuery({ capabilityId: 'world.healthy.status', input: {} }))
      .rejects.toMatchObject({ code: 'capability_target_not_found' })
    expect(connection.health?.()).toEqual([expect.objectContaining({
      runtimeId: 'healthy.runtime',
      state: 'ready',
      failureCount: 0,
    })])
    expect(connection.health?.()[0]).not.toHaveProperty('lastFailure')
    await connection.close()
  })

  test('exact-advancement failures identify the Pack Runtime and underlying error', async () => {
    const base = createStubAdapter('failing.runtime', 'failing-pack', 'world.failing.command')
    const adapter = withConnection({ ...base, clock: 'simulation' }, connection => ({
      ...connection,
      advanceTo: async () => { throw new Error('numerical transition stalled') },
    }))
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))
    try {
      await expect(connection.advanceTo?.({ currentTime: '2026-01-01T00:00:01.000Z' as IsoTimestamp, paused: true, updatedAt: '2026-01-01T00:00:00.000Z' as IsoTimestamp }))
        .rejects.toThrow('Pack Runtime exact advancement failed — failing.runtime: numerical transition stalled')
      expect(connection.health?.()[0]).toMatchObject({
        runtimeId: 'failing.runtime',
        state: 'degraded',
        lastFailure: { operation: 'advance-to', message: 'numerical transition stalled' },
      })
    } finally { await connection.close() }
  })

  test('all observers finish before any reconciliation and every Pack sees the committed object lookup', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const observing = new Promise<void>(resolve => { started = resolve })
    let providerReady = false
    const reconciled: string[] = []
    const readers: PackRuntimeConnectionConfig['objectById'][] = []
    const object = testObject('provider', 2)
    const consumer = withConnection(createStubAdapter('consumer.runtime', 'consumer', 'world.consumer.command'), (base, config) => {
      readers.push(config.objectById)
      return { ...base, afterCommittedEvents: async () => {
        expect(providerReady).toBe(true)
        expect(config.objectById?.(object.id)).toEqual(object)
        reconciled.push('consumer')
      } }
    })
    const provider = withConnection(createStubAdapter('provider.runtime', 'provider', 'world.provider.command'), (base, config) => {
      readers.push(config.objectById)
      return { ...base, observeCommittedEvents: async () => { started(); await gate; providerReady = true },
        afterCommittedEvents: async () => { expect(providerReady).toBe(true); reconciled.push('provider') } }
    })
    const connection = await createRuntimeHub([consumer, provider]).connect(connectionConfig([consumer.id, provider.id]))
    try {
      const pending = connection.observeCommittedEvents([committedUpsert(object, 1)])
      await observing
      expect(reconciled).toEqual([])
      expect(readers.map(read => read?.(object.id))).toEqual([object, object])
      release()
      await pending
      expect(reconciled.sort()).toEqual(['consumer', 'provider'])
    } finally { release(); await connection.close() }
  })

  test('observer failure quarantines stale state until reconnect, including peer reads', async () => {
    let failObserve = true
    let observed = testObject('failure')
    let peerConfig: PackRuntimeConnectionConfig | undefined
    let reconciliations = 0
    const adapter = withConnection(createStubAdapter('failure.runtime', 'failure', 'world.failure.command', { queryKind: 'world.failure.query' }), base => ({
      ...base,
      observeCommittedEvents: async events => {
        if (failObserve) throw new Error('observer failed')
        for (const event of events) if (event.type === 'object.upserted' && event.object.id === observed.id) observed = event.object
      },
      afterCommittedEvents: async () => { reconciliations++ },
    }))
    const peer = withConnection(createStubAdapter('peer.runtime', 'peer', 'world.peer.command'), (base, config) => { peerConfig = config; return base })
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const connection = await createRuntimeHub([adapter, peer]).connect(connectionConfig([adapter.id, peer.id]))
    try {
      await connection.observeCommittedEvents([committedUpsert(testObject('failure', 2), 1)])
      failObserve = false
      await connection.observeCommittedEvents([committedUpsert(testObject('peer'), 2)])
      expect(observed.revision).toBe(1)
      expect(reconciliations).toBe(0)
      expect(connection.health?.()[0]).toMatchObject({ state: 'failed', failureCount: 1, lastFailure: { operation: 'observe-committed-events' } })
      expect(peerConfig?.isObjectProviderAvailable?.(observed.id)).toBe(false)
      await expect(connection.invokeQuery({ capabilityId: 'world.failure.query', input: {} })).rejects.toThrow('missed committed state')
      await expect(peerConfig!.queries!.invoke({ capabilityId: 'world.failure.query', input: {} })).rejects.toThrow('missed committed state')
      await expect(connection.sendCommand(command('world.failure.command'))).rejects.toThrow('missed committed state')
      await expect(connection.setClock({ currentTime: '2026-01-01T00:00:00Z' as IsoTimestamp, updatedAt: '2026-01-01T00:00:00Z' as IsoTimestamp, paused: true })).rejects.toThrow('missed committed state')
      expect(connection.health?.()[0]?.state).toBe('failed')
    } finally { errors.mockRestore(); await connection.close() }
  })

  test('reconciliation failure cannot be cleared by later observations or clock success', async () => {
    let attempts = 0
    const adapter = withConnection(createStubAdapter('failure.runtime', 'failure', 'world.failure.command'), base => ({
      ...base, afterCommittedEvents: async () => { attempts++; throw new Error('reconciliation failed') },
    }))
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))
    try {
      await connection.observeCommittedEvents([committedUpsert(testObject('failure', 2), 1)])
      await connection.observeCommittedEvents([])
      expect(attempts).toBe(1)
      expect(connection.health?.()[0]).toMatchObject({ state: 'failed', lastFailure: { operation: 'after-committed-events' } })
      await expect(connection.checkpoint!()).rejects.toThrow('missed committed state')
    } finally { errors.mockRestore(); await connection.close() }
  })

  test('validates every owned mutation target in order without blocking cross-Pack signals', async () => {
    const adapter = createStubAdapter('owner.runtime', 'owner', 'world.owner.command')
    const connection = await createRuntimeHub([adapter]).connect(connectionConfig([adapter.id]))
    const received: PackRuntimeEmission[] = []
    connection.subscribe(emission => received.push(emission))
    const foreign = testObject('foreign')
    const own = testObject('owner')
    const at = '2026-01-01T00:00:00Z' as IsoTimestamp
    const base = { at, provenance: { source: 'simulator' as const }, history: 'snapshot-only' as const }
    const emit = (events: PackRuntimeEmission['events']) => adapter.emit({ type: 'event.emission', runtimeId: adapter.id, emittedAt: at, events })
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await connection.observeCommittedEvents([committedUpsert(foreign, 1)])
      emit([{ ...base, type: 'object.deleted', objectId: foreign.id }])
      emit([{ ...base, type: 'telemetry.sampled', objectId: foreign.id, telemetry: { signals: {} } }])
      emit([{ ...base, type: 'object.upserted', object: { ...own, id: foreign.id } }])
      emit([{ ...base, type: 'object.deleted', objectId: own.id }])
      expect(received).toHaveLength(0)
      expect(connection.health?.()[0]).toMatchObject({ state: 'degraded', failureCount: 4, lastFailure: { operation: 'emission' } })
      emit([{ ...base, type: 'object.upserted', object: own }, { ...base, type: 'telemetry.sampled', objectId: own.id, telemetry: { signals: {} } }, { ...base, type: 'object.deleted', objectId: own.id }])
      expect(received).toHaveLength(1)
      emit([{ ...base, type: 'telemetry.sampled', objectId: own.id, telemetry: { signals: {} } }])
      expect(received).toHaveLength(2)
      emit([{ ...base, type: 'interaction.signal', signal: {
        id: 'signal:test' as import('../src/core/model/index.ts').SignalId, simulationRunId: 'run-test' as SimulationRunId,
        at, type: 'test', source: { kind: 'object', id: own.id }, targets: [{ kind: 'object', id: foreign.id }], payload: {},
      } }])
      expect(received).toHaveLength(3)
    } finally { errors.mockRestore(); await connection.close() }
  })

  test('derived emissions can commit back through the hub without a reconciliation self-loop', async () => {
    const provider = createStubAdapter('source.runtime', 'source', 'world.source.command')
    const baseConsumer = createStubAdapter('derived.runtime', 'derived', 'world.derived.command')
    let afterCalls = 0
    let emissions = 0
    const consumer = withConnection(baseConsumer, base => ({ ...base, afterCommittedEvents: async events => {
      afterCalls++
      if (!events.some(event => event.type === 'object.upserted' && event.object.packId === 'source')) return
      baseConsumer.emit({ type: 'event.emission', runtimeId: baseConsumer.id, emittedAt: '2026-01-01T00:00:00Z' as IsoTimestamp,
        events: [{ type: 'object.upserted', object: testObject('derived'), at: '2026-01-01T00:00:00Z' as IsoTimestamp, history: 'snapshot-only', provenance: { source: 'simulator' } }] })
    } }))
    const connection = await createRuntimeHub([consumer, provider]).connect(connectionConfig([consumer.id, provider.id]))
    const feedback: Promise<void>[] = []
    const unsubscribe = connection.subscribe(emission => {
      emissions++
      if (emissions > 1) throw new Error('Derived emission loop')
      feedback.push(connection.observeCommittedEvents(emission.events.flatMap(event => event.type === 'object.upserted' ? [committedUpsert(event.object, 2)] : [])))
    })
    try {
      await connection.observeCommittedEvents([committedUpsert(testObject('source'), 1)])
      await Promise.all(feedback)
      expect(emissions).toBe(1)
      expect(afterCalls).toBe(2)
      expect(connection.health?.().every(entry => entry.state === 'ready')).toBe(true)
    } finally { unsubscribe(); await connection.close() }
  })
})
