import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, onObject, openScreen, pastGuardMs, runFor, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { assetsHoldMs } from './controller.ts'
import { alternativeRows } from './recommendations.ts'
import { boardWords } from './text.ts'
import { statusText } from './work-list.ts'

/**
 * What the third tap-only walkthrough of the four demos found on the Board:
 * a divert's confirmation went stale when a unit came free; a call with no
 * free unit offered no Add to end; Assets re-sorted under the finger; a
 * choice that offers only Add to end was titled as a divert; an undo of a
 * send of two named one; the proposed unit stood among the alternatives;
 * and a call a unit holds queued still said what it needs.
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

describe('Fixes from the third tap-only walkthrough', () => {
  test('a divert waiting for its Confirm follows the proposal: when a unit comes free the old divert can no longer be confirmed, and the line says why', async () => {
    const items = [
      unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(1)),
      taskAt('low', 'LOW', kinds.templates.load, at(20), { [low]: 1 }),
      taskAt('far', 'FAR', kinds.templates.load, at(30), { [top]: 1 }),
      taskAt('top', 'TOP', kinds.templates.load, at(3), { [top]: 1 }),
    ]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'far' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 'top' })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'commit' })
      expect(screen.view().commit).toMatchObject({ state: 'confirm', text: 'Divert U1 → TOP' })
      // U2 comes free while the divert waits for its Confirm.
      await accepted(run, ids.recall, { unitId: 'u2', fromTaskId: 'far' })
      await screen.sync()
      expect(screen.view().commit).toMatchObject({ state: 'ready', button: expect.stringContaining('U2') })
      expect(screen.view().feedback?.text).toBe('U2 is free now')
      // The old divert is gone: the commit, once the guard has run out, sends U2 and diverts nothing.
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'commit' })
      expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([[{ units: ['u2'], to: { taskId: 'top' } }, true]])
      expect(run.unit('u1').taskId).toBe('low')
    })
  })

  test('a call with no free unit offers a busy unit as Add to end, two taps from Calls, and then names it as next', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(4), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.wait(pastGuardMs)
      screen.resetActions()
      await screen.click({ kind: 'row', list: 'work', id: 't2' })
      const row = screen.view().workList.rows.find(entry => entry.id === 't2')!
      expect(row.statusText).toBe('No free unit · 1 busy')
      expect(screen.view().commit).toMatchObject({ state: 'ready', button: `${boardWords.addToEnd}: U1 → T2`, enabled: true })
      await screen.click({ kind: 'commit' })
      expect(screen.actions()).toBe(2)
      expect(screen.calls.map(call => [call.capabilityId, call.input, call.result.ok])).toEqual([[ids.queue, { unitId: 'u1', to: { taskId: 't2' } }, true]])
      await screen.sync()
      const queued = screen.view().workList.rows.find(entry => entry.id === 't2')!
      expect([queued.nextText, queued.statusText]).toEqual(['U1 next, 1 step ahead', null])
      // Held queued, the call offers no second Add to end.
      await screen.click({ kind: 'row', list: 'work', id: 't2' })
      expect(screen.view().commit.button).toBeNull()
    })
  })

  test('while an asset is highlighted, Assets keep their places when a unit comes free, and a site tapped right after Assets moved is offered, not sent', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(1)), unitAt('h1', 'H1', site, at(2)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(5), { [low]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      const order = () => screen.view().unitBoard.rows.map(row => row.id)
      // Free first.
      expect(order()).toEqual(['u2', 'u1'])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      await accepted(run, ids.recall, { unitId: 'u1', fromTaskId: 't1' })
      await screen.sync()
      expect(order()).toEqual(['u2', 'u1'])
      // Let go, Assets hold their places a moment after the tap, then sort again.
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect([screen.view().selected, order()]).toEqual([null, ['u2', 'u1']])
      await screen.wait(assetsHoldMs)
      expect(order()).toEqual(['u1', 'u2'])
      // A highlight that only lingers, with no tap since, holds them no longer than that.
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't2' } })
      await screen.sync()
      expect(order()).toEqual(['u2', 'u1'])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      await accepted(run, ids.recall, { unitId: 'u1', fromTaskId: 't2' })
      await screen.sync()
      expect(order()).toEqual(['u2', 'u1'])
      await screen.wait(assetsHoldMs)
      expect([screen.view().selected, order()]).toEqual([{ kind: 'unit', id: 'u2' }, ['u1', 'u2']])
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })

      // U2 highlighted, then Assets move without the operator (U1 takes a step): the site tap right after takes nothing for granted.
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't2' } })
      await screen.sync()
      await screen.click({ kind: 'site', id: 'h1' })
      expect(screen.calls).toHaveLength(0)
      expect(screen.view().feedback?.text).toBe('Not sent: the list changed')
      expect(screen.view().commit.offer).toContain('U2')
    })
  })

  test('a call a unit holds queued, that it would serve, is covered next: its button sends no second unit, and another can still be sent as an alternative', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(10)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(4), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 't2' })
      expect(screen.view().commit.button).toContain('U2')
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 't2' })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'option', option: 'add-to-end' })
      await screen.sync()
      expect(run.unit('u1').orders.map(step => step.target)).toEqual([{ taskId: 't1' }, { taskId: 't2' }])
      expect(screen.view().commit).toMatchObject({ state: 'none', text: `${boardWords.coveredNext} U1 · ${boardWords.orSendNow}`, button: null })
      const selected = screen.view().selected
      expect(selected?.kind === 'task' ? selected.alternatives.map(entry => entry.label) : []).toContain('U2')
    })
  })

  test('Add to end offered from a call with no free unit passes over a paused unit for one that is not', async () => {
    const items = [unitAt('p1', 'P1', pairServer, at(0)), unitAt('p2', 'P2', pairServer, at(0, 0.5)), taskAt('o1', 'O1', kinds.templates.single, at(0.2)), taskAt('o2', 'O2', kinds.templates.single, at(0.2, 0.5)), taskAt('o3', 'O3', kinds.templates.single, at(3))]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['p1'], to: { taskId: 'o1' } })
      await accepted(run, ids.send, { units: ['p2'], to: { taskId: 'o2' } })
      const screen = await openScreen(run, createWall())
      for (let step = 0; step < 40 && (run.unit('p1').phase !== 'on-task' || run.unit('p2').phase !== 'on-task'); step++) await runFor(run, 15_000, [screen])
      expect([run.unit('p1').phase, run.unit('p2').phase]).toEqual(['on-task', 'on-task'])
      await accepted(run, ids.hold, { unitId: 'p1' })
      await screen.sync()
      expect(run.unit('p1').paused).toBe(true)
      await screen.click({ kind: 'row', list: 'work', id: 'o3' })
      expect(screen.view().commit.button).toBe(`${boardWords.addToEnd}: P2 → O3`)
    })
  })

  test('Undo ends once the Run has moved on past it, as in a fast-forward, and while it stands the status line keeps saying what it undoes', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(1)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'units', id: 'u1' })
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      await screen.sync()
      expect(screen.view().undo).toBe(boardWords.undo)
      const sent = screen.view().feedback
      expect(sent).toMatchObject({ tone: 'done', text: expect.stringContaining('U1') })
      // A tap lets the line's last words go, but while Undo stands the line says what it undoes.
      await screen.click({ kind: 'row', list: 'units', id: 'u2' })
      expect(screen.view().feedback).toEqual(sent)
      // The Run moves on 10 s while no wall time passes: Undo is over.
      await runFor(run, 10_000, [screen])
      expect([screen.view().undo, screen.view().feedback]).toEqual([null, null])
    })
  })

  test('the header strip keeps an alert three minutes of Run time; its row keeps it after that', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(30), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      await accepted(run, ids.recall, { unitId: 'u1', fromTaskId: 't1' })
      await screen.sync()
      expect(screen.view().alerts.map(alert => alert.recordId)).toContain('t1')
      await runFor(run, 3 * 60_000, [screen])
      expect(screen.view().alerts.map(alert => alert.recordId)).not.toContain('t1')
      expect(screen.view().workList.rows.find(row => row.id === 't1')?.alerts).toHaveLength(1)
    })
  })

  test('a unit on scene offered only Add to end is titled by Add to end, not by a divert it cannot do', async () => {
    const items = [unitAt('p1', 'P1', pairServer, at(0)), taskAt('o1', 'O1', kinds.templates.single, at(0.2)), taskAt('o2', 'O2', kinds.templates.single, at(3))]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['p1'], to: { taskId: 'o1' } })
      const screen = await openScreen(run, createWall())
      for (let step = 0; step < 40 && run.unit('p1').phase !== 'on-task'; step++) await runFor(run, 15_000, [screen])
      expect(run.unit('p1').phase).toBe('on-task')
      await screen.click({ kind: 'row', list: 'units', id: 'p1' })
      await screen.mapTarget('p1', onObject('o2'))
      expect(screen.view().commit).toMatchObject({ state: 'choice', text: `${boardWords.addToEnd}: P1 → O2`, options: [{ option: 'add-to-end', label: boardWords.addToEnd }] })
    })
  })

  test('an undo of a send of two names both units', async () => {
    const items = [unitAt('p1', 'P1', pairServer, at(0)), unitAt('p2', 'P2', pairServer, at(0, 0.5)), taskAt('o1', 'O1', kinds.templates.pair, at(3))]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 'o1' })
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'commit' })
      expect(screen.view().undo).toBe(boardWords.undo)
      await screen.click({ kind: 'undo' })
      expect(screen.calls.slice(1).map(call => [call.capabilityId, call.result.ok])).toEqual([[ids.stepRemove, true], [ids.stepRemove, true]])
      expect(screen.view().feedback?.text).toBe(`✓ ${boardWords.undo} · P1 + P2`)
    })
  })
})

describe('Words that the third walkthrough found wrong', () => {
  const eta = { kind: 'straight-line', seconds: 120, distanceM: 1_000 } as const
  const answer = (overrides: Partial<Recommendation>): Recommendation => ({
    taskId: 't1',
    rank: { id: top, code: 'P1' },
    need: { id: top, code: 'P1' },
    proposal: { units: [], covers: false, remainder: [] },
    alternatives: [],
    ineligible: [],
    committed: [],
    next: [],
    servable: true,
    ...overrides,
  })

  test('a unit the proposal now sends is no longer one of the alternatives, unless the operator chose it by its number', () => {
    const shown = answer({ proposal: { units: [{ unitId: 'u1', label: 'U1', eta }], covers: true, remainder: [] }, alternatives: [{ unitId: 'u2', label: 'U2', eta }] })
    const numbered = [{ unitId: 'u1', label: 'U1' }, { unitId: 'u2', label: 'U2' }]
    expect(alternativeRows(shown, numbered, null).map(row => row.label)).toEqual(['U2'])
    expect(alternativeRows(shown, numbered, 1).map(row => row.label)).toEqual(['U1', 'U2'])
  })

  test('a call a unit holds queued names it as next, never a remainder beside it', () => {
    const partial = { units: [{ unitId: 'u1', label: 'U1', eta }], covers: false, remainder: ['1 more server'] }
    expect(statusText(answer({ proposal: partial }), () => true, () => true)).toBe('still needs 1 more server')
    expect(statusText(answer({ proposal: partial, next: [{ unitId: 'u2', label: 'U2', stepId: 'step-2', stepsAhead: 0 }] }), () => true, () => true)).toBeNull()
  })
})
