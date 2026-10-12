import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type GeoJsonPoint, type IsoTimestamp } from '../../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { advance, arrivalAt, at, config, controller, emptyState, low, middle, newTask, newUnit, pointOf, ports, refusalOf, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { einsatzSidedSelection } from '../fixtures/sided-run.ts'
import { plannedPaths } from '../chain-path.ts'
import { recommend } from '../recommend.ts'
import type { StepTarget } from '../steps.ts'
import { openViewer } from '../viewer.ts'
import { advanceEngine, executeIntent } from './engine.ts'
import type { Intent } from './intents.ts'
import type { TrackRecord } from './combat-model.ts'
import { emptyEngineState, type EngineState, type Transition, type UnitRecord } from './model.ts'
import { engineObjects, readEngineState, runtimeStateOf } from './objects.ts'
import { sameValue } from './values.ts'

const queue = (unitId: string, to: StepTarget): Intent => ({ kind: 'queue', unitId, to })
const remove = (unitId: string, stepId: string): Intent => ({ kind: 'step.remove', unitId, stepId })
const unitTransitions = (transitions: ReadonlyArray<Transition>, id: string): UnitRecord[] =>
  transitions.flatMap(entry => entry.kind === 'unit' && entry.record.id === id ? [entry.record] : [])
const stepsOf = (unit: UnitRecord) => unit.orders.map(step => [step.id, step.kind, step.state] as const)
const objectsOf = (state: EngineState) => engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))

const sidedSelection = einsatzSidedSelection('chain', { side: 'north', role: 'north-lead' }, { side: 'south', role: 'south-lead' })
const sidedTypes = einsatzConfigSchema.parse(sidedSelection.config).unitTypes
const gunType = sidedTypes.find(type => type.components.effector !== undefined)!
const scoutType = sidedTypes.find(type => type.components.sensor !== undefined && type.components.effector === undefined && type.components.durability !== undefined)!
/** A shooter that cannot move. */
const fixedGun = (() => {
  const { mobility: _mobility, ...components } = gunType.components
  return { ...gunType, id: 'fixed-gun', label: 'Fixed gun', components }
})()
const sidedConfig = einsatzConfigSchema.parse({ ...sidedSelection.config, unitTypes: [...sidedTypes, fixedGun] })
const north = (metres: number): GeoJsonPoint => geoPointFromLonLat(11.2, 59 + metres / 110_540)
const place = (id: string, type: string, side: string, point: GeoJsonPoint): Intent => ({ kind: 'unit.create', id, type, side, at: point, label: id.toUpperCase() })
const outcome = async (state: EngineState, intent: Intent): Promise<EngineState> => {
  const result = await executeIntent(state, intent, controller, ports)
  if (!result.ok) throw new Error(result.reason)
  return result.state
}

/** North's scout and, 500 m north of it, South's, with the units `more` places, once North has identified South's scout: the state and North's track on it. */
const sidedField = async (more: ReadonlyArray<Intent>): Promise<{ readonly state: EngineState; readonly track: TrackRecord }> => {
  let state = emptyEngineState({ config: sidedConfig, sides: ['north', 'south'], timeMs: start })
  for (const intent of [place('ns', scoutType.id, 'north', north(0)), place('ss', scoutType.id, 'south', north(500)), ...more]) state = await outcome(state, intent)
  state = (await advanceEngine(state, start + 2_000, ports)).state
  const track = [...state.combat.tracks.values()].find(entry => entry.side === 'north' && entry.subjectId === 'ss')!
  expect(track.tier).toBe('identified')
  return { state, track }
}

