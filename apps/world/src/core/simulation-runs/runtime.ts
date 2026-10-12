import type { WorkspaceId } from '@leitbild/contracts'
import { randomUUID } from 'node:crypto'
import type { RunHistorian } from '../../features/historian/store.ts'
import type { RunHistorianStatus } from '../../features/historian/policy.ts'
import { recordingSeriesQuerySchema, type RecordingPage } from '../model/recording.ts'
import { prepareProcedureCommand } from '../../features/procedures/run-state.ts'
import { createProcedureSourceService,type ProcedureSourceService, type ProcedureEvidenceRequest, type ProcedureEvidence } from '../../features/procedures/source.ts'
import type { PackRuntimeConnection,PackRuntimeEmission,PackRuntimeEvent,PackRuntimeHealth,PackRuntimeRealtimeInput,PackRuntimeRealtimeMessage,SimulationCapability } from '../../simulation/protocol.ts'
import type { AgentRestrictions,RunRoles,CommandEnvelope,CommandResult,EventId,InteractionEffect,InteractionHandler,InteractionSignal,IsoTimestamp,ObjectId,OperationalObject,ProcedureCatalog,ProcedureDocument,ProcedureId,ProcedureSourceId,Provenance,RecordedSample,RecordingProfileDescriptor,RecordingSeriesDescriptor,RecordingSeriesQuery,ScenarioExecutionState,ScenarioRecordingSelection,ScenarioTimeline,ScenarioTimelineAction,ScenarioTimelineCue,SimulationClockState,SimulationClockUpdate,SimulationRunEvent,SimulationRunId } from '../model/index.ts'
import { procedureObservationUpdatedEventSchema, objectIdSchema, actorIdSchema,agentRestrictionsSchema,commandEnvelopeSchema,deleteObjectCommandKind,deleteObjectPayloadSchema,interactionEffectSchema,interactionSignalSchema,notificationIdSchema,nowIso,simulationClockUpdateSchema } from '../model/index.ts'
import { createSimulationClock,type SimulationClock } from '../model/time.ts'
import type { PackWikiRef } from '../packs/protocol.ts'
import type { ScenarioRevisionId } from '../scenarios/library.ts'
import { canIssueCommand,type Actor } from './actors.ts'
import { assertRunCapabilityAllowed,roleGateRefusal } from './role-gates.ts'
import {
  CommandIdempotencyConflictError,
  commandIdempotencyConfigFromEnv,
  createCommandIdempotencyStore,
  issueCommandWithIdempotency,
} from './command-idempotency.ts'
import type { EventLog } from './event-log.ts'
import { persistenceDispositionFor,type SimulationRunEventPersistenceDisposition } from './persistence-policy.ts'
import {
  createSimulationRunRuntimeMetricsRecorder,
  type SimulationRunRuntimeMetricsSnapshot,
} from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import type { SimulationRunSnapshotStore } from './snapshot-store.ts'
import { maximumPaceProgressWallIntervalMs,maximumPaceStepMs,type SimulationRunCopyCheckpoint } from './execution.ts'
import { createSimulationRunStateStore,type SimulationRunStateSnapshot,type SimulationRunStateStore } from './state-store.ts'
import { createScenarioTimelineRunner,dueScenarioTimelineCues,type ScenarioTimelineRunner } from './timeline-runner.ts'

const projectedSnapshotFlushIntervalMs = defaultSimulationRunRuntimePolicy.projectedSnapshotFlushIntervalMs
const scenarioRunnerActor: Actor = {
  id: actorIdSchema.parse('actor:scenario-timeline'),
  label: 'Scenario timeline',
  role: 'system',
}

interface PublishManyOptions {
  readonly history?: SimulationRunEventPersistenceDisposition
  readonly historyForEvent?: (
    event: SimulationRunEvent,
    previousObject: OperationalObject | undefined,
    index: number,
  ) => SimulationRunEventPersistenceDisposition | undefined
}

export interface SimulationRunEventNotification {
  readonly type: 'event.notification'
  readonly events: ReadonlyArray<SimulationRunEvent>
  readonly realtimeMessages?: ReadonlyArray<PackRuntimeRealtimeMessage>
}

export type SimulationRunEventHandler = (event: SimulationRunEventNotification) => void

export interface SimulationRunRuntime {
  readonly id: SimulationRunId
  readonly capabilities: () => SimulationRunCapabilities
  readonly snapshot: () => SimulationRunStateSnapshot
  /** The roles this Run declares, fixed for its lifetime; null in open mode. */
  readonly roles: () => RunRoles | null
  readonly setClock: (update: SimulationClockUpdate) => Promise<SimulationClockState>
  readonly setAgentRestrictions: (actor: Actor, restrictions: AgentRestrictions, expectedRevision: number) => Promise<ScenarioExecutionState['agentRestrictions']>
  readonly checkpointForCopy: () => Promise<SimulationRunCopyCheckpoint>
  readonly runMaximumPace: (targetSimulationTime: IsoTimestamp | null, control: {
    readonly shouldStop: () => boolean
    readonly onProgress?: (currentSimulationTime: IsoTimestamp) => void | Promise<void>
  }) => Promise<{ readonly currentSimulationTime: IsoTimestamp; readonly stoppedEarly: boolean }>
  readonly failStop: (reason: string) => void
  readonly events: (config?: { readonly afterSeq?: number }) => ReadonlyArray<SimulationRunEvent>
  readonly subscribe: (handler: SimulationRunEventHandler) => () => void
  readonly publishResetBoundary: (config: { readonly scenarioId?: string }) => Promise<SimulationRunEvent>
  readonly invokeCapability: (actor: Actor, invocation: SimulationRunCapabilityInvocation) => Promise<SimulationRunCapabilityInvocationResult>
  readonly receiveRealtimeInput: (input: PackRuntimeRealtimeInput) => Promise<void>
  readonly procedureCatalog: (config?: { readonly sourceId?: ProcedureSourceId; readonly refresh?: boolean }) => Promise<ProcedureCatalog>
  readonly procedureDocument: (config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly sourceRevision?: string
    readonly sourcePath?: string
  }) => Promise<ProcedureDocument>
  readonly procedureEvidence: (config: ProcedureEvidenceRequest) => Promise<ProcedureEvidence>
  readonly publishInteractionSignal: (signal: InteractionSignal, provenance: Provenance) => Promise<void>
  readonly metrics: () => SimulationRunRuntimeMetricsSnapshot
  readonly health: () => ReadonlyArray<PackRuntimeHealth>
  readonly recordingStatus: () => RunHistorianStatus | null
  readonly recordingSeries: () => ReadonlyArray<RecordingSeriesDescriptor & { readonly runtimeId: string }>
  readonly recordedSamples: (query: RecordingSeriesQuery) => RecordingPage
  readonly close: () => Promise<void>
}

export interface SimulationRunCapabilityInvocation {
  readonly capabilityId: string
  readonly input: unknown
  readonly expectedRevision?: number
  readonly idempotencyKey?: string
  readonly scheduled?: boolean
  readonly issuedAt?: IsoTimestamp
}

export type SimulationRunCapabilityInvocationResult =
  | { readonly kind: 'query'; readonly result: unknown }
  | { readonly kind: 'command'; readonly result: CommandResult; readonly replayed: boolean }

export interface ActiveSimulationCapability {
  readonly packId: string
  readonly runtimeId: string
  readonly capability: SimulationCapability
}

export interface SimulationRunCapabilities {
  readonly workspaceId: WorkspaceId | null
  readonly simulationRunId: SimulationRunId
  readonly scenarioId: string | null
  readonly scenarioRevisionId: ScenarioRevisionId | null
  readonly activePackIds: ReadonlyArray<string>
  readonly runtimes: ReadonlyArray<{
    readonly id: string
    readonly packId: string
    readonly clock: 'simulation' | 'live' | 'none'
  }>
  readonly capabilities: ReadonlyArray<{
    readonly id: string
    readonly kind: 'command' | 'query'
    readonly title: string
    readonly description: string
    readonly risk: 'read' | 'write' | 'destructive'
    readonly idempotent: boolean
    readonly schedulable?: boolean
    readonly inputSchema: Readonly<Record<string, unknown>>
    readonly outputSchema: Readonly<Record<string, unknown>>
    readonly packId: string
    readonly runtimeId: string
  }>
  readonly wikiRefs: ReadonlyArray<PackWikiRef>
  readonly recording: {
    readonly selections: ReadonlyArray<ScenarioRecordingSelection>
    readonly profiles: ReadonlyArray<RecordingProfileDescriptor & {
      readonly packId: string
      readonly runtimeId: string
    }>
  }
}

