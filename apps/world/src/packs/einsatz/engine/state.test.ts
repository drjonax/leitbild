import { describe, expect, test } from 'bun:test'
import type { EventId, IsoTimestamp, OperationalObject, SimulationRunEvent, SimulationRunId } from '../../../core/model/index.ts'
import { persistenceDispositionFor } from '../../../core/simulation-runs/persistence-policy.ts'
import { arrivalAt, at, config, emptyState, low, newTask, newUnit, pointOf, ports, run, runAll, send, start, templates, types, unitOf } from '../fixtures/engine-harness.ts'
import { advanceEngine } from './engine.ts'
import type { EngineState } from './model.ts'
import { engineObjects, readEngineState, runtimeStateOf, transitionObject, unitObject } from './objects.ts'

const isoAt = (ms: number) => new Date(ms).toISOString() as IsoTimestamp
const upserted = (object: OperationalObject): SimulationRunEvent => ({
  type: 'object.upserted', object, id: 'event:test' as EventId, simulationRunId: 'run-test' as SimulationRunId, seq: 1, at: object.timestamps.updatedAt, provenance: object.provenance,
})
const objectOf = (state: EngineState, id: string, previous?: OperationalObject) =>
  unitObject(state, unitOf(state, id), state.motion.get(id)!, { at: isoAt(state.timeMs), provenance: { source: 'simulator' }, ...(previous === undefined ? {} : { previous }) })

const travelling = () => runAll(emptyState(), [
  newUnit('u1', types.roadCarrier, at(0)),
  newTask('t1', templates.load, at(0.05), { [low]: 1 }),
  send(['u1'], { taskId: 't1' }),
])

describe('Einsatz state discipline', () => {
  test('motion changes position and route progress only: no transition, packData untouched, a projected upsert', async () => {
    const moving = (await advanceEngine(await travelling(), start + 10_000, ports)).state
    const later = await advanceEngine(moving, start + 70_000, ports)
    expect(later.transitions).toEqual([])
    expect(unitOf(later.state, 'u1')).toBe(unitOf(moving, 'u1'))
    expect(pointOf(later.state, 'u1')).not.toEqual(pointOf(moving, 'u1'))
    const before = objectOf(moving, 'u1')
    const after = objectOf(later.state, 'u1', before)
    expect(after.packData).toEqual(before.packData)
    expect(after.spatial.route?.etaSeconds).toBeLessThan(before.spatial.route!.etaSeconds!)
    expect(persistenceDispositionFor(upserted(after), before)).toBe('projected')
  })

  test('each phase change is one transition, written as a durable upsert carrying the position at that moment', async () => {
    const sent = await travelling()
    const arrival = arrivalAt(sent, 'u1')
    const { state, transitions } = await advanceEngine(sent, arrival, ports)
    expect(transitions.map(entry => [entry.kind, entry.atMs, entry.kind === 'unit' ? entry.record.phase : entry.record.coverage.loads[0]?.covered])).toEqual([
      ['unit', start + 2_000, 'en-route'],
      ['unit', arrival, 'on-task'],
    ])
    const previous = objectOf(sent, 'u1')
    const written = transitionObject(state, transitions[1]!, { at: isoAt(arrival), provenance: { source: 'simulator' }, previous })
    expect(written.spatial.position?.point).toEqual(pointOf(state, 'u1'))
    expect(written.operational.status).toBe('on-task')
    expect(written.revision).toBe(previous.revision + 1)
    expect(persistenceDispositionFor(upserted(written), previous)).toBe('durable')
  })

  test('leg progress lives in the runtime state; a restore without it is refused rather than guessed', async () => {
    const moving = (await advanceEngine(await travelling(), start + 10_000, ports)).state
    const runtime = runtimeStateOf(moving)
    const leg = unitOf(moving, 'u1').leg!
    expect(runtime).toEqual({ timeMs: start + 10_000, units: { u1: { progressMs: 8_000, leg: {
      provider: leg.provider, durationMs: leg.durationMs, distanceM: leg.distanceM, from: leg.geometry.coordinates[0], to: leg.geometry.coordinates.at(-1),
    } } } })
    const objects = engineObjects(moving, () => ({ at: isoAt(moving.timeMs), provenance: { source: 'simulator' } }))
    expect(objects.find(object => object.id === 'u1')?.packData).not.toHaveProperty('progressMs')
    expect(() => readEngineState({ config, sides: [], objects, runtime: { timeMs: runtime.timeMs, units: {} } })).toThrow('leg progress is missing')
    const restored = readEngineState({ config, sides: [], objects, runtime })
    expect(restored.motion.get('u1')).toEqual(moving.motion.get('u1')!)
    expect([...restored.units.values()]).toEqual([...moving.units.values()])
    expect([...restored.tasks.values()]).toEqual([...moving.tasks.values()])
  })

  test('saved progress names its leg; progress saved for a leg the unit has since left is refused, never applied to its new leg', async () => {
    const moving = (await advanceEngine(await travelling(), start + 10_000, ports)).state
    const recalled = await run(moving, { kind: 'recall', unitId: 'u1' })
    expect(unitOf(recalled, 'u1').leg).not.toEqual(unitOf(moving, 'u1').leg)
    const objects = engineObjects(recalled, () => ({ at: isoAt(recalled.timeMs), provenance: { source: 'simulator' } }))
    expect(() => readEngineState({ config, sides: [], objects, runtime: runtimeStateOf(moving) }))
      .toThrow('u1: the saved leg progress measures another leg than the unit\'s canonical one')
    expect(readEngineState({ config, sides: [], objects, runtime: runtimeStateOf(recalled) }).motion.get('u1')).toEqual(recalled.motion.get('u1')!)
  })
})
