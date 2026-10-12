import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from '../capabilities.ts'
import { low, middle, templates, top, types } from '../fixtures/engine-harness.ts'
import { isoAt, lonLat, openRun, taskItem, unitItem, type OpenRun } from '../fixtures/run-harness.ts'
import { einsatzRuntimeId } from '../ids.ts'
import type { Recommendation } from '../recommendation-schema.ts'

/**
 * Job chains on a real Run with its clock running: every command goes
 * through the Run's Capability path and reads the state the clock has
 * brought the runtime to.
 */

const point = (east: number, north = 0) => ({ type: 'Point', coordinates: lonLat(east, north) })

const fleet = [
  unitItem('c1', types.roadCarrier, lonLat(0)),
  unitItem('c2', types.roadCarrier, lonLat(0, 0.001)),
  unitItem('d1', types.directCarrier, lonLat(0)),
  unitItem('s1', types.publicSite, lonLat(0.02)),
  unitItem('s2', types.publicSite, lonLat(-0.02)),
  taskItem('low1', templates.load, lonLat(0.01), { [low]: 1 }),
  taskItem('mid1', templates.load, lonLat(0.015), { [middle]: 1 }),
  taskItem('top1', templates.load, lonLat(0.03), { [top]: 1 }),
  taskItem('far1', templates.load, lonLat(-0.015), { [low]: 1 }),
]

const withRun = async (body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ items: fleet })
  try { await body(run) } finally { await run.close() }
}

const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

/** The step a send or queue created, as its caller learns it: the unit's last order names it. */
const createdStep = (run: OpenRun, unitId: string): string => {
  const stepId = run.unit(unitId).lastAction?.stepId
  if (stepId === undefined) throw new Error(`${unitId} names no step in its last order`)
  return stepId
}

const steps = (run: OpenRun, unitId: string) => run.unit(unitId).orders.map(step => [step.id, step.kind, step.state])
const pointOf = (run: OpenRun, id: string) => run.object(id)?.spatial.position?.point
const healthy = (run: OpenRun) => expect(run.connection.health?.().map(entry => entry.state)).toEqual(['ready'])

