import { describe, expect, test } from 'bun:test'
import { advance, at, emptyState, low, middle, newTask, newUnit, refusalOf, run, runAll, send, start, taskOf, templates, top, types, unitOf } from '../fixtures/engine-harness.ts'
import { countedFor, isDivertCandidate, needFor, rankOf, residualNeed, roleViewFor, roleViewOf } from './coverage.ts'
import { commandsEveryUnit } from './intents.ts'
import type { EngineState } from './model.ts'
import { isFree } from './rules.ts'

const far = (index: number) => at(0.05 * (index + 1), 0.02)

/**
 * The divert-protection scenario: A1 en route to a covered top-class task;
 * A2 en route to a middle-class task (C9); A3 on task at a low-class task;
 * A4 en route to C20 holding top ×1 (covered by A4) + low ×1; A6 en route to
 * a low-class task. Every unit carries one load of any class.
 */
const protectionScenario = async (): Promise<EngineState> => {
  let state = await runAll(emptyState(), [
    ...['a1', 'a2', 'a3', 'a4', 'a6'].map((id, index) => newUnit(id, types.roadCarrier, at(0.001 * index))),
    newTask('top1', templates.load, far(0), { [top]: 1 }),
    newTask('c9', templates.load, far(1), { [middle]: 1 }),
    newTask('low3', templates.load, at(0.002), { [low]: 1 }),
    newTask('c20', templates.load, far(2), { [top]: 1, [low]: 1 }),
    newTask('low6', templates.load, far(3), { [low]: 1 }),
  ])
  state = await runAll(state, [
    send(['a1'], { taskId: 'top1' }),
    send(['a2'], { taskId: 'c9' }),
    send(['a3'], { taskId: 'low3' }),
    send(['a4'], { taskId: 'c20' }),
    send(['a6'], { taskId: 'low6' }),
  ])
  return await advance(state, start + 3_000)
}

const candidatesFor = (state: EngineState, taskId: string, proposal: ReadonlyArray<string> = []): string[] => {
  const task = taskOf(state, taskId)
  const units = proposal.map(id => unitOf(state, id))
  const residual = residualNeed(state, task, roleViewFor(state, commandsEveryUnit, task), units)
  const counted = countedFor(state, task, units)
  return [...state.units.values()].filter(unit => isDivertCandidate(state, { unit, task, counted, residual, commandable: commandsEveryUnit })).map(unit => unit.id).sort()
}

describe('Einsatz divert protection', () => {
  test('the scenario stands as described', async () => {
    const state = await protectionScenario()
    expect(['a1', 'a2', 'a3', 'a4', 'a6'].map(id => unitOf(state, id).phase)).toEqual(['en-route', 'en-route', 'on-task', 'en-route', 'en-route'])
    expect(taskOf(state, 'c20')).toMatchObject({ rank: top, coverage: { loads: [{ classId: top, waiting: 1, covered: 1 }, { classId: low, waiting: 1, covered: 0 }] } })
    expect([...state.units.values()].filter(isFree)).toEqual([])
  })

  test('a new middle-class task is offered only the unit heading to lower-class work', async () => {
    const state = await run(await protectionScenario(), newTask('n2', templates.load, at(0.003), { [middle]: 1 }))
    expect(candidatesFor(state, 'n2')).toEqual(['a6'])
  })

  test('a new top-class task is offered the middle- and low-class units, never the covered top, the one on task or C20\'s', async () => {
    const state = await run(await protectionScenario(), newTask('n1', templates.load, at(0.003), { [top]: 1 }))
    expect(candidatesFor(state, 'n1')).toEqual(['a2', 'a6'])
  })

  test('a task whose top load is covered needs only its low load, so nothing is offered for it', async () => {
    const state = await protectionScenario()
    const task = taskOf(state, 'c20')
    expect(task.rank).toBe(top)
    expect(needFor(state.catalog, task, task.coverage, roleViewFor(state, commandsEveryUnit, task))).toBe(low)
    expect(candidatesFor(state, 'c20')).toEqual([])
  })

  test('with a free unit covering the top load, the residual need is the low load and no divert is offered', async () => {
    let state = await run(await protectionScenario(), newTask('n13', templates.load, at(0.003), { [top]: 1, [low]: 1 }))
    state = await run(state, newUnit('a5', types.roadCarrier, at(0.004)))
    const task = taskOf(state, 'n13')
    const view = roleViewFor(state, commandsEveryUnit, task)
    expect(residualNeed(state, task, view, [unitOf(state, 'a5')])).toBe(low)
    expect(candidatesFor(state, 'n13', ['a5'])).toEqual([])
    const refused = await refusalOf(state, send(['a5', 'a6'], { taskId: 'n13' }, [{ unitId: 'a6', fromTaskId: 'low6' }]))
    expect(refused.reason).toBe('divert_not_lower_priority: LOW6 (C3) is not lower than C3 at N13')
  })

  test('a divert commits only from strictly lower work, before arrival, and returns the work with its age', async () => {
    let state = await run(await protectionScenario(), newTask('n1', templates.load, at(0.003), { [top]: 1 }))
    expect((await refusalOf(state, send(['a1'], { taskId: 'n1' }, [{ unitId: 'a1', fromTaskId: 'top1' }]))).code).toBe('divert_not_lower_priority')
    expect((await refusalOf(state, send(['a4'], { taskId: 'n1' }, [{ unitId: 'a4', fromTaskId: 'c20' }]))).code).toBe('divert_not_lower_priority')
    expect((await refusalOf(state, send(['a3'], { taskId: 'n1' }, [{ unitId: 'a3', fromTaskId: 'low3' }]))).code).toBe('divert_after_arrival')
    const stale = await refusalOf(state, send(['a2'], { taskId: 'n1' }, [{ unitId: 'a2', fromTaskId: 'low6' }]))
    expect(stale.reason).toBe('unit_committed: A2 now en route to C9')
    expect((await refusalOf(state, send(['a2'], { taskId: 'n1' }))).code).toBe('unit_committed')

    state = await run(state, send(['a2'], { taskId: 'n1' }, [{ unitId: 'a2', fromTaskId: 'c9' }]))
    expect(unitOf(state, 'a2')).toMatchObject({ taskId: 'n1', phase: 'en-route', lastAction: { verb: 'divert', target: 'n1', cause: 'from C9' } })
    expect(taskOf(state, 'c9')).toMatchObject({ createdAtMs: start, loads: { [middle]: 1 }, alerts: [{ code: 'work_returned' }] })
    expect(taskOf(state, 'c9').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 0 }])
    expect(taskOf(state, 'n1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
  })
})

describe('Einsatz carriers of different load classes', () => {
  /** A carrier of any class at the task and a carrier of the top class only further away; the task holds one top and one low load. */
  const mixed = () => runAll(emptyState(), [
    newUnit('near', types.roadCarrier, at(0)),
    newUnit('solo', types.narrowCarrier, at(0.01)),
    newTask('t1', templates.load, at(0), { [top]: 1, [low]: 1 }),
  ])
  const bothCovered = [{ classId: top, waiting: 1, covered: 1 }, { classId: low, waiting: 1, covered: 1 }]

  test('a send is judged the same whichever order it names its units in', async () => {
    const state = await mixed()
    for (const units of [['near', 'solo'], ['solo', 'near']]) expect(taskOf(await run(state, send(units, { taskId: 't1' })), 't1').coverage.loads).toEqual(bothCovered)
  })

  test('a unit that would add nothing beside the rest of the send is refused, whichever position it holds', async () => {
    const state = await run(await mixed(), newUnit('spare', types.narrowCarrier, at(0.02)))
    for (const units of [['spare', 'near', 'solo'], ['near', 'solo', 'spare']]) {
      expect((await refusalOf(state, send(units, { taskId: 't1' }))).code).toBe('requirement_covered')
    }
  })

  test('each carrier picks up the load coverage allocated to it, though the any-class carrier arrives first, and the task closes', async () => {
    let state = await run(await mixed(), send(['near', 'solo'], { taskId: 't1' }))
    expect(taskOf(state, 't1').coverage.loads).toEqual(bothCovered)
    state = await advance(state, start + 6_000)
    expect(unitOf(state, 'near')).toMatchObject({ phase: 'holding', load: { [low]: 1 } })
    expect(unitOf(state, 'solo')).toMatchObject({ phase: 'en-route', taskId: 't1' })
    expect(taskOf(state, 't1')).toMatchObject({ loads: { [top]: 1 }, coverage: { loads: [{ classId: top, waiting: 1, covered: 1 }] } })
    state = await advance(state, start + 30_000)
    expect(unitOf(state, 'solo').load).toEqual({ [top]: 1 })
    expect(taskOf(state, 't1')).toMatchObject({ loads: {}, pickedUp: { [top]: 1, [low]: 1 }, alerts: [] })
    expect(taskOf(state, 't1').closedAtMs).toBeDefined()
  })
})

describe('Einsatz rank and need', () => {
  test('rank is the higher of floor and waiting load, covered or not; with neither, the least urgent class', async () => {
    const state = await runAll(emptyState(), [
      newTask('floored', templates.payload, at(0), { [low]: 1 }),
      newTask('loaded', templates.payload, at(0), { [top]: 1, [low]: 2 }),
      newTask('bare', templates.load, at(0), { [low]: 1 }),
    ])
    expect(taskOf(state, 'floored').rank).toBe(middle)
    expect(taskOf(state, 'loaded').rank).toBe(top)
    expect(rankOf(state.catalog, { id: 'x', template: templates.load, loads: {} })).toBe(low)
    expect(rankOf(state.catalog, { id: 'x', template: templates.payload, loads: {} })).toBe(middle)
  })

  test('adding coverage never lowers the rank, and picking up the top load does', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.directCarrier, at(0)),
      newTask('t1', templates.load, at(0), { [top]: 1, [middle]: 1, [low]: 1 }),
    ])
    state = await run(state, send(['u1'], { taskId: 't1' }))
    expect(taskOf(state, 't1').rank).toBe(top)
    state = await advance(state, start + 3_000)
    expect(unitOf(state, 'u1').load).toEqual({ [top]: 1, [middle]: 1 })
    expect(taskOf(state, 't1')).toMatchObject({ rank: low, loads: { [low]: 1 }, pickedUp: { [top]: 1, [middle]: 1 } })
  })

  test('need follows what the role can serve; load-less tasks sort by their floor and an open report needs acknowledging', async () => {
    const state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('pair', templates.pair, at(0.01)),
      newTask('note', templates.report, at(0.01)),
      newTask('mixed', templates.load, at(0.01), { [middle]: 1, [low]: 1 }),
    ])
    const servers = roleViewOf(state.catalog, [unitOf(state, 'g1')])
    const carriers = roleViewOf(state.catalog, [unitOf(state, 'c1')])
    const need = (id: string, view: typeof servers) => needFor(state.catalog, taskOf(state, id), taskOf(state, id).coverage, view)
    expect(need('pair', servers)).toBe(middle)
    expect(need('pair', carriers)).toBeUndefined()
    expect(need('note', carriers)).toBe(low)
    expect(need('mixed', carriers)).toBe(middle)
    expect(need('mixed', servers)).toBeUndefined()
  })
})

describe('Einsatz coverage and eligibility', () => {
  test('a requirement counts only units meeting its where; the reason is in property words', async () => {
    let state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0)),
      newUnit('d1', types.directCarrier, at(0)),
      newTask('r1', templates.lift, at(0.01)),
    ])
    const short = await refusalOf(state, send(['c1'], { taskId: 'r1' }))
    expect(short.reason).toBe('requirement_unmet: C1 · Lift 400 kg · needs ≥ 500 kg')
    expect((await refusalOf(state, send(['d1'], { taskId: 'r1' }))).reason).toBe('requirement_unmet: Lift not declared on Flyer')
    state = await run(state, { kind: 'unit.adjust', unitId: 'c1', properties: { liftKg: 600 }, reason: 'Refitted' })
    expect(unitOf(state, 'c1').lastAction).toMatchObject({ verb: 'adjust', cause: 'Refitted' })
    state = await run(state, send(['c1'], { taskId: 'r1' }))
    expect(taskOf(state, 'r1').coverage.requirements).toEqual([{ provides: 'aid', count: 1, enRoute: 1, onTask: 0, completed: 0 }])
    const lowered = await refusalOf(state, { kind: 'unit.adjust', unitId: 'c1', properties: { liftKg: 450 }, reason: 'Damaged' })
    expect(lowered.reason).toBe('requirement_unmet: R1: C1 · Lift 450 kg · needs ≥ 500 kg')
    expect((await refusalOf(state, send(['d1'], { taskId: 'r1' }))).code).toBe('requirement_unmet')
  })

  test('a counted requirement is sent all or nothing and refuses units beyond its count', async () => {
    let state = await runAll(emptyState(), [
      newUnit('g1', types.pairServer, at(0)),
      newUnit('g2', types.pairServer, at(0)),
      newUnit('g3', types.pairServer, at(0)),
      newUnit('c1', types.roadCarrier, at(0)),
      newTask('pair', templates.pair, at(0.01)),
    ])
    expect((await refusalOf(state, send(['g1', 'c1'], { taskId: 'pair' }))).reason).toBe('requirement_unmet: C1 provides nothing PAIR needs')
    expect(unitOf(state, 'g1').taskId).toBeUndefined()
    state = await run(state, send(['g1', 'g2'], { taskId: 'pair' }))
    expect(taskOf(state, 'pair').coverage.requirements[0]).toMatchObject({ enRoute: 2, completed: 0 })
    expect((await refusalOf(state, send(['g3'], { taskId: 'pair' }))).reason).toBe('requirement_covered: PAIR needs nothing more that G3 provides')
    state = await advance(state, start + 120_000)
    expect(taskOf(state, 'pair')).toMatchObject({ served: { guard: 2 } })
    expect(taskOf(state, 'pair').closedAtMs).toBeDefined()
  })

  test('a point move and a hold never commit a unit; a committed unit is not free', async () => {
    let state = await runAll(emptyState(), [
      newUnit('u1', types.roadCarrier, at(0)),
      newTask('t1', templates.load, at(0.01), { [low]: 1 }),
    ])
    state = await run(state, send(['u1'], { point: at(0.02) }))
    expect(unitOf(state, 'u1')).toMatchObject({ phase: 'en-route', lastAction: { verb: 'move' } })
    expect(isFree(unitOf(state, 'u1'))).toBe(true)
    state = await run(state, { kind: 'hold', unitId: 'u1' })
    expect(unitOf(state, 'u1').phase).toBe('holding')
    expect(isFree(unitOf(state, 'u1'))).toBe(true)
    state = await run(state, send(['u1'], { taskId: 't1' }))
    expect(unitOf(state, 'u1').phase).toBe('mobilizing')
    expect(isFree(unitOf(state, 'u1'))).toBe(false)
    expect((await refusalOf(state, { kind: 'hold', unitId: 'u1' })).reason).toBe('unit_committed: U1 now mobilizing to T1; recall first (R), or move it (M)')
  })
})
