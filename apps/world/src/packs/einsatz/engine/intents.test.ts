import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, meters, type IsoTimestamp } from '../../../core/model/index.ts'
import type { RoutePort } from './movement.ts'
import { advance, at, config, controller, emptyState, low, middle, newTask, newUnit, refusalOf, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { refusalCode } from '../refusal.ts'
import { advanceEngine, executeIntent } from './engine.ts'
import { intentSchema } from './intents.ts'
import { engineObjects, readEngineState, runtimeStateOf } from './objects.ts'

const sidedState = () => runAll(emptyState(['north', 'south']), [
  newUnit('n1', types.roadCarrier, at(0), { side: 'north' }),
  newUnit('clinic', types.publicSite, at(0.02)),
  newUnit('ncamp', types.sidedSite, at(0.03), { side: 'north' }),
  newUnit('scamp', types.sidedSite, at(0.002), { side: 'south' }),
  newTask('nt', templates.load, at(0.001), { [top]: 1 }, { side: 'north' }),
  newTask('st', templates.load, at(0.001), { [top]: 1 }, { side: 'south' }),
])

describe('Einsatz same-side linkage', () => {
  test('a side is required exactly when the Run declares sides, and a public type takes none', async () => {
    const sided = await sidedState()
    expect((await refusalOf(sided, newTask('x', templates.load, at(0), { [low]: 1 }))).reason).toBe('side_required: Name a side: north, south')
    expect((await refusalOf(sided, newTask('x', templates.load, at(0), { [low]: 1 }, { side: 'west' }))).code).toBe('side_not_declared')
    expect((await refusalOf(sided, newUnit('x', types.publicSite, at(0), { side: 'north' }))).code).toBe('public_takes_no_side')
    expect((await refusalOf(emptyState(), newUnit('x', types.roadCarrier, at(0), { side: 'north' }))).code).toBe('side_not_declared')
  })

  test('a unit is sent to, counted towards and delivers to only its own side\'s or public tasks and sites', async () => {
    let state = await sidedState()
    const across = await refusalOf(state, send(['n1'], { taskId: 'st' }))
    expect(across.reason).toBe('cross_side_reference: N1 cannot serve another side\'s ST')
    state = await run(state, send(['n1'], { taskId: 'nt' }))
    const pickedUp = await advance(state, start + 30_000)
    const delivering = unitOf(pickedUp, 'n1')
    expect(delivering).toMatchObject({ phase: 'transporting', siteId: 'clinic', lastAction: { by: 'standing-order:deliver' } })
    expect((await refusalOf(pickedUp, send(['n1'], { siteId: 'scamp' }))).code).toBe('cross_side_reference')
    expect(unitOf(await run(pickedUp, send(['n1'], { siteId: 'ncamp' })), 'n1')).toMatchObject({ phase: 'transporting', siteId: 'ncamp' })
  })

  test('canonical objects that commit a unit across sides are refused as a whole', async () => {
    const state = await run(await sidedState(), send(['n1'], { taskId: 'nt' }))
    const objects = engineObjects(state, () => ({ at: new Date(start).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))
    const tampered = objects.map(object => object.id === 'nt' ? { ...object, packData: { ...(object.packData as object), side: 'south' } } : object)
    expect(() => readEngineState({ config, sides: ['north', 'south'], objects: tampered, runtime: runtimeStateOf(state) })).toThrow('cannot be committed')
    expect(readEngineState({ config, sides: ['north', 'south'], objects, runtime: runtimeStateOf(state) }).units.get('n1')?.taskId).toBe('nt')
  })
})

describe('Einsatz release and move', () => {
  const committed = async () => {
    const state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [middle]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    return await advance(state, start + 5_000)
  }

  test('a committed unit moved to a point is released, its task reopens, and it is free', async () => {
    const state = await committed()
    expect((await refusalOf(state, send(['u1'], { point: at(0.02) }))).code).toBe('unit_committed')
    const moved = await run(state, send(['u1'], { point: at(0.02) }, [{ unitId: 'u1', fromTaskId: 't1' }]))
    expect(unitOf(moved, 'u1')).toMatchObject({ phase: 'en-route', lastAction: { verb: 'move' } })
    expect(unitOf(moved, 'u1').taskId).toBeUndefined()
    expect(taskOf(moved, 't1')).toMatchObject({ alerts: [{ code: 'work_returned' }], coverage: { loads: [{ classId: middle, waiting: 1, covered: 0 }] } })
    expect(unitOf(await run(moved, { kind: 'hold', unitId: 'u1' }), 'u1').phase).toBe('holding')
  })

  test('a unit on task may be moved or recalled but not diverted to another task', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0), { [low]: 1 }),
      newTask('t2', templates.load, at(0.01), { [top]: 1 }),
      send(['u1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 3_000)
    expect(unitOf(state, 'u1').phase).toBe('on-task')
    expect((await refusalOf(state, send(['u1'], { taskId: 't2' }, [{ unitId: 'u1', fromTaskId: 't1' }]))).reason)
      .toBe('divert_after_arrival: U1 is working at T1; recall it or move it')
    expect(unitOf(await run(state, send(['u1'], { point: at(0.02) }, [{ unitId: 'u1', fromTaskId: 't1' }])), 'u1').phase).toBe('en-route')
    expect(unitOf(await run(state, { kind: 'recall', unitId: 'u1', fromTaskId: 't1' }), 'u1').phase).toBe('available')
  })

  test('closing a task drops its waiting load and frees the units still committed to it', async () => {
    const state = await run(await committed(), { kind: 'task.close', taskId: 't1', reason: 'Cancelled by caller' })
    expect(taskOf(state, 't1')).toMatchObject({ closedAtMs: start + 5_000, lastAction: { verb: 'close', cause: 'Cancelled by caller' }, coverage: { loads: [{ classId: middle, waiting: 1, covered: 0 }] } })
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'available', lastAction: { verb: 'release', cause: 'T1 closed' } })
    expect((await refusalOf(state, { kind: 'task.close', taskId: 't1' })).code).toBe('task_closed')
    expect((await refusalOf(state, send(['u1'], { taskId: 't1' }))).code).toBe('task_closed')
  })

  test('a report stays open until it is closed explicitly', async () => {
    let state = await runAll(emptyState(), [newTask('n1', templates.report, at(0))])
    state = await advance(state, start + 600_000)
    expect(taskOf(state, 'n1')).toMatchObject({ rank: low })
    expect(taskOf(state, 'n1').closedAtMs).toBeUndefined()
    expect((await refusalOf(state, newTask('n2', templates.load, at(0)))).code).toBe('priority_class_required')
    state = await run(state, { kind: 'task.close', taskId: 'n1' })
    expect(taskOf(state, 'n1').closedAtMs).toBe(start + 600_000)
  })
})

