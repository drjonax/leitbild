import type {
  CommandEnvelope,
  CommandResult,
  ElectricalConnectionDefinition,
  IsoTimestamp,
  ObjectId,
  OperationalObject,
  PackRuntimeRecordingBatch,
  Provenance,
  SignalId,
  SimulationClockState,
  SimulationRunEvent,
} from '../../../core/model/index.ts'
import { electricalPortFromObject,nowIso } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeConnectionConfig,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeEventHistory,
  PackRuntimeQuery,
} from '../../../simulation/protocol.ts'
import {
  electricGridCommandCapabilities,
  electricGridCommandKinds,
  gridClearDerateCommandKind,
  gridClearDeratePayloadSchema,
  gridCloseBranchCommandKind,
  gridCloseBranchPayloadSchema,
  gridDerateBranchCommandKind,
  gridDerateBranchPayloadSchema,
  gridDispatchGeneratorCommandKind,
  gridDispatchGeneratorPayloadSchema,
  gridOpenBranchCommandKind,
  gridOpenBranchPayloadSchema,
  gridRestoreLoadCommandKind,
  gridRestoreLoadPayloadSchema,
  gridReturnGeneratorToServiceCommandKind,
  gridReturnGeneratorToServicePayloadSchema,
  gridSetEvChargingDemandCommandKind,
  gridSetEvChargingDemandPayloadSchema,
  gridSetGeneratorAvailabilityCommandKind,
  gridSetGeneratorAvailabilityPayloadSchema,
  gridShedLoadCommandKind,
  gridShedLoadPayloadSchema,
  gridTripGeneratorCommandKind,
  gridTripGeneratorPayloadSchema,
} from '../commands.ts'
import { gridDefinitionSchema } from '../config.ts'
import { defaultSimulationRunRuntimePolicy } from '../../../core/simulation-runs/runtime-persistence-policy.ts'
import { createRuntimeStateWriter } from '../../../simulation/runtime-state-writer.ts'
import { electricGridPackDataSchema,electricGridPackId } from '../model.ts'
import { answerElectricGridQuery,electricGridQueryCapabilities } from '../queries/index.ts'
import { createGridRecordingPlan } from '../recording.ts'
import { balanceInitialGridDispatch,createGridRuntimeInstance,type GridRuntimeInstance } from '../runtime/instance.ts'
import { advanceGrid } from '../runtime/solver.ts'
import { electricGridAdapterId,electricGridRuntimeId } from './constants.ts'
import { gridProjectionEvents,projectGridObject,projectedInitialGridObjects } from './object-projection.ts'
import { electricGridRuntimeStateSchema,restoredGridRuntimeStateFor,runtimeStateForElectricGrids } from './runtime-state.ts'

const updateIntervalMs = 2_000

const networkConnectionsFor = (
  connections: ReadonlyArray<ElectricalConnectionDefinition>,
  gridId: string,
): ReadonlyArray<ElectricalConnectionDefinition> =>
  connections.filter(connection => connection.network.objectId === gridId)

const emit = (config: {
  readonly handlers: ReadonlySet<PackRuntimeEventHandler>
  readonly events: ReadonlyArray<PackRuntimeEvent>
  readonly recording?: PackRuntimeRecordingBatch
}): void => {
  if (config.events.length === 0 && config.recording === undefined) return
  const emittedAt = nowIso()
  for (const handler of config.handlers) handler({
    type: 'event.emission',
    runtimeId: electricGridRuntimeId,
    emittedAt,
    events: config.events,
    ...(config.recording === undefined ? {} : { recording: config.recording }),
  })
}

const commandRejected = (command: CommandEnvelope, reason: string): CommandResult => ({
  ok: false,
  commandId: command.id,
  rejectedAt: nowIso(),
  reason,
})

const gridObjectDefinitions = (objects: ReadonlyArray<OperationalObject>) => objects.flatMap(object => {
  if (object.packId !== electricGridPackId) return []
  const data = electricGridPackDataSchema.parse(object.packData)
  return [{
    object,
    definition: gridDefinitionSchema.parse({
      id: object.id,
      model: data.model,
      operatingPoint: data.operatingPoint,
      automation: data.automation,
    }),
  }]
})

