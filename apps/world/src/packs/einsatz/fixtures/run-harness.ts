import type { CommandResult, IsoTimestamp, OperationalObject, ScenarioTimeline, SimulationRunEvent, SimulationRunId } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import { compileScenarioDefinition } from '../../../core/scenarios/compiler.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import type { EventLog } from '../../../core/simulation-runs/event-log.ts'
import { createSimulationRunRuntime, type SimulationRunRuntime } from '../../../core/simulation-runs/runtime.ts'
import { createSimulationRunStateStore, type SimulationRunStateSnapshot } from '../../../core/simulation-runs/state-store.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { worldCoreCapabilities } from '../../../simulation/core-capabilities.ts'
import type { PackRuntimeConnection } from '../../../simulation/protocol.ts'
import { createRuntimeHub } from '../../../simulation/runtime-hub.ts'
import { einsatzDataSchema, type TaskData, type UnitData } from '../engine/model.ts'
import { einsatzPackId, einsatzRuntimeId } from '../ids.ts'
import { einsatzPack } from '../pack.ts'
import { refusalCode, type EinsatzRefusalCode } from '../refusal.ts'
import { createEinsatzPackRuntimeAdapter } from '../runtime/adapter.ts'
import fixture from './engine.config.json'
import { start } from './engine-harness.ts'

/**
 * Test-only harness for Einsatz on a real Simulation Run: a Scenario
 * Definition with an Einsatz Pack Selection is compiled, its runtime runs
 * behind the Runtime Hub, and calls go through the Run's Capability path.
 * Only persistence is in memory, and the Run clock reads a monotonic source
 * the test moves, so a running clock is deterministic. Production code never
 * imports this file.
 */

export interface UnitItem { readonly type: 'unit'; readonly id: string; readonly label: string; readonly unitType: string; readonly position: readonly [number, number]; readonly [key: string]: unknown }
export interface TaskItem { readonly type: 'task'; readonly id: string; readonly label: string; readonly template: string; readonly position: readonly [number, number]; readonly [key: string]: unknown }

export const lonLat = (east: number, north = 0): [number, number] => [11 + east, 59 + north]
export const unitItem = (id: string, unitType: string, position: readonly [number, number], extra: Record<string, unknown> = {}): UnitItem =>
  ({ type: 'unit', id, label: id.toUpperCase(), unitType, position, ...extra })
export const taskItem = (id: string, template: string, position: readonly [number, number], loads?: Readonly<Record<string, number>>): TaskItem =>
  ({ type: 'task', id, label: id.toUpperCase(), template, position, ...(loads === undefined ? {} : { loads }) })

export const definitionOf = (items: ReadonlyArray<UnitItem | TaskItem>, timeline?: ScenarioTimeline) => ({
  id: 'einsatz-open-run',
  title: 'Einsatz open run',
  packs: [{ id: einsatzPackId, config: fixture, items }],
  world: { startsAt: new Date(start).toISOString(), environment: {} },
  view: { map: { center: lonLat(0), zoom: 12 } },
  ...(timeline === undefined ? {} : { timeline }),
})

export const operator: Actor = { id: 'actor:operator' as Actor['id'], label: 'actor:operator', role: 'operator' }

const memoryEventLog = (events: SimulationRunEvent[]): EventLog => ({
  appendMany: async batch => { events.push(...batch) },
  readAll: async () => events,
  readAfter: async seq => events.filter(event => event.seq > seq),
  readLast: async () => events.at(-1) ?? null,
  readLastSeq: async () => events.at(-1)?.seq ?? 0,
  sizeBytes: async () => JSON.stringify(events).length,
})

export interface RestorePoint {
  readonly snapshot: SimulationRunStateSnapshot
  readonly runtimeState: unknown
}

export interface OpenRun {
  readonly run: SimulationRunRuntime
  readonly connection: PackRuntimeConnection
  readonly journal: ReadonlyArray<SimulationRunEvent>
  /** Moves the running Run clock forward by this many simulated milliseconds. */
  readonly forward: (ms: number) => void
  /** Brings the runtime to the Run clock and waits until the Run has published what changed. */
  readonly settle: () => Promise<void>
  readonly invoke: (capabilityId: string, input: unknown, actor?: Actor) => Promise<CommandResult>
  readonly refusal: (capabilityId: string, input: unknown) => Promise<{ readonly code: EinsatzRefusalCode; readonly reason: string }>
  readonly query: <T>(capabilityId: string, input: unknown) => Promise<T>
  readonly object: (id: string) => OperationalObject | undefined
  readonly unit: (id: string) => UnitData
  readonly task: (id: string) => TaskData
  readonly nowMs: () => number
  readonly runtimeState: () => unknown
  readonly close: () => Promise<void>
}