describe('Einsatz job chains: steps', () => {
  test('a send gives a free unit an active step, named in its last order; arrival ends the step and the unit holds there', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0))])
    state = await run(state, send(['g1'], { point: at(0.01) }))
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'en-route', stepSerial: 1, orders: [{ id: 'step-1', kind: 'move', state: 'active', by: 'Controller' }], lastAction: { verb: 'move', stepId: 'step-1' } })
    state = await advance(state, arrivalAt(state, 'g1'))
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'holding', orders: [], stepSerial: 1 })
    state = await advance(state, start + 600_000)
    expect(unitOf(state, 'g1').phase).toBe('holding')
  })

  test('queue on a unit with no step is exactly a send; on a busy unit it waits at the end and counts towards nothing', async () => {
    const base = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      newTask('t2', templates.load, at(0.02), { [middle]: 1 }),
    ])
    const sent = await run(base, send(['c1'], { taskId: 't1' }))
    const queuedFirst = await run(base, queue('c1', { taskId: 't1' }))
    expect(unitOf(queuedFirst, 'c1')).toEqual(unitOf(sent, 'c1'))
    expect(taskOf(queuedFirst, 't1')).toEqual(taskOf(sent, 't1'))

    const state = await run(sent, queue('c1', { taskId: 't2' }))
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-1', 'serve', 'active'], ['step-2', 'serve', 'queued']])
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 't1', lastAction: { verb: 'queue', target: 't2', stepId: 'step-2', by: 'Controller' } })
    expect(taskOf(state, 't2').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 0 }])
    const answer = await recommend({ state, viewer: openViewer, taskId: 't2', routing: createDirectRoutingAdapter() })
    expect(answer.next).toEqual([{ unitId: 'c1', label: 'C1', stepId: 'step-2', stepsAhead: 1 }])
    expect(answer.need).toMatchObject({ id: middle })
  })

  test('a deliver order applies only where the chain says nothing: after a pickup with another task next, the unit delivers first', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('s1', types.publicSite, at(0.006)),
      newTask('t1', templates.load, at(0.005), { [low]: 1 }),
      newTask('t2', templates.load, at(0.004), { [middle]: 1 }),
      send(['c1'], { taskId: 't1' }),
      queue('c1', { taskId: 't2' }),
    ])
    const { state: done, transitions } = await advanceEngine(state, start + 600_000, ports)
    state = done
    const orders = unitTransitions(transitions, 'c1').map(unit => unit.lastAction!).filter((action, index, all) => index === 0 || !sameValue(action, all[index - 1]))
    expect(orders.map(action => [action.verb, action.target, action.by])).toEqual([
      ['queue', 't2', 'Controller'],
      ['deliver', 's1', 'standing-order:deliver'],
      ['send', 't2', 'standing-order:chain'],
      ['deliver', 's1', 'standing-order:deliver'],
      ['recall', undefined, 'standing-order:return'],
    ])
    expect(unitOf(state, 's1').received).toEqual({ [middle]: 1, [low]: 1 })
    expect([taskOf(state, 't1').closedAtMs, taskOf(state, 't2').closedAtMs].every(at => at !== undefined)).toBe(true)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'available', atBase: true, orders: [] })
  })

  test('a chain across sites: pick up at one task, deliver at the site it names, then serve a second task', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('near', types.publicSite, at(0.006)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      newTask('b', templates.load, at(0.004), { [low]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      queue('c1', { taskId: 'b' }),
    ])
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
    const { state: done, transitions } = await advanceEngine(state, start + 900_000, ports)
    state = done
    const started = unitTransitions(transitions, 'c1').flatMap(unit => unit.lastAction?.by === 'standing-order:chain' && unit.orders[0]?.state === 'active' ? [[unit.lastAction.verb, unit.lastAction.target, unit.lastAction.stepId]] : [])
    expect(started.filter((entry, index, all) => index === 0 || !sameValue(entry, all[index - 1]))).toEqual([['deliver', 'far', 'step-2'], ['send', 'b', 'step-3']])
    expect(unitOf(state, 'far').received).toEqual({ [top]: 1 })
    expect(unitOf(state, 'near').received).toEqual({ [low]: 1 })
    expect(taskOf(state, 'b').closedAtMs).toBeDefined()
  })

  test('a Run restored mid-chain from its objects and runtime state goes on exactly as the original', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('g1', types.pairServer, at(0)),
      newUnit('s1', types.publicSite, at(0.006)),
      newTask('t1', templates.load, at(0.005), { [low]: 1 }),
      newTask('t2', templates.load, at(0.004), { [middle]: 1 }),
      send(['c1'], { taskId: 't1' }),
      queue('c1', { siteId: 's1' }),
      queue('c1', { taskId: 't2' }),
      send(['g1'], { point: at(0.01) }),
      queue('g1', { point: at(0.02) }),
    ])
    state = await advance(state, start + 30_000)
    state = await run(state, { kind: 'hold', unitId: 'g1' })
    const restored = readEngineState({ config, sides: [], objects: objectsOf(state), runtime: runtimeStateOf(state) })
    expect([...restored.units.values()]).toEqual([...state.units.values()])
    const [original, copy] = [await advance(state, start + 600_000), await advance(restored, start + 600_000)]
    expect([...copy.units.values()]).toEqual([...original.units.values()])
    expect([...copy.tasks.values()]).toEqual([...original.tasks.values()])
  })

  test('every chain change is one transition carrying the unit where it was; motion along a leg is none', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0))])
    state = await run(state, send(['g1'], { point: at(0.01) }))
    state = await run(state, queue('g1', { point: at(0.02) }))
    const moving = await advanceEngine(state, start + 10_000, ports)
    expect(moving.transitions).toEqual([])
    const { transitions } = await advanceEngine(moving.state, start + 120_000, ports)
    const records = unitTransitions(transitions, 'g1')
    expect(records.map(unit => [unit.phase, stepsOf(unit).map(([id, , state]) => `${id}:${state}`).join(' ')])).toEqual([
      ['holding', 'step-2:queued'],
      ['en-route', 'step-2:active'],
      ['holding', ''],
    ])
    for (let index = 1; index < records.length; index++) expect(sameValue(records[index - 1], records[index])).toBe(false)
    const arrivedAt = transitions.find(entry => entry.kind === 'unit' && entry.record.phase === 'holding')!
    expect(arrivedAt.kind === 'unit' && arrivedAt.point).toEqual(at(0.01))
  })
})