const eventId = (): EventId => `event:${randomUUID()}` as EventId

export const createSimulationRunRuntime = async (config: {
  readonly id: SimulationRunId
  readonly runtimeConnection: PackRuntimeConnection
  readonly stateStore?: SimulationRunStateStore
  readonly runClock?: SimulationClock
  readonly eventLog: EventLog
  readonly snapshotStore: SimulationRunSnapshotStore
  readonly interactionHandlers?: ReadonlyArray<InteractionHandler>
  readonly restoredSnapshot?: SimulationRunStateSnapshot
  readonly restoredEvents?: ReadonlyArray<SimulationRunEvent>
  readonly initialSeq?: number
  readonly scenario: {
    readonly id: string
    readonly startsAt: IsoTimestamp
    readonly agentRestrictions: AgentRestrictions
    /** Absent for a Scenario without roles: open mode. */
    readonly roles?: RunRoles
    readonly timeline?: ScenarioTimeline
  }
  readonly capabilities?: Omit<SimulationRunCapabilities, 'simulationRunId'>
  readonly runtimeCapabilities?: ReadonlyArray<ActiveSimulationCapability>
  readonly procedureSourceService?: ProcedureSourceService
  /** Wall-time transport health bound; never a physical qualification duration. */
  readonly observationAcquisitionTimeoutMs?: number
  readonly historian?: RunHistorian
  readonly runtimeStateLoaders?: Readonly<Record<string, () => Promise<unknown | null>>>
}): Promise<SimulationRunRuntime> => {
  const state = config.stateStore ?? createSimulationRunStateStore()
  // Admission state invalidates in-flight prepared commands immediately. Public
  // reads and persistence see only acknowledged journal appends. Both maps share
  // immutable objects; updates cost O(batch size), not a whole-world clone.
  const committedState = createSimulationRunStateStore()
  const metrics = createSimulationRunRuntimeMetricsRecorder({
    simulationRunId: config.id,
    createdAt: nowIso(),
  })
  const handlers = new Set<SimulationRunEventHandler>()
  const durableEvents: SimulationRunEvent[] = [...(config.restoredEvents ?? [])]
  const restoredEventSeq = durableEvents.reduce((max, event) => Math.max(max, event.seq), 0)
  let seq = Math.max(config.initialSeq ?? 0, config.restoredSnapshot?.seq ?? 0, restoredEventSeq)
  let publishQueue: Promise<void> = Promise.resolve()
  let snapshotSaveQueue: Promise<void> = Promise.resolve()
  let projectedSnapshotDirty = false
  let projectedSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  let operationTail: Promise<void> = Promise.resolve()
  let closing = false
  let maximumPaceActive = false
  let terminalExecutionFailure: string | null = null
  let commitFailure: Error | null = null
  let commitFailedAt: IsoTimestamp | null = null
  let lastCommitAt = nowIso()
  let quarantinePending: Promise<void> | null = null
  let activeMutations = 0
  let scenarioRunner: ScenarioTimelineRunner | null = null
  let pendingRuntimeEmissions = 0
  let runtimeEmissionFailure: unknown = null
  const maximumPaceNotificationBuffer = new Map<string, SimulationRunEvent>()
  const maximumPaceRealtimeBuffer = new Map<string, PackRuntimeRealtimeMessage>()
  let lastFastForwardNotificationAt = 0
  const interactionHandlers = [...(config.interactionHandlers ?? [])]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()
  const observationAcquisitionTimeoutMs = config.observationAcquisitionTimeoutMs ?? 5_000
  if (!Number.isFinite(observationAcquisitionTimeoutMs) || observationAcquisitionTimeoutMs <= 0) {
    throw new Error('Observation acquisition timeout must be a positive finite wall-time duration.')
  }
  const commandIdempotencyStore = createCommandIdempotencyStore()
  const commandIdempotency = commandIdempotencyConfigFromEnv()
  const runtimeCapabilities = new Map<string, ActiveSimulationCapability>()
  for (const entry of config.runtimeCapabilities ?? []) {
    if (runtimeCapabilities.has(entry.capability.id)) {
      throw new Error(`duplicate active Simulation Capability: ${entry.capability.id}`)
    }
    runtimeCapabilities.set(entry.capability.id, entry)
  }

  const keepQueueOpenAfter = async (publish: Promise<void>): Promise<void> => {
    await Promise.allSettled([publish])
  }

  const runClock = config.runClock ?? createSimulationClock({
    currentTime: config.restoredSnapshot?.clock?.currentTime ?? config.scenario.startsAt,
    paused: config.restoredSnapshot?.clock?.paused ?? false,
    updatedAt: nowIso(),
  })

  const snapshotWithCurrentClock = (): SimulationRunStateSnapshot => {
    const snapshot = committedState.snapshot()
    if (!snapshot.clock) return snapshot
    return {
      ...snapshot,
      clock: runClock.read(),
    }
  }

  const currentClockMs = (): number => {
    const clock = snapshotWithCurrentClock().clock
    if (!clock) return Date.now()
    const currentTimeMs = Date.parse(clock.currentTime)
    if (!Number.isFinite(currentTimeMs)) throw new Error(`invalid simulation run clock time: ${clock.currentTime}`)
    return currentTimeMs
  }

  const clearProjectedSnapshotTimer = (): void => {
    if (projectedSnapshotTimer === null) return
    clearTimeout(projectedSnapshotTimer)
    projectedSnapshotTimer = null
  }

  const assertCommitAvailable = (): void => {
    if (commitFailure) throw commitFailure
  }

  const failCommit = async (error: unknown, committedObservationFailure = false): Promise<never> => {
    if (!commitFailure) {
      terminalExecutionFailure = `${committedObservationFailure ? 'Events committed, but runtime observation failed; recovery required' : 'Commit outcome is uncertain'}: ${error instanceof Error ? error.message : String(error)}`
      commitFailedAt = nowIso()
      commitFailure = Object.assign(new Error(terminalExecutionFailure, { cause: error }), { code: committedObservationFailure ? 'simulation_run_observer_failed' : 'simulation_run_commit_uncertain' })
      runClock.set({ ...runClock.read(), paused: true })
      scenarioRunner?.close()
      clearProjectedSnapshotTimer()
      projectedSnapshotDirty = false
      quarantinePending = (async () => {
        try { await config.snapshotStore.quarantine(terminalExecutionFailure!) }
        catch (quarantineError) {
          terminalExecutionFailure += `; recovery quarantine could not be persisted; restart safety is unproven: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
          commitFailure!.message = terminalExecutionFailure
        }
      })()
    }
    await quarantinePending
    throw commitFailure
  }

  const queueSnapshotSave = async (): Promise<void> => {
    const previousSave = snapshotSaveQueue
    const save = async (): Promise<void> => {
      try {
        await previousSave
      } catch (err) {
        void err
      }
      assertCommitAvailable()
      const startedAt = performance.now()
      try {
        await config.snapshotStore.save(snapshotWithCurrentClock())
        metrics.recordSnapshotSave(performance.now() - startedAt, nowIso())
      } catch (err) {
        metrics.recordSnapshotSaveFailure()
        await failCommit(err)
      }
    }
    const currentSave = save()
    snapshotSaveQueue = (async (): Promise<void> => {
      try {
        await currentSave
      } catch (err) {
        void err
      }
    })()
    await currentSave
  }

  const saveSnapshotImmediately = async (): Promise<void> => {
    clearProjectedSnapshotTimer()
    projectedSnapshotDirty = false
    metrics.recordImmediateSnapshotSave()
    await queueSnapshotSave()
  }

  const maximumPaceEventKey = (event: SimulationRunEvent): string => {
    if (event.type === 'object.upserted') return `object:${event.object.id}`
    if (event.type === 'object.deleted') return `object:${event.objectId}`
    if (event.type === 'telemetry.sampled') return `telemetry:${event.objectId}`
    return `${event.type}:${event.seq}`
  }

  const flushFastForwardNotifications = (): void => {
    if (maximumPaceNotificationBuffer.size === 0 && maximumPaceRealtimeBuffer.size === 0) return
    const notification: SimulationRunEventNotification = {
      type: 'event.notification',
      events: [...maximumPaceNotificationBuffer.values()],
      ...(maximumPaceRealtimeBuffer.size === 0 ? {} : { realtimeMessages: [...maximumPaceRealtimeBuffer.values()] }),
    }
    maximumPaceNotificationBuffer.clear()
    maximumPaceRealtimeBuffer.clear()
    lastFastForwardNotificationAt = performance.now()
    notifySubscribers(notification)
  }

  const notifySubscribers = (notification: SimulationRunEventNotification): void => {
    for (const handler of handlers) {
      try { handler(notification) }
      catch (error) { console.error('Simulation Run subscriber failed:', error) }
    }
  }

  const scheduleProjectedSnapshotSave = (): void => {
    metrics.recordProjectedSnapshotScheduled()
    projectedSnapshotDirty = true
    if (projectedSnapshotTimer !== null) return
    projectedSnapshotTimer = setTimeout(() => {
      projectedSnapshotTimer = null
      if (!projectedSnapshotDirty) return
      projectedSnapshotDirty = false
      metrics.recordProjectedSnapshotFlushed()
      const save = async (): Promise<void> => {
        try {
          await queueSnapshotSave()
        } catch (err) {
          console.error('simulation run projected snapshot save failed:', err)
        }
      }
      void save()
    }, projectedSnapshotFlushIntervalMs)
    projectedSnapshotTimer.unref?.()
  }


  const publishManyNow = async (
    simulationRunEvents: ReadonlyArray<SimulationRunEvent>,
    options?: PublishManyOptions,
  ): Promise<void> => {
    assertCommitAvailable()
    if (simulationRunEvents.length === 0) return
    if (simulationRunEvents.some(event => event.type === 'object.deleted')) {
      // Validate the complete batch before changing canonical state. This covers
      // UI/API commands, interaction effects and runtime-originated deletions.
      const candidates = new Map(state.snapshot().objects.map(object => [object.id, object]))
      for (const event of simulationRunEvents) {
        if (event.type === 'object.upserted') candidates.set(event.object.id, event.object)
        if (event.type === 'object.deleted') {
          config.runtimeConnection.validateObjectDeletion?.(event.objectId, [...candidates.values()])
          candidates.delete(event.objectId)
        }
      }
    }
    const eventsToPersist: SimulationRunEvent[] = []
    let projectedEventCount = 0
    for (const [index, event] of simulationRunEvents.entries()) {
      const previousObject = event.type === 'object.upserted' ? state.getObject(event.object.id) : undefined
      try { state.apply(event) }
      catch (error) { await failCommit(error) }
      const persistence = options?.history
        ?? options?.historyForEvent?.(event, previousObject, index)
        ?? persistenceDispositionFor(event, previousObject)
      if (persistence === 'durable') {
        eventsToPersist.push(event)
      } else {
        projectedEventCount += 1
      }
    }
    metrics.recordPublishedEvents({
      eventCount: simulationRunEvents.length,
      durableEventCount: eventsToPersist.length,
      projectedEventCount,
    })
    try { await config.eventLog.appendMany(eventsToPersist) }
    catch (error) { await failCommit(error) }
    durableEvents.push(...eventsToPersist)
    for (const event of simulationRunEvents) committedState.apply(event)
    if (eventsToPersist.length > 0) {
      await saveSnapshotImmediately()
    } else {
      scheduleProjectedSnapshotSave()
    }
    if (maximumPaceActive && eventsToPersist.length === 0) {
      for (const event of simulationRunEvents) maximumPaceNotificationBuffer.set(maximumPaceEventKey(event), event)
      if (performance.now() - lastFastForwardNotificationAt >= maximumPaceProgressWallIntervalMs) flushFastForwardNotifications()
    } else {
      flushFastForwardNotifications()
      const notification: SimulationRunEventNotification = { type: 'event.notification', events: simulationRunEvents }
      notifySubscribers(notification)
    }
    try { await config.runtimeConnection.observeCommittedEvents(simulationRunEvents) }
    catch (error) { await failCommit(error, true) }
    const missedObserver = config.runtimeConnection.health?.().find(health => health.state === 'failed'
      && (health.lastFailure?.operation === 'observe-committed-events' || health.lastFailure?.operation === 'after-committed-events'))
    if (missedObserver) await failCommit(new Error(`Committed state was missed by ${missedObserver.runtimeId}: ${missedObserver.lastFailure?.message}`), true)
    lastCommitAt = nowIso()
    if (simulationRunEvents.some(event => event.type === 'procedure.run.started' || event.type === 'procedure.run.resumed' || event.type === 'procedure.step.updated')) {
      await evaluateProcedureObservationsNow()
    }
  }

  // The owning Pack evaluates physical conditions. World only schedules scoped,
  // read-only queries and retains their evidence; it never interprets plant logic.
  const procedureDocuments = new Map<string, ProcedureDocument>()
  const pendingObservationAcquisitions = new Map<string, Promise<unknown>>()
  const acquireObservation = async <T>(key: string, acquire: () => Promise<T>, budget: { readonly deadline: number; exhausted: boolean }): Promise<T> => {
    const timeoutReason = `Observation acquisition pass exceeded its ${observationAcquisitionTimeoutMs} ms wall-time transport budget; original read is still pending.`
    // A transport without cancellation may never settle. Do not leak another
    // request on each scan, and never let its late result publish old evidence.
    if (pendingObservationAcquisitions.has(key)) throw new Error(timeoutReason)
    const remainingMs = budget.deadline - performance.now()
    if (budget.exhausted || remainingMs <= 0) throw new Error(`Observation acquisition pass exceeded its ${observationAcquisitionTimeoutMs} ms wall-time transport budget; this read was not started.`)
    const pending = Promise.resolve().then(acquire)
    pendingObservationAcquisitions.set(key, pending)
    const release = () => {
      if (pendingObservationAcquisitions.get(key) === pending) pendingObservationAcquisitions.delete(key)
    }
    void pending.then(release, release)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          budget.exhausted = true
          reject(new Error(timeoutReason))
        }, Math.max(1, Math.ceil(remainingMs)))
      })])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const evaluateProcedureObservationsNow = async (): Promise<void> => {
    if (closing) return
    // One budget for the entire scan: many distinct stalled bindings cannot
    // multiply the time for which this read-side observer occupies the queue.
    const acquisitionBudget = { deadline: performance.now() + observationAcquisitionTimeoutMs, exhausted: false }
    const runs = state.snapshot().procedures?.runs ?? []
    const keyFor = (run: typeof runs[number]) => JSON.stringify([run.sourceId, run.sourceRevision, run.sourcePath, run.procedureId])
    const livePins = new Set(runs.filter(run => run.status === 'active' || run.status === 'transferred').map(keyFor))
    for (const key of procedureDocuments.keys()) if (!livePins.has(key)) procedureDocuments.delete(key)
    for (const run of runs) {
      if (closing) return
      if (run.status !== 'active' && run.status !== 'transferred') continue
      const key = keyFor(run)
      let document = procedureDocuments.get(key)
      if (!document) {
        try {
          document = await acquireObservation(`source:${key}`, async () => await procedureSourceService.readDocument(run), acquisitionBudget)
          procedureDocuments.set(key, document)
        } catch (error) {
          // A missing pin is failed acquisition, not evidence that the last
          // satisfied condition remains true. Do not reject an already committed
          // operator decision merely because its observer source is unavailable.
          const reason = `Procedure evidence source unavailable: ${error instanceof Error ? error.message : String(error)}`
          for (const previous of run.observations ?? []) {
            if (previous.result.status === 'unknown' && previous.result.reason === reason) continue
            const observation = { stepId: previous.stepId, simulationTime: runClock.read().currentTime,
              result: { status: 'unknown' as const, reason } }
            await publishManyNow([{ id: eventId(), simulationRunId: config.id, seq: ++seq, at: nowIso(),
              provenance: { source: 'system' }, type: 'procedure.observation.updated', runId: run.runId, observation }], { history: 'durable' })
          }
          console.error(`[procedure.observation] ${run.runId}: ${reason}`)
          continue
        }
      }
      for (const step of document.steps) {
        if (closing) return
        const binding = step.observation
        if (!binding || (!binding.continuous && (run.status !== 'active' || step.id !== run.currentStepId))) continue
        let result: Record<string, unknown>
        try {
          const active = runtimeCapabilities.get(binding.capabilityId)
          if (!active || active.capability.kind !== 'query') throw new Error(`Observation requires an active read-only capability: ${binding.capabilityId}`)
          const input = active.capability.input.parse({ ...binding.input, targetObjectId: run.scope.plantId })
          const targets = active.capability.inspectObjectIds?.(input) ?? []
          if (!targets.includes(objectIdSchema.parse(run.scope.plantId)) || targets.some(target => target !== run.scope.plantId)) {
            throw new Error('Procedure observation must inspect only its scoped operational object')
          }
          const acquisitionKey = JSON.stringify(['query', binding.capabilityId, input])
          const raw = active.capability.output.parse(await acquireObservation(acquisitionKey,
            async () => await config.runtimeConnection.invokeQuery({ capabilityId: binding.capabilityId, input }), acquisitionBudget))
          result = procedureObservationUpdatedEventSchema.shape.observation.shape.result.parse(raw)
        } catch (error) {
          // Failed acquisition is explicit unknown evidence, never the last green.
          result = { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
        }
        const observation = procedureObservationUpdatedEventSchema.shape.observation.parse({
          stepId: step.id, simulationTime: runClock.read().currentTime, result,
        })
        const prior = state.snapshot().procedures?.runs.find(item => item.runId === run.runId)?.observations?.find(item => item.stepId === step.id)
        if (prior?.simulationTime === observation.simulationTime && JSON.stringify(prior.result) === JSON.stringify(result)) continue
        const meaningfulChange = prior === undefined || prior.result.status !== observation.result.status || prior.result.reason !== observation.result.reason
        await publishManyNow([{ id: eventId(), simulationRunId: config.id, seq: ++seq, at: nowIso(),
          provenance: { source: 'system' }, type: 'procedure.observation.updated', runId: run.runId, observation }],
          { history: meaningfulChange ? 'durable' : 'projected' })
      }
    }
  }

  const enqueuePublish = async (work: () => Promise<void>): Promise<void> => {
    const previousPublish = publishQueue
    const currentPublish = (async (): Promise<void> => {
      await previousPublish
      assertCommitAvailable()
      await work()
    })()
    publishQueue = keepQueueOpenAfter(currentPublish)
    await currentPublish
  }

  const publishGenerated = async (
    generate: () => ReadonlyArray<SimulationRunEvent> | Promise<ReadonlyArray<SimulationRunEvent>>,
    options?: PublishManyOptions,
  ): Promise<ReadonlyArray<SimulationRunEvent>> => {
    let generatedEvents: ReadonlyArray<SimulationRunEvent> = []
    await enqueuePublish(async () => {
      generatedEvents = await generate()
      await publishManyNow(generatedEvents, options)
    })
    return generatedEvents
  }

  const publishOneGenerated = async (
    generate: () => SimulationRunEvent | Promise<SimulationRunEvent>,
    options?: PublishManyOptions,
  ): Promise<SimulationRunEvent> => {
    const events = await publishGenerated(async () => [await generate()], options)
    const event = events[0]
    if (!event) throw new Error('internal event generation produced no event')
    return event
  }

  const nextScenarioBase = (at: IsoTimestamp): Omit<SimulationRunEvent, 'type'> => ({
    id: eventId(),
    simulationRunId: config.id,
    seq: ++seq,
    at,
    provenance: { source: 'system' },
  })

  const simulationRunEventFromScenarioAction = (
    action: ScenarioTimelineAction,
    at: IsoTimestamp,
  ): SimulationRunEvent | null => {
    if (action.type === 'show_guidance') {
      return { ...nextScenarioBase(at), type: 'scenario.guidance.shown', guidance: action.guidance }
    }
    if (action.type === 'hide_guidance') {
      return {
        ...nextScenarioBase(at),
        type: 'scenario.guidance.hidden',
        ...(action.guidanceId === undefined ? {} : { guidanceId: action.guidanceId }),
      }
    }
    if (action.type === 'highlight_objects') {
      return { ...nextScenarioBase(at), type: 'scenario.objects.highlighted', objectIds: action.objectIds }
    }
    if (action.type === 'clear_highlights') {
      return {
        ...nextScenarioBase(at),
        type: 'scenario.highlights.cleared',
        ...(action.objectIds === undefined ? {} : { objectIds: action.objectIds }),
      }
    }
    return null // Commands and signals use their validated live dispatch paths.
  }

  const scenarioSignalForAction = (
    action: Extract<ScenarioTimelineAction, { readonly type: 'emit_signal' }>,
    at: IsoTimestamp,
  ): InteractionSignal => ({
    id: action.signal.id,
    simulationRunId: config.id,
    at,
    source: action.signal.source,
    targets: action.signal.targets,
    type: action.signal.signalType,
    payload: action.signal.payload,
    ...(action.signal.severity === undefined ? {} : { severity: action.signal.severity }),
    ...(action.signal.correlationId === undefined ? {} : { correlationId: action.signal.correlationId }),
    ...(action.signal.causationId === undefined ? {} : { causationId: action.signal.causationId }),
    ...(action.signal.ttlMs === undefined ? {} : { ttlMs: action.signal.ttlMs }),
  })

  const scenarioCueStartedEvent = (cue: ScenarioTimelineCue, at: IsoTimestamp): SimulationRunEvent => ({
    ...nextScenarioBase(at),
    type: 'scenario.cue.started',
    cueId: cue.id,
  })

  const scenarioCueFailedEvent = (cue: ScenarioTimelineCue, error: unknown, at: IsoTimestamp): SimulationRunEvent => ({
    ...nextScenarioBase(at),
    type: 'notification.emitted',
    notification: {
      id: notificationIdSchema.parse(`notification:scenario-cue-failed:${cue.id}:${randomUUID()}`),
      simulationRunId: config.id,
      at,
      title: 'Scenario cue failed',
      message: `Scenario cue ${cue.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'critical',
      source: { kind: 'simulation', id: 'scenario-timeline' },
      targets: [{ kind: 'broadcast' }],
    },
  })

  const simulationRunEventsForScenarioActions = (actions: ReadonlyArray<ScenarioTimelineAction>, at: IsoTimestamp): ReadonlyArray<SimulationRunEvent> =>
    actions
      .map(action => simulationRunEventFromScenarioAction(action, at))
      .filter((event): event is SimulationRunEvent => event !== null)

  const nextBase = (simEvent: PackRuntimeEvent): Omit<SimulationRunEvent, 'type'> => ({
    id: eventId(),
    simulationRunId: config.id,
    seq: ++seq,
    at: simEvent.at,
    provenance: simEvent.provenance,
  })

  const simulationRunEventFromPackRuntimeEvent = (simEvent: PackRuntimeEvent): SimulationRunEvent => {
    if (simEvent.type === 'object.upserted') {
      return { ...nextBase(simEvent), type: 'object.upserted', object: simEvent.object }
    }
    if (simEvent.type === 'object.deleted') {
      return { ...nextBase(simEvent), type: 'object.deleted', objectId: simEvent.objectId }
    }
    if (simEvent.type === 'interaction.signal') {
      return { ...nextBase(simEvent), type: 'interaction.signal.received', signal: simEvent.signal }
    }
    return { ...nextBase(simEvent), type: 'telemetry.sampled', objectId: simEvent.objectId, telemetry: simEvent.telemetry }
  }

  const simulationRunEventFromInteractionEffect = (
    effect: InteractionEffect,
    at: IsoTimestamp,
    provenance: Provenance,
  ): SimulationRunEvent => {
    if (effect.type === 'object.upsert') {
      return {
        id: eventId(),
        simulationRunId: config.id,
        seq: ++seq,
        at,
        provenance: effect.object.provenance,
        type: 'object.upserted',
        object: effect.object,
      }
    }
    if (effect.type === 'object.delete') {
      return {
        id: eventId(),
        simulationRunId: config.id,
        seq: ++seq,
        at,
        provenance,
        type: 'object.deleted',
        objectId: effect.objectId,
      }
    }
    return {
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at,
      provenance,
      type: 'notification.emitted',
      notification: effect.notification,
    }
  }

  const clearDeletedObjectReference = (
    object: OperationalObject,
    deletedObjectId: ObjectId,
    at: IsoTimestamp,
    command: CommandEnvelope,
  ): OperationalObject | null => {
    if (object.tasking?.currentTaskId !== deletedObjectId) return null
    const { route: _route, ...spatialWithoutRoute } = object.spatial
    const { intent: _intent, ...operationalWithoutIntent } = object.operational
    const { tasking: _tasking, ...objectWithoutTasking } = object
    return {
      ...objectWithoutTasking,
      revision: object.revision + 1,
      spatial: {
        ...spatialWithoutRoute,
        ...(object.spatial.position
          ? {
              position: {
                ...object.spatial.position,
                speedMps: 0,
                observedAt: at,
              },
            }
          : {}),
      },
      operational: operationalWithoutIntent,
      provenance: {
        source: 'operator',
        causedByCommandId: command.id,
      },
      timestamps: {
        ...object.timestamps,
        updatedAt: at,
      },
    }
  }

  const coreDeleteEvents = (command: CommandEnvelope, at: IsoTimestamp): ReadonlyArray<SimulationRunEvent> => {
    const payload = deleteObjectPayloadSchema.parse(command.payload)
    const snapshot = state.snapshot()
    const target = snapshot.objects.find(object => object.id === payload.objectId)
    if (!target) throw new Error(`cannot delete unknown object: ${payload.objectId}`)
    const cleanupEvents: SimulationRunEvent[] = snapshot.objects.flatMap(object => {
      const cleaned = clearDeletedObjectReference(object, payload.objectId, at, command)
      return cleaned
        ? [{
            id: eventId(),
            simulationRunId: config.id,
            seq: ++seq,
            at,
            provenance: cleaned.provenance,
            type: 'object.upserted' as const,
            object: cleaned,
          }]
        : []
    })
    return [
      ...cleanupEvents,
      {
        id: eventId(),
        simulationRunId: config.id,
        seq: ++seq,
        at,
        provenance: { source: 'operator', causedByCommandId: command.id },
        type: 'object.deleted',
        objectId: payload.objectId,
      },
    ]
  }

  const handleCoreCommand = async (command: CommandEnvelope, commandSource: Provenance['source'], actor: Actor): Promise<CommandResult | null> => {
    const at = nowIso()
    if (command.kind !== deleteObjectCommandKind) {
      try {
        const commit = await prepareProcedureCommand({
          command,
          procedures: state.snapshot().procedures,
          readDocument: async documentConfig =>
            await procedureSourceService.readDocument(documentConfig),
          ...(procedureSourceService.assertTargetApplicable === undefined ? {} : { assertTargetApplicable: procedureSourceService.assertTargetApplicable }),
        })
        if (commit === null) return null
        await publishGenerated(async () => {
          await evaluateProcedureObservationsNow()
          const snapshot = state.snapshot()
          // Document preparation may outlive a controller's restriction change.
          // Recheck current AI authority at the serialized procedure commit,
          // including the actual live Run scope rather than just caller targets.
          const restrictions = snapshot.scenario?.agentRestrictions
          if (actor.role === 'ai_agent' && restrictions) {
            if (restrictions.operationIds.includes(command.kind)) throw new Error(`AI access to operation ${command.kind} is restricted for this Run`)
            const payload = command.payload as { readonly runId?: string; readonly scope?: { readonly plantId?: string } }
            const plantId = payload.scope?.plantId ?? snapshot.procedures?.runs.find(run => run.runId === payload.runId)?.scope.plantId
            const targets = plantId === undefined ? command.targetObjectIds : [...new Set([...command.targetObjectIds, objectIdSchema.parse(plantId)])]
            const denied = targets.filter(objectId => restrictions.objects.some(entry => entry.objectId === objectId && entry.deny.includes('change')))
            if (denied.length > 0) throw new Error(`AI change access is restricted for: ${denied.join(', ')}`)
          }
          return commit({
            simulationRunId: config.id, at: nowIso(), procedures: snapshot.procedures,
            simulationTime: runClock.read().currentTime,
            commandSource,
            objectIds: new Set(snapshot.objects.map(object => object.id)),
            objects: new Map(snapshot.objects.map(object => [object.id, object])),
            factory: { eventId, nextSeq: () => ++seq },
          })
        })
        return { ok: true, commandId: command.id, acceptedAt: at }
      } catch (error) {
        assertCommitAvailable()
        return {
          ok: false,
          commandId: command.id,
          rejectedAt: at,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    try {
      await publishGenerated(() => coreDeleteEvents(command, at))
      return { ok: true, commandId: command.id, acceptedAt: at }
    } catch (error) {
      assertCommitAvailable()
      return {
        ok: false,
        commandId: command.id,
        rejectedAt: at,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const commitInteractionEffectsNow = async (
    effects: ReadonlyArray<InteractionEffect>,
    at: IsoTimestamp,
    provenance: Provenance,
  ): Promise<void> => {
    if (effects.length === 0) return
    const parsedEffects = effects.map(effect => interactionEffectSchema.parse(effect) as InteractionEffect)
    const simulationRunEvents = parsedEffects.map(effect => simulationRunEventFromInteractionEffect(effect, at, provenance))
    await publishManyNow(simulationRunEvents)
  }

  const handleInteractionSignalNow = async (
    signal: InteractionSignal,
    provenance: Provenance,
  ): Promise<void> => {
    const parsedSignal = interactionSignalSchema.parse(signal) as InteractionSignal
    if (parsedSignal.simulationRunId !== config.id) {
      throw new Error(`interaction signal simulation run mismatch: ${parsedSignal.simulationRunId}`)
    }
    await publishManyNow([{
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: parsedSignal.at,
      provenance,
      type: 'interaction.signal.received',
      signal: parsedSignal,
    }])
    for (const handler of interactionHandlers) {
      if (!handler.accepts(parsedSignal)) continue
      const effects = await handler.handle({
        signal: parsedSignal,
        snapshot: state.snapshot(),
        provenance,
      })
      await commitInteractionEffectsNow(effects, parsedSignal.at, provenance)
    }
  }

  const publishPackRuntimeEmission = async (emission: PackRuntimeEmission): Promise<void> => {
    metrics.recordPackEmission(emission.runtimeId, emission.events.length, emission.emittedAt)
    if (emission.recording !== undefined) {
      if (!config.historian) throw new Error(`Pack Runtime ${emission.runtimeId} emitted recording samples without an active Run Historian`)
      config.historian.record(emission.runtimeId, emission.recording)
    }
    await enqueuePublish(async () => {
      const pendingEvents: SimulationRunEvent[] = []
      const pendingPersistences: SimulationRunEventPersistenceDisposition[] = []

      const flushPendingEvents = async (): Promise<void> => {
        if (pendingEvents.length === 0) return
        const events = pendingEvents.splice(0, pendingEvents.length)
        const persistences = pendingPersistences.splice(0, pendingPersistences.length)
        await publishManyNow(events, {
          historyForEvent: (_event, _previousObject, index) => persistences[index],
        })
      }

      for (const event of emission.events) {
        if (event.type === 'interaction.signal') {
          await flushPendingEvents()
          await handleInteractionSignalNow(event.signal, event.provenance)
        } else {
          pendingEvents.push(simulationRunEventFromPackRuntimeEvent(event))
          pendingPersistences.push(event.history === 'record' ? 'durable' : 'projected')
        }
      }
      await flushPendingEvents()
      if (emission.realtimeMessages && emission.realtimeMessages.length > 0) {
        if (maximumPaceActive) {
          for (const message of emission.realtimeMessages) maximumPaceRealtimeBuffer.set(message.type, message)
          if (performance.now() - lastFastForwardNotificationAt >= maximumPaceProgressWallIntervalMs) flushFastForwardNotifications()
          return
        }
        const notification: SimulationRunEventNotification = {
          type: 'event.notification',
          events: [],
          realtimeMessages: emission.realtimeMessages,
        }
        notifySubscribers(notification)
      }
    })
  }

  const publishPackRuntimeEmissionSafely = async (emission: PackRuntimeEmission): Promise<void> => {
    try {
      await publishPackRuntimeEmission(emission)
    } catch (err) {
      runtimeEmissionFailure = err
      console.error(err)
    }
  }

  const unsubscribeRuntime = config.runtimeConnection.subscribe((emission) => {
    if (commitFailure) return
    pendingRuntimeEmissions += 1
    void publishPackRuntimeEmissionSafely(emission).finally(() => { pendingRuntimeEmissions -= 1 })
  })

  const drainRuntimeEmissions = async (): Promise<void> => {
    do {
      await publishQueue
      if (pendingRuntimeEmissions > 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    } while (pendingRuntimeEmissions > 0)
    await publishQueue
    if (runtimeEmissionFailure !== null) {
      const failure = runtimeEmissionFailure
      runtimeEmissionFailure = null
      throw failure
    }
  }

  const initialScenarioState = (): ScenarioExecutionState => ({
    scenarioId: config.scenario.id,
    agentRestrictions: { ...config.scenario.agentRestrictions, revision: 0 },
    ...(config.scenario.roles === undefined ? {} : { roles: config.scenario.roles }),
    highlightedObjectIds: [],
    ...(config.scenario.timeline === undefined
      ? {}
      : {
          timeline: {
            startedAt: config.scenario.startsAt,
            firedCueIds: [],
          },
        }),
  })

  if (config.restoredSnapshot) {
    // Roles are compiled once and never change in a Run; restored state must
    // still declare exactly the Compiled Scenario's roles.
    if (!Bun.deepEquals(config.restoredSnapshot.scenario?.roles ?? null, config.scenario.roles ?? null)) {
      throw new Error(`Simulation Run snapshot roles do not match its Compiled Scenario: ${config.id}`)
    }
    state.hydrate({
      ...config.restoredSnapshot,
      clock: runClock.read(),
    })
  } else {
    const snapshot = await config.runtimeConnection.getSnapshot()
    const scenarioState = initialScenarioState()
    state.hydrate({
      objects: snapshot.objects,
      seq,
      clock: runClock.read(),
      scenario: scenarioState,
    })
    committedState.hydrate(state.snapshot())
    await config.snapshotStore.save(snapshotWithCurrentClock())
  }
  const hydratedClock = state.snapshot().clock
  if (hydratedClock) {
    const initial = { ...hydratedClock, paused: config.restoredSnapshot?.clock?.paused ?? false }
    await config.runtimeConnection.setClock(initial)
    runClock.set(initial)
    state.hydrate({ ...state.snapshot(), clock: initial })
  }
  committedState.hydrate(state.snapshot())
  const runRoles: RunRoles | null = config.scenario.roles ?? null

  const issueCommandThroughRuntime = async (
    actor: Actor,
    command: CommandEnvelope,
    commandSource: Provenance['source'],
  ): Promise<CommandResult> => {
    if (command.simulationRunId !== config.id) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: 'command simulation run does not match active simulation run' }
    }
    if (!canIssueCommand(actor, command)) {
      return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: `role ${actor.role} may not issue command ${command.kind}` }
    }
    const commandEventHistory = config.runtimeConnection.commandEventHistory?.(command) ?? 'record'
    const commandEventDisposition = commandEventHistory === 'record' ? 'durable' : 'projected'
    await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: command.issuedAt,
      provenance: { source: commandSource },
      type: 'command.issued',
      command,
    }), { history: commandEventDisposition })
    const result = await handleCoreCommand(command, commandSource, actor) ?? await config.runtimeConnection.sendCommand(command)
    await drainRuntimeEmissions()
    await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at: result.ok ? result.acceptedAt : result.rejectedAt,
      provenance: { source: 'simulator', causedByCommandId: command.id },
      type: 'command.result',
      result,
    }), { history: commandEventDisposition })
    return result
  }

  const invokeCapabilityThroughRuntime = async (
    actor: Actor,
    invocation: SimulationRunCapabilityInvocation,
    commandSource: Provenance['source'],
  ): Promise<SimulationRunCapabilityInvocationResult> => {
    assertCommitAvailable()
    const active = runtimeCapabilities.get(invocation.capabilityId)
    if (!active) throw new Error(`Simulation Capability is not active: ${invocation.capabilityId}`)
    if (invocation.scheduled === true && active.capability.schedulable !== true) {
      throw new Error(`Simulation Capability is not schedulable: ${invocation.capabilityId}`)
    }
    const input = active.capability.input.parse(invocation.input)
    const currentRestrictions = state.snapshot().scenario?.agentRestrictions
    const assertAllowed = (effect: 'inspect' | 'change', objectIds: ReadonlyArray<ObjectId>): void => {
      if (actor.role !== 'ai_agent' || !currentRestrictions) return
      if (currentRestrictions.operationIds.includes(active.capability.id)) {
        throw Object.assign(new Error(`AI access to operation ${active.capability.id} is restricted for this Run`), { code: 'agent_access_restricted' })
      }
      const denied = objectIds.filter(objectId => currentRestrictions.objects.some(entry => entry.objectId === objectId && entry.deny.includes(effect)))
      if (denied.length > 0) {
        throw Object.assign(new Error(`AI ${effect} access is restricted for: ${denied.join(', ')}`), { code: 'agent_access_restricted', objectIds: denied })
      }
    }
    if (active.capability.kind === 'query') {
      assertAllowed('inspect', active.capability.inspectObjectIds?.(input) ?? [])
      const result = await config.runtimeConnection.invokeQuery({
        capabilityId: active.capability.id,
        input,
      })
      return { kind: 'query', result: active.capability.output.parse(result) }
    }
    const built = active.capability.buildCommand?.(input)
    if (!built) throw new Error(`Simulation command Capability cannot build a command: ${active.capability.id}`)
    const procedureRunId = active.capability.id.startsWith('world.procedure.') && typeof built.payload === 'object' && built.payload !== null
      ? (built.payload as { runId?: string }).runId : undefined
    const procedureScope = procedureRunId === undefined ? undefined
      : state.snapshot().procedures?.runs.find(run => run.runId === procedureRunId)?.scope.plantId
    const targetObjectIds = procedureScope === undefined ? built.targetObjectIds : [...new Set([...built.targetObjectIds, objectIdSchema.parse(procedureScope)])]
    assertAllowed('change', targetObjectIds)
    const command = commandEnvelopeSchema.parse({
      id: `command:${randomUUID()}`,
      simulationRunId: config.id,
      actorId: actor.id,
      kind: active.capability.id,
      targetObjectIds,
      payload: built.payload,
      ...(runRoles === null || actor.roleIds === undefined ? {} : { roleIds: actor.roleIds }),
      issuedAt: invocation.issuedAt ?? runClock.read().currentTime,
      ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    }) as CommandEnvelope
    const issued = await issueCommandWithIdempotency({
      store: commandIdempotencyStore,
      idempotency: commandIdempotency,
      actor,
      command,
      issue: async (commandActor, commandToIssue) =>
        await issueCommandThroughRuntime(commandActor, commandToIssue, commandSource),
    })
    if (!issued.ok) throw new CommandIdempotencyConflictError(issued.message)
    return {
      kind: 'command',
      result: active.capability.output.parse(issued.result) as CommandResult,
      replayed: issued.replayed,
    }
  }

  const executeScenarioCue = async (cue: ScenarioTimelineCue, at: IsoTimestamp): Promise<void> => {
    await publishOneGenerated(() => scenarioCueStartedEvent(cue, at))

    for (const action of cue.actions) {
      if (action.type === 'emit_signal') {
        await enqueuePublish(async () => {
          await handleInteractionSignalNow(scenarioSignalForAction(action, at), { source: 'system' })
        })
        continue
      }
      if (action.type === 'invoke_capability') {
        const outcome = await invokeCapabilityThroughRuntime(scenarioRunnerActor, {
          capabilityId: action.capabilityId,
          input: action.input,
          scheduled: true,
          issuedAt: at,
        }, 'system')
        if (outcome.kind !== 'command') throw new Error(`Scenario cannot invoke query Capability: ${action.capabilityId}`)
        if (!outcome.result.ok) throw new Error(outcome.result.reason)
        continue
      }
      await publishGenerated(() => simulationRunEventsForScenarioActions([action], at))
    }
  }

  let cueQueue: Promise<void> = Promise.resolve()
  let pendingCues = 0
  const publishScenarioCue = (cue: ScenarioTimelineCue, at: IsoTimestamp): Promise<void> => {
    pendingCues++
    const pending = cueQueue.then(async () => {
      if (state.snapshot().scenario?.timeline?.firedCueIds.includes(cue.id)) return
      try { await executeScenarioCue(cue, at) }
      catch (error) { await publishOneGenerated(() => scenarioCueFailedEvent(cue, error, nowIso())) }
    }).finally(() => { pendingCues-- })
    cueQueue = pending.catch(() => {})
    return pending
  }

  const runDueScenarioCues = async (at: IsoTimestamp = runClock.read().currentTime): Promise<void> => {
    if (!config.scenario.timeline || !state.snapshot().scenario?.timeline) return
    const dueCues = dueScenarioTimelineCues({
      timeline: config.scenario.timeline,
      state: state.snapshot().scenario!,
      nowMs: currentClockMs(),
    })
    for (const cue of dueCues) {
      await publishScenarioCue(cue, at)
    }
  }

  const startScenarioRunner = (): void => {
    scenarioRunner?.close()
    scenarioRunner = null
    const clock = state.snapshot().clock
    if (clock?.paused) return
    const runnerScenarioState = state.snapshot().scenario
    if (!config.scenario.timeline || !runnerScenarioState?.timeline) return
    scenarioRunner = createScenarioTimelineRunner({
      timeline: config.scenario.timeline,
      state: runnerScenarioState,
      nowMs: currentClockMs,
      delayMs: (dueAtMs, nowMs): number => {
        return Math.max(0, dueAtMs - nowMs)
      },
      onCueDue: async (cue): Promise<void> => {
        await publishScenarioCue(cue, nowIso())
      },
      onCueFailed: async (cue, error): Promise<void> => {
        await publishOneGenerated(() => scenarioCueFailedEvent(cue, error, nowIso()))
      },
    })
    scenarioRunner?.start()
  }

  if (config.scenario.timeline && state.snapshot().scenario?.timeline) {
    await runDueScenarioCues()
    startScenarioRunner()
  }

  const enqueueOperation = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(Object.assign(new Error('Simulation Run is closing'), { code: 'simulation_run_busy' }))
    const previous = operationTail
    const current = (async (): Promise<T> => {
      await previous
      if (closing) throw Object.assign(new Error('Simulation Run is closing'), { code: 'simulation_run_busy' })
      if (terminalExecutionFailure) throw Object.assign(new Error(`Simulation Run is fail-stopped: ${terminalExecutionFailure}`), { code: 'simulation_run_failed' })
      return await work()
    })()
    operationTail = current.then(() => undefined, () => undefined)
    return current
  }

  const receiveRealtimeInput = async (input: PackRuntimeRealtimeInput): Promise<void> => await enqueueOperation(async () => {
      if (!config.runtimeConnection.receiveRealtimeInput) throw new Error(`runtime cannot receive realtime input type: ${input.type}`)
      await config.runtimeConnection.receiveRealtimeInput(input)
  })

  let clockQueue: Promise<unknown> = Promise.resolve()
  const applyClockUpdate = async (update: SimulationClockUpdate): Promise<SimulationClockState> => {
    const parsedUpdate = simulationClockUpdateSchema.parse(update) as SimulationClockUpdate
    await cueQueue
    const currentClock = state.snapshot().clock
    if (!currentClock) throw new Error('simulation run clock is not initialized')
    const current = runClock.read()
    const at = nowIso()
    const nextClock: SimulationClockState = {
      currentTime: current.currentTime,
      updatedAt: at,
      paused: parsedUpdate.paused ?? current.paused,
    }
    scenarioRunner?.close()
    scenarioRunner = null
    const stopped = { ...current, paused: true }
    runClock.set(stopped)
    try { await config.runtimeConnection.validateClock?.(nextClock) }
    catch (error) { runClock.set(current); startScenarioRunner(); throw error }
    try { await config.runtimeConnection.setClock(nextClock) }
    catch (error) {
      // A failing adapter may already have accepted the new rate. The shared
      // clock remains frozen: no Pack can advance a partially changed Run.
      await publishOneGenerated(() => ({ id: eventId(), simulationRunId: config.id, seq: ++seq, at: nowIso(), provenance: { source: 'system' }, type: 'clock.updated', clock: stopped }))
      throw error
    }
    runClock.set(nextClock)
    await publishOneGenerated(() => ({
      id: eventId(),
      simulationRunId: config.id,
      seq: ++seq,
      at,
      provenance: { source: 'operator' },
      type: 'clock.updated',
      clock: nextClock,
    }))
    if (config.scenario.timeline) {
      if (nextClock.paused) {
        scenarioRunner = null
      } else {
        await runDueScenarioCues()
        startScenarioRunner()
      }
    }
    return nextClock
  }
  const setClock = (update: SimulationClockUpdate): Promise<SimulationClockState> => {
    const parsed = simulationClockUpdateSchema.parse(update) as SimulationClockUpdate
    return enqueueOperation(async () => {
      if (maximumPaceActive) throw Object.assign(new Error('Pause maximum-pace execution before changing the realtime clock'), { code: 'simulation_run_busy' })
      const pending = clockQueue.then(() => applyClockUpdate(parsed))
      clockQueue = pending.catch(() => {})
      return await pending
    })
  }

  const setAgentRestrictions = async (
    actor: Actor,
    rawRestrictions: AgentRestrictions,
    expectedRevision: number,
  ): Promise<ScenarioExecutionState['agentRestrictions']> => {
    if (!['operator', 'supervisor', 'controller', 'system'].includes(actor.role)) {
      throw Object.assign(new Error('Only a human operator or system actor may replace Run AI restrictions'), { code: 'agent_restrictions_human_required' })
    }
    if (runRoles !== null) throw roleGateRefusal('agent_restrictions_in_role_run', 'A Run that declares roles has no AI restrictions, because AI is refused on it')
    const restrictions = agentRestrictionsSchema.parse(rawRestrictions) as AgentRestrictions
    return await enqueueOperation(async () => {
      const snapshot = state.snapshot()
      const current = snapshot.scenario?.agentRestrictions
      if (!current) throw new Error('Simulation Run scenario state is unavailable')
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error(`Agent Restrictions changed: expected ${expectedRevision}, current ${current.revision}`), { code: 'agent_restrictions_revision_conflict' })
      }
      const knownObjectIds = new Set(snapshot.objects.map(object => object.id))
      const unknownObjectIds = restrictions.objects.map(entry => entry.objectId).filter(objectId => !knownObjectIds.has(objectId))
      if (unknownObjectIds.length > 0) {
        throw Object.assign(new Error(`AI restrictions reference unknown current objects: ${unknownObjectIds.join(', ')}`), { code: 'agent_restrictions_object_not_found' })
      }
      const revision = current.revision + 1
      await publishOneGenerated(() => ({
        id: eventId(),
        simulationRunId: config.id,
        seq: ++seq,
        at: runClock.read().currentTime,
        provenance: { source: 'operator' },
        type: 'scenario.agent-restrictions.set',
        restrictions,
        revision,
        updatedBy: actor.id,
      }))
      return { ...restrictions, revision }
    })
  }

  const invokeCapability = async (
    actor: Actor,
    invocation: SimulationRunCapabilityInvocation,
  ): Promise<SimulationRunCapabilityInvocationResult> => {
    assertRunCapabilityAllowed(runRoles, actor, invocation.capabilityId)
    // Generic object deletion is a short canonical mutation. Commit it inside
    // the execution queue so maximum pace cannot advance another slice between
    // validation and deletion. Pack cleanup follows the resulting core event.
    if (invocation.capabilityId === deleteObjectCommandKind) {
      return await enqueueOperation(async () => await invokeCapabilityThroughRuntime(actor, invocation, 'operator'))
    }
    // Enter at an exact execution boundary, then let potentially slow command
    // preparation (routing, document reads) overlap. Canonical commits already
    // serialize through publishQueue and reject stale revisions atomically.
    // Holding operationTail across preparation would deadlock valid reset and
    // deletion races while adding no consistency guarantee.
    const mutating = runtimeCapabilities.get(invocation.capabilityId)?.capability.kind === 'command'
    await enqueueOperation(async () => { if (mutating) activeMutations++ })
    try { return await invokeCapabilityThroughRuntime(actor, invocation, 'operator') }
    finally { if (mutating) activeMutations-- }
  }

  const checkpointForCopy = async (): Promise<SimulationRunCopyCheckpoint> => await enqueueOperation(async () => {
    if (activeMutations > 0 || pendingCues > 0) throw Object.assign(
      new Error('Simulation Run has commands preparing changes; retry copy when they finish'),
      { code: 'simulation_run_busy' },
    )
    const currentControl = runClock.read()
    let stopped = { ...currentControl, paused: true }
    scenarioRunner?.close()
    scenarioRunner = null
    try {
      await clockQueue
      await cueQueue
      await drainRuntimeEmissions()
      stopped = { ...runClock.read(), paused: true }
      runClock.set(stopped)
      await config.runtimeConnection.setClock(stopped)
      await drainRuntimeEmissions()
      if (!config.runtimeConnection.checkpoint) throw new Error('active Pack Runtimes do not support a coherent checkpoint')
      await config.runtimeConnection.checkpoint()
      await saveSnapshotImmediately()
      const runtimeStates = Object.fromEntries(await Promise.all(Object.entries(config.runtimeStateLoaders ?? {}).map(async ([id, load]) => {
        const value = await load()
        if (value === null) throw new Error(`Pack Runtime checkpoint is missing after flush: ${id}`)
        return [id, value] as const
      })))
      return {
        snapshot: structuredClone({ ...snapshotWithCurrentClock(), clock: stopped }),
        runtimeStates,
      }
    } finally {
      const resumed: SimulationClockState = {
        ...stopped,
        paused: commitFailure ? true : currentControl.paused,
        updatedAt: nowIso(),
      }
      runClock.set(resumed)
      if (!commitFailure) await config.runtimeConnection.setClock(resumed)
      if (!resumed.paused) startScenarioRunner()
    }
  })

  const runMaximumPace = async (
    targetSimulationTime: IsoTimestamp | null,
    control: { readonly shouldStop: () => boolean; readonly onProgress?: (currentSimulationTime: IsoTimestamp) => void | Promise<void> },
  ): Promise<{ readonly currentSimulationTime: IsoTimestamp; readonly stoppedEarly: boolean }> => {
    const advanceTo = config.runtimeConnection.advanceTo
    const checkpoint = config.runtimeConnection.checkpoint
    if (!advanceTo || !checkpoint) throw new Error('active Pack Runtimes do not support exact maximum-pace execution')
    maximumPaceActive = true
    try {
      const targetMs = targetSimulationTime === null ? Number.POSITIVE_INFINITY : Date.parse(targetSimulationTime)
      let currentMs = 0
      await enqueueOperation(async () => {
        scenarioRunner?.close()
        scenarioRunner = null
        await clockQueue
        await cueQueue
        await drainRuntimeEmissions()
        currentMs = currentClockMs()
        if (Number.isNaN(targetMs) || targetMs < currentMs) throw new Error('maximum-pace target must not precede the current simulation time')
        if (!runClock.read().paused) throw new Error('Simulation Run must be paused before maximum pace starts')
      })
      while (currentMs < targetMs && !control.shouldStop()) {
        await enqueueOperation(async () => {
          const timelineState = state.snapshot().scenario?.timeline
          const fired = new Set(timelineState?.firedCueIds ?? [])
          const startedMs = timelineState ? Date.parse(timelineState.startedAt) : Number.NaN
          const nextCueMs = config.scenario.timeline?.cues
            .filter(cue => !fired.has(cue.id))
            .map(cue => startedMs + cue.at.seconds * 1_000)
            .filter(dueMs => dueMs > currentMs)
            .sort((left, right) => left - right)[0]
          const nextMs = Math.min(targetMs, currentMs + maximumPaceStepMs, nextCueMs ?? Number.POSITIVE_INFINITY)
          const nextTime = new Date(nextMs).toISOString() as IsoTimestamp
          const nextClock: SimulationClockState = { currentTime: nextTime, paused: true, updatedAt: nowIso() }
          await advanceTo(nextClock)
          runClock.set(nextClock)
          await drainRuntimeEmissions()
          await runDueScenarioCues(nextTime)
          await drainRuntimeEmissions()
          await enqueuePublish(evaluateProcedureObservationsNow)
          currentMs = nextMs
          await control.onProgress?.(nextTime)
        })
        // Admit network requests before scheduling the next simulation slice.
        if (currentMs < targetMs) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      await enqueueOperation(async () => {
        await checkpoint()
        await saveSnapshotImmediately()
      })
      flushFastForwardNotifications()
      return { currentSimulationTime: new Date(currentMs).toISOString() as IsoTimestamp, stoppedEarly: currentMs < targetMs }
    } finally {
      maximumPaceActive = false
      flushFastForwardNotifications()
    }
  }

  const publishResetBoundary = async (resetConfig: { readonly scenarioId?: string }): Promise<SimulationRunEvent> => await enqueueOperation(async () => {
      const snapshot = state.snapshot()
      return await publishOneGenerated(() => ({
        id: eventId(),
        simulationRunId: config.id,
        seq: ++seq,
        at: nowIso(),
        provenance: { source: 'system' },
        type: 'simulationRun.reset',
        previousSeq: snapshot.seq,
        ...(snapshot.scenario?.scenarioId === undefined ? {} : { previousScenarioId: snapshot.scenario.scenarioId }),
        ...(resetConfig.scenarioId === undefined ? {} : { scenarioId: resetConfig.scenarioId }),
      }))
  })

  // Presentation can be absent. Normal time uses a nominal one-second sampled
  // wall cadence; maximum pace samples its explicit simulation boundaries.
  // Coalesce queued/running timer scans so slow acquisition cannot build a
  // control-blocking backlog. This sampling is not continuous protection logic.
  let observationTimerPending = false
  const observationTimer = setInterval(() => {
    if (closing || maximumPaceActive || observationTimerPending || !state.snapshot().procedures?.runs.some(run => run.status === 'active' || run.status === 'transferred')) return
    observationTimerPending = true
    void enqueueOperation(async () => {
      if (!closing && !maximumPaceActive) await enqueuePublish(evaluateProcedureObservationsNow)
    }).catch(error => console.error('procedure observation acquisition failed:', error))
      .finally(() => { observationTimerPending = false })
  }, maximumPaceStepMs)
  observationTimer.unref?.()
  return {
    id: config.id,
    capabilities: (): SimulationRunCapabilities => ({
      workspaceId: config.capabilities?.workspaceId ?? null,
      simulationRunId: config.id,
      scenarioId: config.capabilities?.scenarioId ?? config.scenario.id,
      scenarioRevisionId: config.capabilities?.scenarioRevisionId ?? null,
      activePackIds: config.capabilities?.activePackIds ?? [],
      runtimes: config.capabilities?.runtimes ?? [],
      capabilities: config.capabilities?.capabilities ?? [],
      wikiRefs: config.capabilities?.wikiRefs ?? [],
      recording: config.capabilities?.recording ?? { selections: [], profiles: [] },
    }),
    snapshot: () => snapshotWithCurrentClock(),
    roles: () => runRoles,
    setClock,
    setAgentRestrictions,
    checkpointForCopy,
    runMaximumPace,
    failStop: (reason: string): void => { terminalExecutionFailure = reason },
    events: (eventsConfig?: { readonly afterSeq?: number }): ReadonlyArray<SimulationRunEvent> => {
      const afterSeq = eventsConfig?.afterSeq ?? -1
      return durableEvents.filter(event => event.seq > afterSeq)
    },
    subscribe: (handler: SimulationRunEventHandler): (() => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    publishResetBoundary,
    invokeCapability,
    receiveRealtimeInput,
    procedureCatalog: async (catalogConfig = {}) => await procedureSourceService.readCatalog(catalogConfig),
    procedureDocument: async (documentConfig) => await procedureSourceService.readDocument(documentConfig),
    procedureEvidence: async evidenceConfig => await procedureSourceService.readEvidence(evidenceConfig),
    publishInteractionSignal: async (signal: InteractionSignal, provenance: Provenance): Promise<void> => await enqueueOperation(async () => {
        await enqueuePublish(async () => {
          await handleInteractionSignalNow(signal, provenance)
        })
    }),
    metrics: () => metrics.snapshot(),
    health: () => [
      ...(config.runtimeConnection.health?.() ?? []),
      ...(commitFailure ? [{ runtimeId: 'world.core', state: 'failed' as const, failureCount: 1,
        lastSuccessfulInteractionAt: lastCommitAt, lastFailure: { at: commitFailedAt!, operation: 'commit', message: commitFailure.message } }] : []),
    ],
    recordingStatus: () => config.historian?.status() ?? null,
    recordingSeries: () => config.historian?.listSeries() ?? [],
    recordedSamples: (input) => {
      const query = recordingSeriesQuerySchema.parse(input)
      if (config.historian) return config.historian.query(query)
      // No recording selection is legitimate; an unavailable configured
      // historian has its own throwing query and never uses this empty view.
      return {
        ...(query.mode === 'raw' ? { mode: 'raw' as const, samples: [], hasMore: false, nextBeforeSequence: null } : { mode: 'summary' as const }),
        windowSummary: {
          sampleCount: 0,
          seriesCount: 0,
          qualityCounts: { good: 0, uncertain: 0, bad: 0 },
          firstSample: null,
          lastSample: null,
          distinctValueCount: 0,
          numericMinimum: null,
          numericMaximum: null,
          numericAverage: null,
        },
        retainedFromSequence: null,
        retainedFromObservedAt: null,
        retainedToObservedAt: null,
        retainedFromSimulationTime: null,
        retainedToSimulationTime: null,
        retentionGap: false,
      }
    },
    close: async (): Promise<void> => {
      closing = true
      clearInterval(observationTimer)
      pendingObservationAcquisitions.clear()
      scenarioRunner?.close()
      await operationTail
      await clockQueue
      await cueQueue
      scenarioRunner?.close()
      const current = runClock.read()
      const stopped = { ...current, paused: true }
      runClock.set(stopped)
      const failures: unknown[] = []
      const recordCloseFailure = async (error: unknown): Promise<void> => {
        try { await failCommit(error) }
        catch (failure) { failures.push(failure) }
      }
      try {
        if (!commitFailure) await config.runtimeConnection.setClock(stopped)
        if (!commitFailure) await drainRuntimeEmissions()
      } catch (error) { await recordCloseFailure(error) }
      unsubscribeRuntime()
      await quarantinePending
      try { await config.runtimeConnection.close() }
      catch (error) { await recordCloseFailure(error) }
      if (projectedSnapshotTimer !== null) clearTimeout(projectedSnapshotTimer)
      projectedSnapshotTimer = null
      projectedSnapshotDirty = false
      try {
        await snapshotSaveQueue
        if (!commitFailure && failures.length === 0) {
          try { await config.snapshotStore.save({ ...committedState.snapshot(), clock: { ...stopped, paused: current.paused } }) }
          catch (error) { await failCommit(error) }
        }
      } catch (error) { failures.push(error) }
      finally {
        config.historian?.close()
        metrics.markClosed(nowIso())
        handlers.clear()
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Simulation Run close failed')
    },
  }
}
