import type { CommandResult, CompiledScenario, SimulationRunId, IsoTimestamp, ObjectId, OperationalNotification, OperationalObject, ScenarioGuidance, ScenarioExecutionState, SimulationClockState } from '../core/model/index.ts'
import type { PackRuntimeRealtimeMessage } from '../simulation/protocol.ts'
import type { CapabilityInvocationResponse } from './types.ts'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import { simulationRunIdSchema } from '../core/model/index.ts'
import type { RealtimePerspective } from './roles/perspective.ts'

export interface SimulationRunEventPayload {
  readonly type: string
  readonly at?: IsoTimestamp
  readonly object?: OperationalObject
  readonly objectId?: ObjectId
  readonly cueId?: string
  readonly guidance?: ScenarioGuidance
  readonly guidanceId?: string
  readonly notification?: OperationalNotification
  readonly objectIds?: ReadonlyArray<ObjectId>
  readonly result?: CommandResult
  readonly clock?: SimulationClockState
}

/** In a Run that declares roles every message carries its perspective epoch. */
interface PerspectiveEpochTag {
  readonly epoch?: number
}

export interface SimulationRunEventBatchMessage extends PerspectiveEpochTag {
  readonly type: 'events'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly events: ReadonlyArray<SimulationRunEventPayload>
}

export interface RealtimeReadyMessage {
  readonly type: 'realtime.ready'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly clock?: SimulationClockState
  readonly perspective?: RealtimePerspective
}

export interface RealtimeCapabilityResultMessage extends PerspectiveEpochTag {
  readonly type: 'capability.result'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly requestId: string
  readonly outcome: CapabilityInvocationResponse
}

export interface RealtimeCapabilityErrorMessage extends PerspectiveEpochTag {
  readonly type: 'capability.error'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly requestId?: string
  readonly code?: string
  readonly message: string
}

export interface RuntimeRealtimeMessageBatch extends PerspectiveEpochTag {
  readonly type: 'runtime.realtime'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly messages: ReadonlyArray<PackRuntimeRealtimeMessage>
}

export interface RuntimeInputErrorMessage extends PerspectiveEpochTag {
  readonly type: 'runtime.input.error'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly inputType?: string
  readonly message: string
}

/** The Run refused a `role.set`; the connection keeps its role set and epoch. */
export interface RoleRefusedMessage extends PerspectiveEpochTag {
  readonly type: 'role.refused'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly code: string
  readonly message: string
}

export type SimulationRunWebSocketMessage =
  | SimulationRunEventBatchMessage
  | RealtimeReadyMessage
  | RealtimeCapabilityResultMessage
  | RealtimeCapabilityErrorMessage
  | RuntimeRealtimeMessageBatch
  | RuntimeInputErrorMessage
  | RoleRefusedMessage

interface ObjectApplicationResult {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly changed: boolean
  readonly routesChanged: boolean
}

export interface ObjectSelectionState {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
  readonly scenarioState?: ScenarioExecutionState
}

export interface ObjectSelectionUpdate {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly selectedControllerId: string | null
}

export interface SimulationRunEventApplication {
  readonly objectUpdate?: ObjectSelectionUpdate
  readonly scenarioUpdate?: ScenarioExecutionState
  readonly clockUpdate?: SimulationClockState
  readonly routesChanged: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isRealtimeCommandResult = (value: unknown): value is CommandResult => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (typeof value.commandId !== 'string') return false
  if (value.ok) return typeof value.acceptedAt === 'string'
  return typeof value.rejectedAt === 'string' && typeof value.reason === 'string'
}

const isCapabilityInvocationResponse = (value: unknown): value is CapabilityInvocationResponse => {
  if (!isRecord(value)) return false
  if (value.kind === 'query') return Object.hasOwn(value, 'result')
  return value.kind === 'command'
    && isRealtimeCommandResult(value.result)
    && typeof value.replayed === 'boolean'
}