describe('Einsatz job chains: rules', () => {
  test('a task closed by someone else is skipped on every chain under an alert naming it, and each chain goes on', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('c2', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      newTask('t2', templates.load, at(0.02), { [low]: 1 }),
      newTask('t3', templates.load, at(0.03), { [low]: 1 }),
      send(['c1'], { taskId: 't1' }),
      queue('c1', { point: at(0.003) }),
      send(['c2'], { taskId: 't2' }),
      queue('c2', { taskId: 't3' }),
    ])
    state = await advance(state, start + 5_000)
    state = await run(state, { kind: 'task.close', taskId: 't1', reason: 'Resolved by phone' })
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'en-route', orders: [{ id: 'step-2', kind: 'move', state: 'active' }], alerts: [{ code: 'step_skipped', message: 'Skipped T1 (closed)' }] })
    expect(unitOf(state, 'c1').taskId).toBeUndefined()
    state = await run(state, { kind: 'task.close', taskId: 't3' })
    expect(unitOf(state, 'c2')).toMatchObject({ taskId: 't2', orders: [{ id: 'step-1', kind: 'serve', state: 'active' }], alerts: [{ code: 'step_skipped', message: 'Skipped T3 (closed)' }] })
    expect(unitOf(state, 'c2').orders).toHaveLength(1)
  })

  test('a delivery to a site that stopped accepting is skipped when it would start, and the deliver order finds another site', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('near', types.publicSite, at(0.006)),
      newUnit('far', types.publicSite, at(-0.01)),
      newTask('a', templates.load, at(0.005), { [top]: 1 }),
      send(['c1'], { taskId: 'a' }),
      queue('c1', { siteId: 'far' }),
      { kind: 'site.set', siteId: 'far', accepting: false },
    ])
    state = await advance(state, start + 900_000)
    expect(unitOf(state, 'near').received).toEqual({ [top]: 1 })
    expect(unitOf(state, 'far').received).toEqual({})
    expect(unitOf(state, 'c1').alerts).toEqual([expect.objectContaining({ code: 'step_skipped', message: 'Skipped FAR (FAR is not accepting)' })])
  })

  test('capacity: a step a loaded unit cannot take before delivering is refused with the reason, until a delivery comes first', async () => {
    let state = await runAll(emptyState(), [
      newUnit('d1', types.directCarrier, at(0)),
      newUnit('s1', types.publicSite, at(0.01)),
      newTask('t1', templates.load, at(0.005), { [low]: 1 }),
      newTask('t2', templates.load, at(0.006), { [low]: 1 }),
      send(['d1'], { taskId: 't1' }),
    ])
    expect(await refusalOf(state, queue('d1', { taskId: 't2' }))).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: D1 will have 1 person on board by then; queue a delivery first' })
    expect((await refusalOf(state, queue('d1', { point: at(0.02) }))).code).toBe('unit_loaded')
    state = await run(state, queue('d1', { siteId: 's1' }))
    state = await run(state, queue('d1', { taskId: 't2' }))
    expect(stepsOf(unitOf(state, 'd1'))).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
    // Before the pickup the unit carries nothing, but the delivery is judged on the load it will carry there.
    expect(await refusalOf(state, remove('d1', 'step-2'))).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: D1 will have 1 person on board by then; that step delivers it' })
    state = await advance(state, start + 600_000)
    expect(taskOf(state, 't2').closedAtMs).toBeDefined()
    expect(unitOf(state, 'd1')).toMatchObject({ phase: 'holding', load: { [low]: 1 }, orders: [] })
  })

  test('a task the chain already holds is queued again only as a further trip for load still waiting; a do-now send takes its queued copy with it', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('c2', types.roadCarrier, at(0.001)),
      newUnit('s1', types.publicSite, at(0.01)),
      newTask('one', templates.load, at(0.005), { [low]: 1 }),
      newTask('two', templates.load, at(0.006), { [low]: 2 }),
      send(['c1'], { taskId: 'one' }),
      send(['c2'], { taskId: 'two' }),
    ])
    expect(await refusalOf(state, queue('c1', { taskId: 'one' }))).toEqual({ code: 'requirement_covered', reason: 'requirement_covered: ONE needs nothing more that C1 provides' })
    // Two wait at TWO and C2 carries one: a second trip there is work, a third is not.
    const second = await runAll(state, [queue('c2', { siteId: 's1' }), queue('c2', { taskId: 'two' })])
    expect(stepsOf(unitOf(second, 'c2'))).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
    expect((await refusalOf(await run(second, queue('c2', { siteId: 's1' })), queue('c2', { taskId: 'two' }))).code).toBe('requirement_covered')

    state = await run(state, { kind: 'hold', unitId: 'c1' })
    state = await run(state, queue('c1', { point: at(0.02) }))
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-1', 'serve', 'queued'], ['step-2', 'move', 'queued']])
    state = await run(state, send(['c1'], { taskId: 'one' }))
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-3', 'serve', 'active'], ['step-2', 'move', 'queued']])
    state = await advance(state, start + 600_000)
    expect(taskOf(state, 'one').closedAtMs).toBeDefined()
    expect(unitOf(state, 'c1').alerts).toEqual([])
  })

  test('a divert removes only the current step: the queued chain stays behind the new task', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('low1', templates.load, at(0.01), { [low]: 1 }),
      newTask('top1', templates.load, at(0.02), { [top]: 1 }),
      send(['c1'], { taskId: 'low1' }),
      queue('c1', { point: at(0.03) }),
    ])
    state = await advance(state, start + 4_000)
    state = await run(state, send(['c1'], { taskId: 'top1' }, [{ unitId: 'c1', fromTaskId: 'low1' }]))
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-3', 'serve', 'active'], ['step-2', 'move', 'queued']])
    expect(unitOf(state, 'c1')).toMatchObject({ taskId: 'top1', lastAction: { verb: 'divert', stepId: 'step-3', cause: 'from LOW1' } })
    expect(taskOf(state, 'low1').alerts).toMatchObject([{ code: 'work_returned' }])
  })

  test('removing a queued step leaves the rest; removing the active one releases it and starts the next; a loaded unit keeps its delivery', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('s1', types.publicSite, at(0.01)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
      send(['c1'], { taskId: 't1' }),
      queue('c1', { point: at(0.02) }),
      queue('c1', { point: at(0.03) }),
    ])
    state = await run(state, remove('c1', 'step-2'))
    expect(stepsOf(unitOf(state, 'c1'))).toEqual([['step-1', 'serve', 'active'], ['step-3', 'move', 'queued']])
    expect(unitOf(state, 'c1').lastAction).toMatchObject({ verb: 'remove', stepId: 'step-2' })
    expect(await refusalOf(state, remove('c1', 'step-2'))).toEqual({ code: 'step_not_found', reason: 'step_not_found: C1 holds no step step-2' })

    state = await advance(state, start + 5_000)
    state = await run(state, remove('c1', 'step-1'))
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'en-route', orders: [{ id: 'step-3', kind: 'move', state: 'active' }], lastAction: { verb: 'move', by: 'standing-order:chain', stepId: 'step-3' } })
    expect(taskOf(state, 't1')).toMatchObject({ alerts: [{ code: 'work_returned' }], coverage: { loads: [{ classId: low, waiting: 1, covered: 0 }] } })

    let loaded = await runAll(emptyState(), [
      newUnit('d1', types.directCarrier, at(0)),
      newUnit('s1', types.publicSite, at(0.01)),
      newTask('t1', templates.load, at(0), { [low]: 1 }),
      send(['d1'], { taskId: 't1' }),
      queue('d1', { siteId: 's1' }),
    ])
    loaded = await advance(loaded, start + 3_000)
    expect(unitOf(loaded, 'd1')).toMatchObject({ phase: 'transporting', load: { [low]: 1 }, orders: [{ id: 'step-2', kind: 'deliver', state: 'active' }] })
    expect((await refusalOf(loaded, remove('d1', 'step-2'))).code).toBe('unit_loaded')
    expect((await refusalOf(loaded, { kind: 'clear', unitId: 'd1' })).code).toBe('unit_loaded')
  })

  test('clear empties the chain and stops the unit, whose return order then applies; recall empties it and brings the unit home', async () => {
    let state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      send(['g1'], { point: at(0.01) }),
      queue('g1', { point: at(0.02) }),
    ])
    state = await advance(state, start + 10_000)
    const cleared = await run(state, { kind: 'clear', unitId: 'g1' })
    expect(unitOf(cleared, 'g1')).toMatchObject({ phase: 'available', orders: [], lastAction: { verb: 'clear' } })
    expect(unitOf(cleared, 'g1').leg).toBeUndefined()
    expect(unitOf(await advance(cleared, start + 41_000), 'g1')).toMatchObject({ phase: 'returning', lastAction: { verb: 'recall', by: 'standing-order:return' } })
    const recalled = await run(state, { kind: 'recall', unitId: 'g1' })
    expect(unitOf(recalled, 'g1')).toMatchObject({ phase: 'returning', orders: [] })
  })

  test('hold pauses the chain where the unit is; resume starts the paused step again from there', async () => {
    let state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      send(['g1'], { point: at(0.01) }),
      queue('g1', { point: at(0.02) }),
    ])
    state = await advance(state, start + 10_000)
    state = await run(state, { kind: 'hold', unitId: 'g1' })
    const stopped = pointOf(state, 'g1')
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'holding', paused: true, orders: [{ id: 'step-1', state: 'queued' }, { id: 'step-2', state: 'queued' }] })
    state = await run(state, queue('g1', { point: at(0.03) }))
    state = await advance(state, start + 300_000)
    expect(pointOf(state, 'g1')).toEqual(stopped)
    expect(unitOf(state, 'g1').orders).toHaveLength(3)
    state = await run(state, { kind: 'resume', unitId: 'g1' })
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'en-route', orders: [{ id: 'step-1', state: 'active' }, { id: 'step-2' }, { id: 'step-3' }] })
    expect(unitOf(state, 'g1').paused).toBeUndefined()
    expect(unitOf(state, 'g1').leg!.geometry.coordinates[0]).toEqual([...stopped.coordinates])
    state = await advance(state, start + 900_000)
    expect(pointOf(state, 'g1')).toEqual(at(0.03))
  })

  test('an actor leaves a chain at most its limit of steps: a queue past it, or a do-now send to a paused full chain, is refused', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: at(0.5) })])
    for (let index = 1; index < 20; index++) state = await run(state, queue('g1', { point: at(0.5, 0.001 * index) }))
    expect(unitOf(state, 'g1').orders).toHaveLength(20)
    expect(await refusalOf(state, queue('g1', { point: at(0.6) }))).toEqual({ code: 'chain_full', reason: 'chain_full: G1 already holds 20 steps; remove one first' })
    // A send drops the active step, so the chain keeps its length.
    expect(unitOf(await run(state, send(['g1'], { point: at(0.4) })), 'g1').orders).toHaveLength(20)
    // Paused, the head waits in the queue and a send would add a step.
    const held = await run(state, { kind: 'hold', unitId: 'g1' })
    expect(await refusalOf(held, send(['g1'], { point: at(0.4) }))).toEqual({ code: 'chain_full', reason: 'chain_full: G1 already holds 20 steps; remove one first' })
    const room = await run(held, remove('g1', 'step-20'))
    expect(unitOf(await run(room, send(['g1'], { point: at(0.4) })), 'g1').orders).toHaveLength(20)
  })

  test('a loaded unit whose chain names no delivery delivers first, even in front of a full chain, and a Run restores that chain', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('s1', types.publicSite, at(0.02)),
      newTask('t1', templates.load, at(0), { [low]: 1 }),
      send(['c1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 3_000)
    expect(unitOf(state, 'c1').phase).toBe('on-task')
    state = await run(state, { kind: 'hold', unitId: 'c1' })
    state = await advance(state, start + 6_000)
    expect(unitOf(state, 'c1')).toMatchObject({ phase: 'holding', paused: true, load: { [low]: 1 }, orders: [] })
    // Its deliver order delivers before any other step, so the queue takes the full limit.
    for (let index = 1; index <= 20; index++) state = await run(state, queue('c1', { point: at(-0.01, 0.001 * index) }))
    expect((await refusalOf(state, queue('c1', { point: at(-0.02) }))).code).toBe('chain_full')
    state = await run(state, { kind: 'resume', unitId: 'c1' })
    const carrier = unitOf(state, 'c1')
    expect(carrier.orders).toHaveLength(21)
    expect(carrier).toMatchObject({ phase: 'transporting', siteId: 's1' })
    expect(carrier.orders.slice(0, 2)).toMatchObject([{ id: 'step-22', kind: 'deliver', state: 'active', by: 'standing-order:deliver' }, { id: 'step-2', state: 'queued' }])
    expect(await refusalOf(state, queue('c1', { point: at(-0.02) }))).toEqual({ code: 'chain_full', reason: 'chain_full: C1 already holds 21 steps; remove one first' })

    const restored = readEngineState({ config, sides: [], objects: objectsOf(state), runtime: runtimeStateOf(state) })
    expect(unitOf(restored, 'c1')).toEqual(carrier)
    expect(plannedPaths(objectsOf(state)).find(path => path.unitId === 'c1')!.segments).toHaveLength(20)
    const done = await advance(restored, start + 600_000)
    expect(unitOf(done, 's1').received).toEqual({ [low]: 1 })
    expect(unitOf(done, 'c1').orders.map(step => step.by)).not.toContain('standing-order:deliver')
  })

  test('the next step waits under an alert while the router is unavailable and starts once it answers', async () => {
    const control = { online: true }
    const direct = createDirectRoutingAdapter()
    const routing = { id: 'switchable', route: async (request: Parameters<typeof direct.route>[0]) => { if (!control.online) throw new Error('Router offline'); return await direct.route(request) } }
    const state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: at(0.001) }), queue('g1', { point: at(0.01) })])
    control.online = false
    const waiting = await advanceEngine(state, start + 20_000, { routing })
    expect(unitOf(waiting.state, 'g1')).toMatchObject({ phase: 'holding', orders: [{ id: 'step-2', state: 'queued' }], alerts: [{ code: 'chain_failed', message: 'Next step failed: No route for G1: Router offline' }] })
    control.online = true
    const resumed = await advanceEngine(waiting.state, start + 22_000, { routing })
    expect(unitOf(resumed.state, 'g1')).toMatchObject({ phase: 'en-route', orders: [{ id: 'step-2', state: 'active' }], alerts: [] })
  })
})