describe('Einsatz intent refusals', () => {
  test('every refusal reads `<code>: <message>` in configuration words', async () => {
    const state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newUnit('h1', types.payloadServer, at(0)),
      newUnit('site', types.publicSite, at(0.01)),
      newUnit('store', types.inert, at(0.01)),
      newTask('t1', templates.load, at(0.01), { [top]: 1 }),
    ])
    const cases: ReadonlyArray<readonly [string, Parameters<typeof refusalOf>[1]]> = [
      ['not_in_picture: Not in your picture', send(['nobody'], { taskId: 't1' })],
      ['not_in_picture: Not in your picture', send(['u1'], { taskId: 'nothing' })],
      ['not_a_site: H1 is no place to go to: it moves', send(['u1'], { siteId: 'h1' })],
      ['not_a_site: STORE does not receive load', { kind: 'site.set', siteId: 'store', accepting: false }],
      ['unit_unavailable: SITE cannot move', send(['site'], { point: at(0) })],
      ['duplicate_id: u1 already exists', newUnit('u1', types.roadCarrier, at(0))],
      ['unknown_unit_type: Unit type "nothing" is not declared', newUnit('x', 'nothing', at(0))],
      ['unknown_task_template: Task template "nothing" is not declared', newTask('x', 'nothing', at(0))],
      ['unknown_load_class: Load class "L9" is not declared', newTask('x', templates.load, at(0), { L9: 1 })],
      ['priority_class_required: Call has no priority floor, so the task needs load', newTask('x', templates.load, at(0))],
      ['unknown_property: Carrier declares no property "payloadKg"', newUnit('x', types.roadCarrier, at(0), { properties: { payloadKg: 1 } })],
      ['property_kind_mismatch: Payload is a number property', { kind: 'unit.adjust', unitId: 'h1', properties: { payloadKg: true }, reason: 'Test' }],
      ['property_out_of_range: Payload 30000 is outside 0–20000 kg', { kind: 'unit.adjust', unitId: 'h1', properties: { payloadKg: 30_000 }, reason: 'Test' }],
    ]
    for (const [reason, intent] of cases) expect((await refusalOf(state, intentSchema.parse(intent))).reason).toBe(reason)
  })

  test('a loaded unit delivers only to an accepting site that takes its load', async () => {
    let state = await runAll(emptyState(['north']), [
      newUnit('d1', types.directCarrier, at(0), { side: 'north' }),
      newUnit('site', types.publicSite, at(0.01)),
      newUnit('camp', types.sidedSite, at(0.01), { side: 'north' }),
      newTask('t1', templates.load, at(0), { [low]: 1 }, { side: 'north' }),
      send(['d1'], { taskId: 't1' }),
    ])
    state = await advance(state, start + 3_000)
    expect(unitOf(state, 'd1')).toMatchObject({ phase: 'holding', load: { [low]: 1 } })
    expect((await refusalOf(state, send(['d1'], { siteId: 'camp' }))).reason).toBe('site_not_accepting: CAMP does not accept C3 people')
    state = await run(state, { kind: 'site.set', siteId: 'site', accepting: false })
    expect((await refusalOf(state, send(['d1'], { siteId: 'site' }))).reason).toBe('site_not_accepting: SITE is not accepting')
  })

  test('a road move the router cannot serve is refused, never routed in a straight line', async () => {
    const offline: RoutePort = { id: 'offline', route: async () => { throw new Error('Router offline') } }
    const roadless: RoutePort = { id: 'roadless', route: async ({ to }) => ({ geometry: { type: 'LineString', coordinates: [to.coordinates, geoPointFromLonLat(to.coordinates[0] + 0.1, to.coordinates[1]).coordinates] }, distanceM: meters(5_000), durationSeconds: 300, provider: 'roadless' }) }
    const state = await runAll(emptyState(), [newUnit('u1', types.roadCarrier, at(0)), newTask('t1', templates.load, at(0.01), { [top]: 1 })])
    for (const [routing, code] of [[offline, 'routing_unavailable'], [roadless, 'no_road_near_point']] as const) {
      const outcome = await executeIntent(state, send(['u1'], { taskId: 't1' }), controller, { routing })
      expect(outcome.ok ? 'accepted' : refusalCode(outcome.reason)).toBe(code)
    }
    const flown = await executeIntent(await run(state, newUnit('d1', types.directCarrier, at(0))), send(['d1'], { taskId: 't1' }), controller, { routing: offline })
    expect(flown.ok).toBe(true)
    expect((await advanceEngine(state, start + 1_000, { routing: offline })).state.timeMs).toBe(start + 1_000)
  })
})