const parseEventPayload = (value: unknown): SimulationRunEventPayload => {
  if (!isRecord(value)) throw new Error('invalid WebSocket event: expected object')
  if (typeof value.type !== 'string') throw new Error('invalid WebSocket event: missing event type')
  if (value.type === 'command.result' && !isRealtimeCommandResult(value.result)) throw new Error('invalid WebSocket event: command result without a valid result')
  return {
    type: value.type,
    ...(typeof value.at === 'string' ? { at: value.at as IsoTimestamp } : {}),
    ...(isRecord(value.object) ? { object: value.object as unknown as OperationalObject } : {}),
    ...(typeof value.objectId === 'string' ? { objectId: value.objectId as ObjectId } : {}),
    ...(typeof value.cueId === 'string' ? { cueId: value.cueId } : {}),
    ...(isRecord(value.guidance) ? { guidance: value.guidance as unknown as ScenarioGuidance } : {}),
    ...(typeof value.guidanceId === 'string' ? { guidanceId: value.guidanceId } : {}),
    ...(isRecord(value.notification) ? { notification: value.notification as unknown as OperationalNotification } : {}),
    ...(Array.isArray(value.objectIds) ? { objectIds: value.objectIds.filter((objectId): objectId is ObjectId => typeof objectId === 'string') } : {}),
    ...(isRealtimeCommandResult(value.result) ? { result: value.result } : {}),
    ...(isRecord(value.clock) ? { clock: value.clock as unknown as SimulationClockState } : {}),
  }
}

const parseRealtimeMessage = (value: unknown): PackRuntimeRealtimeMessage => {
  if (!isRecord(value)) throw new Error('invalid runtime realtime message: expected object')
  if (typeof value.type !== 'string' || value.type.trim().length === 0) throw new Error('invalid runtime realtime message: missing type')
  if (typeof value.at !== 'string') throw new Error('invalid runtime realtime message: missing timestamp')
  return {
    type: value.type,
    at: value.at as IsoTimestamp,
    payload: value.payload,
  }
}

const validEpoch = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`invalid ${label}: invalid perspective epoch`)
  return value
}

const parseEpoch = (value: Record<string, unknown>, label: string): PerspectiveEpochTag =>
  value.epoch === undefined ? {} : { epoch: validEpoch(value.epoch, label) }

const parsePerspective = (value: Record<string, unknown>): RealtimePerspective | undefined => {
  if (value.epoch === undefined) return undefined
  const epoch = validEpoch(value.epoch, 'realtime ready message')
  if (!Array.isArray(value.roleIds) || !value.roleIds.every(roleId => typeof roleId === 'string')) throw new Error('invalid realtime ready message: perspective without a role set')
  const snapshot = value.snapshot
  if (!isRecord(snapshot) || !Array.isArray(snapshot.objects) || typeof snapshot.seq !== 'number') throw new Error('invalid realtime ready message: perspective without a snapshot')
  const compiledScenario = value.compiledScenario
  if (!isRecord(compiledScenario) || typeof compiledScenario.id !== 'string' || !Array.isArray(compiledScenario.roles)) {
    throw new Error('invalid realtime ready message: perspective without a Compiled Scenario that declares roles')
  }
  return {
    epoch,
    roleIds: value.roleIds as ReadonlyArray<string>,
    snapshot: {
      objects: snapshot.objects as ReadonlyArray<OperationalObject>,
      seq: snapshot.seq,
      ...(isRecord(snapshot.scenario) ? { scenario: snapshot.scenario as unknown as ScenarioExecutionState } : {}),
      ...(isRecord(snapshot.clock) ? { clock: snapshot.clock as unknown as SimulationClockState } : {}),
    },
    compiledScenario: compiledScenario as unknown as CompiledScenario,
  }
}

const parseMessageScope = (value: Record<string, unknown>, label: string): {
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
} => {
  const workspace = workspaceIdSchema.safeParse(value.workspaceId)
  if (!workspace.success) throw new Error(`invalid ${label}: missing or invalid Workspace id`)
  const simulationRun = simulationRunIdSchema.safeParse(value.simulationRunId)
  if (!simulationRun.success) throw new Error(`invalid ${label}: missing or invalid Simulation Run id`)
  return { workspaceId: workspace.data, simulationRunId: simulationRun.data }
}

