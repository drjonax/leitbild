import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, openScreen, pastGuardMs, pointAt, runFor, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import supplyRun from '../fixtures/supply-run.scenario.json'
import { boardWords } from './text.ts'

/**
 * Job chains on the Board (A9), by taps against the real runtime on a
 * running clock: a busy asset asks "Do now" or "Add to end"; an asset's +
 * adds its next target tap to the end of its chain; its row shows the chain
 * and, highlighted, a × per step; Stop, Resume and Clear act on the chain;
 * Undo removes the step a send or queue created; a call held queued says who
 * comes next; skipped steps raise their alert in the strip and on the row.
 * The universal flows run on two Definitions whose types the code never
 * names: supply-run (a place, then two requests) and civil Halden (a call,
 * then a chosen receiving site instead of the nearest).
 */

const kinds = civilKinds(civilConfig)
const { carrier, site } = kinds.types
const [top, middle, low] = kinds.classes as [string, string, string]
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
const row = (screen: Screen, unitId: string) => {
  const found = screen.view().unitBoard.rows.find(entry => entry.id === unitId)
  if (found === undefined) throw new Error(`Assets shows no ${unitId}`)
  return found
}
const workRow = (screen: Screen, taskId: string) => {
  const found = screen.view().workList.rows.find(entry => entry.id === taskId)
  if (found === undefined) throw new Error(`Calls shows no ${taskId}`)
  return found
}
const stepsOf = (run: OpenRun, unitId: string) => run.unit(unitId).orders.map(step => [step.id, step.state])

