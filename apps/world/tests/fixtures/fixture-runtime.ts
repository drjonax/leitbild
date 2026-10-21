// The fixture Pack's local runtime: real commands, queries, motion and
// recording on the Run clock, kept small enough to read in one sitting.
import { z } from 'zod'
import {
  audienceVisibleTo,
  commandResultSchema,
  geoPointFromLonLat,
  isoTimestampSchema,
  nowIso,
  objectIdSchema,
  operationalObjectSchema,
  recordingSeriesIdFor,
  routeDistanceMeters,
  type CommandEnvelope,
  type GeoJsonPoint,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type PackRuntimeRecordingBatch,
  type RecordingSeriesDescriptor,
  type RunViewer,
  type ScenarioRecordingSelection,
} from '../../src/core/model/index.ts'
import { defineObservationCapability, observationShapes, type ObservationDeclaration } from '../../src/core/observation/capabilities.ts'
import type { Observation } from '../../src/core/observation/model.ts'
import type { TopologyGraph } from '../../src/core/observation/topology.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../src/simulation/capabilities.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeEventHistory,
  PackRuntimeRealtimeMessage,
} from '../../src/simulation/protocol.ts'
import {
  createFixtureObject,
  fixtureConfigSchema,
  fixtureDataOf,
  fixtureItemSchema,
  fixtureObservationIds,
  fixturePackId,
  fixtureRecordingProfiles,
  fixtureRuntimeId,
  prioritySchema,
  type FixtureData,
} from './fixture-pack.ts'

export const fixtureCommandIds = {
  createItem: 'world.fixture.create-item',
  assign: 'world.fixture.assign',
  setPriority: 'world.fixture.set-priority',
  announce: 'world.fixture.announce',
} as const
export const fixtureQueryIds = { state: 'world.fixture.state', object: 'world.fixture.object', viewer: 'world.fixture.viewer' } as const

/** The runtime realtime message an announcement sends. */
export const fixtureAnnouncementType = 'fixture.announcement'

const createItemInput = z.object({ item: fixtureItemSchema }).strict()
const assignInput = z.object({ unitId: objectIdSchema, taskId: objectIdSchema }).strict()
const setPriorityInput = z.object({ taskId: objectIdSchema, priority: prioritySchema }).strict()
const announceInput = z.object({ text: z.string().trim().min(1).max(200) }).strict()
const stateInput = z.object({}).strict()
const objectInput = z.object({ objectId: objectIdSchema }).strict()
const viewerOutput = z.object({
  viewer: z.object({
    roleIds: z.array(z.string()),
    class: z.enum(['controller', 'operator']),
    sees: z.union([z.literal('all'), z.array(z.string())]),
  }).strict().nullable(),
}).strict()
const summarySchema = z.object({ id: z.string(), label: z.string(), status: z.string() }).strict()
const stateOutput = z.object({
  units: z.array(summarySchema.extend({ taskId: z.string().nullable() })),
  tasks: z.array(summarySchema.extend({ priority: prioritySchema, unitId: z.string().nullable() })),
  sites: z.array(summarySchema),
}).strict()