const requireGrid = (grids: ReadonlyMap<string, GridRuntimeInstance>, command: CommandEnvelope): GridRuntimeInstance => {
  if (command.targetObjectIds.length !== 1) throw new Error('electric-grid commands require exactly one target Grid object')
  const gridId = command.targetObjectIds[0]!
  const grid = grids.get(gridId)
  if (!grid) throw new Error(`target Grid not found: ${gridId}`)
  return grid
}

const applyCommand = (grid: GridRuntimeInstance, command: CommandEnvelope): void => {
  if (command.kind === gridDispatchGeneratorCommandKind) {
    const payload = gridDispatchGeneratorPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    if (state.state !== 'online') throw new Error(`generator Grid Asset ${payload.assetId} is ${state.state}; return it to service before dispatching`)
    state.targetMw = Math.min(payload.targetMw, state.availableMw)
    return
  }
  if (command.kind === gridTripGeneratorCommandKind) {
    const payload = gridTripGeneratorPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.state = 'tripped'
    state.dispatchMw = 0
    state.targetMw = 0
    return
  }
  if (command.kind === gridSetGeneratorAvailabilityCommandKind) {
    const payload = gridSetGeneratorAvailabilityPayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'generator' ? entry.definition : undefined
    if (!state || !definition) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.availableMw = Math.min(payload.availableMw, definition.capacityMw)
    state.targetMw = Math.min(state.targetMw, state.availableMw)
    state.dispatchMw = Math.min(state.dispatchMw, state.availableMw)
    if (state.availableMw === 0 && state.state === 'online') state.state = 'offline'
    return
  }
  if (command.kind === gridReturnGeneratorToServiceCommandKind) {
    const payload = gridReturnGeneratorToServicePayloadSchema.parse(command.payload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    if (state.availableMw <= 0) throw new Error(`generator Grid Asset ${payload.assetId} has no available capacity`)
    state.state = 'online'
    state.dispatchMw = 0
    state.targetMw = 0
    return
  }
  if (command.kind === gridOpenBranchCommandKind || command.kind === gridCloseBranchCommandKind || command.kind === gridDerateBranchCommandKind || command.kind === gridClearDerateCommandKind) {
    const payload = command.kind === gridOpenBranchCommandKind
      ? gridOpenBranchPayloadSchema.parse(command.payload)
      : command.kind === gridCloseBranchCommandKind
        ? gridCloseBranchPayloadSchema.parse(command.payload)
        : command.kind === gridDerateBranchCommandKind
          ? gridDerateBranchPayloadSchema.parse(command.payload)
          : gridClearDeratePayloadSchema.parse(command.payload)
    const state = grid.branches.get(payload.assetId)
    if (!state) throw new Error(`branch Grid Asset not found: ${payload.assetId}`)
    if (command.kind === gridOpenBranchCommandKind) state.state = 'open'
    if (command.kind === gridCloseBranchCommandKind) state.state = 'closed'
    if (command.kind === gridClearDerateCommandKind) state.availability = 1
    if (command.kind === gridDerateBranchCommandKind) state.availability = gridDerateBranchPayloadSchema.parse(command.payload).availability
    if (command.kind === gridOpenBranchCommandKind || command.kind === gridCloseBranchCommandKind) grid.topologyPlan = null
    return
  }
  if (command.kind === gridShedLoadCommandKind) {
    const payload = gridShedLoadPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || !definition.controllable) throw new Error(`controllable load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, state.nominalDemandMw - payload.amountMw)
    return
  }
  if (command.kind === gridRestoreLoadCommandKind) {
    const payload = gridRestoreLoadPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || !definition.controllable) throw new Error(`controllable load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = definition.demandMw * grid.definition.operatingPoint.loadScale
    return
  }
  if (command.kind === gridSetEvChargingDemandCommandKind) {
    const payload = gridSetEvChargingDemandPayloadSchema.parse(command.payload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || definition.kind !== 'ev_charging' || !definition.controllable) throw new Error(`controllable EV charging Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, payload.demandMw)
    return
  }
  throw new Error(`electric-grid runtime does not accept command kind: ${command.kind}`)
}

export const createLocalElectricGridPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: electricGridRuntimeId,
  version: '1.0.0',
  packId: electricGridPackId,
  clock: 'simulation',
  capabilities: [...electricGridCommandCapabilities, ...electricGridQueryCapabilities],
  connect: async (config: PackRuntimeConnectionConfig): Promise<PackRuntimeConnection> => {
    const { compileGridDefinition } = await import('../definitions.ts')
    const initialObjects = (config.initialObjects ?? config.scenario.initialObjects).filter(object => object.packId === electricGridPackId)
    const rawState = await config.runtimeStateStore?.load()
    const runtimeState = rawState === undefined || rawState === null ? null : electricGridRuntimeStateSchema.parse(rawState)
    const initialAt = config.scenario.world.startsAt
    const grids = new Map<string, GridRuntimeInstance>()
    const initiallyBalancedGridIds = new Set<string>()
    for (const item of gridObjectDefinitions(initialObjects)) {
      const definition = compileGridDefinition(item.definition)
      const restored = restoredGridRuntimeStateFor(runtimeState, item.object.id, definition.definitionDigest)
      if (restored !== undefined) initiallyBalancedGridIds.add(item.object.id)
      grids.set(item.object.id, createGridRuntimeInstance({
        definition,
        at: initialAt,
        connections: networkConnectionsFor(config.scenario.connections, item.object.id),
        ...(restored === undefined ? {} : { restored }),
      }))
    }
    for (const grid of grids.values()) advanceGrid(grid, 0, initialAt)
    const objectsById = new Map<ObjectId, OperationalObject>(projectedInitialGridObjects({ objects: initialObjects, grids, at: initialAt }).map(object => [object.id, object]))
    const projectionKeys = new Map<string, string>()
    const handlers = new Set<PackRuntimeEventHandler>()
    const persistence = createRuntimeStateWriter({
      ...(config.runtimeStateStore === undefined ? {} : { store: config.runtimeStateStore }),
      readState: () => runtimeStateForElectricGrids(grids),
      delayMs: defaultSimulationRunRuntimePolicy.runtimePrivateStateFlushIntervalMs,
      label: 'electric-grid',
      onError: error => {
        const message = error instanceof Error ? error.message : String(error)
        for (const grid of grids.values()) {
          grid.diagnostics.persistenceFailureCount += 1
          grid.diagnostics.lastPersistenceFailure = message
        }
      },
    })
    if (config.recording?.packId !== undefined && config.recording.packId !== electricGridPackId) throw new Error(`electric-grid runtime received recording selection for Pack ${config.recording.packId}`)
    const recordingSelection = config.recording
    let recordingPlan = recordingSelection === undefined || grids.size === 0 ? null : createGridRecordingPlan({ selection: recordingSelection, grids })
    let recordingDescriptorsPending = recordingPlan !== null
    let nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    let clock: SimulationClockState = { currentTime: initialAt, updatedAt: nowIso(), paused: false }
    clock = config.runClock?.read() ?? clock
    const localClock = config.runClock ? null : createSimulationClock(clock)
    const runClock = config.runClock ?? localClock!
    let clockInitialized = false
    const currentSimulationTime = (): IsoTimestamp => runClock.read().currentTime
    let lastSimulationMs = Date.parse(currentSimulationTime())
    let closed = false
    let failure: string | null = null
    let failureAt = nowIso()
    let lastSuccessfulInteractionAt = nowIso()
    const observedStartupConnections = new Set<string>()

    const observeSystemObjects = (
      objects: ReadonlyArray<OperationalObject>,
      trackStartup: boolean,
    ): ReadonlySet<string> => {
      const affectedGridIds = new Set<string>()
      const byId = new Map(objects.map(object => [object.id, object]))
      for (const grid of grids.values()) {
        for (const connection of grid.externalConnections.values()) {
          const object = byId.get(connection.definition.system.objectId)
          if (!object) continue
          const port = electricalPortFromObject(object, connection.definition.system.portId)
          if (!port?.state) throw new Error(`connected system port has no live state: ${connection.definition.system.objectId}:${connection.definition.system.portId}`)
          const nextPowerMw = Math.max(
            -connection.definition.maximumSystemImportMw,
            Math.min(connection.definition.maximumSystemExportMw, port.state.activePowerMw),
          )
          const nextConnected = port.state.connected && port.state.energized
          if (connection.systemActivePowerMw !== nextPowerMw || connection.connected !== nextConnected) {
            affectedGridIds.add(grid.definition.gridId)
          }
          connection.systemActivePowerMw = nextPowerMw
          connection.connected = nextConnected
          if (trackStartup) observedStartupConnections.add(`${grid.definition.gridId}\u0000${connection.definition.network.portId}`)
        }
      }
      return affectedGridIds
    }

    const disconnectSystemObject = (objectId: ObjectId): ReadonlySet<string> => {
      const affectedGridIds = new Set<string>()
      for (const grid of grids.values()) {
        for (const connection of grid.externalConnections.values()) {
          if (connection.definition.system.objectId !== objectId) continue
          if (connection.connected || connection.systemActivePowerMw !== 0) affectedGridIds.add(grid.definition.gridId)
          connection.connected = false
          connection.systemActivePowerMw = 0
        }
      }
      return affectedGridIds
    }

    const emitAffectedGridProjections = (config: {
      readonly gridIds: ReadonlySet<string>
      readonly at: IsoTimestamp
      readonly cause?: Provenance
    }): void => {
      if (config.gridIds.size === 0) return
      const affectedGrids = new Map<string, GridRuntimeInstance>()
      for (const gridId of config.gridIds) {
        const grid = grids.get(gridId)
        if (!grid) continue
        advanceGrid(grid, 0, config.at)
        affectedGrids.set(gridId, grid)
      }
      emit({
        handlers,
        events: gridProjectionEvents({
          objectsById,
          grids: affectedGrids,
          previousKeys: projectionKeys,
          at: config.at,
          provenance: {
            source: 'simulator',
            adapterId: electricGridAdapterId,
            ...(config.cause?.causedByCommandId === undefined ? {} : { causedByCommandId: config.cause.causedByCommandId }),
          },
          history: 'snapshot-only',
        }),
      })
    }

    const balanceReadyStartingDispatch = (): void => {
      for (const grid of grids.values()) {
        if (initiallyBalancedGridIds.has(grid.definition.gridId)) continue
        const allObserved = [...grid.externalConnections.values()].every(connection =>
          observedStartupConnections.has(`${grid.definition.gridId}\u0000${connection.definition.network.portId}`))
        if (!allObserved) continue
        balanceInitialGridDispatch(grid)
        initiallyBalancedGridIds.add(grid.definition.gridId)
      }
    }

    const rebuildRecordingPlan = (): void => {
      recordingPlan = recordingSelection === undefined || grids.size === 0
        ? null
        : createGridRecordingPlan({ selection: recordingSelection, grids })
      recordingDescriptorsPending = recordingPlan !== null
      nextRecordingElapsedMs = recordingPlan?.intervalMs ?? Number.POSITIVE_INFINITY
    }

    const advanceAndEmit = (history: PackRuntimeEventHistory, targetTime = currentSimulationTime(), forced = false): void => {
      if (closed || (!forced && clock.paused) || failure !== null) return
      const at = targetTime
      const simulationMs = Date.parse(at)
      const dtSeconds = Math.max(0, simulationMs - lastSimulationMs) / 1_000
      lastSimulationMs = simulationMs
      for (const grid of grids.values()) {
        for (const connection of grid.externalConnections.values()) {
          if (config.isObjectProviderAvailable?.(connection.definition.system.objectId) === false) {
            connection.connected = false
            connection.systemActivePowerMw = 0
          }
        }
        advanceGrid(grid, dtSeconds, at)
      }
      const events = gridProjectionEvents({
        objectsById,
        grids,
        previousKeys: projectionKeys,
        at: nowIso(),
        provenance: { source: 'simulator', adapterId: electricGridAdapterId },
        history,
      })
      const elapsedMs = simulationMs - Date.parse(config.scenario.world.startsAt)
      const recording = recordingPlan !== null && elapsedMs >= nextRecordingElapsedMs
        ? (() => {
            nextRecordingElapsedMs = elapsedMs + recordingPlan.intervalMs
            const sampled = recordingPlan.sample({ observedAt: nowIso(), simulationTime: at })
            if (!recordingDescriptorsPending) return sampled
            recordingDescriptorsPending = false
            return { ...sampled, descriptors: [...recordingPlan.descriptors] }
          })()
        : undefined
      persistence.scheduleSave()
      emit({ handlers, events, ...(recording === undefined ? {} : { recording }) })
      lastSuccessfulInteractionAt = nowIso()
    }

    const interval = setInterval(() => {
      try {
        advanceAndEmit('snapshot-only')
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        failureAt = nowIso()
        clearInterval(interval)
        const at = nowIso()
        for (const grid of grids.values()) grid.projection = {
          ...grid.projection,
          statusTone: 'error',
          statusLabel: 'Runtime failed',
          summary: failure,
          updatedAt: at,
        }
        const projectionEvents = gridProjectionEvents({
          objectsById,
          grids,
          previousKeys: projectionKeys,
          at,
          provenance: { source: 'simulator', adapterId: electricGridAdapterId },
          history: 'record',
        })
        emit({
          handlers,
          events: [...projectionEvents, {
            type: 'interaction.signal',
            at,
            provenance: { source: 'simulator', adapterId: electricGridAdapterId },
            signal: {
              id: `electric-grid-runtime-failed:${crypto.randomUUID()}` as SignalId,
              simulationRunId: config.simulationRunId,
              at,
              source: { kind: 'simulation', id: electricGridRuntimeId },
              targets: [{ kind: 'broadcast' }],
              type: 'electric-grid.runtime.failed',
              severity: 'critical',
              payload: { runtimeId: electricGridRuntimeId, message: failure },
            },
          }],
        })
        console.error('electric-grid runtime failed:', error)
      }
    }, updateIntervalMs)

    return {
      health: () => [{ runtimeId: electricGridRuntimeId, state: failure === null ? 'ready' : 'failed',
        failureCount: failure === null ? 0 : 1, lastSuccessfulInteractionAt,
        ...(failure === null ? {} : { lastFailure: { at: failureAt, operation: 'advance', message: failure } }) }],
      getSnapshot: async () => ({ simulationRunId: config.simulationRunId, objects: [...objectsById.values()], capturedAt: nowIso() }),
      subscribe: handler => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      sendCommand: async (command: CommandEnvelope): Promise<CommandResult> => {
        if (failure !== null) return commandRejected(command, `electric-grid runtime stopped after a failure: ${failure}`)
        if (!electricGridCommandKinds.includes(command.kind as typeof electricGridCommandKinds[number])) return commandRejected(command, `electric-grid runtime does not accept command kind: ${command.kind}`)
        try {
          const grid = requireGrid(grids, command)
          applyCommand(grid, command)
          const at = currentSimulationTime()
          advanceGrid(grid, 0, at)
          const events = gridProjectionEvents({
            objectsById,
            grids: new Map([[grid.definition.gridId, grid]]),
            previousKeys: projectionKeys,
            at: nowIso(),
            provenance: { source: 'operator', causedByCommandId: command.id },
            history: 'record',
          })
          await persistence.saveNow()
          emit({ handlers, events })
          return { ok: true, commandId: command.id, acceptedAt: nowIso() }
        } catch (error) {
          return commandRejected(command, error instanceof Error ? error.message : String(error))
        }
      },
      invokeQuery: async (request: PackRuntimeQuery): Promise<unknown> => {
        if (failure !== null) throw new Error(`Electric Grid runtime stopped after a failure: ${failure}`)
        const startedAtMs = performance.now()
        const response = answerElectricGridQuery({ request, grids })
        const gridId = typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
          ? (request.input as { readonly gridId?: unknown }).gridId
          : undefined
        if (typeof gridId === 'string') {
          const grid = grids.get(gridId)
          if (grid) {
            grid.diagnostics.queryCount += 1
            grid.diagnostics.lastQueryDurationMs = performance.now() - startedAtMs
          }
        }
        return response
      },
      observeCommittedEvents: async (events: ReadonlyArray<SimulationRunEvent>): Promise<void> => {
        const affectedGridIds = new Set<string>()
        let structuralChange = false
        let latestCause: SimulationRunEvent | undefined
        for (const event of events) {
          if (event.type === 'object.deleted') {
            const removedGrid = grids.delete(event.objectId)
            objectsById.delete(event.objectId)
            if (removedGrid) {
              structuralChange = true
              rebuildRecordingPlan()
            }
            for (const gridId of disconnectSystemObject(event.objectId)) affectedGridIds.add(gridId)
            if (affectedGridIds.size > 0) latestCause = event
            continue
          }
          if (event.type !== 'object.upserted' || event.object.packId !== electricGridPackId) continue
          objectsById.set(event.object.id, event.object)
          const data = electricGridPackDataSchema.parse(event.object.packData)
          const definition = compileGridDefinition(gridDefinitionSchema.parse({ id: event.object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation }))
          const current = grids.get(event.object.id)
          if (!current || current.definition.definitionDigest !== definition.definitionDigest) {
            const grid = createGridRuntimeInstance({
              definition,
              at: event.at,
              connections: networkConnectionsFor(config.scenario.connections, event.object.id),
            })
            advanceGrid(grid, 0, event.at)
            grids.set(event.object.id, grid)
            rebuildRecordingPlan()
            structuralChange = true
          }
        }
        const systemEvents = events.flatMap(event => event.type === 'object.upserted' ? [event] : [])
        const gridsAffectedBySystemUpdates = observeSystemObjects(systemEvents.map(event => event.object), true)
        for (const gridId of gridsAffectedBySystemUpdates) affectedGridIds.add(gridId)
        if (systemEvents.length > 0 && gridsAffectedBySystemUpdates.size > 0) latestCause = systemEvents.at(-1)
        balanceReadyStartingDispatch()
        if (latestCause) emitAffectedGridProjections({ gridIds: affectedGridIds, at: latestCause.at, cause: latestCause.provenance })
        if (structuralChange) await persistence.saveNow()
        else persistence.scheduleSave()
      },
      observeInitialSnapshot: async (objects: ReadonlyArray<OperationalObject>): Promise<void> => {
        // The first combined snapshot can still contain a system waiting for its
        // network boundary. Use it for live state, but only balance dispatch
        // after every connection has published a committed runtime projection.
        observeSystemObjects(objects, false)
        for (const grid of grids.values()) {
          advanceGrid(grid, 0, initialAt)
          const object = objectsById.get(grid.definition.gridId as ObjectId)
          if (object) objectsById.set(object.id, projectGridObject({ object, grid, at: initialAt }))
        }
      },
      setClock: async (nextClock: SimulationClockState): Promise<void> => {
        if (clockInitialized) advanceAndEmit('snapshot-only')
        clockInitialized = true
        clock = nextClock
        localClock?.set(nextClock)
        lastSimulationMs = Date.parse(currentSimulationTime())
      },
      advanceTo: async (nextClock: SimulationClockState): Promise<void> => {
        advanceAndEmit('snapshot-only', nextClock.currentTime, true)
        clock = nextClock
        localClock?.set(nextClock)
      },
      checkpoint: persistence.saveNow,
      close: async (): Promise<void> => {
        closed = true
        clearInterval(interval)
        handlers.clear()
        await persistence.close()
      },
    }
  },
})

export { electricGridAdapterId,electricGridRuntimeId }
