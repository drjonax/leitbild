import { describe, expect, test } from 'bun:test'
import { actorIdSchema, commandIdSchema, nowIso, type CommandEnvelope, type SimulationRunId } from '../../../core/model/index.ts'
import { compileScenarioDefinition } from '../../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { config, low, middle, start, templates, top, types } from '../fixtures/engine-harness.ts'
import fixture from '../fixtures/engine.config.json'
import { definitionOf, isoAt, lonLat, openRun, taskItem, unitItem, type OpenRun } from '../fixtures/run-harness.ts'
import { einsatzPackId, einsatzRuntimeId } from '../ids.ts'
import { einsatzPack } from '../pack.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { refusalCode } from '../refusal.ts'

const point = (east: number, north = 0) => ({ type: 'Point', coordinates: lonLat(east, north) })
const send = (units: ReadonlyArray<string>, to: unknown, divert?: ReadonlyArray<{ readonly unitId: string; readonly fromTaskId: string }>) =>
  ({ units, to, ...(divert === undefined ? {} : { divert }) })

/** A fleet on the engine fixture configuration: three carriers, a hauler, a flyer, an immobile store, a public site and tasks of every template, one of them needing two carriers. */
const fleet = [
  unitItem('c1', types.roadCarrier, lonLat(0)),
  unitItem('c2', types.roadCarrier, lonLat(0, 0.001)),
  unitItem('c3', types.roadCarrier, lonLat(0, 0.002)),
  unitItem('h1', types.payloadServer, lonLat(0)),
  unitItem('d1', types.directCarrier, lonLat(0)),
  unitItem('k1', types.inert, lonLat(0.005)),
  unitItem('s1', types.publicSite, lonLat(0.02)),
  taskItem('low1', templates.load, lonLat(0.01), { [low]: 1 }),
  taskItem('low2', templates.load, lonLat(0.012), { [low]: 1 }),
  taskItem('mid1', templates.load, lonLat(0.03), { [middle]: 1 }),
  taskItem('top1', templates.load, lonLat(0.015), { [top]: 1 }),
  taskItem('lift1', templates.lift, lonLat(0.01, 0.01)),
  taskItem('haul1', templates.payload, lonLat(0.01, 0.01)),
  taskItem('note1', templates.report, lonLat(0.005, 0.005)),
  taskItem('two1', templates.load, lonLat(0.008), { [low]: 2 }),
]

const withRun = async (options: Parameters<typeof openRun>[0], body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun(options)
  try { await body(run) } finally { await run.close() }
}

const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

const durableUpserts = (run: OpenRun, id: string): number =>
  run.journal.filter(event => event.type === 'object.upserted' && event.object.id === id).length

const healthy = (run: OpenRun) => expect(run.connection.health?.().map(entry => entry.state)).toEqual(['ready'])

describe('Einsatz scenario codec', () => {
  const routing = createDirectRoutingAdapter()
  const compile = (items: Parameters<typeof definitionOf>[0], packConfig: unknown = fixture) =>
    compileScenarioDefinition({ ...definitionOf(items), packs: [{ id: einsatzPackId, config: packConfig, items }] }, [einsatzPack], { routing })

  test('a Definition with an Einsatz Pack Selection compiles its items into units, sites and tasks of declared types, the same way every time', async () => {
    const items = [
      unitItem('c1', types.roadCarrier, lonLat(0), { properties: { liftKg: 600 }, base: lonLat(0.001) }),
      unitItem('s1', types.publicSite, lonLat(0.02)),
      taskItem('t1', templates.load, lonLat(0.01), { [top]: 1, [low]: 2 }),
    ]
    const compiled = await compile(items)
    expect((await compile(items)).initialObjects).toEqual(compiled.initialObjects)
    expect(compiled.packConfigs[einsatzPackId]).toEqual(einsatzConfigSchema.parse(fixture))
    const [unit, site, task] = compiled.initialObjects
    const carrier = config.unitTypes.find(type => type.id === types.roadCarrier)!
    expect(unit).toMatchObject({ id: 'c1', kind: 'mobile_entity', packId: einsatzPackId, packData: {
      type: 'unit', unitType: types.roadCarrier, phase: 'available', integrity: 'healthy', atBase: false, properties: { liftKg: 600 },
      presentation: { icon: carrier.icon, typeLabel: carrier.label }, lastAction: { verb: 'create', by: 'scenario' },
    } })
    expect(site).toMatchObject({ kind: 'facility', packData: { accepting: true, received: {} } })
    expect(task).toMatchObject({ kind: 'incident', packData: { type: 'task', rank: top, loads: { [top]: 1, [low]: 2 }, coverage: { loads: [{ classId: top, waiting: 1, covered: 0 }, { classId: low, waiting: 2, covered: 0 }] } } })
  })

  test('an item is refused for the reason the matching create command would give, and so is a configuration that cannot run', async () => {
    await expect(compile([unitItem('x', 'nope', lonLat(0))])).rejects.toThrow('unknown_unit_type')
    await expect(compile([unitItem('x', types.roadCarrier, lonLat(0), { side: 'north' })])).rejects.toThrow('side_not_declared')
    await expect(compile([unitItem('x', types.roadCarrier, lonLat(0), { properties: { liftKg: 5_000 } })])).rejects.toThrow('property_out_of_range')
    await expect(compile([taskItem('x', templates.load, lonLat(0))])).rejects.toThrow('priority_class_required')
    await expect(compile([], { ...fixture, taskTemplates: [{ id: 'job', label: 'Job', icon: 'not-a-symbol' }] })).rejects.toThrow('unknown_icon')
  })
})

describe('Einsatz commands on a running clock', () => {
  test('commit checks read the current state: committed, covered, idempotent re-send, lower priority and stale diverts', async () => {
    await withRun({ items: fleet }, async run => {
      await accepted(run, ids.send, send(['c1'], { taskId: 'low1' }))
      run.forward(1_000)
      expect(await run.refusal(ids.send, send(['c1'], { taskId: 'top1' }))).toEqual({ code: 'unit_committed', reason: 'unit_committed: C1 now mobilizing to LOW1' })

      const before = durableUpserts(run, 'c1')
      await accepted(run, ids.send, send(['c1'], { taskId: 'low1' }))
      expect(durableUpserts(run, 'c1')).toBe(before)
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'low1' })

      expect(await run.refusal(ids.send, send(['c3'], { taskId: 'low1' }))).toEqual({ code: 'requirement_covered', reason: 'requirement_covered: LOW1 needs nothing more that C3 provides' })

      await accepted(run, ids.send, send(['c2'], { taskId: 'mid1' }))
      run.forward(1_000)
      expect((await run.refusal(ids.send, send(['c2'], { taskId: 'low2' }, [{ unitId: 'c2', fromTaskId: 'mid1' }]))).reason)
        .toBe('divert_not_lower_priority: MID1 (C2) is not lower than C3 at LOW2')
      expect((await run.refusal(ids.send, send(['c2'], { taskId: 'low2' }, [{ unitId: 'c2', fromTaskId: 'low1' }]))).reason)
        .toBe('unit_committed: C2 now mobilizing to MID1')
      expect((await run.refusal(ids.recall, { unitId: 'c2', fromTaskId: 'low1' })).code).toBe('unit_committed')
      expect((await run.refusal(ids.hold, { unitId: 'c2' })).reason).toBe('unit_committed: C2 now mobilizing to MID1; recall first (R), or move it (M)')

      await accepted(run, ids.send, send(['c1'], { taskId: 'top1' }, [{ unitId: 'c1', fromTaskId: 'low1' }]))
      expect(run.unit('c1')).toMatchObject({ taskId: 'top1', lastAction: { verb: 'divert', target: 'top1', cause: 'from LOW1', by: 'actor:operator' } })
      expect(run.task('low1')).toMatchObject({ loads: { [low]: 1 }, alerts: [{ code: 'work_returned' }], coverage: { loads: [{ classId: low, waiting: 1, covered: 0 }] } })
      healthy(run)
    })
  })

  test('a re-send to the task a unit serves changes nothing, even while work returned to that task waits', async () => {
    await withRun({ items: fleet }, async run => {
      await accepted(run, ids.send, send(['c1', 'c2'], { taskId: 'two1' }))
      run.forward(1_000)
      await accepted(run, ids.recall, { unitId: 'c2', fromTaskId: 'two1' })
      await run.settle()
      const alerts = run.task('two1').alerts
      expect(alerts).toMatchObject([{ code: 'work_returned', message: 'C2 released from TWO1 · 2 people waiting' }])
      const upserts = () => ({ task: durableUpserts(run, 'two1'), unit: durableUpserts(run, 'c1') })
      const before = upserts()
      await accepted(run, ids.send, send(['c1'], { taskId: 'two1' }))
      await run.settle()
      expect(upserts()).toEqual(before)
      expect(run.task('two1').alerts).toEqual(alerts)
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'two1' })
    })
  })

  test('release and move: a committed unit sent to a point leaves its task, which reopens, and is then free to hold', async () => {
    await withRun({ items: fleet }, async run => {
      await accepted(run, ids.send, send(['c2'], { taskId: 'mid1' }))
      run.forward(5_000)
      expect(run.task('mid1').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 1 }])
      await accepted(run, ids.send, send(['c2'], { point: point(0, 0.003) }, [{ unitId: 'c2', fromTaskId: 'mid1' }]))
      expect(run.unit('c2')).toMatchObject({ phase: 'en-route', lastAction: { verb: 'move' } })
      expect(run.unit('c2').taskId).toBeUndefined()
      expect(run.task('mid1')).toMatchObject({ alerts: [{ code: 'work_returned', message: 'C2 released from MID1 · 1 person waiting' }], coverage: { loads: [{ classId: middle, waiting: 1, covered: 0 }] } })
      run.forward(1_000)
      await accepted(run, ids.hold, { unitId: 'c2' })
      expect(run.unit('c2')).toMatchObject({ phase: 'holding', lastAction: { verb: 'hold' } })
    })
  })

  test('arrival, load and site checks follow the unit as the clock runs on', async () => {
    await withRun({ items: fleet }, async run => {
      await accepted(run, ids.send, send(['c1'], { taskId: 'low1' }))
      const legS = run.unit('c1').leg!.durationMs / 1_000
      run.forward(2_000 + Math.ceil(legS * 1_000) + 500)
      await run.settle()
      expect(run.unit('c1').phase).toBe('on-task')
      expect((await run.refusal(ids.send, send(['c1'], { taskId: 'top1' }, [{ unitId: 'c1', fromTaskId: 'low1' }]))).reason)
        .toBe('divert_after_arrival: C1 is working at LOW1; recall it or move it')

      run.forward(3_000)
      await run.settle()
      expect(run.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1', load: { [low]: 1 }, lastAction: { verb: 'deliver', by: 'standing-order:deliver' } })
      expect(await run.refusal(ids.send, send(['c1'], { taskId: 'top1' }))).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: C1 has 1 person on board, deliver first' })
      expect((await run.refusal(ids.recall, { unitId: 'c1' })).code).toBe('unit_loaded')

      await accepted(run, ids.siteSet, { siteId: 's1', accepting: false })
      expect(run.unit('c1')).toMatchObject({ phase: 'holding', alerts: [{ code: 'deliver_failed', message: 'Deliver failed: No site accepts 1 person' }] })
      expect(await run.refusal(ids.send, send(['c1'], { siteId: 's1' }))).toEqual({ code: 'site_not_accepting', reason: 'site_not_accepting: S1 is not accepting' })
      expect(await run.refusal(ids.send, send(['c1'], { siteId: 'c3' }))).toEqual({ code: 'not_a_site', reason: 'not_a_site: C3 does not receive load' })
      healthy(run)
    })
  })

  test('unavailable, unmet, closed and unknown records, and create and adjust refusals, each name their code', async () => {
    await withRun({ items: fleet }, async run => {
      run.forward(10_000)
      expect(await run.refusal(ids.send, send(['k1'], { point: point(0.006) }))).toEqual({ code: 'unit_unavailable', reason: 'unit_unavailable: K1 cannot move' })
      expect(await run.refusal(ids.send, send(['h1'], { taskId: 'haul1' }))).toEqual({ code: 'requirement_unmet', reason: 'requirement_unmet: H1 · Payload 300 kg · needs ≥ 500 kg' })
      expect(await run.refusal(ids.send, send(['d1'], { taskId: 'lift1' }))).toEqual({ code: 'requirement_unmet', reason: 'requirement_unmet: Lift not declared on Flyer' })
      expect(await run.refusal(ids.send, send(['ghost'], { taskId: 'low1' }))).toEqual({ code: 'not_in_picture', reason: 'not_in_picture: Not in your picture' })

      await accepted(run, ids.taskClose, { taskId: 'note1', reason: 'Acknowledged' })
      expect(run.task('note1')).toMatchObject({ closedAtMs: run.nowMs(), lastAction: { verb: 'close', cause: 'Acknowledged' } })
      expect(await run.refusal(ids.send, send(['d1'], { taskId: 'note1' }))).toEqual({ code: 'task_closed', reason: 'task_closed: NOTE1 is closed' })
      expect((await run.refusal(ids.taskClose, { taskId: 'note1' })).code).toBe('task_closed')

      expect((await run.refusal(ids.unitCreate, { type: types.roadCarrier, at: point(0), side: 'north' })).reason).toBe('side_not_declared: This Run declares no sides, so "north" is not one')
      expect((await run.refusal(ids.taskCreate, { template: templates.load, at: point(0), loads: { [low]: 1 }, label: 'X', side: 'north' })).code).toBe('side_not_declared')
      expect((await run.refusal(ids.unitCreate, { type: 'nope', at: point(0) })).code).toBe('unknown_unit_type')
      expect((await run.refusal(ids.taskCreate, { template: templates.load, at: point(0), label: 'Bare' })).code).toBe('priority_class_required')
      expect((await run.refusal(ids.unitAdjust, { unitId: 'c3', properties: { liftKg: 5_000 }, reason: 'Test' })).reason).toBe('property_out_of_range: Lift 5000 is outside 0–1000 kg')
      expect((await run.refusal(ids.unitAdjust, { unitId: 'c3', properties: { nope: 1 }, reason: 'Test' })).code).toBe('unknown_property')

      await accepted(run, ids.unitAdjust, { unitId: 'c3', properties: { liftKg: 600 }, reason: 'Refitted' })
      await accepted(run, ids.send, send(['c3'], { taskId: 'lift1' }))
      expect((await run.refusal(ids.unitAdjust, { unitId: 'c3', properties: { liftKg: 450 }, reason: 'Worn' })).reason)
        .toBe('requirement_unmet: LIFT1: C3 · Lift 450 kg · needs ≥ 500 kg')
      healthy(run)
    })
  })

  test('a road send the router cannot serve is refused routing_unavailable and leaves the runtime healthy', async () => {
    const direct = createDirectRoutingAdapter()
    const offline: RoutingAdapter = { ...direct, id: 'offline', route: async () => { throw new Error('Router offline') } }
    await withRun({ items: fleet, routing: offline }, async run => {
      expect(await run.refusal(ids.send, send(['c1'], { taskId: 'low1' }))).toEqual({ code: 'routing_unavailable', reason: 'routing_unavailable: No route for C1: Router offline' })
      expect(run.unit('c1').phase).toBe('available')
      await accepted(run, ids.send, send(['d1'], { taskId: 'low1' }))
      healthy(run)
    })
  })

  test('deleting a committed unit releases its share of the task; a unit carrying load cannot be deleted', async () => {
    await withRun({ items: fleet }, async run => {
      await accepted(run, ids.send, send(['d1'], { taskId: 'top1' }))
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
      await accepted(run, 'world.object.delete', { objectId: 'd1' })
      await run.settle()
      expect(run.object('d1')).toBeUndefined()
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])

      await accepted(run, ids.send, send(['c1'], { taskId: 'low1' }))
      run.forward(60_000)
      await run.settle()
      expect(run.unit('c1').load).toEqual({ [low]: 1 })
      expect(await run.invoke('world.object.delete', { objectId: 'c1' })).toMatchObject({ ok: false, reason: 'unit_loaded: C1 has 1 person on board, deliver first' })
      healthy(run)
    })
  })
})

describe('Einsatz recommendations through the Run', () => {
  const recommendFor = (run: OpenRun, taskId: string) => run.query<Recommendation>(einsatzQueryIds.recommend, { taskId })

  test('ineligible units carry their reasons in property words, and once the free units are deleted the nearer divert is proposed', async () => {
    await withRun({ items: fleet }, async run => {
      expect(await recommendFor(run, 'haul1')).toMatchObject({
        proposal: { units: [], covers: false, remainder: ['1 more hauler'] },
        ineligible: [{ unitId: 'h1', label: 'H1', reasons: ['H1 · Payload 300 kg · needs ≥ 500 kg'] }],
        servable: false,
      })

      await accepted(run, ids.send, send(['c1'], { taskId: 'low1' }))
      await accepted(run, ids.send, send(['c2'], { taskId: 'mid1' }))
      for (const objectId of ['c3', 'd1']) await accepted(run, 'world.object.delete', { objectId })
      const top = await recommendFor(run, 'top1')
      expect(top.proposal).toMatchObject({ covers: true, remainder: [], units: [{ unitId: 'c1', eta: { kind: 'straight-line' }, divertFrom: { taskId: 'low1', label: 'LOW1', rank: { id: low, code: 'C3' } } }] })
      expect(top.proposal.units).toHaveLength(1)
      expect(top.alternatives).toMatchObject([{ unitId: 'c2', divertFrom: { taskId: 'mid1', label: 'MID1', rank: { id: middle, code: 'C2' } } }])
      expect(top.alternatives).toHaveLength(1)
      healthy(run)
    })
  })

  test('while the router cannot answer a table, recommend still proposes units with unavailable ETAs and the runtime stays healthy', async () => {
    const direct = createDirectRoutingAdapter()
    const tableDown: RoutingAdapter = { ...direct, id: 'table-down', table: async () => { throw new Error('Router offline') } }
    await withRun({ items: fleet, routing: tableDown }, async run => {
      const top = await recommendFor(run, 'top1')
      expect(top.proposal).toMatchObject({ covers: true, units: [{ unitId: 'd1', eta: { kind: 'straight-line' } }] })
      expect(top.alternatives.map(entry => entry.unitId)).toEqual(['c1', 'c2', 'c3'])
      for (const entry of top.alternatives) {
        expect(entry.eta).toEqual({ kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: Router offline', straightDistanceM: expect.any(Number) })
        expect(entry.eta.kind === 'unavailable' && entry.eta.straightDistanceM).toBeGreaterThan(0)
      }
      healthy(run)
    })
  })
})

describe('Einsatz runtime refusals and faults', () => {
  const envelope = (id: string, kind: string, payload: unknown, roleIds?: ReadonlyArray<string>): CommandEnvelope => ({
    id: commandIdSchema.parse(id),
    simulationRunId: 'run-einsatz-open' as SimulationRunId,
    actorId: actorIdSchema.parse('actor:operator'),
    kind,
    targetObjectIds: [],
    payload,
    issuedAt: nowIso(),
    ...(roleIds === undefined ? {} : { roleIds }),
  })
  const reasonOf = (result: Awaited<ReturnType<OpenRun['connection']['sendCommand']>>): string => {
    if (result.ok) throw new Error('Expected a refusal')
    refusalCode(result.reason)
    return result.reason
  }

  test('input that does not parse is the caller\'s mistake; a fault while running a command fails the runtime, which then refuses every command', async () => {
    await withRun({ items: fleet }, async run => {
      expect(reasonOf(await run.connection.sendCommand(envelope('bad-input', ids.hold, { unitId: 'c1', extra: true }), {}))).toStartWith('invalid_input: ')
      healthy(run)

      // Core stamps a viewer only from roles the Run declares, and this Run declares none: a viewer reaching it is a fault.
      expect(reasonOf(await run.connection.sendCommand(envelope('forged-roles', ids.hold, { unitId: 'c1' }, ['ground']), { viewer: { roleIds: ['ground'], class: 'operator', sees: 'all' } })))
        .toBe('runtime_unavailable: The Einsatz runtime failed running world.einsatz.unit.hold: The caller holds role ground, which this Run does not declare')
      expect(run.connection.health?.()).toMatchObject([{ state: 'failed', lastFailure: { operation: 'command' } }])
      expect(await run.refusal(ids.hold, { unitId: 'c1' })).toEqual({ code: 'runtime_unavailable', reason: 'runtime_unavailable: The Einsatz runtime is unavailable; inspect runtime health' })
      expect(run.unit('c1').phase).toBe('available')
    })
  })
})

describe('Einsatz standing orders in a Run', () => {
  test('a return whose routing fails raises an alert and holds the unit; the runtime stays healthy and the unit returns once routing is back', async () => {
    const direct = createDirectRoutingAdapter()
    const router = { online: true }
    const switchable: RoutingAdapter = {
      ...direct,
      id: 'switchable',
      route: async request => {
        if (!router.online) throw new Error('Router offline')
        return await direct.route(request)
      },
    }
    const items = [unitItem('g1', types.pairServer, lonLat(0)), unitItem('g2', types.pairServer, lonLat(0, 0.001)), taskItem('w1', templates.pair, lonLat(0.005))]
    await withRun({ items, routing: switchable }, async run => {
      await accepted(run, ids.send, send(['g1', 'g2'], { taskId: 'w1' }))
      run.forward(30_000)
      await run.settle()
      expect(run.task('w1').closedAtMs).toBeDefined()
      const idleSince = run.unit('g1').phaseSinceMs
      expect(run.unit('g1')).toMatchObject({ phase: 'available', atBase: false })

      router.online = false
      run.forward(idleSince + 35_000 - run.nowMs())
      await run.settle()
      expect(run.unit('g1')).toMatchObject({ phase: 'available', alerts: [{ code: 'return_failed', message: 'Return failed: No route for G1: Router offline', sinceMs: idleSince + 30_000 }] })
      expect(run.object('g1')?.alerts).toMatchObject([{ kind: 'return_failed', severity: 'warning' }])
      healthy(run)

      router.online = true
      run.forward(2_000)
      await run.settle()
      expect(run.unit('g1')).toMatchObject({ phase: 'returning', alerts: [], lastAction: { verb: 'recall', by: 'standing-order:return' } })
      healthy(run)
    })
  })
})

describe('Einsatz on the Scenario timeline', () => {
  test('unit.create and task.create are cue targets, and a later cue commands what they created', async () => {
    const at = (seconds: number) => ({ kind: 'after_scenario_start' as const, seconds })
    const cue = (id: string, seconds: number, capabilityId: string, input: unknown) => ({ id, at: at(seconds), actions: [{ type: 'invoke_capability' as const, capabilityId, input }] })
    const timeline = { cues: [
      cue('reinforce', 5, ids.unitCreate, { type: types.roadCarrier, at: point(0.001) }),
      cue('call', 10, ids.taskCreate, { template: templates.load, at: point(0.01), loads: { [middle]: 1 }, label: 'Cue task' }),
      cue('dispatch', 15, ids.send, { units: ['unit:1'], to: { taskId: 'task:1' } }),
    ] }
    await withRun({ items: [unitItem('c1', types.roadCarrier, lonLat(0))], timeline, paused: true }, async run => {
      await run.run.runMaximumPace(isoAt(start + 20_000), { shouldStop: () => false })
      expect(run.journal.filter(event => event.type === 'notification.emitted').map(event => JSON.stringify(event))).toEqual([])
      const carrier = config.unitTypes.find(type => type.id === types.roadCarrier)!
      expect(run.object('unit:1')?.label).toBe(`${carrier.label} 2`)
      expect(run.unit('unit:1')).toMatchObject({ unitType: types.roadCarrier, phase: 'en-route', phaseSinceMs: start + 17_000, taskId: 'task:1', lastAction: { verb: 'send', by: 'actor:scenario-timeline', atMs: start + 15_000 } })
      expect(run.object('task:1')?.label).toBe('Cue task')
      expect(run.task('task:1')).toMatchObject({ createdAtMs: start + 10_000, rank: middle, lastAction: { verb: 'create', by: 'actor:scenario-timeline' } })
      expect(run.journal.filter(event => event.type === 'notification.emitted').map(event => JSON.stringify(event))).toEqual([])
    })
  })
})

describe('Einsatz checkpoint and restore', () => {
  test('a Run restored from a checkpoint continues exactly as the original does', async () => {
    const items = [unitItem('c1', types.roadCarrier, lonLat(0)), unitItem('s1', types.publicSite, lonLat(0.02)), taskItem('t1', templates.load, lonLat(0.03), { [top]: 1 })]
    await withRun({ items, paused: true }, async original => {
      await accepted(original, ids.send, send(['c1'], { taskId: 't1' }))
      await original.run.runMaximumPace(isoAt(start + 20_000), { shouldStop: () => false })
      const checkpoint = await original.run.checkpointForCopy()
      const runtimeState = checkpoint.runtimeStates[einsatzRuntimeId]
      expect(runtimeState).toMatchObject({ revision: 0, serials: { unit: 1, task: 1 }, engine: { timeMs: start + 20_000, units: { c1: { progressMs: 18_000 } } } })
      await expect(openRun({ items, restore: { snapshot: checkpoint.snapshot, runtimeState: null } })).rejects.toThrow('Einsatz runtime state is missing on a restored Run')

      await withRun({ items, restore: { snapshot: checkpoint.snapshot, runtimeState } }, async restored => {
        for (const run of [original, restored]) await run.run.runMaximumPace(isoAt(start + 140_000), { shouldStop: () => false })
        for (const id of ['c1', 's1', 't1']) {
          expect(restored.object(id)?.packData).toEqual(original.object(id)?.packData)
          expect(restored.object(id)?.spatial.position?.point).toEqual(original.object(id)?.spatial.position?.point)
        }
        expect(restored.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1', load: { [top]: 1 } })
        expect(restored.task('t1').closedAtMs).toBeDefined()
        expect(await restored.query<unknown>(einsatzQueryIds.configuration, {})).toEqual({ revision: 0, config })
      })
    })
  })

  test('a restore whose saved progress belongs to a leg the unit has since left is refused, never applied to its new leg', async () => {
    const items = [unitItem('c1', types.roadCarrier, lonLat(0)), taskItem('t1', templates.load, lonLat(0.03), { [top]: 1 })]
    await withRun({ items, paused: true }, async original => {
      await accepted(original, ids.send, send(['c1'], { taskId: 't1' }))
      await original.run.runMaximumPace(isoAt(start + 20_000), { shouldStop: () => false })
      const beforeRecall = await original.run.checkpointForCopy()
      await accepted(original, ids.recall, { unitId: 'c1' })
      const afterRecall = await original.run.checkpointForCopy()
      expect(original.unit('c1')).toMatchObject({ phase: 'returning', lastAction: { verb: 'recall' } })
      await expect(openRun({ items, restore: { snapshot: afterRecall.snapshot, runtimeState: beforeRecall.runtimeStates[einsatzRuntimeId] } }))
        .rejects.toThrow('c1: the saved leg progress measures another leg than the unit\'s canonical one')
    })
  })
})
