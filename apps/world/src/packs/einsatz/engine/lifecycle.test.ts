import { describe, expect, test } from 'bun:test'
import { meters, routeDistanceMeters, type IsoTimestamp, type RouteImpact } from '../../../core/model/index.ts'
import type { RoutePort } from './movement.ts'
import { advance, arrivalAt, at, config, controller, emptyState, low, middle, newTask, newUnit, pointOf, ports, refusalOf, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { advanceEngine, commitIntent, executeIntent, planIntent, prepareLegs, setRouteImpacts } from './engine.ts'
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
    expect(unitOf(sent, 'u1')).toMatchObject({ phase: 'mobilizing', phaseDueMs: start + 2_000, taskId: 't1', atBase: true })
    const onTaskAt = arrivalAt(sent, 'u1')
    const { state, transitions } = await advanceEngine(sent, start + 300_000, ports)
    expect(phasesOf(transitions, 'u1')).toEqual(['en-route', 'on-task', 'holding', 'transporting', 'at-site', 'available', 'returning', 'available'])
    const departed = transitions.find(entry => entry.kind === 'unit' && entry.record.id === 'u1' && entry.record.phase === 'en-route')
    expect(departed?.kind === 'unit' && departed.record).toMatchObject({ atBase: false })
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

  test('a site serves an earlier arrival first even when its id sorts later', async () => {
    let state = await runAll(emptyState(), [
      newUnit('a', types.directCarrier, at(0)),
      newUnit('b', types.directCarrier, at(0.002)),
      newUnit('site', types.publicSite, at(0.003)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
      newTask('t2', templates.load, at(0.002), { [low]: 1 }),
      send(['a'], { taskId: 't1' }),
      send(['b'], { taskId: 't2' }),
    ])
    state = await advance(state, start + 3_000)
    state = await run(state, send(['a', 'b'], { siteId: 'site' }))
    state = await run(state, { kind: 'site.set', siteId: 'site', accepting: false })
    const [first, second] = [arrivalAt(state, 'b'), arrivalAt(state, 'a')]
    expect(first).toBeLessThan(second)
    const reopenAt = second + 1_000
    state = await advance(state, reopenAt)
    expect([unitOf(state, 'a'), unitOf(state, 'b')].map(unit => [unit.phase, unit.phaseSinceMs, unit.phaseDueMs])).toEqual([['at-site', second, undefined], ['at-site', first, undefined]])
    state = await run(state, { kind: 'site.set', siteId: 'site', accepting: true })
    expect(unitOf(state, 'b').phaseDueMs).toBe(reopenAt + 4_000)
    expect(unitOf(state, 'a').phaseDueMs).toBeUndefined()
    state = await advance(state, reopenAt + 4_000)
    expect(unitOf(state, 'b')).toMatchObject({ phase: 'available', load: {} })
    expect(unitOf(state, 'a').phaseDueMs).toBe(reopenAt + 8_000)
  })

  test('a unit turning out is still at base, so a task closed or a recall then leaves it there with no return order', async () => {
    const turningOut = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    for (const intent of [{ kind: 'task.close', taskId: 't1' }, { kind: 'recall', unitId: 'u1' }] as const) {
      const stood = await run(turningOut, intent)
      expect(unitOf(stood, 'u1')).toMatchObject({ phase: 'available', atBase: true })
      expect(unitOf(stood, 'u1').leg).toBeUndefined()
      expect((await advanceEngine(stood, start + 300_000, ports)).transitions).toEqual([])
    }
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

  test('a canonical route impact slows actual progress and the ETA, and a zero factor stops the unit mid-route without losing its phase', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 5_000)
    const travelled = state.motion.get('u1')!
    expect(travelled.progressMs).toBe(3_000)
    expect(travelled.point).not.toEqual(at(0))
    const impact = (speedFactor: number): RouteImpact => ({ source: { kind: 'runtime', id: 'test.impact' }, label: 'Synthetic constraint', severity: 'high', speedFactor, updatedAt: stampAt })
    state = setRouteImpacts(state, 'u1', [impact(0)])
    state = await advance(state, start + 25_000)
    expect(state.motion.get('u1')).toMatchObject({ point: travelled.point, progressMs: 3_000 })
    expect(unitObject(state, unitOf(state, 'u1'), state.motion.get('u1')!, stamp()).spatial.route?.etaSeconds).toBeUndefined()
    expect(unitOf(state, 'u1').phase).toBe('en-route')

    state = setRouteImpacts(state, 'u1', [impact(0.5)])
    const remainingMs = unitOf(state, 'u1').leg!.durationMs - 3_000
    expect(unitObject(state, unitOf(state, 'u1'), state.motion.get('u1')!, stamp()).spatial.route?.etaSeconds).toBeCloseTo(remainingMs * 2 / 1_000, 6)
    state = await advance(state, start + 25_000 + Math.ceil(remainingMs * 2) - 1)
    expect(unitOf(state, 'u1').phase).toBe('en-route')
    state = await advance(state, start + 25_000 + Math.ceil(remainingMs * 2))
    expect(unitOf(state, 'u1').phase).toBe('on-task')
  })

  test('a road leg follows dense router geometry by distance and arrives on the provider travel time', async () => {
    const corners = [at(0), at(0, 0.002), at(0.01, 0.002), at(0.01)]
    const dogleg: RoutePort = {
      id: 'dogleg',
      route: async () => ({ geometry: { type: 'LineString', coordinates: corners.map(point => point.coordinates) }, distanceM: meters(1_100), durationSeconds: 100, provider: 'dogleg' }),
    }
    const routed = { routing: dogleg }
    const sent = await executeIntent(await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
    ]), send(['u1'], { taskId: 't1' }), controller, routed)
    if (!sent.ok) throw new Error(sent.reason)
    expect(unitOf(sent.state, 'u1').leg).toMatchObject({ durationMs: 100_000, distanceM: 1_100, provider: 'dogleg' })
    const lengths = corners.slice(1).map((point, index) => routeDistanceMeters(corners[index]!, point))
    const halfway = lengths.reduce((sum, length) => sum + length, 0) / 2
    const midway = (await advanceEngine(sent.state, start + 2_000 + 50_000, routed)).state
    expect(unitObject(midway, unitOf(midway, 'u1'), midway.motion.get('u1')!, stamp()).spatial.route?.progress?.segmentIndex).toBe(2)
    const [lon, lat] = pointOf(midway, 'u1').coordinates
    expect(lat).toBeCloseTo(corners[1]!.coordinates[1], 9)
    expect(lon).toBeCloseTo(corners[1]!.coordinates[0] + (corners[2]!.coordinates[0] - corners[1]!.coordinates[0]) * (halfway - lengths[0]!) / lengths[1]!, 9)
    const arrived = (await advanceEngine(midway, start + 2_000 + 100_000, routed)).state
    expect(unitOf(arrived, 'u1').phase).toBe('on-task')
    expect(pointOf(arrived, 'u1')).toEqual(at(0.01))
  })

  test('legs routed on an earlier state are refused at commit; legs routed on the current state start where the unit is', async () => {
    const sent = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.05), { [low]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    const planned = await advance(sent, start + 2_000)
    const intent = send(['u1'], { point: at(0.02, 0.01) }, [{ unitId: 'u1', fromTaskId: 't1' }])
    const routedOn = async (state: EngineState) => {
      const plan = planIntent(state, intent, controller)
      if (!plan.ok) throw new Error(plan.reason)
      const legs = await prepareLegs(state, plan.routes, ports.routing)
      if (!legs.ok) throw new Error(legs.reason)
      return legs.legs
    }
    const early = await routedOn(planned)
    const moved = await advance(planned, start + 60_000)
    expect(() => commitIntent(moved, intent, controller, early)).toThrow('State changed while routing u1; plan and route again')
    const committed = commitIntent(moved, intent, controller, await routedOn(moved))
    if (!committed.ok) throw new Error(committed.reason)
    expect(pointOf(committed.state, 'u1')).toEqual(pointOf(moved, 'u1'))
    expect(unitOf(committed.state, 'u1').leg!.geometry.coordinates[0]).toEqual([...pointOf(moved, 'u1').coordinates])
    const next = await advance(committed.state, start + 61_000)
    expect(routeDistanceMeters(pointOf(moved, 'u1'), pointOf(next, 'u1'))).toBeCloseTo(15, 0)
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