const capabilities = [
  defineSimulationCommandCapability({
    id: fixtureCommandIds.createItem, title: 'Create fixture item',
    description: 'Create a unit, site or task with the item schema Scenario authoring uses.',
    input: createItemInput, output: commandResultSchema, idempotent: false, schedulable: true,
    buildCommand: raw => ({ targetObjectIds: [], payload: createItemInput.parse(raw) }),
  }),
  defineSimulationCommandCapability({
    id: fixtureCommandIds.assign, title: 'Assign unit to task',
    description: 'Send an unassigned unit in a straight line to a task that has no unit.',
    input: assignInput, output: commandResultSchema, idempotent: false, schedulable: true,
    buildCommand: raw => {
      const payload = assignInput.parse(raw)
      return { targetObjectIds: [payload.unitId, payload.taskId], payload }
    },
  }),
  defineSimulationCommandCapability({
    id: fixtureCommandIds.setPriority, title: 'Set task priority',
    description: 'Change a task\'s priority. Its status and assigned unit stay as they are.',
    input: setPriorityInput, output: commandResultSchema, idempotent: true, schedulable: true,
    buildCommand: raw => {
      const payload = setPriorityInput.parse(raw)
      return { targetObjectIds: [payload.taskId], payload }
    },
  }),
  defineSimulationCommandCapability({
    id: fixtureCommandIds.announce, title: 'Announce',
    description: 'Send every screen that may receive runtime messages a transient announcement. Changes no object.',
    input: announceInput, output: commandResultSchema, idempotent: false, schedulable: true,
    buildCommand: raw => ({ targetObjectIds: [], payload: announceInput.parse(raw) }),
  }),
  defineSimulationQueryCapability({
    id: fixtureQueryIds.viewer, title: 'Read the stamped viewer',
    description: 'The role view core stamped on this query from the caller\'s connection, or null where there is none.',
    input: stateInput, output: viewerOutput,
  }),
  defineSimulationQueryCapability({
    id: fixtureQueryIds.state, title: 'Read fixture state',
    description: 'Every unit, task and site with its status and assignment.',
    input: stateInput, output: stateOutput,
  }),
  defineSimulationQueryCapability({
    id: fixtureQueryIds.object, title: 'Read one fixture object',
    description: 'One exact fixture object, or null when it does not exist.',
    input: objectInput, output: z.object({ object: operationalObjectSchema.nullable() }).strict(),
    inspectObjectIds: raw => [objectInput.parse(raw).objectId],
  }),
  defineObservationCapability('declarations', { id: fixtureObservationIds.declarations, title: 'Declare unit observations', description: 'Speed and status of each unit, measured on its engine.' }),
  defineObservationCapability('read', { id: fixtureObservationIds.read, title: 'Read unit observations', description: 'Current speed and status of units.' }),
  defineObservationCapability('topology', { id: fixtureObservationIds.topology, title: 'Draw a unit', description: 'A unit\'s tank feeding its engine.' }),
]

/** Units' observation content; the revision never changes because the declared set never does. */
const observationRevision = 'fixture-observation-1'
const overspeedMps = 40
const unitDeclaration = (unit: OperationalObject, recorded: boolean): ObservationDeclaration => ({
  objectId: unit.id, revision: observationRevision,
  elements: [{ id: 'engine', class: 'mover', label: `${unit.label} engine` }, { id: 'tank', class: 'store', label: `${unit.label} tank` }],
  observables: [
    { ref: `${unit.id}#speed`, label: `${unit.label} speed`, quantity: 'speed', unit: 'm/s', valueType: 'number', tag: 'SPD', element: 'engine', series: null,
      thresholds: [{ id: 'overspeed', direction: 'high', value: overspeedMps, order: 1, effect: 'alarm', priority: 'caution' }] },
    { ref: `${unit.id}#status`, label: `${unit.label} status`, quantity: 'state', unit: '', valueType: 'text', thresholds: [],
      series: recorded ? { seriesId: recordingSeriesIdFor(unit.id, 'operational.status'), intervalMs: 1_000 } : null },
  ],
})
const unitObservations = (unit: OperationalObject, at: IsoTimestamp): ReadonlyArray<Observation> => {
  const speed = unit.spatial.position?.speedMps ?? 0
  return [
    { ref: `${unit.id}#speed`, at, clock: 'simulation', value: speed, quality: 'good', priority: speed > overspeedMps ? 'caution' : 'none', rank: 1 },
    { ref: `${unit.id}#status`, at, clock: 'simulation', value: unit.operational.status, quality: 'good', priority: 'none', rank: 2 },
  ]
}
const unitTopology = (unit: OperationalObject): TopologyGraph => ({
  objectId: unit.id, revision: observationRevision, family: 'flow',
  media: [{ id: 'fuel', label: 'Fuel', kind: 'fluid' }], groups: [], boundaries: [],
  nodes: [
    { id: 'tank', element: 'tank', class: 'store', kind: 'tank', label: `${unit.label} tank`, rank: '1', ports: [{ id: 'out', rank: '1', media: ['fuel'], direction: 'out' }], bindings: [] },
    { id: 'engine', element: 'engine', class: 'mover', kind: 'engine', label: `${unit.label} engine`, rank: '2', ports: [{ id: 'in', rank: '1', media: ['fuel'], direction: 'in' }],
      bindings: [{ role: 'flow', ref: `${unit.id}#speed` }] },
  ],
  edges: [{ id: 'feed', rank: '1', from: { node: 'tank', port: 'out' }, to: { node: 'engine', port: 'in' }, medium: 'fuel', directed: true, bindings: [] }],
})