describe('Einsatz job chains on a running clock', () => {
  test('queue starts a free unit at once and waits behind a busy one; the caller learns each step id; recommend names the queued unit next', async () => {
    await withRun(async run => {
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'low1' } })
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'low1', lastAction: { verb: 'send', target: 'low1' } })
      expect(createdStep(run, 'c1')).toBe('step-1')

      run.forward(1_000)
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'mid1' } })
      expect(createdStep(run, 'c1')).toBe('step-2')
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'serve', 'queued']])
      expect(run.task('mid1').coverage.loads).toEqual([{ classId: middle, waiting: 1, covered: 0 }])
      const answer = await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId: 'mid1' })
      expect(answer.next).toEqual([{ unitId: 'c1', label: 'C1', stepId: 'step-2', stepsAhead: 1 }])
      expect(answer.proposal.units.map(entry => entry.unitId)).not.toContain('c1')
      healthy(run)
    })
  })

  test('removing a queued step shortens the chain; removing the active one releases it and starts the next; a send is undone by removing its step', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'low1' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { point: point(0.005, 0.005) } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'mid1' } })
      run.forward(3_000)
      await accepted(run, ids.stepRemove, { unitId: 'c1', stepId: 'step-2' })
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-3', 'serve', 'queued']])

      run.forward(2_000)
      await accepted(run, ids.stepRemove, { unitId: 'c1', stepId: 'step-1' })
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'mid1', lastAction: { verb: 'send', target: 'mid1', by: 'standing-order:chain', stepId: 'step-3' } })
      expect(run.task('low1')).toMatchObject({ alerts: [{ code: 'work_returned' }], coverage: { loads: [{ classId: low, waiting: 1, covered: 0 }] } })

      await accepted(run, ids.send, { units: ['c2'], to: { taskId: 'top1' } })
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
      await accepted(run, ids.stepRemove, { unitId: 'c2', stepId: createdStep(run, 'c2') })
      expect(run.unit('c2')).toMatchObject({ phase: 'available', orders: [], atBase: true })
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])
      expect((await run.refusal(ids.stepRemove, { unitId: 'c2', stepId: 'step-1' })).code).toBe('step_not_found')
      healthy(run)
    })
  })

  test('hold stops a unit mid-route and releases its task; resume sets off again from where it stopped', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'top1' } })
      run.forward(20_000)
      await accepted(run, ids.hold, { unitId: 'c1' })
      const stopped = pointOf(run, 'c1')
      expect(run.unit('c1')).toMatchObject({ phase: 'holding', paused: true, orders: [{ id: 'step-1', state: 'queued' }] })
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 0 }])

      run.forward(60_000)
      await run.settle()
      expect(pointOf(run, 'c1')).toEqual(stopped)
      await accepted(run, ids.resume, { unitId: 'c1' })
      expect(run.unit('c1')).toMatchObject({ phase: 'mobilizing', taskId: 'top1', orders: [{ id: 'step-1', state: 'active' }] })
      expect(run.unit('c1').paused).toBeUndefined()
      expect(run.unit('c1').leg?.geometry.coordinates[0]).toEqual([...stopped!.coordinates])
      expect(run.task('top1').coverage.loads).toEqual([{ classId: top, waiting: 1, covered: 1 }])
      run.forward(200_000)
      await run.settle()
      expect(run.task('top1').pickedUp).toEqual({ [top]: 1 })
      healthy(run)
    })
  })

  test('Stop then Resume leaves a unit parked at a point there, long past its return order', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c2'], to: { point: point(0.005, 0.005) } })
      run.forward(120_000)
      await run.settle()
      expect(run.unit('c2')).toMatchObject({ phase: 'holding', orders: [] })
      await accepted(run, ids.hold, { unitId: 'c2' })
      expect(run.unit('c2')).toMatchObject({ phase: 'holding', paused: true })
      await accepted(run, ids.resume, { unitId: 'c2' })
      run.forward(300_000)
      await run.settle()
      expect(run.unit('c2')).toMatchObject({ phase: 'holding', lastAction: { verb: 'resume' } })
      expect(pointOf(run, 'c2')).toEqual(geoPointFromLonLat(...lonLat(0.005, 0.005)))
      healthy(run)
    })
  })

  test('clear stops the unit and its return order brings it home later; recall clears the chain and returns at once', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'top1' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'mid1' } })
      await accepted(run, ids.send, { units: ['c2'], to: { point: point(0.01, 0.01) } })
      await accepted(run, ids.queue, { unitId: 'c2', to: { point: point(0.02, 0.01) } })
      run.forward(20_000)
      await accepted(run, ids.clear, { unitId: 'c1' })
      expect(run.unit('c1')).toMatchObject({ phase: 'available', orders: [], lastAction: { verb: 'clear' } })
      expect(run.task('top1').alerts).toMatchObject([{ code: 'work_returned' }])
      run.forward(61_000)
      await run.settle()
      expect(run.unit('c1')).toMatchObject({ phase: 'returning', lastAction: { verb: 'recall', by: 'standing-order:return' } })

      await accepted(run, ids.recall, { unitId: 'c2' })
      expect(run.unit('c2')).toMatchObject({ phase: 'returning', orders: [], lastAction: { verb: 'recall', by: 'actor:operator' } })
      healthy(run)
    })
  })

  test('a step is skipped under an alert when its task is closed or its site stops accepting, and the chain goes on', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'low1' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { siteId: 's2' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'far1' } })
      await accepted(run, ids.send, { units: ['c2'], to: { taskId: 'mid1' } })
      await accepted(run, ids.queue, { unitId: 'c2', to: { taskId: 'top1' } })
      run.forward(10_000)
      await accepted(run, ids.taskClose, { taskId: 'top1', reason: 'Withdrawn' })
      expect(run.unit('c2')).toMatchObject({ taskId: 'mid1', orders: [{ id: 'step-1' }], alerts: [{ code: 'step_skipped', message: 'Skipped TOP1 (closed)' }] })

      await accepted(run, ids.siteSet, { siteId: 's2', accepting: false })
      run.forward(60_000)
      await run.settle()
      expect(run.unit('c1').alerts).toMatchObject([{ code: 'step_skipped', message: 'Skipped S2 (S2 is not accepting)' }])
      expect(run.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1', lastAction: { verb: 'deliver', by: 'standing-order:deliver' }, orders: [{ kind: 'deliver', state: 'active', by: 'standing-order:deliver' }, { kind: 'serve', target: { taskId: 'far1' }, state: 'queued' }] })
      run.forward(300_000)
      await run.settle()
      expect(run.task('far1').pickedUp).toEqual({ [low]: 1 })
      healthy(run)
    })
  })

  test('capacity is refused with the reason, and a delivery queued first makes room', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['d1'], to: { taskId: 'low1' } })
      expect(await run.refusal(ids.queue, { unitId: 'd1', to: { taskId: 'mid1' } })).toEqual({ code: 'unit_loaded', reason: 'unit_loaded: D1 will have 1 person on board by then; queue a delivery first' })
      await accepted(run, ids.queue, { unitId: 'd1', to: { siteId: 's1' } })
      await accepted(run, ids.queue, { unitId: 'd1', to: { taskId: 'mid1' } })
      expect(steps(run, 'd1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
      run.forward(120_000)
      await run.settle()
      expect(run.unit('s1').received).toEqual({ [low]: 1 })
      expect(run.task('mid1').pickedUp).toEqual({ [middle]: 1 })
      healthy(run)
    })
  })

  test('a divert removes only the current step; the queued chain follows the new task', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'low1' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { point: point(0, 0.01) } })
      run.forward(5_000)
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'top1' }, divert: [{ unitId: 'c1', fromTaskId: 'low1' }] })
      expect(steps(run, 'c1')).toEqual([['step-3', 'serve', 'active'], ['step-2', 'move', 'queued']])
      expect(run.task('low1').alerts).toMatchObject([{ code: 'work_returned' }])
      expect(createdStep(run, 'c1')).toBe('step-3')
      healthy(run)
    })
  })

  test('a chain stays within its limit, and a Run restored with a delivery in front of a full chain carries on', async () => {
    const items = [unitItem('c1', types.roadCarrier, lonLat(0)), unitItem('g1', types.pairServer, lonLat(0)), unitItem('s1', types.publicSite, lonLat(0.02)), taskItem('here', templates.load, lonLat(0), { [low]: 1 })]
    const run = await openRun({ items })
    try {
      await accepted(run, ids.send, { units: ['g1'], to: { point: point(0.5) } })
      for (let index = 1; index < 20; index++) await accepted(run, ids.queue, { unitId: 'g1', to: { point: point(0.5, 0.001 * index) } })
      await accepted(run, ids.hold, { unitId: 'g1' })
      expect(await run.refusal(ids.send, { units: ['g1'], to: { point: point(0.4) } })).toEqual({ code: 'chain_full', reason: 'chain_full: G1 already holds 20 steps; remove one first' })
      expect(run.unit('g1').orders).toHaveLength(20)

      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'here' } })
      run.forward(3_000)
      await accepted(run, ids.hold, { unitId: 'c1' })
      run.forward(3_000)
      await run.settle()
      expect(run.unit('c1')).toMatchObject({ phase: 'holding', paused: true, load: { [low]: 1 }, orders: [] })
      for (let index = 1; index <= 20; index++) await accepted(run, ids.queue, { unitId: 'c1', to: { point: point(-0.01, 0.001 * index) } })
      await accepted(run, ids.resume, { unitId: 'c1' })
      expect(run.unit('c1').orders).toHaveLength(21)
      expect(run.unit('c1')).toMatchObject({ phase: 'transporting', siteId: 's1' })
      expect(run.unit('c1').orders[0]).toMatchObject({ kind: 'deliver', state: 'active', by: 'standing-order:deliver' })
      healthy(run)

      const checkpoint = await run.run.checkpointForCopy()
      const restored = await openRun({ items, restore: { snapshot: checkpoint.snapshot, runtimeState: checkpoint.runtimeStates[einsatzRuntimeId] } })
      try {
        expect(restored.unit('c1')).toEqual(run.unit('c1'))
        const targetMs = run.nowMs() + 120_000
        for (const copy of [run, restored]) {
          await copy.run.setClock({ paused: true })
          await copy.run.runMaximumPace(isoAt(targetMs), { shouldStop: () => false })
        }
        expect(restored.unit('c1')).toEqual(run.unit('c1'))
        expect(restored.unit('s1').received).toEqual({ [low]: 1 })
        healthy(restored)
      } finally { await restored.close() }
    } finally { await run.close() }
  })

  test('a chain across sites: pick up at one task, deliver at the second site, then serve another task', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['c1'], to: { taskId: 'low1' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { siteId: 's2' } })
      await accepted(run, ids.queue, { unitId: 'c1', to: { taskId: 'far1' } })
      expect(steps(run, 'c1')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'deliver', 'queued'], ['step-3', 'serve', 'queued']])
      expect(run.task('far1').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 0 }])
      run.forward(170_000)
      await run.settle()
      expect(run.unit('s2').received).toEqual({ [low]: 1 })
      expect(run.unit('c1')).toMatchObject({ taskId: 'far1', orders: [{ id: 'step-3', state: 'active' }] })
      expect(run.task('far1').coverage.loads).toEqual([{ classId: low, waiting: 1, covered: 1 }])
      run.forward(300_000)
      await run.settle()
      expect(run.unit('s2').received).toEqual({ [low]: 2 })
      expect(run.unit('c1').orders).toEqual([])
      healthy(run)
    })
  })
})