describe('Board job chains', () => {
  test('a busy asset tapped onto a call asks Do now or Add to end; Add to end queues it, the call says who comes next, and Undo removes that step', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [middle]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      expect(row(screen, 'u1').chain).toEqual([{ stepId: 'step-1', text: 'T1', active: true, removable: true }])
      await screen.mapTap('u1')
      await screen.mapTap('t2')
      expect(screen.view().commit).toMatchObject({
        state: 'choice',
        options: [{ option: 'do-now', label: boardWords.doNow }, { option: 'add-to-end', label: boardWords.addToEnd }],
        detail: expect.stringMatching(/^T1 \(/),
      })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'option', option: 'add-to-end' })
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([[ids.queue, { unitId: 'u1', to: { taskId: 't2' } }, true]])
      expect(stepsOf(run, 'u1')).toEqual([['step-1', 'active'], ['step-2', 'queued']])
      expect(row(screen, 'u1').chain.map(step => step.text)).toEqual(['T1', `${boardWords.next}: T2`])
      // The queued call counts towards nothing yet, so it stays unserved and says who comes next.
      expect([workRow(screen, 't2').served, workRow(screen, 't2').nextText]).toEqual([false, 'U1 next, 1 step ahead'])
      expect(screen.view().undo).toBe(boardWords.undo)
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-2' }, result: { ok: true } })
      expect([stepsOf(run, 'u1'), run.unit('u1').taskId]).toEqual([[['step-1', 'active']], 't1'])
    })
  })

  test('the highlighted row shows a × per step, Clear empties the chain, and a + then open ground asks "Move here" before adding the move', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [middle]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      await accepted(run, ids.queue, { unitId: 'u1', to: { taskId: 't2' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'verb', verb: 'add', id: 'u1' })
      expect([screen.view().selected, row(screen, 'u1').adding, screen.view().commit.text]).toEqual([{ kind: 'unit', id: 'u1' }, true, `${boardWords.addToEnd}: tap a call, a site or the map for U1`])
      await screen.groundTap(at(-2, 2))
      expect(screen.calls).toHaveLength(0)
      expect(screen.view().mapPrompt).toMatchObject({ unitId: 'u1', label: `${boardWords.addToEnd}: ${civilConfig.lexicon.move ?? 'Move'} U1 here` })
      await screen.click({ kind: 'move-here' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.queue, input: { unitId: 'u1', to: { point: pointAt(at(-2, 2)) } }, result: { ok: true } })
      expect(row(screen, 'u1')).toMatchObject({ selected: true, adding: false })
      expect(row(screen, 'u1').chain.map(step => [step.stepId, step.text])).toEqual([['step-1', 'T1'], ['step-2', `${boardWords.next}: T2`], ['step-3', `${boardWords.next}: to ${boardWords.mapPoint}`]])
      await screen.click({ kind: 'verb', verb: 'clear', id: 'u1' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.clear, input: { unitId: 'u1' }, result: { ok: true } })
      // Clear lets the highlight go; highlighted again, the asset offers no Clear.
      expect([stepsOf(run, 'u1'), row(screen, 'u1').chain, screen.view().selected]).toEqual([[], [], null])
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'recall'])
    })
  })

  test('a step skipped because its call closed raises its alert in the header strip and on the asset row, worded from the alert', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(6), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      await accepted(run, ids.queue, { unitId: 'u1', to: { taskId: 't2' } })
      const screen = await openScreen(run, createWall())
      await accepted(run, ids.taskClose, { taskId: 't2' })
      await runFor(run, 2_000, [screen])
      const alert = run.unit('u1').alerts.find(entry => entry.code === 'step_skipped')
      expect(alert?.message).toBe('Skipped T2 (closed)')
      expect(screen.view().alerts).toContainEqual(expect.objectContaining({ recordId: 'u1', label: 'U1', code: 'step_skipped', message: 'Skipped T2 (closed)' }))
      expect(row(screen, 'u1').alerts).toEqual(['Skipped T2 (closed)'])
      expect(row(screen, 'u1').chain.map(step => step.stepId)).toEqual(['step-1'])
    })
  })

  test('civil Halden: a call, then a chosen receiving site, delivers there and not at the nearest one', async () => {
    const items = [
      unitAt('c1', 'C1', carrier, at(0)), taskAt('k1', 'K1', kinds.templates.load, at(2), { [low]: 1 }),
      unitAt('near', 'NEAR', site, at(3)), unitAt('far', 'FAR', site, at(-6, 3)),
    ]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'c1' })
      await screen.click({ kind: 'row', list: 'work', id: 'k1' })
      await screen.click({ kind: 'offer' })
      await screen.click({ kind: 'verb', verb: 'add', id: 'c1' })
      await screen.mapTap('far')
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([
        [ids.send, { units: ['c1'], to: { taskId: 'k1' } }, true],
        [ids.queue, { unitId: 'c1', to: { siteId: 'far' } }, true],
      ])
      expect(run.unit('c1').orders.map(step => [step.kind, step.state])).toEqual([['serve', 'active'], ['deliver', 'queued']])
      expect(row(screen, 'c1').chain.map(step => step.text)).toEqual(['K1', `${boardWords.next}: deliver to FAR`])
      await runFor(run, 3_600_000, [screen])
      expect([run.unit('far').received, run.unit('near').received]).toEqual([{ [low]: 1 }, {}])
    })
  })

  test('supply-run: a place from the sites under Assets, then two requests from Calls, by taps, served in that order', async () => {
    const run = await openRun({ definition: supplyRun })
    try {
      // Past the cues that add the heavier vehicle and the second request.
      await runFor(run, 250_000)
      const objects = run.run.snapshot().objects
      const unitData = (id: string) => run.unit(id)
      const heavier = objects.find(object => object.packData !== undefined && (object.packData as { type?: string }).type === 'unit' && unitData(object.id).properties['payloadKg'] === 1000)!
      const place = objects.find(object => object.label === 'Brekke depot')!
      const [first, second] = ['R-1', 'R-2'].map(code => objects.find(object => object.label.startsWith(`${code} `))!) as [typeof place, typeof place]
      // The vehicle stands away from the place first.
      await accepted(run, ids.send, { units: [heavier.id], to: { point: pointAt([11.36, 59.1]) } })
      await runFor(run, 900_000)
      expect(run.unit(heavier.id).orders).toEqual([])
      const screen = await openScreen(run, createWall())
      // The place is listed under Assets, so it is a target by tap even where vehicles parked on it cover it on the map.
      expect(screen.view().unitBoard.sites.map(entry => entry.id)).toContain(place.id)
      await screen.click({ kind: 'row', list: 'units', id: heavier.id })
      await screen.click({ kind: 'site', id: place.id })
      for (const request of [first, second]) {
        await screen.click({ kind: 'verb', verb: 'add', id: heavier.id })
        await screen.click({ kind: 'row', list: 'work', id: request.id })
        expect(screen.view().commit.offer).toBe(`${boardWords.addToEnd}: ${heavier.label} here`)
        await screen.click({ kind: 'offer' })
      }
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([
        [ids.send, { units: [heavier.id], to: { siteId: place.id } }, true],
        [ids.queue, { unitId: heavier.id, to: { taskId: first.id } }, true],
        [ids.queue, { unitId: heavier.id, to: { taskId: second.id } }, true],
      ])
      expect(row(screen, heavier.id).chain.map(step => step.text)).toEqual([`to ${place.label}`, `${boardWords.next}: ${first.label}`, `${boardWords.next}: ${second.label}`])
      expect(workRow(screen, second.id).nextText).toBe(`${heavier.label} next, 2 steps ahead`)
      await runFor(run, 3_600_000, [screen])
      const [firstClosed, secondClosed] = [run.task(first.id).closedAtMs, run.task(second.id).closedAtMs]
      if (firstClosed === undefined || secondClosed === undefined) throw new Error('Both requests should be served by now')
      expect(firstClosed).toBeLessThan(secondClosed)
    } finally {
      await run.close()
    }
  })
})