/** Realtime cadence of motion and recording between explicit Run advances. */
const tickIntervalMs = 500

/** The one private mechanic: when the next recording sample falls due. Every
 * other fact is canonical object state or the Run clock. */
const checkpointSchema = z.object({ nextRecordingAt: isoTimestampSchema.nullable() }).strict()

interface Change {
  readonly object: OperationalObject
  readonly history: PackRuntimeEventHistory
}

const pointOf = (object: OperationalObject): GeoJsonPoint => {
  const point = object.spatial.position?.point
  if (!point) throw new Error(`${object.id} has no position`)
  return point
}

const validated = (object: OperationalObject): OperationalObject => {
  if (object.packId !== fixturePackId) throw new Error(`${object.id} is not a fixture object`)
  fixtureDataOf(object)
  pointOf(object)
  return object
}

const revise = (object: OperationalObject, patch: {
  readonly status?: string
  readonly point?: GeoJsonPoint
  readonly speedMps?: number
  readonly packData?: FixtureData
}): OperationalObject => {
  const at = nowIso()
  const position = object.spatial.position!
  const moved = patch.point !== undefined || patch.speedMps !== undefined
  return {
    ...object,
    revision: object.revision + 1,
    operational: patch.status === undefined ? object.operational : { ...object.operational, status: patch.status },
    spatial: moved ? {
      ...object.spatial,
      position: { ...position, point: patch.point ?? position.point, ...(patch.speedMps === undefined ? {} : { speedMps: patch.speedMps }), observedAt: at },
    } : object.spatial,
    packData: patch.packData ?? object.packData,
    timestamps: { ...object.timestamps, updatedAt: at },
  }
}

const stateOf = (objects: ReadonlyArray<OperationalObject>): z.infer<typeof stateOutput> => {
  const entries = objects.map(object => ({ object, data: fixtureDataOf(object) }))
  const summary = (object: OperationalObject) => ({ id: object.id, label: object.label, status: object.operational.status })
  return {
    units: entries.flatMap(({ object, data }) => data.type === 'unit' ? [{ ...summary(object), taskId: data.taskId ?? null }] : []),
    tasks: entries.flatMap(({ object, data }) => data.type === 'task' ? [{ ...summary(object), priority: data.priority, unitId: data.unitId ?? null }] : []),
    sites: entries.flatMap(({ object, data }) => data.type === 'site' ? [summary(object)] : []),
  }
}

/** The refusal convention: `<code>: <message>`, never naming what the viewer cannot see. */
const refusal = (code: string, message: string): Error => new Error(`${code}: ${message}`)

/** A role-aware Pack answers only within the stamped viewer's picture; without a viewer it sees everything. */
const inPicture = (object: { readonly audience?: OperationalObject['audience'] }, viewer: RunViewer | undefined): boolean =>
  viewer === undefined || audienceVisibleTo(object.audience, viewer.sees)

const createRecorder = (selection: ScenarioRecordingSelection, startsAtMs: number) => {
  const profile = fixtureRecordingProfiles.find(candidate => candidate.id === selection.profileId)
  if (!profile) throw new Error(`unknown fixture recording profile: ${selection.profileId}`)
  const described = new Set<string>()
  return {
    intervalMs: selection.intervalMs ?? profile.defaultIntervalMs,
    sample: (objects: ReadonlyArray<OperationalObject>, simulationMs: number): PackRuntimeRecordingBatch => {
      const descriptors: RecordingSeriesDescriptor[] = []
      const observedAt = nowIso()
      const simulationTime = new Date(simulationMs).toISOString() as IsoTimestamp
      const samples = objects.map(object => {
        const seriesId = recordingSeriesIdFor(object.id, 'operational.status')
        if (!described.has(seriesId)) {
          described.add(seriesId)
          descriptors.push({ id: seriesId, subjectId: object.id, signalId: 'operational.status', title: `${object.label} · Status`, valueType: 'string' })
        }
        return { seriesId, observedAt, simulationTime, elapsedMs: simulationMs - startsAtMs, value: object.operational.status, quality: 'good' as const }
      })
      return { descriptors, samples }
    },
  }
}

export const createFixturePackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: fixtureRuntimeId,
  version: '1.0.0',
  packId: fixturePackId,
  clock: 'simulation',
  capabilities,
  requiredQueries: runtimeConfig => fixtureConfigSchema.parse(runtimeConfig).requiredQueries,
  connect: async config => {
    const runClock = config.runClock
    if (!runClock) throw new Error('The fixture runtime runs only on its Run clock')
    const objects = new Map((config.initialObjects ?? config.scenario.initialObjects)
      .filter(object => object.packId === fixturePackId)
      .map(object => [object.id, validated(object)]))
    const objectById = (id: ObjectId): OperationalObject | undefined => objects.get(id) ?? config.objectById?.(id)
    const handlers = new Set<PackRuntimeEventHandler>()
    const recorder = config.recording ? createRecorder(config.recording, Date.parse(config.scenario.world.startsAt)) : null
    const authority = fixtureConfigSchema.parse(config.scenario.runtimeConfig).authority
    const store = config.runtimeStateStore
    const saved = await store?.load() ?? null
    if (config.initialObjects && store && saved === null) throw new Error('Fixture runtime checkpoint is missing on a restored Run')
    let simulationMs = Date.parse(runClock.read().currentTime)
    const savedNextRecordingAt = saved === null ? null : checkpointSchema.parse(saved).nextRecordingAt
    let nextRecordingMs = !recorder ? Number.POSITIVE_INFINITY
      : savedNextRecordingAt === null ? simulationMs + recorder.intervalMs : Date.parse(savedNextRecordingAt)
    let closed = false
    const checkpoint = async (): Promise<void> => {
      await store?.save(checkpointSchema.parse({
        nextRecordingAt: Number.isFinite(nextRecordingMs) ? new Date(nextRecordingMs).toISOString() : null,
      }))
    }
    if (saved === null) await checkpoint()

    const commit = (changes: ReadonlyArray<Change>): void => {
      for (const { object } of changes) objects.set(object.id, object)
    }
    const emit = (changes: ReadonlyArray<Change>, recording?: PackRuntimeRecordingBatch, realtimeMessages?: ReadonlyArray<PackRuntimeRealtimeMessage>): void => {
      if (changes.length === 0 && recording === undefined && realtimeMessages === undefined) return
      const at = nowIso()
      const events: PackRuntimeEvent[] = changes.map(({ object, history }) =>
        ({ type: 'object.upserted', object, history, at, provenance: object.provenance }))
      for (const handler of handlers) {
        handler({ type: 'event.emission', runtimeId: fixtureRuntimeId, emittedAt: at, events, ...(recording ? { recording } : {}), ...(realtimeMessages ? { realtimeMessages } : {}) })
      }
    }

    const typed = <T extends FixtureData['type']>(id: ObjectId, type: T, viewer?: RunViewer) => {
      const object = objects.get(id)
      // A side view learns nothing of what it cannot see: a missing object and
      // one outside its picture are refused alike, without echoing the id.
      const visible = object !== undefined && inPicture(object, viewer)
      if (!visible && viewer !== undefined && viewer.sees !== 'all') throw refusal('not_in_picture', `a ${type} this command names is not in your picture`)
      const data = object ? fixtureDataOf(object) : undefined
      if (!object || data?.type !== type) throw new Error(`Fixture ${type} not found: ${id}`)
      return { object, data: data as Extract<FixtureData, { type: T }> }
    }

    /** With authority declared, an operator view commands only the crews its roles are given. */
    const assertCommands = (crew: string | undefined, viewer: RunViewer | undefined): void => {
      if (viewer === undefined || viewer.class === 'controller' || authority === undefined) return
      if (crew !== undefined && authority.some(entry => viewer.roleIds.includes(entry.roleId) && entry.crews.includes(crew))) return
      throw refusal('unit_not_authorized', 'none of your roles commands this unit')
    }

    const step = (object: OperationalObject, seconds: number): Change[] => {
      const data = fixtureDataOf(object)
      if (data.type !== 'unit' || data.taskId === undefined || object.operational.status !== 'en_route') return []
      const from = pointOf(object)
      const to = pointOf(typed(data.taskId, 'task').object)
      const remainingM = routeDistanceMeters(from, to)
      const travelM = data.speedMps * seconds
      if (travelM >= remainingM) return [{ object: revise(object, { status: 'arrived', point: to, speedMps: 0 }), history: 'record' }]
      const fraction = travelM / remainingM
      const point = geoPointFromLonLat(
        from.coordinates[0] + (to.coordinates[0] - from.coordinates[0]) * fraction,
        from.coordinates[1] + (to.coordinates[1] - from.coordinates[1]) * fraction,
      )
      return [{ object: revise(object, { point }), history: 'snapshot-only' }]
    }

    const advance = (targetMs: number): void => {
      if (closed || targetMs <= simulationMs) return
      const seconds = (targetMs - simulationMs) / 1_000
      const changes = [...objects.values()].flatMap(object => step(object, seconds))
      simulationMs = targetMs
      commit(changes)
      let recording: PackRuntimeRecordingBatch | undefined
      if (recorder && simulationMs >= nextRecordingMs) {
        recording = recorder.sample([...objects.values()], simulationMs)
        nextRecordingMs = simulationMs + recorder.intervalMs
      }
      emit(changes, recording)
    }
    const advanceToRunClock = (): void => advance(Date.parse(runClock.read().currentTime))

    const apply = (command: CommandEnvelope, viewer: RunViewer | undefined): Change[] => {
      if (command.kind === fixtureCommandIds.createItem) {
        const { item } = createItemInput.parse(command.payload)
        // Every picture check comes before construction, which would say an id
        // is taken or read a place: a side view learns nothing that way of an
        // object outside its picture, and the refusal echoes no id.
        if (!inPicture(item, viewer)) throw refusal('not_in_picture', 'a screen creates only objects in its own picture')
        for (const id of [item.id, ...(item.atObject === undefined ? [] : [item.atObject])]) {
          const existing = objectById(id)
          if (existing !== undefined && !inPicture(existing, viewer)) throw refusal('not_in_picture', 'an object this command names is not in your picture')
        }
        return [{ object: createFixtureObject(item, { at: nowIso(), objectById }), history: 'record' }]
      }
      if (command.kind === fixtureCommandIds.assign) {
        const { unitId, taskId } = assignInput.parse(command.payload)
        const unit = typed(unitId, 'unit', viewer)
        const task = typed(taskId, 'task', viewer)
        assertCommands(unit.data.crew, viewer)
        if (unit.data.taskId !== undefined) throw new Error(`${unitId} is already assigned to ${unit.data.taskId}`)
        if (task.data.unitId !== undefined) throw new Error(`${taskId} already has unit ${task.data.unitId}`)
        return [
          { object: revise(unit.object, { status: 'en_route', speedMps: unit.data.speedMps, packData: { ...unit.data, taskId } }), history: 'record' },
          { object: revise(task.object, { status: 'assigned', packData: { ...task.data, unitId } }), history: 'record' },
        ]
      }
      if (command.kind === fixtureCommandIds.setPriority) {
        const { taskId, priority } = setPriorityInput.parse(command.payload)
        const task = typed(taskId, 'task', viewer)
        return [{ object: revise(task.object, { packData: { ...task.data, priority } }), history: 'record' }]
      }
      throw new Error(`Unsupported fixture command: ${command.kind}`)
    }

    // Observation reads answer within the stamped viewer's picture, as every fixture query does.
    const unitFor = (objectId: ObjectId, viewer: RunViewer | undefined): OperationalObject => {
      const object = objects.get(objectId)
      if (!object || !inPicture(object, viewer) || fixtureDataOf(object).type !== 'unit') throw new Error(`${objectId} is not a unit in this picture`)
      return object
    }
    const observationHandlers: Readonly<Record<string, (raw: unknown, viewer: RunViewer | undefined) => unknown>> = {
      [fixtureObservationIds.declarations]: (raw, viewer) => {
        const input = observationShapes.declarations.input.parse(raw)
        return { declarations: input.objectIds.map(objectId => input.known?.[objectId] === observationRevision
          ? { objectId, revision: observationRevision, unchanged: true as const }
          : unitDeclaration(unitFor(objectId, viewer), config.recording !== undefined)) }
      },
      [fixtureObservationIds.read]: (raw, viewer) => {
        const input = observationShapes.read.input.parse(raw)
        const at = runClock.read().currentTime
        if ('lead' in input) return { observations: unitObservations(unitFor(input.lead.objectId, viewer), at).slice(0, input.lead.count), unknown: [] }
        const values = new Map(input.refs.flatMap(ref => unitObservations(unitFor(objectIdSchema.parse(ref.slice(0, ref.indexOf('#'))), viewer), at)).map(entry => [entry.ref, entry]))
        return { observations: input.refs.flatMap(ref => values.get(ref) ?? []), unknown: input.refs.filter(ref => !values.has(ref)) }
      },
      [fixtureObservationIds.topology]: (raw, viewer) => {
        const input = observationShapes.topology.input.parse(raw)
        const unit = unitFor(input.objectId, viewer)
        return input.known === observationRevision ? { objectId: unit.id, revision: observationRevision, unchanged: true } : unitTopology(unit)
      },
    }

    const interval = setInterval(advanceToRunClock, tickIntervalMs)

    return {
      getSnapshot: async () => ({ simulationRunId: config.simulationRunId, objects: [...objects.values()], capturedAt: nowIso() }),
      subscribe: handler => {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
      sendCommand: async (command, context) => {
        advanceToRunClock()
        if (command.kind === fixtureCommandIds.announce) {
          const { text } = announceInput.parse(command.payload)
          emit([], undefined, [{ type: fixtureAnnouncementType, at: nowIso(), payload: { text } }])
          return { ok: true, commandId: command.id, acceptedAt: nowIso() }
        }
        let changes: Change[]
        try { changes = apply(command, context.viewer) }
        catch (error) {
          return { ok: false, commandId: command.id, rejectedAt: nowIso(), reason: error instanceof Error ? error.message : String(error) }
        }
        commit(changes)
        emit(changes)
        return { ok: true, commandId: command.id, acceptedAt: nowIso() }
      },
      invokeQuery: async request => {
        if (request.capabilityId === fixtureQueryIds.state) {
          stateInput.parse(request.input)
          return stateOf([...objects.values()].filter(object => inPicture(object, request.viewer)))
        }
        if (request.capabilityId === fixtureQueryIds.object) {
          const object = objects.get(objectInput.parse(request.input).objectId)
          return { object: object !== undefined && inPicture(object, request.viewer) ? object : null }
        }
        if (request.capabilityId === fixtureQueryIds.viewer) {
          stateInput.parse(request.input)
          return { viewer: request.viewer ?? null }
        }
        if (request.capabilityId in observationHandlers) return observationHandlers[request.capabilityId]!(request.input, request.viewer)
        throw new Error(`Unsupported fixture query: ${request.capabilityId}`)
      },
      validateObjectDeletion: (objectId, candidates) => {
        for (const object of candidates) {
          if (object.packId !== fixturePackId) continue
          const data = fixtureDataOf(object)
          if (data.type === 'unit' && data.taskId !== undefined && (object.id === objectId || data.taskId === objectId)) {
            throw new Error(`Cannot delete ${objectId}: ${object.label} is assigned to ${data.taskId}`)
          }
        }
      },
      observeCommittedEvents: async events => {
        for (const event of events) {
          if (event.type === 'object.deleted') objects.delete(event.objectId)
          if (event.type === 'object.upserted' && event.object.packId === fixturePackId) {
            const current = objects.get(event.object.id)
            if (!current || current.revision < event.object.revision) objects.set(event.object.id, validated(event.object))
          }
        }
      },
      setClock: async () => { advanceToRunClock() },
      advanceTo: async clock => { advance(Date.parse(clock.currentTime)) },
      checkpoint,
      close: async () => {
        closed = true
        clearInterval(interval)
        handlers.clear()
        await checkpoint()
      },
    }
  },
})
