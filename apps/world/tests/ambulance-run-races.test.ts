import { expect, test } from 'bun:test'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import type { CommandResult, InteractionHandler, ObjectId, SimulationRunEvent, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, nowIso } from '../src/core/model/time.ts'
import { createSimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { createSimulationRunStateStore, type SimulationRunStateSnapshot } from '../src/core/simulation-runs/state-store.ts'
import type { EventLog } from '../src/core/simulation-runs/event-log.ts'
import { createLocalAmbulancePackRuntimeAdapter } from '../src/packs/ambulance/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { RoutingAdapter } from '../src/routing/protocol.ts'
import { worldCoreCapabilities } from '../src/simulation/core-capabilities.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import { testScenarioRuntimeConfig } from './helpers.ts'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const actor: Actor = { id: 'actor:run-race-test' as Actor['id'], label: 'Test operator', role: 'operator' }
const unitId = 'amb:a12' as ObjectId
const incidentId = 'incident:torshov-partial' as ObjectId
const patientId = 'patient:torshov-partial:1' as ObjectId

/** Only persistence and routing latency are controlled test doubles. The Run,
 * Hub, Ambulance adapter/engine and capability dispatch path are real. */
const setup = async (options: {
  readonly beforeAppend?: (events: readonly SimulationRunEvent[]) => Promise<void>
  readonly routing?: RoutingAdapter
  readonly onDispatchResult?: (result: CommandResult) => void
  readonly interactionHandlers?: readonly InteractionHandler[]
  readonly beforeCheckpoint?: () => Promise<void>
} = {}) => {
  const id = 'run-ambulance-publication-race' as SimulationRunId
  const sourceScenario = testScenarioRuntimeConfig()
  const scenario = { ...sourceScenario, runtimeIds: ['ambulance.local'], initialObjects: sourceScenario.initialObjects.filter(object => object.packId === 'ambulance'), runtimeConfigByRuntimeId: { 'ambulance.local': {} } }
  const stateStore = createSimulationRunStateStore()
  const runClock = createSimulationClock({ currentTime: scenario.world.startsAt, updatedAt: nowIso(), paused: true })
  const restoredSnapshot: SimulationRunStateSnapshot = { objects: scenario.initialObjects, seq: 0, clock: runClock.read(), scenario: { scenarioId: scenario.scenarioId, agentRestrictions: { operationIds: [], objects: [], revision: 0 }, highlightedObjectIds: [] } }
  stateStore.hydrate(restoredSnapshot)
  const actual = createLocalAmbulancePackRuntimeAdapter({ routing: options.routing ?? createDirectRoutingAdapter() })
  const adapter = { ...actual, connect: async (config: Parameters<typeof actual.connect>[0]) => {
    const connection = await actual.connect(config)
    return { ...connection, checkpoint: async () => { await options.beforeCheckpoint?.(); await connection.checkpoint!() }, sendCommand: async (command: Parameters<typeof connection.sendCommand>[0]) => {
      const result = await connection.sendCommand(command)
      if (command.kind === 'world.ambulance.assign') options.onDispatchResult?.(result)
      return result
    } }
  } }
  let privateState: unknown | null = null
  const connection = await createRuntimeHub([adapter]).connect({ simulationRunId: id, scenario, initialObjects: restoredSnapshot.objects, runClock, objectById: stateStore.getObject,
    runtimeStateStores: { [adapter.id]: { load: async () => privateState, save: async value => { privateState = structuredClone(value) } } },
  })
  const persisted: SimulationRunEvent[] = []
  let saved: SimulationRunStateSnapshot | null = null
  const eventLog: EventLog = {
    appendMany: async events => { await options.beforeAppend?.(events); persisted.push(...events) },
    readAll: async () => persisted,
    readAfter: async seq => persisted.filter(event => event.seq > seq),
    readLast: async () => persisted.at(-1) ?? null,
    readLastSeq: async () => persisted.at(-1)?.seq ?? 0,
    sizeBytes: async () => JSON.stringify(persisted).length,
  }
  const run = await createSimulationRunRuntime({
    id, runtimeConnection: connection, stateStore, runClock, restoredSnapshot, eventLog,
    runtimeStateLoaders: { [adapter.id]: async () => privateState },
    snapshotStore: { load: async () => saved, save: async snapshot => { saved = snapshot }, quarantine: async () => {} },
    scenario: { id: scenario.scenarioId, startsAt: scenario.world.startsAt, agentRestrictions: { operationIds: [], objects: [] } },
    runtimeCapabilities: [
      ...adapter.capabilities.map(capability => ({ packId: adapter.packId, runtimeId: adapter.id, capability })),
      ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
    ],
    ...(options.interactionHandlers ? { interactionHandlers: options.interactionHandlers } : {}),
  })
  return { run, stateStore, persisted }
}
const dispatch = (run: Awaited<ReturnType<typeof setup>>['run']) => run.invokeCapability(actor, {
  capabilityId: 'world.ambulance.assign', input: { unitId, incidentId, patientIds: [patientId] },
})

test('free unit deletion becomes authoritative before journal completion; late route cannot resurrect it', async () => {
  const routeEntered = deferred(), releaseRoute = deferred(), deleteApplied = deferred(), releaseJournal = deferred(), routeReturned = deferred()
  let dispatchResult: CommandResult | undefined
  const direct = createDirectRoutingAdapter()
  const { run, stateStore, persisted } = await setup({
    routing: { id: 'test-delayed-routing', route: async request => { routeEntered.resolve(); await releaseRoute.promise; return direct.route(request) } },
    beforeAppend: async events => { if (events.some(event => event.type === 'object.deleted' && event.objectId === unitId)) { deleteApplied.resolve(); await releaseJournal.promise } },
    onDispatchResult: result => { dispatchResult = result; routeReturned.resolve() },
  })
  try {
    const pendingDispatch = dispatch(run)
    await routeEntered.promise
    const pendingDelete = run.invokeCapability(actor, { capabilityId: 'world.object.delete', input: { objectId: unitId } })
    await deleteApplied.promise
    expect(stateStore.getObject(unitId)).toBeUndefined()
    // Admission invalidates the route now; public state waits for the journal.
    expect(run.snapshot().objects.some(object => object.id === unitId)).toBe(true)
    // Hub has not observed deletion: the journal flush is still gated.
    releaseRoute.resolve()
    await routeReturned.promise
    expect(dispatchResult?.ok).toBe(false)
    if (dispatchResult?.ok === false) expect(dispatchResult.reason).toContain('Canonical object changed')
    releaseJournal.resolve()
    const deletion = await pendingDelete
    expect(deletion.kind === 'command' && deletion.result.ok).toBe(true)
    const response = await pendingDispatch
    expect(response.kind === 'command' && response.result.ok).toBe(false)
    expect(run.snapshot().objects.some(object => object.id === unitId)).toBe(false)
    const deletedIndex = persisted.findIndex(event => event.type === 'object.deleted' && event.objectId === unitId)
    expect(persisted.slice(deletedIndex + 1).some(event => event.type === 'object.upserted' && event.object.id === unitId)).toBe(false)
  } finally { releaseRoute.resolve(); releaseJournal.resolve(); await run.close() }
})

test('occupied-holder deletion rejects its entire interaction effect batch before any object changes', async () => {
  const handler: InteractionHandler = {
    id: 'test-delete-occupied-batch', priority: 0, accepts: signal => signal.type === 'test.delete-occupied-batch',
    handle: async ({ snapshot }) => {
      const freeUnit = snapshot.objects.find(object => object.id === unitId)!
      return [
        { type: 'object.upsert', object: { ...freeUnit, revision: freeUnit.revision + 1, label: 'This change must not commit' } },
        { type: 'object.delete', objectId: incidentId },
      ]
    },
  }
  const { run, persisted } = await setup({ interactionHandlers: [handler] })
  try {
    const before = run.snapshot().objects
    await expect(run.publishInteractionSignal({
      id: 'signal:test-delete-batch' as never, simulationRunId: run.id, at: nowIso(), source: { kind: 'actor', id: actor.id }, targets: [], type: 'test.delete-occupied-batch', payload: {},
    }, { source: 'operator' })).rejects.toThrow('patient')
    expect(run.snapshot().objects).toEqual(before)
    expect(persisted.some(event => event.type === 'object.deleted' || event.type === 'object.upserted')).toBe(false)
    expect((await dispatch(run)).kind).toBe('command')
  } finally { await run.close() }
})

test('copy rejects an installed Ambulance command awaiting routing without pausing or blocking deletion', async () => {
  const routeEntered = deferred(), releaseRoute = deferred()
  const direct = createDirectRoutingAdapter()
  const { run } = await setup({ routing: { id: 'test-copy-delayed-route', route: async request => {
    routeEntered.resolve(); await releaseRoute.promise; return direct.route(request)
  } } })
  try {
    const pending = dispatch(run)
    await routeEntered.promise
    const before = run.snapshot()
    await expect(run.checkpointForCopy()).rejects.toMatchObject({ code: 'simulation_run_busy' })
    expect(run.snapshot()).toMatchObject({ objects: before.objects, seq: before.seq,
      clock: { paused: before.clock!.paused, currentTime: before.clock!.currentTime } })
    expect(await run.invokeCapability(actor, { capabilityId: 'world.object.delete', input: { objectId: unitId } })).toMatchObject({ result: { ok: true } })
    releaseRoute.resolve()
    expect(await pending).toMatchObject({ result: { ok: false } })
    const checkpoint = await run.checkpointForCopy()
    expect(checkpoint.snapshot.objects.some(object => object.id === unitId)).toBe(false)
    expect(checkpoint.runtimeStates['ambulance.local']).toBeDefined()
  } finally { releaseRoute.resolve(); await run.close() }
})

test('copy admission fences a later installed Ambulance command throughout private checkpoint capture', async () => {
  const checkpointEntered = deferred(), releaseCheckpoint = deferred()
  let routeCalls = 0
  const direct = createDirectRoutingAdapter()
  const { run } = await setup({
    beforeCheckpoint: async () => { checkpointEntered.resolve(); await releaseCheckpoint.promise },
    routing: { id: 'test-copy-route', route: async request => { routeCalls++; return direct.route(request) } },
  })
  try {
    const before = run.snapshot()
    const copying = run.checkpointForCopy()
    await checkpointEntered.promise
    const pending = dispatch(run)
    await Promise.resolve(); await Promise.resolve()
    expect(routeCalls).toBe(0)
    releaseCheckpoint.resolve()
    const copied = await copying
    expect(copied.snapshot.objects).toEqual(before.objects)
    expect(copied.runtimeStates['ambulance.local']).toBeDefined()
    expect(await pending).toMatchObject({ result: { ok: true } })
    expect(routeCalls).toBeGreaterThan(0)
    const after = await run.checkpointForCopy()
    expect(after.snapshot.objects.find(object => object.id === unitId)?.revision).toBeGreaterThan(before.objects.find(object => object.id === unitId)!.revision)
  } finally { releaseCheckpoint.resolve(); await run.close() }
})
