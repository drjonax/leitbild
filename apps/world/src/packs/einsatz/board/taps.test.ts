import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, onObject, openScreen, pastGuardMs, pointAt, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { openModeViewer } from '../picture.ts'
import { refusalCode } from '../refusal.ts'
import { sendFromMap, undoCalls } from './calls.ts'
import { readBoardRecords } from './records.ts'
import { createBoardRules } from './rules.ts'
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
  test('Hold is offered for a free asset only; a committed one offers its recall alone', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['hold', 'recall'])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect(screen.view().commit.verbs.map(entry => entry.verb)).toEqual(['recall'])
    })
  })

  test('a send to a call offers Undo; a send to a site or to open ground does not, nor would a send of a loaded unit or of one holding queued steps', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), unitAt('h1', 'H1', site, at(1, 1)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapTap('u1')
      await screen.mapTap('h1')
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u1'], to: { siteId: 'h1' } }, null])
      await screen.mapTap('u2')
      await screen.groundTap(at(2, 2))
      await screen.click({ kind: 'move-here' })
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u2'], to: { point: pointAt(at(2, 2)) } }, null])
      await screen.mapTap('u2')
      await screen.mapTap('t1')
      expect([screen.calls.at(-1)!.input, screen.view().undo]).toEqual([{ units: ['u2'], to: { taskId: 't1' } }, boardWords.undo])
      expect(screen.calls.every(call => call.result.ok)).toBe(true)

      // A recall refuses a loaded unit, so its send has no Undo.
      const rules = createBoardRules(civilConfig, openModeViewer, () => [])
      const records = readBoardRecords(run.run.snapshot().objects)
      const u1 = records.units.get('u1')!
      const loaded = { ...records, units: new Map([...records.units, ['u1', { ...u1, load: { [low]: 1 } }]]) }
      const send = sendFromMap(rules, loaded, loaded.units.get('u1')!, { taskId: 't1' })
      expect(undoCalls(rules, loaded, send)).toBeNull()
      // A recall clears a unit's whole job chain, so a send of one holding queued steps has no Undo either.
      const chained = { ...records, units: new Map([...records.units, ['u1', { ...u1, orders: [{ id: 'step-9', kind: 'serve' as const, target: { taskId: 't1' }, state: 'queued' as const, by: 'Dispatcher' }] }]]) }
      expect(undoCalls(rules, chained, sendFromMap(rules, chained, chained.units.get('u1')!, { taskId: 't1' }))).toBeNull()
      expect(() => undoCalls(rules, { ...records, units: new Map() }, send)).toThrow('The Board sent u1, which is not in its picture')
    })
  })
})
