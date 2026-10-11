import { describe, expect, test } from 'bun:test'
import type { SimulationRunId, GeoJsonLineString, IsoTimestamp, ObjectId, SimulationClockState } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  applySimulationRunEventBatchMessage,
  type SimulationRunEventBatchMessage,
  commandStatusForResult,
  parseSimulationRunEventBatchMessage,
  parseSimulationRunWebSocketMessage,
  removeOperationalObject,
  upsertOperationalObject,
} from '../src/ui/simulation-run-events.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { workspaceIdSchema } from '@leitbild/contracts'

const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const messageScope = { workspaceId, simulationRunId: 'run-event-helper-test' }

const scenarioObjects = () => structuredClone(responseScenario.initialObjects)

const eventBatch = (
  events: SimulationRunEventBatchMessage['events'],
  config: { readonly scenarioId?: string; readonly snapshotSeq?: number } = {},
): SimulationRunEventBatchMessage => ({
  type: 'events',
  workspaceId,
  simulationRunId: 'run-event-helper-test' as SimulationRunId,
  ...(config.scenarioId === undefined ? {} : { scenarioId: config.scenarioId }),
  snapshotSeq: config.snapshotSeq ?? 1,
  events,
})

describe('simulation run event helpers', () => {
  test('parses valid event-array messages and ignores unrelated messages', () => {
    const object = scenarioObjects()[0]
    if (!object) throw new Error('scenario fixture missing object')

    const parsed = parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'events',
      ...messageScope,
      scenarioId: 'test-response',
      snapshotSeq: 1,
      events: [{ type: 'object.upserted', object }],
    }))

    expect(parsed?.events[0]?.type).toBe('object.upserted')
    expect(parsed?.events[0]?.object?.id).toBe(object.id)
    expect(parsed?.scenarioId).toBe('test-response')
    expect(parseSimulationRunEventBatchMessage(JSON.stringify({ type: 'snapshot' }))).toBeNull()
  })

  test('parses realtime ready messages separately from event batches', () => {
    const parsed = parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'realtime.ready',
      ...messageScope,
      scenarioId: 'halden',
      snapshotSeq: 12,
    }))

    expect(parsed?.type).toBe('realtime.ready')
    if (parsed?.type !== 'realtime.ready') throw new Error('expected realtime ready message')
    expect(String(parsed.simulationRunId)).toBe('run-event-helper-test')
    expect(parsed.workspaceId).toBe(workspaceId)
    expect(parsed.scenarioId).toBe('halden')
    expect(parsed.snapshotSeq).toBe(12)
    expect(parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'realtime.ready',
      ...messageScope,
      snapshotSeq: 12,
    }))).toBeNull()
  })

  test('parses realtime Capability result messages', () => {
    const parsed = parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'capability.result',
      ...messageScope,
      requestId: 'rtcmd:test',
      outcome: {
        kind: 'command',
        replayed: false,
        result: {
          ok: true,
          commandId: 'command:test',
          acceptedAt: '2026-01-01T10:00:00.000Z',
        },
      },
    }))

    expect(parsed?.type).toBe('capability.result')
    if (parsed?.type !== 'capability.result') throw new Error('expected Capability result message')
    expect(parsed.requestId).toBe('rtcmd:test')
    expect(parsed.outcome.kind).toBe('command')
  })

  test('parses runtime realtime messages separately from event batches', () => {
    const parsed = parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'runtime.realtime',
      ...messageScope,
      scenarioId: 'test-drone',
      snapshotSeq: 42,
      messages: [{
        type: 'drone.motion.frames',
        at: '2026-01-01T10:00:00.000Z',
        payload: { frames: [] },
      }],
    }))

    expect(parsed?.type).toBe('runtime.realtime')
    if (parsed?.type !== 'runtime.realtime') throw new Error('expected runtime realtime message')
    expect(parsed.snapshotSeq).toBe(42)
    expect(parsed.messages[0]?.type).toBe('drone.motion.frames')
    expect(parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'runtime.realtime',
      ...messageScope,
      snapshotSeq: 42,
      messages: [],
    }))).toBeNull()
  })

  test('parses runtime input errors as visible protocol failures', () => {
    const parsed = parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'runtime.input.error',
      ...messageScope,
      inputType: 'drone.manual.intent',
      message: 'manual flight is not ready',
    }))

    expect(parsed?.type).toBe('runtime.input.error')
    if (parsed?.type !== 'runtime.input.error') throw new Error('expected runtime input error')
    expect(parsed.inputType).toBe('drone.manual.intent')
    expect(parsed.message).toBe('manual flight is not ready')
  })

  test('fails visibly for malformed WebSocket protocol payloads', () => {
    expect(() => parseSimulationRunEventBatchMessage('{')).toThrow('invalid WebSocket JSON')
    expect(() => parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'events',
      workspaceId,
      events: [{}],
    }))).toThrow('Simulation Run id')
    expect(() => parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'events',
      ...messageScope,
      snapshotSeq: 1,
      events: [{}],
    }))).toThrow('missing event type')
    expect(() => parseSimulationRunEventBatchMessage(JSON.stringify({
      type: 'events',
      ...messageScope,
      snapshotSeq: 1,
    }))).toThrow('missing events array')
    expect(() => parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'realtime.ready',
      workspaceId,
      scenarioId: 'halden',
      snapshotSeq: 12,
    }))).toThrow('Simulation Run id')
    expect(() => parseSimulationRunWebSocketMessage(JSON.stringify({
      type: 'runtime.realtime',
      ...messageScope,
      snapshotSeq: 1,
      messages: [{}],
    }))).toThrow('missing type')
  })

  test('upserts objects without duplicating object ids', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const updated = { ...object, label: 'Updated object', revision: object.revision + 1 }
    const next = upsertOperationalObject(objects, updated)

    expect(next.filter(candidate => candidate.id === object.id)).toHaveLength(1)
    expect(next.find(candidate => candidate.id === object.id)?.label).toBe('Updated object')
  })

  test('upserts existing objects without changing their list order', () => {
    const objects = scenarioObjects()
    const first = objects[0]
    const second = objects[1]
    const third = objects[2]
    if (!first || !second || !third) throw new Error('scenario fixture missing expected objects')

    const updatedSecond = { ...second, label: 'Updated second object', revision: second.revision + 1 }
    const next = upsertOperationalObject(objects, updatedSecond)

    expect(next.map(object => object.id)).toEqual(objects.map(object => object.id))
    expect(next[1]?.label).toBe('Updated second object')
  })

  test('removes deleted objects and clears selection when the selected controller is deleted', () => {
    const objects = scenarioObjects()
    const selected = objects[0]
    if (!selected) throw new Error('scenario fixture missing object')

    const next = removeOperationalObject({ objects, selectedControllerId: selected.id }, selected.id)

    expect(next.objects.some(object => object.id === selected.id)).toBe(false)
    expect(next.selectedControllerId).toBeNull()
  })

  test('applies supported event-array messages to object and command-status state', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const deleted = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: object.id },
      eventBatch([{ type: 'object.deleted', objectId: object.id as ObjectId }]),
    )
    expect(deleted.objectUpdate?.selectedControllerId).toBeNull()
    expect(deleted.routesChanged).toBe(false)

    const rejected = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: object.id },
      eventBatch([{ type: 'command.result', result: { ok: false, reason: 'blocked' } }]),
    )
    expect(rejected.commandStatusUpdate?.commandStatus).toBe('Command rejected: blocked')
    expect(rejected.routesChanged).toBe(false)
    expect(commandStatusForResult({ ok: true })).toBe('Command accepted')
  })

  test('applies clock update events separately from object updates', () => {
    const objects = scenarioObjects()
    const clock: SimulationClockState = {
      currentTime: '2026-01-01T10:00:00.000Z' as IsoTimestamp,
      updatedAt: '2026-01-01T10:00:00.000Z' as IsoTimestamp,
      paused: true,
    }

    const applied = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: null },
      eventBatch([{ type: 'clock.updated', clock }]),
    )

    expect(applied.clockUpdate).toEqual(clock)
    expect(applied.objectUpdate).toBeUndefined()
    expect(applied.routesChanged).toBe(false)
  })

  test('applies multiple object updates in one pass while preserving existing order', () => {
    const objects = scenarioObjects()
    const first = objects[0]
    const second = objects[1]
    const third = objects[2]
    if (!first || !second || !third) throw new Error('scenario fixture missing expected objects')

    const updatedSecond = { ...second, label: 'Updated second', revision: second.revision + 1 }
    const updatedAgain = { ...updatedSecond, label: 'Updated second again', revision: updatedSecond.revision + 1 }
    const newObject = { ...first, id: 'object:new' as ObjectId, label: 'New object' }
    const applied = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: first.id },
      eventBatch([
          { type: 'object.upserted', object: updatedSecond },
          { type: 'object.upserted', object: newObject },
          { type: 'object.upserted', object: updatedAgain },
        ]),
    )

    expect(applied.objectUpdate?.objects.map(candidate => candidate.id)).toEqual([...objects.map(candidate => candidate.id), newObject.id])
    expect(applied.objectUpdate?.objects[1]?.label).toBe('Updated second again')
  })

  test('reports route changes separately from position-only updates', () => {
    const objects = scenarioObjects()
    const object = objects[0]
    if (!object) throw new Error('scenario fixture missing object')

    const positionOnly = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: object.id },
      eventBatch([{ type: 'object.upserted', object: { ...object, revision: object.revision + 1 } }]),
    )
    expect(positionOnly.routesChanged).toBe(false)

    const plannedRoute: GeoJsonLineString = {
      type: 'LineString',
      coordinates: [
        geoPointFromLonLat(10.7, 59.9).coordinates,
        geoPointFromLonLat(10.8, 59.95).coordinates,
      ],
    }
    const routed = {
      ...object,
      revision: object.revision + 2,
      spatial: {
        ...object.spatial,
        route: {
          planned: plannedRoute,
          source: 'operator' as const,
        },
      },
    }
    const routeUpdate = applySimulationRunEventBatchMessage(
      { objects, selectedControllerId: object.id },
      eventBatch([{ type: 'object.upserted', object: routed }]),
    )
    expect(routeUpdate.routesChanged).toBe(true)
  })
})
