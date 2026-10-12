import { nowIso, type CommandEnvelope, type CommandResult, type GeoJsonPoint, type IsoTimestamp, type ObjectId, type OperationalObject, type Provenance } from '../../../core/model/index.ts'
import { defaultSimulationRunRuntimePolicy } from '../../../core/simulation-runs/runtime-persistence-policy.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import type { PackRuntimeAdapter, PackRuntimeConnection, PackRuntimeConnectionConfig, PackRuntimeEvent, PackRuntimeEventHandler, PackRuntimeHealth } from '../../../simulation/protocol.ts'
import { createRuntimeStateWriter } from '../../../simulation/runtime-state-writer.ts'
import { einsatzCapabilities, einsatzQueryIds, isEinsatzCommand, recommendInputSchema } from '../capabilities.ts'
import { payloadIssue, prepareCommand } from '../commands.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { advanceEngine, commitIntent, planIntent, prepareLegs, type EnginePorts } from '../engine/engine.ts'
import { loadedText } from '../engine/intent-support.ts'
import { motionOf, type EngineState, type Transition } from '../engine/model.ts'
import { readEngineState, runtimeStateOf, transitionObject, unitObject, type ObjectStamp } from '../engine/objects.ts'
import { hasLoad } from '../engine/rules.ts'
import { recommend } from '../recommend.ts'
import { refusal } from '../refusal.ts'
import { resolveViewer } from '../viewer.ts'
import { removeRecords } from './removal.ts'
import { einsatzAdapterId, einsatzPackId, einsatzRuntimeId } from '../ids.ts'
import { savedStateSchema, type SavedState } from './saved-state.ts'

/**
 * The Einsatz Pack runtime. One queue serializes commands, clock changes and
 * ticks, so the engine state changes in one place at a time; queries read
 * the current engine state outside it. Canonical objects change only on
 * transitions (`record`); positions and route progress between them are
 * `snapshot-only`. A refused command or a standing order that cannot be
 * carried out is never a runtime failure: only a fault in advancing the
 * engine fails it.
 */

/** Wall-time cadence at which positions follow the Run clock between explicit advances. */
const tickIntervalMs = 1_000
/** How often one command plans and routes again when the Run deleted a record it involved while it was routing. */
const routingAttempts = 3

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const samePoint = (a: GeoJsonPoint, b: GeoJsonPoint): boolean => a.coordinates[0] === b.coordinates[0] && a.coordinates[1] === b.coordinates[1]

