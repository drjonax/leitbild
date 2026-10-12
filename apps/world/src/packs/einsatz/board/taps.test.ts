import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, onObject, openScreen, pastGuardMs, pointAt, runFor, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { refusalCode } from '../refusal.ts'
import { boardWords } from './text.ts'

/**
 * Tap safety (A9: no accidental orders), against the real runtime on a
 * running clock: an asset tapped onto a Calls row that just moved under the
 * finger is not sent; a target the Board can tell is refused is not sent
 * either, and the asset stays highlighted; a refusal the engine gives
 * highlights the asset again; a row tap during a confirmation cancels it and
 * then acts.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, site } = kinds.types
const [top, , low] = kinds.classes as [string, string, string]
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}

describe('Board tap safety', () => {
  test('an asset tapped onto a Calls row that moved 120 ms before is not sent and stays highlighted; once the list stood still the same tap sends', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      // A more urgent call arrives and sorts above T1: the row the finger aimed at moves down.
      await accepted(run, ids.taskCreate, { template: kinds.templates.load, label: 'T2', at: pointAt(at(0.5)), loads: { [top]: 1 } })
      await screen.sync()
      expect(screen.view().workList.rows.map(row => row.id)).toEqual(['task:1', 't1'])
      await screen.wait(120)
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.calls.length, screen.view().feedback?.text, screen.view().selected]).toEqual([0, 'Not sent: the list changed', { kind: 'unit', id: 'u1' }])
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([[{ units: ['u1'], to: { taskId: 't1' } }, true]])
    })
  })

  test('an asset tapped onto a report, or onto a call it serves nothing of, is not sent, says why and stays highlighted, in Calls and on the map', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('p1', 'P1', pairServer, at(0, 1)), taskAt('r1', 'R1', kinds.templates.report, at(1)), taskAt('t1', 'T1', kinds.templates.load, at(2), { [low]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 'r1' })
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual(['R1 is a report: nothing to send', { kind: 'unit', id: 'u1' }])
      expect(screen.preview('u1', onObject('r1'))).toEqual({ text: 'R1 is a report: nothing to send', refused: true })
      await screen.click({ kind: 'row', list: 'units', id: 'p1' })
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      expect([screen.view().feedback?.text, screen.view().selected]).toEqual(['P1 provides nothing T1 needs', { kind: 'unit', id: 'p1' }])
      await screen.mapTap('t1')
      expect([screen.view().feedback?.text, screen.view().selected, screen.mapSelection()]).toEqual(['P1 provides nothing T1 needs', { kind: 'unit', id: 'p1' }, 'p1'])
      expect(screen.calls).toHaveLength(0)
    })
  })

  test('when the engine refuses an asset sent by a tap, the asset is highlighted again for another target', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(-1), { [top]: 1 })]
    await withScene(items, async run => {
      const wall = createWall()
      const mine = await openScreen(run, wall)
      const other = await openScreen(run, wall)
      await mine.click({ kind: 'row', list: 'units', id: 'u1' })
      // Another screen takes U1 before this one's tap; this screen has not seen it yet.
      mine.freeze(true)
      await other.click({ kind: 'row', list: 'work', id: 't2' })
      await other.click({ kind: 'commit' })
      await mine.click({ kind: 'row', list: 'work', id: 't1' })
      const refused = mine.calls.at(-1)!.result
      if (refused.ok) throw new Error('expected a refusal')
      expect(refusalCode(refused.reason)).toBe('unit_committed')
      expect([mine.view().feedback?.tone, mine.view().selected, mine.mapSelection()]).toEqual(['refused', { kind: 'unit', id: 'u1' }, 'u1'])
    })
  })

  test('a row tap during a busy asset\'s choice cancels the choice, then acts: a call row selects the call, an asset row highlights the asset', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(20), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(3), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.mapTap('top')
      expect(screen.view().commit.state).toBe('choice')
      await screen.click({ kind: 'row', list: 'work', id: 'low' })
      expect([screen.view().commit.state, screen.view().selected?.id, screen.view().feedback?.text]).toEqual(['none', 'low', 'Cancelled'])
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 'top' })
      expect(screen.view().commit.state).toBe('choice')
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect([screen.view().commit.state, screen.view().selected, screen.view().feedback?.text]).toEqual(['asset', { kind: 'unit', id: 'u1' }, 'Cancelled'])
      expect(screen.calls).toHaveLength(0)
    })
  })
})

describe('Board verbs and Undo say only what they do', () => {
  test('Stop is offered for every asset and Resume once it is paused; Clear while it holds steps; recall always', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'recall'])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'clear', 'recall'])
      await screen.click({ kind: 'verb', verb: 'hold', id: 'u2' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['resume', 'clear', 'recall'])
      expect(screen.view().unitBoard.rows.find(row => row.id === 'u2')?.pausedText).toBe(boardWords.paused)
      await screen.click({ kind: 'verb', verb: 'resume', id: 'u2' })
      expect(screen.calls.map(call => [call.capabilityId, call.result.ok])).toEqual([[ids.hold, true], [ids.resume, true]])
      expect(run.unit('u2').paused).toBeUndefined()
    })
  })

  test('a send of a free asset to a call, a site or open ground offers Undo, which removes the step the send created; a send that drops a step offers none', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), unitAt('h1', 'H1', site, at(1, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.mapTap('h1')
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u1'], to: { siteId: 'h1' } }, boardWords.undo])
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1' }, result: { ok: true } })
      expect(run.unit('u1').orders).toEqual([])
      await screen.mapTap('u2')
      await screen.groundTap(at(2, 2))
      await screen.click({ kind: 'move-here' })
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u2'], to: { point: pointAt(at(2, 2)) } }, boardWords.undo])
      // U2 now holds a step: a call tapped for it asks, and doing it now drops the move, so it offers no Undo.
      await screen.mapTap('u2')
      await screen.mapTap('t1')
      expect(screen.view().commit).toMatchObject({ state: 'choice', detail: 'U2 stops: to a map point' })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'option', option: 'do-now' })
      expect([screen.calls.at(-1)!.input, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([{ units: ['u2'], to: { taskId: 't1' } }, true, null])
    })
  })

  test('Undo is offered only where removing the step gives the asset back as it stood: not for one parked at a point, paused, or on its way home', async () => {
    const items = [
      unitAt('parked', 'PARKED', carrier, at(0)), unitAt('paused', 'PAUSED', carrier, at(0, 1)), unitAt('home', 'HOME', carrier, at(0, 2)),
      taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(5, 1), { [low]: 1 }), taskAt('t3', 'T3', kinds.templates.load, at(5, 2), { [low]: 1 }),
    ]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['parked'], to: { point: pointAt(at(0.5)) } })
      await accepted(run, ids.send, { units: ['home'], to: { point: pointAt(at(1, 2)) } })
      await accepted(run, ids.hold, { unitId: 'paused' })
      await runFor(run, 300_000)
      await accepted(run, ids.recall, { unitId: 'home' })
      expect([run.unit('parked').phase, run.unit('parked').orders, run.unit('paused').paused, run.unit('home').phase]).toEqual(['holding', [], true, 'returning'])
      const screen = await openScreen(run, createWall())
      for (const [unitId, taskId] of [['parked', 't1'], ['paused', 't2'], ['home', 't3']] as const) {
        await screen.mapTap(unitId)
        await screen.mapTap(taskId)
        // Free, so sent at once; undone, it would be sent home, resumed or made to idle, so Undo is not offered.
        expect([screen.calls.at(-1)!.input, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([{ units: [unitId], to: { taskId } }, true, null])
      }
    })
  })

  test('a step added behind an asset\'s steps, or while it is paused, keeps Undo, which leaves the asset as it stood', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      await accepted(run, ids.hold, { unitId: 'u1' })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'verb', verb: 'add', id: 'u1' })
      await screen.mapTap('t1')
      expect([screen.calls.at(-1)!.capabilityId, screen.calls.at(-1)!.result.ok, screen.view().undo]).toEqual([ids.queue, true, boardWords.undo])
      expect(run.unit('u1').orders.map(step => [step.id, step.state])).toEqual([['step-1', 'queued']])
      await screen.click({ kind: 'undo' })
      expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.stepRemove, input: { unitId: 'u1', stepId: 'step-1' }, result: { ok: true } })
      expect([run.unit('u1').orders, run.unit('u1').paused, run.unit('u1').atBase]).toEqual([[], true, true])
    })
  })
})