describe('Einsatz job chains for any unit', () => {
  test('a round of three points: each arrival starts the next leg, and the unit holds at the last', async () => {
    const points = [at(0.01), at(0.01, 0.01), at(0, 0.01)]
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: points[0]! }), queue('g1', { point: points[1]! }), queue('g1', { point: points[2]! })])
    const { state: done, transitions } = await advanceEngine(state, start + 600_000, ports)
    state = done
    const arrivals = transitions.flatMap(entry => entry.kind === 'unit' && entry.record.phase === 'holding' ? [entry.point] : [])
    expect(arrivals).toEqual(points)
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'holding', orders: [] })
    expect(pointOf(state, 'g1')).toEqual(points[2]!)
  })

  test('a depot, then two requests: a unit without load goes to a site, then serves each request in turn and returns home', async () => {
    let state = await runAll(emptyState(), [
      newUnit('h1', types.payloadServer, at(0), { properties: { payloadKg: 600 } }),
      newUnit('depot', types.publicSite, at(0.01)),
      newTask('r1', templates.payload, at(0.02)),
      newTask('r2', templates.payload, at(0.02, 0.01)),
      send(['h1'], { siteId: 'depot' }),
      queue('h1', { taskId: 'r1' }),
      queue('h1', { taskId: 'r2' }),
    ])
    expect(stepsOf(unitOf(state, 'h1'))).toEqual([['step-1', 'move', 'active'], ['step-2', 'serve', 'queued'], ['step-3', 'serve', 'queued']])
    state = await advance(state, start + 900_000)
    const [first, second] = [taskOf(state, 'r1').closedAtMs!, taskOf(state, 'r2').closedAtMs!]
    expect(first).toBeLessThan(second)
    expect(unitOf(state, 'depot').received).toEqual({})
    expect(unitOf(state, 'h1')).toMatchObject({ phase: 'available', atBase: true, orders: [] })
  })

  test('Stop, then Resume or Clear, leaves a unit parked at a point there: only the pause held its orders back, and it never had a return to make', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: at(0.02) })])
    state = await advance(state, arrivalAt(state, 'g1'))
    const parked = unitOf(state, 'g1')
    expect(parked).toMatchObject({ phase: 'holding', orders: [] })
    const held = await run(state, { kind: 'hold', unitId: 'g1' })
    expect(unitOf(held, 'g1')).toMatchObject({ phase: 'holding', paused: true, phaseSinceMs: parked.phaseSinceMs })
    for (const verb of ['resume', 'clear'] as const) {
      let after = await run(held, { kind: verb, unitId: 'g1' })
      expect(unitOf(after, 'g1')).toMatchObject({ phase: 'holding', phaseSinceMs: parked.phaseSinceMs, lastAction: { verb } })
      expect(unitOf(after, 'g1').paused).toBeUndefined()
      after = await advance(after, after.timeMs + 600_000)
      expect(unitOf(after, 'g1')).toMatchObject({ phase: 'holding', lastAction: { verb } })
      expect(pointOf(after, 'g1')).toEqual(at(0.02))
    }
  })

  test('a unit stopped on its way home stands available, paused; resumed, its return order brings it home', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: at(0.02) })])
    state = await advance(state, arrivalAt(state, 'g1'))
    state = await run(state, { kind: 'recall', unitId: 'g1' })
    state = await advance(state, state.timeMs + 20_000)
    state = await run(state, { kind: 'hold', unitId: 'g1' })
    const stopped = pointOf(state, 'g1')
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'available', paused: true, atBase: false, orders: [] })
    expect(unitOf(state, 'g1').leg).toBeUndefined()
    state = await advance(state, state.timeMs + 600_000)
    expect(pointOf(state, 'g1')).toEqual(stopped)
    // Idle since the hold for longer than its return order waits, it sets off home at once.
    state = await run(state, { kind: 'resume', unitId: 'g1' })
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'returning', lastAction: { verb: 'recall', by: 'standing-order:return' } })
    state = await advance(state, state.timeMs + 600_000)
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'available', atBase: true })
  })

  test('a move to an observation point, then hold: the unit stays there past its return order', async () => {
    let state = await runAll(emptyState(), [newUnit('g1', types.pairServer, at(0)), send(['g1'], { point: at(0.02) })])
    state = await advance(state, arrivalAt(state, 'g1') + 120_000)
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'holding', orders: [] })
    state = await run(state, { kind: 'hold', unitId: 'g1' })
    state = await run(state, queue('g1', { point: at(0.03) }))
    state = await advance(state, state.timeMs + 600_000)
    expect(unitOf(state, 'g1')).toMatchObject({ phase: 'holding', paused: true, orders: [{ id: 'step-2', state: 'queued' }] })
    expect(pointOf(state, 'g1')).toEqual(at(0.02))
  })

  test('an armed unit moves into range, then engages a track of its side until the kill it watched ends the step', async () => {
    let { state, track } = await sidedField([place('ng', gunType.id, 'north', north(-3_000))])
    // Its weapon reaches the track only in the last 100 m of the move.
    state = await outcome(state, send(['ng'], { point: north(-1_400) }))
    state = await outcome(state, queue('ng', { trackId: track.id }))
    expect(stepsOf(unitOf(state, 'ng'))).toEqual([['step-1', 'move', 'active'], ['step-2', 'engage', 'queued']])
    expect(unitOf(state, 'ng').engage).toBeUndefined()
    state = (await advanceEngine(state, arrivalAt(state, 'ng'), ports)).state
    expect(unitOf(state, 'ng')).toMatchObject({ phase: 'holding', engage: track.id, orders: [{ id: 'step-2', kind: 'engage', state: 'active' }] })
    state = (await advanceEngine(state, state.timeMs + 120_000, ports)).state
    expect(unitOf(state, 'ss').integrity).toBe('destroyed')
    // The kill is the step's success: it ends without an alert, as the unit's last action.
    expect(unitOf(state, 'ng')).toMatchObject({ phase: 'holding', orders: [], alerts: [], lastAction: { verb: 'engage', target: track.id, by: 'Controller', cause: 'destroyed', stepId: 'step-2' } })
    expect(unitOf(state, 'ng').engage).toBeUndefined()
  })

  test('a queued engage step whose track another unit destroyed is skipped under an alert, and the chain goes on', async () => {
    let { state, track } = await sidedField([place('ng', gunType.id, 'north', north(-3_000)), place('near', gunType.id, 'north', north(-1_000))])
    state = await outcome(state, send(['ng'], { point: north(-6_000) }))
    state = await outcome(state, queue('ng', { trackId: track.id }))
    state = await outcome(state, queue('ng', { point: north(-6_200) }))
    state = (await advanceEngine(state, state.timeMs + 120_000, ports)).state
    expect(unitOf(state, 'ss').integrity).toBe('destroyed')
    expect(unitOf(state, 'ng')).toMatchObject({ phase: 'en-route', orders: [{ id: 'step-1', state: 'active' }, { id: 'step-3', state: 'queued' }], alerts: [{ code: 'step_skipped', message: `Skipped ${track.label} (destroyed)` }] })
    state = (await advanceEngine(state, state.timeMs + 600_000, ports)).state
    expect(unitOf(state, 'ng')).toMatchObject({ phase: 'holding', orders: [] })
    expect(pointOf(state, 'ng')).toEqual(north(-6_200))
  })

  test('a step for a track its side has lost is skipped under an alert naming the track as its side knew it, and the chain goes on', async () => {
    let { state, track } = await sidedField([place('ng', gunType.id, 'north', north(-3_000))])
    state = await outcome(state, send(['ng'], { trackId: track.id }))
    state = await outcome(state, queue('ng', { point: north(-3_100) }))
    expect(stepsOf(unitOf(state, 'ng'))).toEqual([['step-1', 'engage', 'active'], ['step-2', 'move', 'queued']])
    // South's scout drives out of North's sight; North drops its track five minutes later.
    state = await outcome(state, send(['ss'], { point: north(30_000) }))
    state = (await advanceEngine(state, state.timeMs + 900_000, ports)).state
    expect(state.combat.tracks.has(track.id)).toBe(false)
    expect(unitOf(state, 'ng')).toMatchObject({ phase: 'holding', orders: [], alerts: [{ code: 'step_skipped', message: `Skipped ${track.label} (lost)` }] })
    expect(unitOf(state, 'ng').engage).toBeUndefined()
    expect(pointOf(state, 'ng')).toEqual(north(-3_100))
  })

  test('a unit that cannot move pauses and resumes the engage steps it holds; holding none, it has nothing to pause', async () => {
    let { state, track } = await sidedField([place('fx', fixedGun.id, 'north', north(-3_000))])
    expect(await refusalOf(state, { kind: 'hold', unitId: 'fx' })).toEqual({ code: 'unit_unavailable', reason: 'unit_unavailable: FX cannot move' })
    state = await outcome(state, send(['fx'], { trackId: track.id }))
    state = await outcome(state, { kind: 'hold', unitId: 'fx' })
    expect(unitOf(state, 'fx')).toMatchObject({ phase: 'available', paused: true, engage: track.id, orders: [{ id: 'step-1', kind: 'engage', state: 'active' }] })
    state = await outcome(state, { kind: 'resume', unitId: 'fx' })
    expect(unitOf(state, 'fx')).toMatchObject({ phase: 'available', engage: track.id, lastAction: { verb: 'resume' } })
    expect(unitOf(state, 'fx').paused).toBeUndefined()
  })
})
