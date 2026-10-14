import { randomUUID } from 'node:crypto'
import type { CommandEnvelope,CommandResult,ElectricalConnectionDefinition,IsoTimestamp,ObjectId,OperationalObject,PackRuntimeRecordingBatch,SignalId,SimulationClockState,SimulationRunEvent } from '../../../core/model/index.ts'
import { electricalPortFromObject,nowIso } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import type {
  PackCommandContext,
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeQuery,
} from '../../../simulation/protocol.ts'
import { commandsForProcessPlantAction } from '../actions.ts'
import { processPlantCapabilities } from '../capabilities.ts'
import {
  processPlantActionInvokeCommandKind,
  processPlantActionInvokePayloadSchema,
  processPlantActuationResetCommandKind,
  processPlantActuationResetPayloadSchema,
  processPlantControlDecideCommandKind,
  processPlantControlDecidePayloadSchema,
  processPlantControlProposeCommandKind,
  processPlantControlProposePayloadSchema,
  processPlantControlRampCommandKind,
  processPlantControlRampPayloadSchema,
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
} from '../commands.ts'
import { processPlantDefinitionSchema,type ProcessPlantDefinition } from '../config.ts'
import type { ProcessPlantControlProposeResult } from '../capabilities.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { aiProposeOnlyRefusal, drivesProcedureOn, instructorOnlyRefusal, throttledUnder, validateOperatorWrite } from '../operations/command-guard.ts'
import { listedResetsFor, proposalPortsFor, resetContextFor } from '../operations/instance-ports.ts'
import { resetRefusal } from '../operations/actuation-reset.ts'
import { decideProposal, proposeOperation } from '../operations/proposals.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { processPlantElectricalBoundaries } from '../electrical-ports.ts'
import { processPlantIdForObject,processPlantPackId,processPlantUnitPackDataSchema,type ProcessPlantUnitPackData } from '../model.ts'
import { compileProcessPlants } from '../plant-compiler.ts'
import { answerProcessPlantQuery } from '../query.ts'
import { defaultSimulationRunRuntimePolicy } from '../../../core/simulation-runs/runtime-persistence-policy.ts'
import { createRuntimeStateWriter } from '../../../simulation/runtime-state-writer.ts'
import { createProcessPlantRecordingPlan } from '../recording.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import type { ProcessVariableValue, VariablePath } from '../graph/index.ts'
import { componentVariablePath } from '../runtime/index.ts'
import { processPlantSimAdapterId,processPlantSimRuntimeId } from './constants.ts'
import {
  initialProcessPlantObjects,
  processPlantProjectionEvents,
  projectedInitialProcessPlantObjects,
} from './object-projection.ts'
import { proposalSignalEvents } from './proposal-signals.ts'
import { createProcessPlantRuntimeInstances } from './runtime-instance-factory.ts'
import {
  processPlantRuntimeStateSchema,
  restoredOffsiteIsolationsFor,
  runtimeStateForProcessPlants,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'
import {
  coupledBoundaryEffect,
  coupledBoundaryRampRefusal,
  coupledBoundaryVariables,
  type CoupledBoundaryEffect,
  type OffsiteIsolation,
} from './offsite-isolation.ts'

const updateIntervalMs = 1_000

const systemConnectionsFor = (
  connections: ReadonlyArray<ElectricalConnectionDefinition>,
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
): ReadonlyArray<ElectricalConnectionDefinition> =>
  connections.filter(connection => plants.has(connection.system.objectId))

const processPlantDefinitionsFor = (
  objects: ReadonlyArray<OperationalObject>,
): ReadonlyArray<ProcessPlantDefinition> => objects.flatMap(object => {
  if (object.packId !== processPlantPackId) return []
  const data = processPlantUnitPackDataSchema.parse(object.packData)
  return [processPlantDefinitionSchema.parse({
    id: object.id,
    model: data.model,
    operatingPoint: data.operatingPoint,
    automation: data.automation,
  })]
})

const emitPackRuntimeEvents = (
  handlers: ReadonlySet<PackRuntimeEventHandler>,
  events: ReadonlyArray<PackRuntimeEvent>,
  recording?: PackRuntimeRecordingBatch,
): void => {
  if (events.length === 0 && recording === undefined) return
  const emittedAt = nowIso()
  for (const handler of handlers) {
    handler({
      type: 'event.emission',
      events,
      ...(recording === undefined ? {} : { recording }),
      emittedAt,
      runtimeId: processPlantSimRuntimeId,
    })
  }
}

const emitRuntimeFailure = (config: {
  readonly handlers: ReadonlySet<PackRuntimeEventHandler>
  readonly simulationRunId: PackRuntimeConnectionConfig['simulationRunId']
  readonly error: unknown
}): void => {
  const at = nowIso()
  emitPackRuntimeEvents(config.handlers, [{
    type: 'interaction.signal',
    at,
    provenance: { source: 'simulator', adapterId: processPlantSimAdapterId },
    signal: {
      id: `process-plant-runtime-failed:${randomUUID()}` as SignalId,
      simulationRunId: config.simulationRunId,
      at,
      source: { kind: 'simulation', id: processPlantSimRuntimeId },
      targets: [{ kind: 'broadcast' }],
      type: 'process-plant.runtime.failed',
      severity: 'critical',
      payload: {
        runtimeId: processPlantSimRuntimeId,
        message: config.error instanceof Error ? config.error.message : String(config.error),
      },
    },
  }])
}

const emitOffsiteIsolationChange = (config: {
  readonly handlers: ReadonlySet<PackRuntimeEventHandler>
  readonly simulationRunId: PackRuntimeConnectionConfig['simulationRunId']
  readonly connection: ElectricalConnectionDefinition
  readonly isolated: boolean
  readonly cause: string
}): void => {
  const at = nowIso()
  const plantId = String(config.connection.system.objectId)
  emitPackRuntimeEvents(config.handlers, [{
    type: 'interaction.signal',
    at,
    provenance: { source: 'simulator', adapterId: processPlantSimAdapterId },
    signal: {
      id: `process-plant-offsite-isolation:${randomUUID()}` as SignalId,
      simulationRunId: config.simulationRunId,
      at,
      source: { kind: 'simulation', id: processPlantSimRuntimeId },
      targets: [{ kind: 'broadcast' }],
      type: config.isolated ? 'process-plant.offsite.isolated' : 'process-plant.offsite.restored',
      severity: config.isolated ? 'warning' : 'info',
      payload: {
        plantId,
        portId: config.connection.system.portId,
        gridObjectId: config.connection.network.objectId,
        gridPortId: config.connection.network.portId,
        cause: config.cause,
        message: config.isolated
          ? `${plantId} is isolated from ${config.connection.network.objectId} by a plant-side fault (${config.cause}): its offsite source holds unavailable and its port reports disconnected until available is set true`
          : `${plantId}'s offsite isolation from ${config.connection.network.objectId} is cleared (${config.cause}); the Grid port's state applies again`,
      },
    },
  }])
}

/**
 * The Grid boundary state a Plant reads: a live port has frequency and a voltage, unless the Grid's
 * AC load flow did not converge there (null); a dead one has neither.
 */
type NetworkPortState =
  | { readonly connected: boolean; readonly energized: true; readonly voltagePu: number | null; readonly frequencyHz: number }
  | { readonly connected: boolean; readonly energized: false; readonly voltagePu: 0; readonly frequencyHz: null }

export const createLocalProcessPlantPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: processPlantSimRuntimeId,
  version: '1.0.0',
  packId: processPlantPackId,
  clock: 'simulation',
  capabilities: processPlantCapabilities,
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const handlers = new Set<PackRuntimeEventHandler>()
    const rawRuntimeState = await config.runtimeStateStore?.load()
    const runtimeState = rawRuntimeState === undefined || rawRuntimeState === null
      ? null
      : processPlantRuntimeStateSchema.parse(rawRuntimeState) as ProcessPlantRuntimeState
    const initialObjects = initialProcessPlantObjects(config)
    const compiledPlants = compileProcessPlants(processPlantDefinitionsFor(initialObjects))
    const plants = createProcessPlantRuntimeInstances({
      compiledPlants,
      runtimeState,
    })
    const systemConnections = systemConnectionsFor(config.scenario.connections, plants)
    const connectedPlantIds = new Set(systemConnections.map(connection => String(connection.system.objectId)))
    const networkAvailableByPlant = new Map<string, boolean>()
    const boundaryVariablesByPlant = coupledBoundaryVariables(systemConnections, plants)
    const connectionKey = (connection: ElectricalConnectionDefinition): string => `${connection.system.objectId}\u0000${connection.system.portId}`
    // Plant-side isolations of connected ports (offsite-isolation.ts), restored with the Plants' state.
    const offsiteIsolations = new Map<string, OffsiteIsolation[]>()
    for (const plantId of plants.keys()) {
      const restored = restoredOffsiteIsolationsFor(runtimeState, plantId)
      for (const isolation of restored) {
        if (!systemConnections.some(connection => String(connection.system.objectId) === plantId && connection.system.portId === isolation.portId)) {
          throw new Error(`restored offsite isolation names a port with no Grid connection: ${plantId}:${isolation.portId}`)
        }
      }
      if (restored.length > 0) offsiteIsolations.set(plantId, restored.map(isolation => ({ ...isolation })))
    }
    const isolationOf = (connection: ElectricalConnectionDefinition): OffsiteIsolation | undefined =>
      offsiteIsolations.get(String(connection.system.objectId))?.find(isolation => isolation.portId === connection.system.portId)
    // The last Grid port state each connection delivered, re-applied when an isolation changes.
    const lastNetworkStateByConnection = new Map<string, NetworkPortState>()

    const queueNetworkState = (
      connection: ElectricalConnectionDefinition,
      state: NetworkPortState,
    ): void => {
      const plant = plants.get(connection.system.objectId)
      if (!plant) return
      const boundary = processPlantElectricalBoundaries(plant.plant)
        .find(candidate => candidate.port.id === connection.system.portId)
      if (!boundary) throw new Error(`process plant electrical boundary disappeared: ${connection.system.objectId}:${connection.system.portId}`)
      // A dead Grid boundary has no frequency: it makes offsite power unavailable at voltage 0, and no
      // frequency is written into the Plant. A live boundary without a solved voltage is a network
      // that cannot hold its voltage there (no AC steady state): the Plant treats it as lost offsite power too.
      // A plant-side isolation holds against the port: no offsite voltage or frequency reaches the Plant.
      lastNetworkStateByConnection.set(connectionKey(connection), state)
      const live = isolationOf(connection) === undefined && state.connected && state.energized && state.voltagePu !== null ? { voltagePu: state.voltagePu, frequencyHz: state.frequencyHz } : null
      plant.runtime.writeCommand({ type: 'setVariable', path: componentVariablePath(boundary.component, 'available'), value: live !== null })
      plant.runtime.writeCommand({ type: 'setVariable', path: componentVariablePath(boundary.component, 'voltageFraction'), value: live === null ? 0 : live.voltagePu })
      if (live !== null) plant.runtime.writeCommand({ type: 'setVariable', path: componentVariablePath(boundary.component, 'frequencyHz'), value: live.frequencyHz })
      const available = live !== null
      networkAvailableByPlant.set(String(connection.system.objectId), available)
    }

    const observeNetworkObjects = (
      objects: ReadonlyArray<OperationalObject>,
      initialSnapshot = false,
    ): void => {
      const byId = new Map(objects.map(object => [object.id, object]))
      for (const connection of systemConnections) {
        const object = byId.get(connection.network.objectId)
        if (!object) continue
        const port = electricalPortFromObject(object, connection.network.portId)
        if (!port?.state) throw new Error(`connected Grid port has no live state: ${connection.network.objectId}:${connection.network.portId}`)
        // At bootstrap the Grid has already solved its bus state, but it cannot
        // have observed this Plant's first projection yet. The declared
        // connection plus an energized Grid boundary is sufficient for initial
        // offsite-power availability; normal committed updates use live
        // connection state after the runtimes begin exchanging projections.
        queueNetworkState(connection, initialSnapshot
          ? { ...port.state, connected: port.state.energized }
          : port.state)
      }
    }
    const deadPortState: NetworkPortState = { connected: false, energized: false, voltagePu: 0, frequencyHz: null }
    /** Latches and clears plant-side isolations a command's accepted writes cause, and re-applies the boundary. */
    const applyCoupledBoundaryEffect = (effect: CoupledBoundaryEffect, cause: string): void => {
      for (const connection of effect.isolate) {
        if (isolationOf(connection) !== undefined) continue
        const plantId = String(connection.system.objectId)
        offsiteIsolations.set(plantId, [...(offsiteIsolations.get(plantId) ?? []), { portId: connection.system.portId, cause }])
        queueNetworkState(connection, lastNetworkStateByConnection.get(connectionKey(connection)) ?? deadPortState)
        emitOffsiteIsolationChange({ handlers, simulationRunId: config.simulationRunId, connection, isolated: true, cause })
      }
      for (const connection of effect.clear) {
        if (isolationOf(connection) === undefined) continue
        const plantId = String(connection.system.objectId)
        const remaining = (offsiteIsolations.get(plantId) ?? []).filter(isolation => isolation.portId !== connection.system.portId)
        if (remaining.length === 0) offsiteIsolations.delete(plantId)
        else offsiteIsolations.set(plantId, remaining)
        queueNetworkState(connection, lastNetworkStateByConnection.get(connectionKey(connection)) ?? deadPortState)
        emitOffsiteIsolationChange({ handlers, simulationRunId: config.simulationRunId, connection, isolated: false, cause })
      }
    }

    const persistence = createRuntimeStateWriter({
      ...(config.runtimeStateStore === undefined ? {} : { store: config.runtimeStateStore }),
      readState: () => runtimeStateForProcessPlants(plants, offsiteIsolations),
      delayMs: defaultSimulationRunRuntimePolicy.runtimePrivateStateFlushIntervalMs,
      label: 'process-plant',
    })
    if (config.recording?.packId !== undefined && config.recording.packId !== processPlantPackId) {
      throw new Error(`process plant runtime received recording selection for Pack ${config.recording.packId}`)
    }
    let recordingPlan = config.recording === undefined
      ? null
      : createProcessPlantRecordingPlan({ selection: config.recording, plants })
    let recordingDescriptorsPending = recordingPlan !== null
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    // Composed displays say which trended signals have history in this Run.
    const recordedSeriesFor = (plan: typeof recordingPlan): ReadonlySet<string> => new Set(plan?.descriptors.map(descriptor => descriptor.id) ?? [])
    let recordedSeriesIds = recordedSeriesFor(recordingPlan)
    let clock: SimulationClockState = {
      currentTime: config.scenario.world.startsAt,
      updatedAt: nowIso(),
      paused: false,
    }
    clock = config.runClock?.read() ?? clock
    const localClock = config.runClock ? null : createSimulationClock(clock)
    const runClock = config.runClock ?? localClock!
    let clockInitialized = false
    let lastSimulationMs = Date.parse(clock.currentTime)
    const objectsById = new Map<ObjectId, OperationalObject>(
      projectedInitialProcessPlantObjects({
        objects: initialObjects,
        plants,
        at: nowIso(),
        connectedPlantIds,
      }).map(object => [object.id, object]),
    )

    // How AI agents operate each Plant, as its object declares it (ProcessPlantUnitPackData.aiOperation).
    const aiOperationOf = (plantId: string): ProcessPlantUnitPackData['aiOperation'] =>
      processPlantUnitPackDataSchema.parse(objectsById.get(plantId as ObjectId)?.packData).aiOperation

    // The operations log keeps what people and AI agents did; the Run's own writes are its Scenario's.
    const recordOperation = (
      plant: ProcessPlantRuntimeInstance,
      command: CommandEnvelope,
      context: PackCommandContext,
      write: { readonly path: VariablePath; readonly value: ProcessVariableValue; readonly kind: 'write' | 'ramp' | 'approval'; readonly proposalId?: string },
    ): void => {
      if (plant.operations === undefined || (context.origin !== 'person' && context.origin !== 'ai')) return
      const at = { elapsedMs: plant.runtime.elapsedMs(), wallMs: Date.now() }
      // A throttle under a standing actuation is logged with the actuations it sits under.
      const under = plant.protection === undefined ? [] : throttledUnder(plant.plant, plant.protection.snapshot(), write)
      const transitions = plant.operations.record({
        commandId: command.id, actorId: command.actorId, origin: context.origin, elapsedMs: at.elapsedMs, ...write,
        ...(under.length === 0 ? {} : { throttledUnder: [...under] }),
      }, at)
      emitPackRuntimeEvents(handlers, proposalSignalEvents(config.simulationRunId, transitions))
    }

    /**
     * A person's reset of a latched actuation, executed directly or approved
     * from a proposal: allowed only as actuation-reset.ts offers it now; it
     * clears the latch and writes nothing, and is logged with what it held.
     * Returns why it is refused, or null.
     */
    const resetActuation = (
      plant: ProcessPlantRuntimeInstance,
      command: CommandEnvelope,
      context: PackCommandContext,
      ruleId: string,
      reason: string | undefined,
      proposalId?: string,
    ): string | null => {
      if (plant.protection === undefined) return `process plant I&C is not configured for plant: ${plant.plant.id}`
      // An AI agent resets one itself only as the operator of a procedure it drives on this Plant.
      if (context.origin !== 'person' && context.origin !== 'system' && !(context.origin === 'ai' && drivesProcedureOn(context, plant.plant.id))) {
        return context.origin === 'ai'
          ? 'An AI agent proposes an actuation reset for a person to approve (world.process-plant.control.propose with reset); it resets one itself only while it drives an active procedure Run on this Plant'
          : 'A reset needs who takes it'
      }
      const refusal = resetRefusal(plant.plant, plant.protection.snapshot(), ruleId, resetContextFor(plant))
      if (refusal !== null) return refusal
      const reset = listedResetsFor(plant).find(candidate => candidate.ruleId === ruleId)!
      const events = plant.protection.resetActuation({
        ruleId,
        elapsedMs: plant.runtime.elapsedMs(),
        simulationRunId: config.simulationRunId,
        sourceRuntimeId: processPlantSimRuntimeId,
        actorId: command.actorId,
        ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
        ...(reason === undefined ? {} : { reason }),
      })
      emitPackRuntimeEvents(handlers, events)
      if (plant.operations !== undefined && context.origin === 'person') {
        const at = { elapsedMs: plant.runtime.elapsedMs(), wallMs: Date.now() }
        const transitions = plant.operations.recordReset({
          commandId: command.id, kind: 'reset', ruleId, label: reset.label, holds: [...reset.holds],
          origin: context.origin, actorId: command.actorId, elapsedMs: at.elapsedMs,
          ...(proposalId === undefined ? {} : { proposalId }),
        }, at)
        emitPackRuntimeEvents(handlers, proposalSignalEvents(config.simulationRunId, transitions))
      }
      return null
    }

    let runtimeFailureReason: string | null = null
    let failureAt = nowIso()
    let lastSuccessfulInteractionAt = nowIso()

    const rebuildRecordingPlan = (): void => {
      recordingPlan = config.recording === undefined || plants.size === 0
        ? null
        : createProcessPlantRecordingPlan({ selection: config.recording, plants })
      recordingDescriptorsPending = recordingPlan !== null
      nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
      recordedSeriesIds = recordedSeriesFor(recordingPlan)
    }

    const advance = async (targetSimulationMs = Date.parse(runClock.read().currentTime)): Promise<void> => {
      if (runtimeFailureReason !== null) return
      const simulationMs = targetSimulationMs
      const elapsedMs = Math.max(0, simulationMs - lastSimulationMs)
      lastSimulationMs = simulationMs
      if (elapsedMs <= 0 || plants.size === 0) return
      for (const connection of systemConnections) {
        const plantId = String(connection.system.objectId)
        if (config.isObjectProviderAvailable?.(connection.network.objectId) === false && networkAvailableByPlant.get(plantId) !== false) {
          queueNetworkState(connection, { connected: false, energized: false, voltagePu: 0, frequencyHz: null })
        }
      }
      const events: PackRuntimeEvent[] = []
      for (const { runtime, ramps, protection, operations, performance: runtimePerformance } of plants.values()) {
        const startedAt = performance.now()
        ramps.apply(runtime.elapsedMs() + elapsedMs)
        const tick = runtime.tick(elapsedMs)
        events.push(...(protection?.evaluate({
          runtime,
          elapsedMs: runtime.elapsedMs(),
          simulationRunId: config.simulationRunId,
          sourceRuntimeId: processPlantSimRuntimeId,
        }) ?? []))
        // A proposal lapses at its plant time, never within a minute of wall time (proposals.ts).
        events.push(...proposalSignalEvents(config.simulationRunId, operations?.expire({ elapsedMs: runtime.elapsedMs(), wallMs: Date.now() }) ?? []))
        runtimePerformance.record({
          wallMs: performance.now() - startedAt,
          simulatedMs: tick.simulatedMs,
        })
      }
      events.push(...processPlantProjectionEvents({
        objectsById,
        plants,
        at: nowIso(),
        connectedPlantIds,
        provenance: {
          source: 'simulator',
          adapterId: processPlantSimAdapterId,
        },
      }))
      const recordedElapsedMs = simulationMs - Date.parse(config.scenario.world.startsAt)
      const recording = recordingPlan !== null && recordedElapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = recordedElapsedMs + recordingPlan.intervalMs
            const sampled = recordingPlan.sample({
              observedAt: nowIso(),
              simulationTime: new Date(simulationMs).toISOString() as IsoTimestamp,
            })
            if (!recordingDescriptorsPending) return sampled
            recordingDescriptorsPending = false
            return { ...sampled, descriptors: [...recordingPlan.descriptors] }
          })()
        : undefined
      emitPackRuntimeEvents(handlers, events, recording)
      lastSuccessfulInteractionAt = nowIso()
      persistence.scheduleSave()
    }

    const interval = setInterval(() => {
      const runAdvance = async (): Promise<void> => {
        try {
          await advance()
        } catch (error) {
          runtimeFailureReason = error instanceof Error ? error.message : String(error)
          failureAt = nowIso()
          clearInterval(interval)
          emitRuntimeFailure({
            handlers,
            simulationRunId: config.simulationRunId,
            error,
          })
        }
      }
      void runAdvance()
    }, updateIntervalMs)

    return {
      health: () => [{ runtimeId: processPlantSimRuntimeId, state: runtimeFailureReason === null ? 'ready' : 'failed',
        failureCount: runtimeFailureReason === null ? 0 : 1, lastSuccessfulInteractionAt,
        ...(runtimeFailureReason === null ? {} : { lastFailure: { at: failureAt, operation: 'advance', message: runtimeFailureReason } }) }],
      getSnapshot: async () => ({
        simulationRunId: config.simulationRunId,
        objects: [...objectsById.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler: PackRuntimeEventHandler): (() => void) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand: async (command: CommandEnvelope, context: PackCommandContext): Promise<CommandResult> => {
        const acceptedAt = nowIso()
        if (runtimeFailureReason !== null) {
          return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant runtime has stopped after a runtime failure: ${runtimeFailureReason}` }
        }
        if (command.kind === processPlantActionInvokeCommandKind) {
          const payload = processPlantActionInvokePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          const aiRefusal = aiProposeOnlyRefusal(command.kind, context, payload.data.plantId, aiOperationOf(payload.data.plantId))
          if (aiRefusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: aiRefusal }
          try {
            const commands = commandsForProcessPlantAction({
              actionId: payload.data.actionId,
              parameters: payload.data.parameters,
              graph: plant.plant.graph,
            })
            const validated = commands.map(actionCommand => {
              const result = validateProcessPlantControlWrite({
                system: plant.plant,
                runtime: plant.runtime,
                ...(plant.protection === undefined ? {} : { protection: plant.protection }),
                payload: {
                  plantId: payload.data.plantId,
                  path: actionCommand.path,
                  value: actionCommand.value,
                },
              })
              if (!result.accepted) throw new Error(result.reason)
              // An instructor action is a person's or the Scenario's; an AI agent's reaches no fault or boundary input.
              const refusal = context.origin === 'ai' ? instructorOnlyRefusal(plant.plant.graph.signalBindingByPath.get(result.targetPath)!, context.origin) : null
              if (refusal !== null) throw new Error(refusal)
              return { type: 'setVariable' as const, path: result.targetPath, value: actionCommand.value }
            })
            const boundary = coupledBoundaryEffect(boundaryVariablesByPlant.get(payload.data.plantId), validated)
            if (!boundary.ok) throw new Error(boundary.reason)
            for (const actionCommand of validated) plant.runtime.writeCommand(actionCommand)
            applyCoupledBoundaryEffect(boundary.effect, `action ${payload.data.actionId}`)
            await persistence.saveNow()
            return { ok: true, commandId: command.id, acceptedAt }
          } catch (err) {
            return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: err instanceof Error ? err.message : String(err) }
          }
        }
        if (command.kind === processPlantIcLifecycleCommandKind) {
          const payload = processPlantIcLifecyclePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          const aiRefusal = aiProposeOnlyRefusal(command.kind, context, payload.data.plantId, aiOperationOf(payload.data.plantId))
          if (aiRefusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: aiRefusal }
          if (!plant.protection) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant I&C is not configured for plant: ${payload.data.plantId}` }
          // Resetting a latched protection actuation's alarm or trip resets the actuation: as a reset is offered, never around it.
          const snapshot = plant.protection.snapshot()
          const ruleId = [...snapshot.trips, ...snapshot.alarms].find(lifecycle => lifecycle.id === payload.data.lifecycleId)?.ruleId
          const rule = plant.plant.automation.rules.find(candidate => candidate.id === ruleId)
          if (payload.data.action === 'reset' && rule !== undefined && rule.ruleClass === 'protection' && rule.latch && snapshot.rules.find(state => state.ruleId === rule.id)?.latched === true) {
            const refusal = resetActuation(plant, command, context, rule.id, payload.data.reason)
            if (refusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: refusal }
            await persistence.saveNow()
            return { ok: true, commandId: command.id, acceptedAt }
          }
          try {
            const events = plant.protection.applyLifecycleAction({
              id: payload.data.lifecycleId,
              action: payload.data.action,
              elapsedMs: plant.runtime.elapsedMs(),
              simulationRunId: config.simulationRunId,
              sourceRuntimeId: processPlantSimRuntimeId,
              actorId: command.actorId,
              ...(command.clientId === undefined ? {} : { clientId: command.clientId }),
              ...(payload.data.reason === undefined ? {} : { reason: payload.data.reason }),
              ...(payload.data.shelveDurationMs === undefined ? {} : { shelveDurationMs: payload.data.shelveDurationMs }),
            })
            emitPackRuntimeEvents(handlers, events)
            await persistence.saveNow()
            return { ok: true, commandId: command.id, acceptedAt }
          } catch (err) {
            return {
              ok: false,
              commandId: command.id,
              rejectedAt: acceptedAt,
              reason: err instanceof Error ? err.message : String(err),
            }
          }
        }
        if (command.kind === processPlantControlProposeCommandKind) {
          const payload = processPlantControlProposePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          if (plant.operations === undefined) throw new Error(`process plant ${payload.data.plantId} keeps no operations record`)
          if (context.origin !== 'person' && context.origin !== 'ai') return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: 'Only a person or an AI agent proposes an operation' }
          try {
            const operation = payload.data.reset !== undefined ? { reset: payload.data.reset } : {
              write: {
                path: resolveProcessPlantSignalBinding(plant.plant.graph, payload.data.path !== undefined ? { path: payload.data.path } : { tagId: payload.data.tagId! }).path,
                value: payload.data.value!,
              },
            }
            const step = proposeOperation(plant.operations.book(), {
              id: command.id,
              plantId: payload.data.plantId,
              ...operation,
              reason: payload.data.reason,
              ...(payload.data.procedureStep === undefined ? {} : { procedureStep: payload.data.procedureStep }),
              evidence: payload.data.evidence,
              proposer: { actorId: command.actorId, origin: context.origin },
              at: { elapsedMs: plant.runtime.elapsedMs(), wallMs: Date.now() },
            }, proposalPortsFor(plant, context.origin))
            if (!step.ok) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: step.reason! }
            plant.operations.setBook(step.book)
            emitPackRuntimeEvents(handlers, proposalSignalEvents(config.simulationRunId, step.transitions))
            await persistence.saveNow()
            // The proposer reads at once what it proposed: the control's word and what the operation takes away now.
            const recorded = step.book.proposals.find(proposal => proposal.id === command.id)!
            const accepted: ProcessPlantControlProposeResult = {
              ok: true, commandId: command.id, acceptedAt, word: recorded.word,
              ...(recorded.consequence === undefined ? {} : { consequence: recorded.consequence }),
            }
            return accepted
          } catch (err) {
            return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: err instanceof Error ? err.message : String(err) }
          }
        }
        if (command.kind === processPlantActuationResetCommandKind) {
          const payload = processPlantActuationResetPayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          const refusal = resetActuation(plant, command, context, payload.data.ruleId, payload.data.reason)
          if (refusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: refusal }
          await persistence.saveNow()
          return { ok: true, commandId: command.id, acceptedAt }
        }
        if (command.kind === processPlantControlDecideCommandKind) {
          const payload = processPlantControlDecidePayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          if (plant.operations === undefined) throw new Error(`process plant ${payload.data.plantId} keeps no operations record`)
          if (context.origin === undefined) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: 'A decision on a proposal needs who takes it' }
          const step = decideProposal(plant.operations.book(), {
            proposalId: payload.data.proposalId,
            decision: payload.data.decision,
            decider: { actorId: command.actorId, origin: context.origin },
            commandId: command.id,
            ...(payload.data.reason === undefined ? {} : { reason: payload.data.reason }),
            at: { elapsedMs: plant.runtime.elapsedMs(), wallMs: Date.now() },
          }, proposalPortsFor(plant, context.origin))
          plant.operations.setBook(step.book)
          emitPackRuntimeEvents(handlers, proposalSignalEvents(config.simulationRunId, step.transitions))
          // An approval executes the stored write, validated again under the approver's guards, as a control write does; or the stored reset.
          if (step.ok && step.execute !== undefined) {
            plant.runtime.writeCommand({ type: 'setVariable', path: step.execute.path, value: step.execute.value })
            recordOperation(plant, command, context, { path: step.execute.path, value: step.execute.value, kind: 'approval', proposalId: payload.data.proposalId })
          }
          if (step.ok && step.executeReset !== undefined) {
            const refusal = resetActuation(plant, command, context, step.executeReset, payload.data.reason, payload.data.proposalId)
            if (refusal !== null) throw new Error(`an approved reset was refused after its check: ${refusal}`)
          }
          await persistence.saveNow()
          return step.ok ? { ok: true, commandId: command.id, acceptedAt } : { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: step.reason! }
        }
        if (command.kind === processPlantControlRampCommandKind) {
          const payload = processPlantControlRampPayloadSchema.safeParse(command.payload)
          if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
          const plant = plants.get(payload.data.plantId)
          if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
          const aiRefusal = aiProposeOnlyRefusal(command.kind, context, payload.data.plantId, aiOperationOf(payload.data.plantId))
          if (aiRefusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: aiRefusal }
          const validation = validateOperatorWrite({
            system: plant.plant,
            runtime: plant.runtime,
            ...(plant.protection === undefined ? {} : { protection: plant.protection }),
            payload: {
              plantId: payload.data.plantId,
              ...(payload.data.path === undefined ? {} : { path: payload.data.path }),
              ...(payload.data.tagId === undefined ? {} : { tagId: payload.data.tagId }),
              value: payload.data.targetValue,
            },
            origin: context.origin,
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          const rampRefusal = coupledBoundaryRampRefusal(boundaryVariablesByPlant.get(payload.data.plantId), validation.targetPath)
          if (rampRefusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: rampRefusal }
          plant.ramps.start({
            id: command.id,
            path: validation.targetPath,
            target: payload.data.targetValue,
            durationMs: payload.data.durationSeconds * 1_000,
          })
          recordOperation(plant, command, context, { path: validation.targetPath, value: payload.data.targetValue, kind: 'ramp' })
          await persistence.saveNow()
          return { ok: true, commandId: command.id, acceptedAt }
        }
        if (command.kind !== processPlantControlWriteCommandKind) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: `process plant runtime does not accept command kind: ${command.kind}`,
          }
        }
        const payload = processPlantControlWritePayloadSchema.safeParse(command.payload)
        if (!payload.success) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: payload.error.message }
        const plant = plants.get(payload.data.plantId)
        if (!plant) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: `process plant not found: ${payload.data.plantId}` }
        const aiRefusal = aiProposeOnlyRefusal(command.kind, context, payload.data.plantId, aiOperationOf(payload.data.plantId))
        if (aiRefusal !== null) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: aiRefusal }
        try {
          const validation = validateOperatorWrite({
            system: plant.plant,
            runtime: plant.runtime,
            ...(plant.protection === undefined ? {} : { protection: plant.protection }),
            payload: payload.data,
            origin: context.origin,
          })
          if (!validation.accepted) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: validation.reason }
          const boundary = coupledBoundaryEffect(boundaryVariablesByPlant.get(payload.data.plantId), [{ path: validation.targetPath, value: payload.data.value }])
          if (!boundary.ok) return { ok: false, commandId: command.id, rejectedAt: acceptedAt, reason: boundary.reason }
          plant.runtime.writeCommand({
            type: 'setVariable',
            path: validation.targetPath,
            value: payload.data.value,
          })
          applyCoupledBoundaryEffect(boundary.effect, `control write by ${command.actorId}`)
          recordOperation(plant, command, context, { path: validation.targetPath, value: payload.data.value, kind: 'write' })
          await persistence.saveNow()
          return { ok: true, commandId: command.id, acceptedAt }
        } catch (err) {
          return {
            ok: false,
            commandId: command.id,
            rejectedAt: acceptedAt,
            reason: err instanceof Error ? err.message : String(err),
          }
        }
      },
      invokeQuery: async (request: PackRuntimeQuery): Promise<unknown> => {
        if (runtimeFailureReason !== null) throw new Error(`Process Plant runtime has stopped after a runtime failure: ${runtimeFailureReason}`)
        if (plants.size === 0) throw new Error('Process Plant runtime is not active for this Scenario')
        return answerProcessPlantQuery({
          request,
          plants,
          objects: objectsById,
          simulationTime: new Date(lastSimulationMs).toISOString() as IsoTimestamp,
          recordedSeriesIds,
          ...(config.recordedHistory === undefined ? {} : { recordedHistory: config.recordedHistory }),
        })
      },
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        let plantRemoved = false
        for (const event of events) {
          if (event.type === 'object.upserted' && processPlantIdForObject(event.object) !== null) {
            objectsById.set(event.object.id, event.object)
          }
          if (event.type !== 'object.deleted') continue
          objectsById.delete(event.objectId)
          if (plants.delete(event.objectId)) {
            const plantId = String(event.objectId)
            connectedPlantIds.delete(plantId)
            networkAvailableByPlant.delete(plantId)
            plantRemoved = true
          }
          for (const connection of systemConnections) {
            if (connection.network.objectId !== event.objectId) continue
            queueNetworkState(connection, { connected: false, energized: false, voltagePu: 0, frequencyHz: null })
          }
        }
        observeNetworkObjects(events.flatMap(event => event.type === 'object.upserted' ? [event.object] : []))
        if (plantRemoved) {
          rebuildRecordingPlan()
          await persistence.saveNow()
        }
      },
      observeInitialSnapshot: async (objects: ReadonlyArray<OperationalObject>): Promise<void> => {
        observeNetworkObjects(objects, true)
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        if (clockInitialized) await advance()
        clockInitialized = true
        clock = nextClock
        localClock?.set(nextClock)
        lastSimulationMs = Date.parse(runClock.read().currentTime)
      },
      advanceTo: async (nextClock: SimulationClockState): Promise<void> => {
        await advance(Date.parse(nextClock.currentTime))
        clock = nextClock
        localClock?.set(nextClock)
      },
      checkpoint: persistence.saveNow,
      close: async (): Promise<void> => {
        clearInterval(interval)
        await persistence.close()
        handlers.clear()
      },
    }
  },
})