/** A Run of the Einsatz engine fixture configuration with these items: running unless `paused`, or restored from a checkpoint. */
export const openRun = async (options: {
  readonly items: ReadonlyArray<UnitItem | TaskItem>
  readonly timeline?: ScenarioTimeline
  readonly paused?: boolean
  readonly routing?: RoutingAdapter
  readonly restore?: RestorePoint
}): Promise<OpenRun> => {
  const direct = createDirectRoutingAdapter()
  const compiled = await compileScenarioDefinition(definitionOf(options.items, options.timeline), [einsatzPack], { routing: direct })
  const adapter = createEinsatzPackRuntimeAdapter({ routing: options.routing ?? direct })
  let monotonicMs = 0
  const runClock = createSimulationClock(
    options.restore?.snapshot.clock ?? { currentTime: compiled.world.startsAt, updatedAt: nowIso(), paused: false },
    { wallMs: () => Date.now(), monotonicMs: () => monotonicMs },
  )
  let saved: unknown = options.restore === undefined ? null : structuredClone(options.restore.runtimeState)
  const stateStore = createSimulationRunStateStore()
  stateStore.hydrate(options.restore?.snapshot ?? { objects: compiled.initialObjects, seq: 0 })
  const simulationRunId = 'run-einsatz-open' as SimulationRunId
  const connection = await createRuntimeHub([adapter]).connect({
    simulationRunId,
    runClock,
    objectById: stateStore.getObject,
    scenario: {
      scenarioId: compiled.id,
      runtimeIds: [einsatzRuntimeId],
      world: compiled.world,
      initialObjects: compiled.initialObjects,
      connections: [],
      runtimeConfigByRuntimeId: { [einsatzRuntimeId]: compiled.packConfigs[einsatzPackId] },
      runtimeConfig: {},
    },
    runtimeStateStores: { [einsatzRuntimeId]: { load: async () => saved, save: async value => { saved = structuredClone(value) } } },
    ...(options.restore === undefined ? {} : { initialObjects: options.restore.snapshot.objects }),
  })
  const journal: SimulationRunEvent[] = []
  let snapshot: SimulationRunStateSnapshot | null = null
  const run = await createSimulationRunRuntime({
    id: simulationRunId,
    runtimeConnection: connection,
    stateStore,
    runClock,
    eventLog: memoryEventLog(journal),
    snapshotStore: { load: async () => snapshot, save: async next => { snapshot = next }, quarantine: async () => undefined },
    scenario: {
      id: compiled.id,
      startsAt: compiled.world.startsAt,
      agentRestrictions: compiled.agentRestrictions,
      ...(compiled.timeline === undefined ? {} : { timeline: compiled.timeline }),
    },
    runtimeCapabilities: [
      ...adapter.capabilities.map(capability => ({ packId: einsatzPackId, runtimeId: einsatzRuntimeId, capability })),
      ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
    ],
    runtimeStateLoaders: { [einsatzRuntimeId]: async () => saved },
    ...(options.restore === undefined ? {} : { restoredSnapshot: options.restore.snapshot }),
  })
  // A new Run starts with its clock running; a paused test Run stops it at the start.
  if (options.paused === true && options.restore === undefined) await run.setClock({ paused: true })
  const object = (id: string) => run.snapshot().objects.find(entry => entry.id === id)
  const dataOf = (id: string) => {
    const found = object(id)
    if (found === undefined) throw new Error(`${id} is not in the Run`)
    return einsatzDataSchema.parse(found.packData)
  }
  const invoke = async (capabilityId: string, input: unknown, actor: Actor = operator): Promise<CommandResult> => {
    const outcome = await run.invokeCapability(actor, { capabilityId, input })
    if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
    return outcome.result
  }
  return {
    run,
    connection,
    journal,
    forward: ms => { monotonicMs += ms },
    settle: async () => { await run.setClock({}) },
    invoke,
    refusal: async (capabilityId, input) => {
      const result = await invoke(capabilityId, input)
      if (result.ok) throw new Error(`Expected ${capabilityId} to be refused`)
      return { code: refusalCode(result.reason), reason: result.reason }
    },
    query: async <T>(capabilityId: string, input: unknown): Promise<T> => {
      const outcome = await run.invokeCapability(operator, { capabilityId, input })
      if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
      return outcome.result as T
    },
    object,
    unit: id => {
      const data = dataOf(id)
      if (data.type !== 'unit') throw new Error(`${id} is not a unit`)
      return data
    },
    task: id => {
      const data = dataOf(id)
      if (data.type !== 'task') throw new Error(`${id} is not a task`)
      return data
    },
    nowMs: () => Date.parse(runClock.read().currentTime),
    runtimeState: () => saved,
    close: async () => { await run.close() },
  }
}

export const isoAt = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp
