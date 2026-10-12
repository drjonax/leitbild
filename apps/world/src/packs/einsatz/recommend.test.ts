import { describe, expect, test } from 'bun:test'
import { meters, routeDistanceMeters } from '../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import type { RouteTableResult } from '../../routing/protocol.ts'
import type { Recommendation } from './capabilities.ts'
import type { EngineState } from './engine/model.ts'
import { advance, at, emptyState, low, middle, newTask, newUnit, pointOf, run, runAll, send, start, templates, top, types } from './fixtures/engine-harness.ts'
import type { TablePort } from './eta.ts'
import { recommend } from './recommend.ts'
import { refusalCode } from './refusal.ts'
import { openViewer } from './viewer.ts'

const direct = createDirectRoutingAdapter()
const recommendFor = (state: EngineState, taskId: string, routing: TablePort = direct): Promise<Recommendation> =>
  recommend({ state, viewer: openViewer, taskId, routing })
const unitIds = (entries: ReadonlyArray<{ readonly unitId: string }>): string[] => entries.map(entry => entry.unitId)
const far = (index: number) => at(0.05 * (index + 1), 0.02)

/**
 * The divert-protection scenario: A1 en route to a covered top-class task;
 * A2 en route to a middle-class task (C9); A3 on task at a low-class task;
 * A4 en route to C20 holding top ×1 (covered by A4) + low ×1; A6 en route to
 * a low-class task. Every unit carries one load of any class; none is free.
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

describe('Einsatz recommendations with diverts', () => {
  test('a new middle-class task is proposed only the unit heading to lower-class work, as a divert', async () => {
    const state = await run(await protectionScenario(), newTask('n2', templates.load, at(0.003), { [middle]: 1 }))
    const recommendation = await recommendFor(state, 'n2')
    expect(recommendation.proposal).toMatchObject({ covers: true, remainder: [], units: [{ unitId: 'a6', divertFrom: { taskId: 'low6', label: 'LOW6', rank: { id: low, code: 'C3' } } }] })
    expect(recommendation.alternatives).toEqual([])
    expect(unitIds(recommendation.committed)).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(recommendation.committed.find(entry => entry.unitId === 'a3')?.reason).toBe('A3 now working at LOW3 · Controller')
  })

  test('a new top-class task is proposed the nearer divert, from low-class work; the unit heading to middle-class work is the one alternative', async () => {
    const state = await run(await protectionScenario(), newTask('n1', templates.load, at(0.003), { [top]: 1 }))
    const recommendation = await recommendFor(state, 'n1')
    const divertFrom = (taskId: string, label: string, rank: string, code: string) => ({ taskId, label, rank: { id: rank, code } })
    const straightTo = (unitId: string) => {
      const distanceM = routeDistanceMeters(pointOf(state, unitId), at(0.003))
      return { kind: 'straight-line', seconds: distanceM / 15, distanceM }
    }
    expect(recommendation.proposal).toEqual({ units: [{ unitId: 'a6', label: 'A6', eta: straightTo('a6'), divertFrom: divertFrom('low6', 'LOW6', low, 'C3') }], covers: true, remainder: [] })
    expect(recommendation.alternatives).toEqual([{ unitId: 'a2', label: 'A2', eta: straightTo('a2'), divertFrom: divertFrom('c9', 'C9', middle, 'C2') }])
    expect(unitIds(recommendation.committed)).toEqual(['a1', 'a3', 'a4'])
  })

  test('a task whose top load is covered needs only its low load: nothing is offered and the remainder is named', async () => {
    const recommendation = await recommendFor(await protectionScenario(), 'c20')
    expect(recommendation).toMatchObject({ rank: { id: top, code: 'C1' }, need: { id: low, code: 'C3' }, servable: true })
    expect(recommendation.proposal).toEqual({ units: [], covers: false, remainder: ['C3×1'] })
    expect(recommendation.alternatives).toEqual([])
    expect(unitIds(recommendation.committed)).toEqual(['a1', 'a2', 'a3', 'a6'])
  })

  test('with a free unit covering the top load, the low load remains and no unit is diverted for it', async () => {
    let state = await run(await protectionScenario(), newTask('n13', templates.load, at(0.003), { [top]: 1, [low]: 1 }))
    state = await run(state, newUnit('a5', types.roadCarrier, at(0.004)))
    const recommendation = await recommendFor(state, 'n13')
    expect(recommendation.proposal).toMatchObject({ units: [{ unitId: 'a5' }], covers: false, remainder: ['C3×1'] })
    expect(recommendation.proposal.units[0]?.divertFrom).toBeUndefined()
    expect(recommendation.alternatives).toEqual([])
  })
})

describe('Einsatz smallest covering sets', () => {
  test('a counted requirement is proposed the nearest units that cover it; the rest are alternatives by ETA', async () => {
    const state = await runAll(emptyState(), [
      newUnit('g3', types.pairServer, at(0.03)),
      newUnit('g1', types.pairServer, at(0.001)),
      newUnit('g2', types.pairServer, at(0.002)),
      newTask('pair', templates.pair, at(0)),
    ])
    const recommendation = await recommendFor(state, 'pair')
    expect(recommendation.proposal).toMatchObject({ covers: true, remainder: [] })
    expect(unitIds(recommendation.proposal.units)).toEqual(['g1', 'g2'])
    expect(unitIds(recommendation.alternatives)).toEqual(['g3'])
  })

  test('fewer units come first: one carrier taking both loads beats two nearer carriers taking one each', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('c2', types.roadCarrier, at(0.002)),
      newUnit('d1', types.directCarrier, at(0.04)),
      newTask('t1', templates.load, at(0), { [top]: 1, [middle]: 1 }),
    ])
    const recommendation = await recommendFor(state, 't1')
    expect(unitIds(recommendation.proposal.units)).toEqual(['d1'])
    expect(recommendation.proposal.covers).toBe(true)
    expect(unitIds(recommendation.alternatives)).toEqual(['c1', 'c2'])
  })

  test('without enough units the best partial set is proposed and the remainder named', async () => {
    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0), { [top]: 3 }),
    ])
    const recommendation = await recommendFor(state, 't1')
    expect(recommendation.proposal).toMatchObject({ units: [{ unitId: 'c1' }], covers: false, remainder: ['C1×2'] })
    expect(recommendation.servable).toBe(true)
  })
})

describe('Einsatz ineligible units', () => {
  test('a unit failing a requirement is listed with the reason in property words; one lacking the property says so', async () => {
    let state = await runAll(emptyState(), [
      newUnit('h1', types.payloadServer, at(0.001)),
      newUnit('c1', types.roadCarrier, at(0.001)),
      newUnit('d1', types.directCarrier, at(0.002)),
      newTask('haul1', templates.payload, at(0)),
      newTask('lift1', templates.lift, at(0)),
    ])
    const haul = await recommendFor(state, 'haul1')
    expect(haul.ineligible).toEqual([{ unitId: 'h1', label: 'H1', reasons: ['H1 · Payload 300 kg · needs ≥ 500 kg'] }])
    expect(haul.proposal).toEqual({ units: [], covers: false, remainder: ['1 more hauler'] })
    expect(haul.servable).toBe(false)
    const lift = await recommendFor(state, 'lift1')
    expect(lift.ineligible).toEqual([
      { unitId: 'c1', label: 'C1', reasons: ['C1 · Lift 400 kg · needs ≥ 500 kg'] },
      { unitId: 'd1', label: 'D1', reasons: ['Lift not declared on Flyer'] },
    ])
    state = await run(state, { kind: 'unit.adjust', unitId: 'h1', properties: { payloadKg: 800 }, reason: 'Loaded lighter' })
    const eligible = await recommendFor(state, 'haul1')
    expect(eligible.ineligible).toEqual([])
    expect(eligible.proposal).toMatchObject({ units: [{ unitId: 'h1' }], covers: true })
  })
})

describe('Einsatz ETAs', () => {
  const twoUnits = () => runAll(emptyState(), [
    newUnit('c1', types.roadCarrier, at(0.01)),
    newUnit('d1', types.directCarrier, at(0.02)),
    newTask('t1', templates.load, at(0), { [top]: 1, [low]: 1 }),
  ])
  const table = (cell: { readonly durationS: number | null; readonly distanceM: number | null; readonly sourceSnapM?: number; readonly destinationSnapM?: number }): TablePort & { calls: number } => {
    const port = {
      calls: 0,
      table: async (): Promise<RouteTableResult> => {
        port.calls += 1
        return {
          durationsSeconds: [[cell.durationS]],
          distancesM: [[cell.distanceM === null ? null : meters(cell.distanceM)]],
          sourceSnapsM: [meters(cell.sourceSnapM ?? 5)],
          destinationSnapsM: [meters(cell.destinationSnapM ?? 5)],
          basis: 'routed',
          provider: 'stub',
        }
      },
    }
    return port
  }
  const etaOf = (recommendation: Recommendation, unitId: string) =>
    [...recommendation.proposal.units, ...recommendation.alternatives].find(entry => entry.unitId === unitId)?.eta

  test('road ETAs come from one router table with turnout added; a direct unit flies a straight line; the direct router says straight-line', async () => {
    const state = await twoUnits()
    const routed = table({ durationS: 100, distanceM: 1_200 })
    const recommendation = await recommendFor(state, 't1', routed)
    expect(routed.calls).toBe(1)
    expect(etaOf(recommendation, 'c1')).toEqual({ kind: 'routed', seconds: 2 + 100, distanceM: 1_200 })
    const straight = routeDistanceMeters(pointOf(state, 'd1'), at(0))
    expect(etaOf(recommendation, 'd1')).toEqual({ kind: 'straight-line', seconds: straight / 50, distanceM: straight })
    expect(etaOf(await recommendFor(state, 't1'), 'c1')?.kind).toBe('straight-line')
  })

  test('a pair without a route has no ETA, only its straight distance, and sorts last', async () => {
    const state = await twoUnits()
    const recommendation = await recommendFor(state, 't1', table({ durationS: null, distanceM: null }))
    expect(etaOf(recommendation, 'c1')).toEqual({ kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: no route', straightDistanceM: routeDistanceMeters(pointOf(state, 'c1'), at(0)) })
    expect(unitIds(recommendation.proposal.units)).toEqual(['d1'])
  })

  test('a unit or task more than 1 km from a road has no ETA, refused as a send of it would be', async () => {
    const state = await twoUnits()
    const straightDistanceM = routeDistanceMeters(pointOf(state, 'c1'), at(0))
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, sourceSnapM: 1_001 })), 'c1'))
      .toEqual({ kind: 'unavailable', reason: 'no_road_near_point: C1 is more than 1 km from a road', straightDistanceM })
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, destinationSnapM: 1_001 })), 'c1'))
      .toEqual({ kind: 'unavailable', reason: 'no_road_near_point: The destination is more than 1 km from a road', straightDistanceM })
    expect(etaOf(await recommendFor(state, 't1', table({ durationS: 100, distanceM: 1_200, sourceSnapM: 1_000, destinationSnapM: 1_000 })), 'c1')?.kind).toBe('routed')
  })

  test('when the router fails every road ETA is unavailable with the cause, direct units keep theirs, and road units are still proposed by fit then id', async () => {
    const failing: TablePort = { table: async () => { throw new Error('Router offline') } }
    const mixed = await recommendFor(await twoUnits(), 't1', failing)
    expect(etaOf(mixed, 'c1')?.kind).toBe('unavailable')
    expect(etaOf(mixed, 'd1')?.kind).toBe('straight-line')
    expect(unitIds(mixed.proposal.units)).toEqual(['d1'])

    const state = await runAll(emptyState(), [
      newUnit('c1', types.roadCarrier, at(0.02)),
      newUnit('c2', types.roadCarrier, at(0.001)),
      newTask('t1', templates.load, at(0), { [top]: 1 }),
    ])
    const roadOnly = await recommendFor(state, 't1', failing)
    expect(roadOnly.proposal).toMatchObject({ covers: true, units: [{ unitId: 'c1', eta: { kind: 'unavailable', reason: 'routing_unavailable: ETA unavailable: Router offline', straightDistanceM: routeDistanceMeters(pointOf(state, 'c1'), at(0)) } }] })
    expect(unitIds(roadOnly.alternatives)).toEqual(['c2'])
  })
})

describe('Einsatz recommendation refusals', () => {
  test('an unknown task is not in the picture and a closed one is refused, both as Capability rejections', async () => {
    const state = await runAll(emptyState(), [newTask('n1', templates.report, at(0)), { kind: 'task.close', taskId: 'n1' }])
    const reasonOf = (taskId: string) => recommendFor(state, taskId).then(() => { throw new Error('expected a refusal') }, (error: Error & { readonly code?: string }) => ({ code: error.code, refusal: refusalCode(error.message) }))
    expect(await reasonOf('ghost')).toEqual({ code: 'capability_target_not_found', refusal: 'not_in_picture' })
    expect(await reasonOf('n1')).toEqual({ code: 'capability_input_rejected', refusal: 'task_closed' })
  })
})
