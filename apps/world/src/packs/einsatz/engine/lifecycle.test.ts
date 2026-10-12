import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, RouteImpact } from '../../../core/model/index.ts'
import { advance, arrivalAt, at, config, controller, emptyState, low, middle, newTask, newUnit, pointOf, ports, refusalOf, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { advanceEngine, executeIntent, setRouteImpacts } from './engine.ts'
import type { EngineState } from './model.ts'
import { engineObjects, readEngineState, runtimeStateOf, unitObject } from './objects.ts'

const stampAt = new Date(start).toISOString() as IsoTimestamp
const stamp = () => ({ at: stampAt, provenance: { source: 'simulator' as const } })

const lifecycleState = () => runAll(emptyState(), [
  newUnit('u1', types.roadCarrier, at(0)),
  newUnit('site', types.publicSite, at(0.004)),
  newTask('t1', templates.load, at(0.002), { [top]: 1 }),
  send(['u1'], { taskId: 't1' }),
])

const phasesOf = (transitions: Awaited<ReturnType<typeof advanceEngine>>['transitions'], id: string): string[] =>
  transitions.flatMap(entry => entry.kind === 'unit' && entry.record.id === id ? [entry.record.phase] : [])
    .filter((phase, index, phases) => phase !== phases[index - 1])

const normalized = (state: EngineState) => ({
  time: state.timeMs,
  units: [...state.units.values()].map(unit => ({ unit, point: pointOf(state, unit.id).coordinates })),
  tasks: [...state.tasks.values()],
})

describe('Einsatz unit lifecycle', () => {
  test('crosses every timed phase, delivers by standing order, closes the task and returns to base', async () => {
    const sent = await lifecycleState()
    expect(unitOf(sent, 'u1')).toMatchObject({ phase: 'mobilizing', phaseDueMs: start + 2_000, taskId: 't1', atBase: false })
    const onTaskAt = arrivalAt(sent, 'u1')
    const { state, transitions } = await advanceEngine(sent, start + 300_000, ports)
    expect(phasesOf(transitions, 'u1')).toEqual(['en-route', 'on-task', 'holding', 'transporting', 'at-site', 'available', 'returning', 'available'])
    const timeOf = (phase: string): number => transitions.find(entry => entry.kind === 'unit' && entry.record.id === 'u1' && entry.record.phase === phase)!.atMs
    expect(timeOf('on-task')).toBe(onTaskAt)
    expect(timeOf('holding')).toBe(onTaskAt + 3_000)
    expect(timeOf('transporting')).toBe(onTaskAt + 3_000)
    expect(taskOf(state, 't1')).toMatchObject({ closedAtMs: onTaskAt + 3_000, loads: {}, pickedUp: { [top]: 1 } })
    expect(unitOf(state, 'site').received).toEqual({ [top]: 1 })
    const delivered = transitions.find(entry => entry.kind === 'unit' && entry.record.id === 'u1' && entry.record.phase === 'transporting')
    expect(delivered?.kind === 'unit' && delivered.record.lastAction).toMatchObject({ verb: 'deliver', target: 'site', by: 'standing-order:deliver' })
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'available', atBase: true, load: {} })
    expect(pointOf(state, 'u1')).toEqual(unitOf(state, 'u1').base)
  })

  test('large versus small advances and a mid-route restore from objects and runtime state reach the same outcome', async () => {
    const large = await lifecycleState()
    let small = await lifecycleState()
    small = await advance(small, start + 7_250)
    expect(unitOf(small, 'u1').phase).toBe('en-route')
    const restored = readEngineState({ config, sides: [], objects: engineObjects(small, stamp), runtime: runtimeStateOf(small) })
    for (let elapsed = 7_500; elapsed <= 300_000; elapsed += 250) small = await advance(small, start + elapsed)
    const expected = normalized(await advance(large, start + 300_000))
    expect(normalized(small)).toEqual(expected)
    expect(normalized(await advance(restored, start + 300_000))).toEqual(expected)
  })

  test('a site hands over in arrival order with stable ties, holds its queue while closed and resumes when it reopens', async () => {
    let state = await runAll(emptyState(), [
      newUnit('a', types.directCarrier, at(0)),
      newUnit('b', types.directCarrier, at(0)),
      newUnit('site', types.publicSite, at(0.003)),
      newTask('t1', templates.load, at(0), { [top]: 1, [middle]: 1, [low]: 1 }),
    ])
    state = await run(state, send(['a'], { taskId: 't1' }))
    state = await run(state, send(['b'], { taskId: 't1' }))
    state = await advance(state, start + 4_000)
    expect([unitOf(state, 'a').phase, unitOf(state, 'b').phase]).toEqual(['holding', 'holding'])
    expect(taskOf(state, 't1').closedAtMs).toBe(start + 3_000)
    state = await run(state, send(['b', 'a'], { siteId: 'site' }))
    const arrival = arrivalAt(state, 'a')
    state = await advance(state, arrival)
    expect(unitOf(state, 'a')).toMatchObject({ phase: 'at-site', phaseDueMs: arrival + 4_000 })
    expect(unitOf(state, 'b')).toMatchObject({ phase: 'at-site' })
    expect(unitOf(state, 'b').phaseDueMs).toBeUndefined()
    state = await run(state, { kind: 'site.set', siteId: 'site', accepting: false })
    state = await advance(state, arrival + 10_000)
    expect(unitOf(state, 'a')).toMatchObject({ phase: 'available', load: {} })
    expect(unitOf(state, 'b').phaseDueMs).toBeUndefined()
    state = await run(state, { kind: 'site.set', siteId: 'site', accepting: true })
    expect(unitOf(state, 'b').phaseDueMs).toBe(arrival + 14_000)
    state = await advance(state, arrival + 20_000)
    expect(unitOf(state, 'site').received).toEqual({ [top]: 1, [middle]: 1, [low]: 1 })
  })

  test('a loaded unit cannot be recalled or re-tasked; one recalled before pickup leaves the load waiting at its age', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.directCarrier, at(0)),
      newUnit('u2', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      newTask('t2', templates.load, at(0.01), { [middle]: 1 }),
    ])
    state = await run(state, send(['u1'], { taskId: 't1' }))
    state = await advance(state, start + 3_000)
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'holding', load: { [top]: 1 } })
    const loaded = await refusalOf(state, { kind: 'recall', unitId: 'u1' })
    expect(loaded.code).toBe('unit_loaded')
    expect(loaded.reason).toBe('unit_loaded: U1 has 1 person on board, deliver first')
    expect((await refusalOf(state, send(['u1'], { taskId: 't2' }))).code).toBe('unit_loaded')
    expect((await refusalOf(state, { kind: 'hold', unitId: 'u1' })).code).toBe('unit_loaded')

    state = await run(state, send(['u2'], { taskId: 't2' }))
    state = await advance(state, start + 10_000)
    expect(taskOf(state, 't2').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 1 }])
    state = await run(state, { kind: 'recall', unitId: 'u2', fromTaskId: 't2' })
    expect(unitOf(state, 'u2')).toMatchObject({ phase: 'returning', lastAction: { verb: 'recall', by: 'Controller' } })
    expect(unitOf(state, 'u2').taskId).toBeUndefined()
    expect(taskOf(state, 't2')).toMatchObject({ createdAtMs: start, loads: { [middle]: 1 }, alerts: [{ code: 'work_returned', message: 'U2 released from T2 · 1 person waiting' }] })
    expect(taskOf(state, 't2').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 0 }])
    expect(taskOf(state, 't2').closedAtMs).toBeUndefined()
  })

  test('a fractional direct leg arrives on the millisecond Run clock without stalling', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.directCarrier, at(0)),
      newTask('t1', templates.load, at(0.0013), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    const durationMs = unitOf(state, 'u1').leg!.durationMs
    expect(Number.isInteger(durationMs)).toBe(false)
    expect(unitOf(state, 'u1').phase).toBe('en-route')
    state = await advance(state, start + Math.ceil(durationMs))
    expect(unitOf(state, 'u1').phase).toBe('on-task')
    expect(state.timeMs).toBe(start + Math.ceil(durationMs))
  })

  test('a canonical route impact slows actual progress and the ETA, and a zero factor stops the unit without losing its phase', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 2_000)
    const impact = (speedFactor: number): RouteImpact => ({ source: { kind: 'runtime', id: 'test.impact' }, label: 'Synthetic constraint', severity: 'high', speedFactor, updatedAt: stampAt })
    state = setRouteImpacts(state, 'u1', [impact(0)])
    const stoppedAt = pointOf(state, 'u1')
    state = await advance(state, start + 22_000)
    expect(pointOf(state, 'u1')).toEqual(stoppedAt)
    expect(unitObject(state, unitOf(state, 'u1'), state.motion.get('u1')!, stamp()).spatial.route?.etaSeconds).toBeUndefined()
    expect(unitOf(state, 'u1').phase).toBe('en-route')

    state = setRouteImpacts(state, 'u1', [impact(0.5)])
    const remainingMs = unitOf(state, 'u1').leg!.durationMs
    expect(unitObject(state, unitOf(state, 'u1'), state.motion.get('u1')!, stamp()).spatial.route?.etaSeconds).toBeCloseTo(remainingMs * 2 / 1_000, 6)
    state = await advance(state, start + 22_000 + Math.ceil(remainingMs * 2) - 1)
    expect(unitOf(state, 'u1').phase).toBe('en-route')
    state = await advance(state, start + 22_000 + Math.ceil(remainingMs * 2))
    expect(unitOf(state, 'u1').phase).toBe('on-task')
  })

  test('re-sending a unit to its current task succeeds and changes nothing', async () => {
    const state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    const again = await executeIntent(state, send(['u1'], { taskId: 't1' }), controller, ports)
    expect(again.ok && again.notes).toEqual(['U1 already mobilizing to T1'])
    expect(again.ok && again.transitions).toEqual([])
  })
})