export const parseSimulationRunWebSocketMessage = (raw: string): SimulationRunWebSocketMessage | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    throw new Error(`invalid WebSocket JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(parsed)) return null
  if (parsed.type === 'realtime.ready') {
    const scope = parseMessageScope(parsed, 'realtime ready message')
    if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid realtime ready message: missing snapshot sequence')
    const perspective = parsePerspective(parsed)
    return {
      type: 'realtime.ready',
      ...scope,
      ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
      snapshotSeq: parsed.snapshotSeq,
      ...(isRecord(parsed.clock) ? { clock: parsed.clock as unknown as SimulationClockState } : {}),
      ...(perspective === undefined ? {} : { perspective }),
    }
  }
  if (parsed.type === 'capability.result') {
    const scope = parseMessageScope(parsed, 'Capability result message')
    if (typeof parsed.requestId !== 'string') throw new Error('invalid Capability result message: missing request id')
    if (!isCapabilityInvocationResponse(parsed.outcome)) throw new Error('invalid Capability result message: invalid outcome')
    return {
      type: 'capability.result',
      ...scope,
      requestId: parsed.requestId,
      outcome: parsed.outcome,
      ...parseEpoch(parsed, 'Capability result message'),
    }
  }
  if (parsed.type === 'capability.error') {
    const scope = parseMessageScope(parsed, 'Capability error message')
    if (typeof parsed.message !== 'string') throw new Error('invalid Capability error message: missing message')
    return {
      type: 'capability.error',
      ...scope,
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      message: parsed.message,
      ...parseEpoch(parsed, 'Capability error message'),
    }
  }
  if (parsed.type === 'runtime.realtime') {
    const scope = parseMessageScope(parsed, 'runtime realtime message batch')
    if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid runtime realtime message batch: missing snapshot sequence')
    if (!Array.isArray(parsed.messages)) throw new Error('invalid runtime realtime message batch: missing messages array')
    return {
      type: 'runtime.realtime',
      ...scope,
      ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
      snapshotSeq: parsed.snapshotSeq,
      messages: parsed.messages.map(parseRealtimeMessage),
      ...parseEpoch(parsed, 'runtime realtime message batch'),
    }
  }
  if (parsed.type === 'runtime.input.error') {
    const scope = parseMessageScope(parsed, 'runtime input error message')
    if (typeof parsed.message !== 'string') throw new Error('invalid runtime input error message: missing message')
    return {
      type: 'runtime.input.error',
      ...scope,
      ...(typeof parsed.inputType === 'string' ? { inputType: parsed.inputType } : {}),
      message: parsed.message,
      ...parseEpoch(parsed, 'runtime input error message'),
    }
  }
  if (parsed.type === 'role.refused') {
    const scope = parseMessageScope(parsed, 'role refusal message')
    if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') throw new Error('invalid role refusal message: missing code or message')
    return { type: 'role.refused', ...scope, code: parsed.code, message: parsed.message, ...parseEpoch(parsed, 'role refusal message') }
  }
  if (parsed.type !== 'events') return null
  const scope = parseMessageScope(parsed, 'WebSocket events message')
  if (typeof parsed.snapshotSeq !== 'number') throw new Error('invalid WebSocket events message: missing snapshot sequence')
  if (!Array.isArray(parsed.events)) throw new Error('invalid WebSocket events message: missing events array')

  return {
    type: 'events',
    ...scope,
    ...(typeof parsed.scenarioId === 'string' ? { scenarioId: parsed.scenarioId } : {}),
    snapshotSeq: parsed.snapshotSeq,
    events: parsed.events.map(parseEventPayload),
    ...parseEpoch(parsed, 'WebSocket events message'),
  }
}

export const parseSimulationRunEventBatchMessage = (raw: string): SimulationRunEventBatchMessage | null => {
  const message = parseSimulationRunWebSocketMessage(raw)
  return message?.type === 'events' ? message : null
}

const applyScenarioEvents = (
  scenarioState: ScenarioExecutionState | undefined,
  events: ReadonlyArray<SimulationRunEventPayload>,
): ScenarioExecutionState | undefined => {
  let nextState = scenarioState
  for (const event of events) {
    const current = nextState
    if (!current) continue
    if (event.type === 'scenario.cue.started' && event.cueId) {
      if (!current.timeline) continue
      nextState = {
        ...current,
        timeline: {
          startedAt: current.timeline.startedAt,
          firedCueIds: [...new Set([...current.timeline.firedCueIds, event.cueId])],
        },
      }
    }
    if (event.type === 'scenario.guidance.shown' && event.guidance) {
      nextState = { ...current, guidance: event.guidance }
    }
    if (event.type === 'scenario.guidance.hidden') {
      if (event.guidanceId === undefined || current.guidance?.id === event.guidanceId) {
        const { guidance: _guidance, ...withoutGuidance } = current
        nextState = withoutGuidance
      }
    }
    if (event.type === 'notification.emitted' && event.notification) {
      nextState = {
        ...current,
        guidance: {
          id: event.notification.id,
          title: event.notification.title,
          message: event.notification.message,
          objectIds: event.notification.targets.flatMap(target => target.kind === 'object' ? [target.id] : []),
          dismissible: true,
          tone: 'update',
        },
      }
    }
    if (event.type === 'scenario.objects.highlighted' && event.objectIds) {
      nextState = { ...current, highlightedObjectIds: [...event.objectIds] }
    }
    if (event.type === 'scenario.highlights.cleared') {
      nextState = {
        ...current,
        highlightedObjectIds: event.objectIds === undefined
          ? []
          : current.highlightedObjectIds.filter(objectId => !event.objectIds?.includes(objectId)),
      }
    }
  }
  return nextState === scenarioState ? undefined : nextState
}

export const upsertOperationalObject = (
  objects: ReadonlyArray<OperationalObject>,
  object: OperationalObject,
): ReadonlyArray<OperationalObject> => {
  const existingIndex = objects.findIndex(existing => existing.id === object.id)
  if (existingIndex === -1) return [...objects, object]
  return objects.map((existing, index) => index === existingIndex ? object : existing)
}

export const removeOperationalObject = (
  state: ObjectSelectionState,
  objectId: string,
): ObjectSelectionUpdate => ({
  objects: state.objects.filter(object => object.id !== objectId),
  selectedControllerId: state.selectedControllerId === objectId ? null : state.selectedControllerId,
})

const applyObjectEvents = (
  state: ObjectSelectionState,
  events: ReadonlyArray<SimulationRunEventPayload>,
): ObjectApplicationResult => {
  const objectsById = new Map<ObjectId, OperationalObject>()
  const order: ObjectId[] = []
  for (const object of state.objects) {
    objectsById.set(object.id, object)
    order.push(object.id)
  }

  let selectedControllerId = state.selectedControllerId
  let changed = false
  let routesChanged = false
  for (const event of events) {
    if (event.type === 'object.upserted' && event.object) {
      const existingObject = objectsById.get(event.object.id)
      routesChanged = routesChanged || routeStateKey(existingObject) !== routeStateKey(event.object)
      if (!objectsById.has(event.object.id)) order.push(event.object.id)
      objectsById.set(event.object.id, event.object)
      changed = true
    }
    if (event.type === 'object.deleted' && event.objectId) {
      routesChanged = routesChanged || routeStateKey(objectsById.get(event.objectId)) !== ''
      if (objectsById.delete(event.objectId)) changed = true
      if (selectedControllerId === event.objectId) selectedControllerId = null
    }
  }

  return {
    objects: order.flatMap(objectId => {
      const object = objectsById.get(objectId)
      return object ? [object] : []
    }),
    selectedControllerId,
    changed,
    routesChanged,
  }
}

const routeStateKey = (object: OperationalObject | undefined): string => {
  const route = object?.spatial.route?.planned
  if (!object || !route) return ''
  return [
    object.tasking?.currentTaskId ?? '',
    object.spatial.position?.point.coordinates.join(',') ?? '',
    object.spatial.route?.etaSeconds ?? '',
    object.spatial.route?.progress?.segmentIndex ?? '',
    object.spatial.route?.progress?.remainingDistanceM ?? '',
    object.spatial.route?.source ?? '',
    route.coordinates.map(coordinate => `${coordinate[0]},${coordinate[1]}`).join(';'),
  ].join('|')
}

export const applySimulationRunEventBatchMessage = (
  state: ObjectSelectionState,
  message: SimulationRunEventBatchMessage,
): SimulationRunEventApplication => {
  const objectResult = applyObjectEvents(state, message.events)
  const scenarioUpdate = applyScenarioEvents(state.scenarioState, message.events)
  const clockEvent = [...message.events].reverse().find(event => event.type === 'clock.updated' && event.clock)

  return {
    routesChanged: objectResult.routesChanged,
    ...(objectResult.changed || objectResult.selectedControllerId !== state.selectedControllerId
      ? {
          objectUpdate: {
            objects: objectResult.objects,
            selectedControllerId: objectResult.selectedControllerId,
          },
        }
      : {}),
    ...(scenarioUpdate === undefined ? {} : { scenarioUpdate }),
    ...(clockEvent?.clock ? { clockUpdate: clockEvent.clock } : {}),
  }
}