const connectEinsatz = async (config: PackRuntimeConnectionConfig, routing: RoutingAdapter): Promise<PackRuntimeConnection> => {
  const runClock = config.runClock
  if (runClock === undefined) throw new Error('The Einsatz runtime runs only on its Run clock')
  const clockMs = (): number => Date.parse(runClock.read().currentTime)
  const store = config.runtimeStateStore
  const raw = await store?.load() ?? null
  if (config.initialObjects !== undefined && store !== undefined && raw === null) {
    throw new Error('Einsatz runtime state is missing on a restored Run; leg progress cannot be reconstructed')
  }
  const saved = raw === null ? null : savedStateSchema.parse(raw)
  const revision = saved?.revision ?? 0
  const engineConfig = saved?.config ?? einsatzConfigSchema.parse(config.scenario.runtimeConfig)
  let serials = saved?.serials ?? { unit: 1, task: 1 }
  const objects = (config.initialObjects ?? config.scenario.initialObjects).filter(object => object.packId === einsatzPackId)
  let current: EngineState = readEngineState({
    config: engineConfig,
    sides: [],
    objects,
    runtime: saved?.engine ?? { timeMs: clockMs(), units: {} },
  })
  const ports: EnginePorts = { routing }

  /** The object last published for each record, and where each unit was then. */
  const published = new Map<string, OperationalObject>(objects.map(object => [object.id, object]))
  const publishedMotion = new Map([...current.motion].map(([id, motion]) => [id, { point: motion.point, progressMs: motion.progressMs }]))
  /** Records the Run has held, so one it no longer holds was deleted rather than not yet committed. */
  const heldByRun = new Set<string>()
  const deletedByRun = new Set<string>()

  const handlers = new Set<PackRuntimeEventHandler>()
  let closed = false
  let health: PackRuntimeHealth = { runtimeId: einsatzRuntimeId, state: 'ready', failureCount: 0, lastSuccessfulInteractionAt: nowIso() }
  const unavailable = (): boolean => closed || health.state === 'failed'
  const fault = (operation: string, error: unknown, state: 'degraded' | 'failed'): void => {
    if (closed || health.state === 'failed') return
    health = { ...health, state, failureCount: health.failureCount + 1, lastFailure: { at: nowIso(), operation, message: message(error) } }
  }
  const succeeded = (): void => {
    health = { ...health, ...(health.state === 'degraded' ? { state: 'ready' as const } : {}), lastSuccessfulInteractionAt: nowIso() }
  }

  const savedState = (): SavedState => ({ revision, config: current.catalog.config, serials, engine: runtimeStateOf(current) })
  const persistence = createRuntimeStateWriter({
    ...(store === undefined ? {} : { store }),
    readState: savedState,
    delayMs: defaultSimulationRunRuntimePolicy.runtimePrivateStateFlushIntervalMs,
    label: 'einsatz',
    onError: error => fault('save-runtime-state', error, 'degraded'),
  })
  if (saved === null) await persistence.saveNow()

  const stamp = (id: string, at: IsoTimestamp, commandId: CommandEnvelope['id'] | undefined): ObjectStamp => {
    const provenance: Provenance = commandId === undefined
      ? { source: 'simulator', adapterId: einsatzAdapterId, externalId: id }
      : { source: 'operator', adapterId: einsatzAdapterId, externalId: id, causedByCommandId: commandId }
    const previous = published.get(id)
    return { at, provenance, ...(previous === undefined ? {} : { previous }) }
  }

  /** Publishes each transition as a durable object, then every unit that moved since it was last published. */
  const publish = (state: EngineState, transitions: ReadonlyArray<Transition>, commandId?: CommandEnvelope['id']): void => {
    const at = nowIso()
    const events: PackRuntimeEvent[] = []
    const upsert = (object: OperationalObject, history: 'record' | 'snapshot-only'): void => {
      published.set(object.id, object)
      events.push({ type: 'object.upserted', object, at, history, provenance: object.provenance })
    }
    for (const transition of transitions) {
      upsert(transitionObject(state, transition, stamp(transition.record.id, at, commandId)), 'record')
      if (transition.kind === 'unit') publishedMotion.set(transition.record.id, { point: transition.point, progressMs: transition.progressMs })
    }
    for (const unit of state.units.values()) {
      const motion = motionOf(state, unit.id)
      const last = publishedMotion.get(unit.id)
      if (last !== undefined && samePoint(last.point, motion.point) && last.progressMs === motion.progressMs) continue
      upsert(unitObject(state, unit, motion, stamp(unit.id, at, commandId)), 'snapshot-only')
      publishedMotion.set(unit.id, { point: motion.point, progressMs: motion.progressMs })
    }
    if (events.length === 0) return
    for (const handler of handlers) handler({ type: 'event.emission', events, emittedAt: at, runtimeId: einsatzRuntimeId })
  }

  /** Records the Run no longer holds: deletions it committed, seen through its projection or its committed events. */
  const deletedRecords = (state: EngineState): ReadonlySet<string> => {
    const deleted = new Set<string>()
    for (const id of [...state.units.keys(), ...state.tasks.keys()]) {
      if (deletedByRun.has(id)) deleted.add(id)
      else if (config.objectById !== undefined) {
        if (config.objectById(id as ObjectId) !== undefined) heldByRun.add(id)
        else if (heldByRun.has(id)) deleted.add(id)
      }
    }
    return deleted
  }
  const withoutDeleted = (state: EngineState): { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition>; readonly deleted: ReadonlySet<string> } => {
    const deleted = deletedRecords(state)
    return deleted.size === 0 ? { state, transitions: [], deleted } : { ...removeRecords(state, deleted), deleted }
  }

  /** Makes a state current: drops what the Run deleted meanwhile, publishes the change and schedules a save. */
  const commit = (next: EngineState, transitions: ReadonlyArray<Transition>, commandId?: CommandEnvelope['id']): void => {
    const pruned = withoutDeleted(next)
    if (next === current && transitions.length === 0 && pruned.deleted.size === 0) return
    for (const id of pruned.deleted) {
      published.delete(id)
      publishedMotion.delete(id)
      deletedByRun.delete(id)
    }
    current = pruned.state
    publish(current, [...transitions.filter(transition => !pruned.deleted.has(transition.record.id)), ...pruned.transitions], commandId)
    persistence.scheduleSave()
  }

  const advance = async (targetMs: number): Promise<void> => {
    if (unavailable()) return
    try {
      if (targetMs <= current.timeMs) {
        commit(current, [])
        return
      }
      const outcome = await advanceEngine(current, targetMs, ports)
      commit(outcome.state, outcome.transitions)
      succeeded()
    } catch (error) {
      fault('advance', error, 'failed')
      throw error
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    // Each caller observes its own rejection; one failure must not poison later work.
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** An id of this kind no object of the Run holds, from the kind's next serial on. */
  const freshId = (kind: 'unit' | 'task'): { readonly id: string; readonly serials: typeof serials } => {
    for (let number = serials[kind]; ; number++) {
      const id = `${kind}:${number}`
      const taken = current.units.has(id) || current.tasks.has(id) || config.objectById?.(id as ObjectId) !== undefined
      if (!taken) return { id, serials: { ...serials, [kind]: number + 1 } }
    }
  }

  const runCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
    const refused = (reason: string): CommandResult => ({ ok: false, commandId: command.id, rejectedAt: nowIso(), reason })
    if (unavailable()) return refused('The Einsatz runtime is unavailable; inspect runtime health')
    if (!isEinsatzCommand(command.kind)) return refused(`Einsatz does not accept ${command.kind}`)
    try { await advance(clockMs()) } catch (error) { return refused(message(error)) }
    try {
      const viewer = resolveViewer(command)
      for (let attempt = 0; attempt < routingAttempts; attempt++) {
        commit(current, [])
        const base = current
        let nextSerials = serials
        const prepared = prepareCommand({
          state: base, viewer, by: command.actorId,
          newId: kind => {
            const fresh = freshId(kind)
            nextSerials = fresh.serials
            return fresh.id
          },
        }, command.kind, command.payload)
        if (!prepared.ok) return refused(prepared.reason)
        const plan = planIntent(base, prepared.intent, prepared.actor)
        if (!plan.ok) return refused(plan.reason)
        const legs = await prepareLegs(base, plan.routes, routing)
        if (!legs.ok) return refused(legs.reason)
        commit(current, [])
        if (current !== base) continue
        const outcome = commitIntent(base, prepared.intent, prepared.actor, legs.legs)
        if (!outcome.ok) return refused(outcome.reason)
        const settled = await advanceEngine(outcome.state, outcome.state.timeMs, ports)
        serials = nextSerials
        commit(settled.state, [...outcome.transitions, ...settled.transitions], command.id)
        succeeded()
        return { ok: true, commandId: command.id, acceptedAt: nowIso() }
      }
      return refused(`The Run deleted records this command involved while it was routing, ${routingAttempts} times; send it again`)
    } catch (error) {
      return refused(payloadIssue(error) ?? message(error))
    }
  }

  let tickPending = false
  const interval = setInterval(() => {
    if (unavailable() || tickPending) return
    tickPending = true
    void serialize(() => advance(clockMs())).catch(() => undefined).finally(() => { tickPending = false })
  }, tickIntervalMs)

  return {
    getSnapshot: async () => ({ simulationRunId: config.simulationRunId, objects: [...published.values()], capturedAt: nowIso() }),
    subscribe: handler => {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    sendCommand: command => serialize(() => runCommand(command)),
    invokeQuery: async query => {
      if (unavailable()) throw new Error('The Einsatz runtime is unavailable; inspect runtime health')
      const viewer = resolveViewer({})
      if (query.capabilityId === einsatzQueryIds.recommend) {
        const input = recommendInputSchema.parse(query.input)
        return await recommend({ state: withoutDeleted(current).state, viewer, taskId: input.taskId, routing })
      }
      if (query.capabilityId === einsatzQueryIds.configuration) return { revision, config: current.catalog.config }
      throw new Error(`Einsatz does not answer ${query.capabilityId}`)
    },
    validateObjectDeletion: objectId => {
      const unit = current.units.get(objectId)
      if (unit !== undefined && hasLoad(unit)) throw new Error(refusal('unit_loaded', loadedText(current, unit)))
    },
    observeCommittedEvents: async events => {
      for (const event of events) {
        if (event.type === 'object.deleted' && (current.units.has(event.objectId) || current.tasks.has(event.objectId))) deletedByRun.add(event.objectId)
        if (event.type === 'object.upserted' && event.object.packId === einsatzPackId) heldByRun.add(event.object.id)
      }
    },
    setClock: () => serialize(() => advance(clockMs())),
    advanceTo: clock => serialize(() => advance(Date.parse(clock.currentTime))),
    checkpoint: () => serialize(() => persistence.saveNow()),
    health: () => [health],
    close: async () => {
      closed = true
      clearInterval(interval)
      await queue
      await persistence.close()
      handlers.clear()
    },
  }
}

/** The local Einsatz runtime. Road units route through `routing`; recommendations take their ETAs from its table. */
export const createEinsatzPackRuntimeAdapter = (adapterConfig: { readonly routing: RoutingAdapter }): PackRuntimeAdapter => ({
  id: einsatzRuntimeId,
  version: '1.0.0',
  packId: einsatzPackId,
  clock: 'simulation',
  capabilities: einsatzCapabilities,
  connect: async config => await connectEinsatz(config, adapterConfig.routing),
})
