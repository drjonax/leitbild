import { describe, expect, test } from 'bun:test'
import type { ObjectId } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, onGround, onObject, openScreen, pastGuardMs, pointAt, runFor, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { isoAt, openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { refusalCode } from '../refusal.ts'
import { clockText } from './text.ts'
import type { BoardEffect } from './types.ts'

/**
 * Board behaviour against the real Einsatz runtime on a running clock, by
 * keyboard and by pointer. Scenes use the civil configuration; types,
 * templates and classes are found by their components, never by name.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, conditionedServer } = kinds.types
const [top, middle, low] = kinds.classes as [string, string, string]
const word = (key: keyof NonNullable<typeof civilConfig.lexicon>) => civilConfig.lexicon[key]!
const code = (classId: string) => civilConfig.loadClasses.find(entry => entry.id === classId)!.code

/** A point east and north of the scene's origin, in kilometres. */
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]
const modalities = ['keys', 'pointer'] as const
type Modality = typeof modalities[number]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
const createTask = (run: OpenRun, template: string, label: string, position: readonly [number, number], loads?: Record<string, number>) =>
  accepted(run, ids.taskCreate, { template, label, at: pointAt(position), ...(loads === undefined ? {} : { loads }) })
const lastCall = (screen: Screen) => screen.calls.at(-1)
const invokes = (effects: ReadonlyArray<BoardEffect>) => effects.filter(effect => effect.kind === 'invoke')

/** Selects a work row: N for the most urgent unserved row, or a click on it. */
const selectRow = async (screen: Screen, modality: Modality, taskId: string): Promise<void> => {
  if (modality === 'pointer') return await screen.click({ kind: 'row', list: 'work', id: taskId })
  await screen.key('n')
  for (let step = 0; step < 20 && screen.view().selected?.id !== taskId; step++) await screen.key('ArrowDown')
}
const commit = async (screen: Screen, modality: Modality): Promise<void> =>
  modality === 'keys' ? await screen.key('Enter') : await screen.click({ kind: 'commit' })

describe('Board race, repeat, focus and timing', () => {
  for (const modality of modalities) {
    test(`a top-priority task arriving between select and commit does not change what commits (${modality})`, async () => {
      await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(5)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
        const screen = await openScreen(run, createWall())
        await selectRow(screen, modality, 't1')
        const shown = screen.view().commit.text
        expect(shown).toStartWith(`${word('send')} U1 → T1 · `)
        await createTask(run, kinds.templates.load, 'T2', at(0.5), { [top]: 1 })
        await screen.sync()
        expect(screen.view().workList.rows.map(row => row.id)).toEqual(['task:1', 't1'])
        expect(screen.view().commit).toMatchObject({ text: shown, enabled: true })
        await commit(screen, modality)
        expect(lastCall(screen)).toMatchObject({ input: { units: ['u1'], to: { taskId: 't1' } }, result: { ok: true } })
      })
    })
  }

  test('Enter, then a click on the focused commit control and Enter again, commit once', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      // A held Enter reaches the Board once: the World key router swallows its repeats (tests/panel-key-router.test.ts).
      const first = screen.raw({ kind: 'key', key: 'Enter', code: 'Enter', shift: false })
      const clicked = invokes(screen.raw({ kind: 'click', target: { kind: 'commit' } }))
      const again = invokes(screen.raw({ kind: 'key', key: 'Enter', code: 'Enter', shift: false }))
      expect([invokes(first).length, clicked, again]).toEqual([1, [], []])
      expect(screen.view().commit).toMatchObject({ state: 'sending', enabled: false })
      await screen.perform(first)
      await screen.sync()
      await screen.key('Enter')
      expect(screen.calls.map(call => call.result.ok)).toEqual([true])
    })
  })

  for (const modality of modalities) {
    test(`commits at 300 and 450 ms after a commit wait for the guard; at 700 ms one acts (${modality})`, async () => {
      const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(0, 1)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(1, 1), { [middle]: 1 })]
      await withScene(items, async run => {
        const screen = await openScreen(run, createWall())
        await selectRow(screen, modality, 't1')
        await commit(screen, modality)
        const next = screen.view()
        expect(next.selected?.id).toBe('t2')
        expect(next.commit).toMatchObject({ state: 'ready', enabled: false, hint: 'Confirm next: T2' })
        for (const delay of [300, 150]) {
          await screen.wait(delay)
          await commit(screen, modality)
          expect(screen.calls).toHaveLength(1)
          expect(screen.view().feedback?.text).toBe('Not sent: the list changed · Confirm next: T2')
        }
        await screen.wait(250)
        await commit(screen, modality)
        expect(screen.calls.map(call => [call.input, call.result.ok])).toEqual([
          [{ units: ['u1'], to: { taskId: 't1' } }, true],
          [{ units: ['u2'], to: { taskId: 't2' } }, true],
        ])
      })
    })
  }

  for (const modality of modalities) {
    test(`moving to a row, or choosing an alternative, then committing 120 ms later commits exactly what is shown (${modality})`, async () => {
      const items = [
        unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(2)), unitAt('u3', 'U3', carrier, at(4)),
        taskAt('t1', 'T1', kinds.templates.load, at(0.5), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(2.5), { [middle]: 1 }),
      ]
      await withScene(items, async run => {
        const screen = await openScreen(run, createWall())
        await selectRow(screen, modality, 't1')
        await screen.wait(pastGuardMs)
        if (modality === 'keys') await screen.key('ArrowDown')
        else await screen.click({ kind: 'row', list: 'work', id: 't2' })
        const shown = screen.view().commit.text
        await screen.wait(120)
        await commit(screen, modality)
        expect(shown).toStartWith(`${word('send')} U2 → T2`)
        expect(lastCall(screen)).toMatchObject({ input: { units: ['u2'], to: { taskId: 't2' } }, result: { ok: true } })

        await createTask(run, kinds.templates.load, 'T3', at(1), { [low]: 1 })
        await screen.sync()
        await screen.wait(pastGuardMs)
        await selectRow(screen, modality, 'task:1')
        const second = screen.view().selected
        if (second?.kind !== 'task') throw new Error('expected a task row')
        expect(second.alternatives.map(row => row.label)).toEqual(['U3'])
        if (modality === 'keys') {
          await screen.key('1')
          const chosen = screen.view().commit.text
          await screen.wait(120)
          await commit(screen, modality)
          expect(chosen).toStartWith(`${word('send')} U3 → T3`)
        } else {
          // A tap on an alternative sends it at once.
          await screen.click({ kind: 'alternative', number: 1 })
        }
        expect(lastCall(screen)).toMatchObject({ input: { units: ['u3'], to: { taskId: 'task:1' } }, result: { ok: true } })
      })
    })
  }

  test('a map double-click on the same task sends once and says the unit is already on its way', async () => {
    await withScene([unitAt('p1', 'P1', pairServer, at(0)), taskAt('t1', 'T1', kinds.templates.single, at(2))], async run => {
      const screen = await openScreen(run, createWall())
      await screen.mapSelect('p1')
      const first = screen.raw({ kind: 'map-target', controllerId: 'p1' as ObjectId, target: onObject('t1') })
      const second = screen.raw({ kind: 'map-target', controllerId: 'p1' as ObjectId, target: onObject('t1') })
      expect([invokes(first).length, invokes(second).length]).toEqual([1, 0])
      expect(screen.view().feedback?.text).toBe('P1 already en route to T1')
      await screen.perform(first)
      await screen.sync()
      await screen.mapTarget('p1', onObject('t1'))
      expect(screen.view().feedback?.text).toBe('P1 already en route to T1')
      expect(screen.calls).toHaveLength(1)
    })
  })
})

describe('Board keys after the map', () => {
  test('a unit selected on the map halts with H', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { point: pointAt(at(5)) } })
      const screen = await openScreen(run, createWall())
      await screen.mapSelect('u1')
      expect(screen.view().selected).toEqual({ kind: 'unit', id: 'u1' })
      await screen.key('h')
      expect(lastCall(screen)).toMatchObject({ capabilityId: ids.hold, input: { unitId: 'u1' }, result: { ok: true } })
      expect(run.unit('u1').phase).toBe('holding')
    })
  })

  test('a busy unit sent by map tap waits for its choice, which Enter gives as Do now', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(20), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(3), { [top]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      const screen = await openScreen(run, createWall())
      await screen.mapSelect('u1')
      await screen.mapTarget('u1', onObject('top'))
      expect(screen.calls).toHaveLength(0)
      expect(screen.view().selected?.id).toBe('top')
      expect(screen.view().commit).toMatchObject({
        state: 'choice',
        text: 'Divert U1 → TOP',
        detail: `LOW (${code(low)}) · 1 ${civilConfig.loadClasses[2]!.noun.one} returns to the queue`,
        options: [{ option: 'do-now', label: 'Do now' }, { option: 'add-to-end', label: 'Add to end' }],
        enabled: false,
      })
      await screen.mapSelect('top')
      expect(screen.view().feedback).toBeNull()
      await screen.mapSelect('low')
      expect(screen.view().feedback?.text).toBe('Confirm or cancel first')
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      expect(lastCall(screen)).toMatchObject({ input: { units: ['u1'], to: { taskId: 'top' }, divert: [{ unitId: 'u1', fromTaskId: 'low' }] }, result: { ok: true } })
    })
  })

  test('N and Home select the most urgent unserved row; [ ] and F6 switch between work list and unit board', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(2), { [top]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      for (const key of ['n', 'Home']) {
        await screen.key('ArrowDown')
        await screen.key(key)
        expect([screen.view().focus, screen.view().selected?.id]).toEqual(['work', 't2'])
      }
      for (const [key, focus, selected] of [[']', 'units', 'u1'], ['[', 'work', 't2'], ['F6', 'units', 'u1'], ['F6', 'work', 't2']] as const) {
        await screen.key(key)
        expect([screen.view().focus, screen.view().selected?.id]).toEqual([focus, selected])
      }
      await screen.key('ArrowDown')
      expect(screen.view().selected?.id).toBe('t1')
    })
  })
})

describe('Board competition', () => {
  test('with 15 units moving, a commit on an unchanged shown set acts, and motion asks for no new recommendation', async () => {
    const fleet = Array.from({ length: 15 }, (_, index) => unitAt(`u${index + 1}`, `U${index + 1}`, carrier, at(index, 1)))
    await withScene([...fleet, taskAt('t1', 'T1', kinds.templates.load, at(0.5, 0), { [middle]: 1 })], async run => {
      for (let index = 2; index <= 15; index++) await accepted(run, ids.send, { units: [`u${index}`], to: { point: pointAt(at(index, 30)) } })
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      const shown = screen.view().commit.text
      const queries = screen.queries()
      for (let second = 0; second < 6; second++) await runFor(run, 1_000, [screen])
      expect(run.object('u15')?.spatial.position?.point).not.toEqual(pointAt(at(15, 1)))
      expect([screen.view().commit.text, screen.queries()]).toEqual([shown, queries])
      await screen.key('Enter')
      // The proposed unit is on its move, so the commit asks Do now or Add to end first; Enter is Do now.
      expect(screen.view().commit.state).toBe('choice')
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      const sent = lastCall(screen)!
      expect(sent).toMatchObject({ input: { to: { taskId: 't1' } }, result: { ok: true } })
      expect(shown).toStartWith(`${word('send')} ${(sent.input as { units: string[] }).units.map(id => id.toUpperCase()).join(' + ')} → T1`)
    })
  })

  for (const modality of modalities) {
    test(`another screen taking the shown unit first gets this screen unit_committed, worded as the unit stands (${modality})`, async () => {
      const items = [unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(30)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(-1), { [middle]: 1 })]
      await withScene(items, async run => {
        const wall = createWall()
        const mine = await openScreen(run, wall)
        const other = await openScreen(run, wall)
        await selectRow(mine, modality, 't1')
        expect(mine.view().commit.text).toStartWith(`${word('send')} U1 → T1`)
        mine.freeze(true)
        await other.click({ kind: 'row', list: 'work', id: 't2' })
        await other.click({ kind: 'commit' })
        await commit(mine, modality)
        const refused = lastCall(mine)!.result
        if (refused.ok) throw new Error('expected a refusal')
        expect(refusalCode(refused.reason)).toBe('unit_committed')
        expect(mine.view().feedback).toEqual({ text: '✗ U1 now mobilizing to T2', tone: 'refused' })
        expect(other.view().feedback).toEqual({ text: `✓ ${word('send')} U1 → T2`, tone: 'done' })
      })
    })
  }

  test('a competing re-task before a divert confirm gets the confirm refused and leaves the task the unit left untouched', async () => {
    const items = [unitAt('u2', 'U2', carrier, at(0)), taskAt('c9', 'C9', kinds.templates.load, at(25), { [low]: 1 }), taskAt('c17', 'C17', kinds.templates.load, at(2), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'c9' } })
      const wall = createWall()
      const mine = await openScreen(run, wall)
      const other = await openScreen(run, wall)
      await mine.key('n')
      await mine.key('Enter')
      expect(mine.view().commit.state).toBe('confirm')
      mine.freeze(true)
      await createTask(run, kinds.templates.load, 'C20', at(-2), { [middle]: 1 })
      await other.sync()
      await other.click({ kind: 'row', list: 'work', id: 'task:1' })
      await other.click({ kind: 'commit' })
      await other.wait(pastGuardMs)
      await other.click({ kind: 'commit' })
      expect(lastCall(other)).toMatchObject({ input: { divert: [{ unitId: 'u2', fromTaskId: 'c9' }] }, result: { ok: true } })
      const c9 = run.object('c9')
      await mine.key('Enter')
      const refused = lastCall(mine)!.result
      if (refused.ok) throw new Error('expected a refusal')
      expect(refusalCode(refused.reason)).toBe('unit_committed')
      expect(run.object('c9')).toEqual(c9)
    })
  })
})

describe('Board divert protection', () => {
  /**
   * A1 on its way to a covered top task; A2 to a middle task (C9); A3 on task
   * at a low task; A4 on its way to C20, top covered by A4 and low still
   * waiting; A6 on its way to a low task.
   */
  const protectionScene = (extra: ReadonlyArray<Record<string, unknown>> = []) => [
    unitAt('a1', 'A1', carrier, at(0, 2)), unitAt('a2', 'A2', carrier, at(0, -1)), unitAt('a3', 'A3', carrier, at(10)),
    unitAt('a4', 'A4', carrier, at(0, 4)), unitAt('a6', 'A6', carrier, at(0, -3)),
    unitAt('p1', 'P1', pairServer, at(-20, 10)), unitAt('p2', 'P2', pairServer, at(-20, 11)),
    taskAt('t1', 'T1', kinds.templates.load, at(-30, 2), { [top]: 1 }),
    taskAt('c9', 'C9', kinds.templates.load, at(-30, -1), { [middle]: 1 }),
    taskAt('t3', 'T3', kinds.templates.load, at(10.05), { [low]: 1 }),
    taskAt('c20', 'C20', kinds.templates.load, at(-30, 4), { [top]: 1, [low]: 1 }),
    taskAt('t6', 'T6', kinds.templates.load, at(-30, -3), { [low]: 1 }),
    ...extra,
  ]
  const commitScene = async (run: OpenRun): Promise<void> => {
    for (const [unit, task] of [['a1', 't1'], ['a2', 'c9'], ['a3', 't3'], ['a4', 'c20'], ['a6', 't6']]) await accepted(run, ids.send, { units: [unit], to: { taskId: task } })
    await runFor(run, 70_000)
    expect(['a1', 'a2', 'a3', 'a4', 'a6'].map(id => run.unit(id).phase)).toEqual(['en-route', 'en-route', 'on-task', 'en-route', 'en-route'])
  }
  const offered = (screen: Screen): string[] => {
    const selected = screen.view().selected
    if (selected?.kind !== 'task') throw new Error('expected a task row')
    return [...selected.proposal, ...selected.alternatives].map(entry => entry.label).sort()
  }

  test('diverts take only units on their way to strictly lower work; the row says when every unit is busy; a divert takes 3 actions and returns the work with its age', async () => {
    await withScene(protectionScene(), async run => {
      await commitScene(run)
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      const c20 = screen.view().workList.rows.find(row => row.id === 'c20')!
      expect(screen.view().selected?.id).toBe('c20')
      expect([c20.code, c20.needText, c20.statusText]).toEqual([code(top), `needs ${code(low)}×1`, 'No free unit · 4 busy'])
      expect(offered(screen)).toEqual([])

      await createTask(run, kinds.templates.load, 'NEW2', at(0, -2), { [middle]: 1 })
      await screen.sync()
      await screen.click({ kind: 'row', list: 'work', id: 'task:1' })
      expect(offered(screen)).toEqual(['A6'])

      await createTask(run, kinds.templates.load, 'NEW1', at(0, -1.5), { [top]: 1 })
      await screen.sync()
      await screen.click({ kind: 'row', list: 'work', id: 'task:2' })
      expect(offered(screen)).toEqual(['A2', 'A6'])

      await createTask(run, kinds.templates.pair, 'ORDER', at(0, 1))
      await screen.sync()
      const unserved = screen.view().workList.rows.filter(row => !row.served).map(row => row.label)
      expect(unserved).toEqual(['NEW1', 'NEW2', 'ORDER', 'C20'])

      const c9Created = run.task('c9').createdAtMs
      await screen.wait(pastGuardMs)
      screen.resetActions()
      await screen.key('n')
      await screen.key('Enter')
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      expect(screen.actions()).toBe(3)
      expect(lastCall(screen)).toMatchObject({ input: { units: ['a2'], to: { taskId: 'task:2' }, divert: [{ unitId: 'a2', fromTaskId: 'c9' }] }, result: { ok: true } })
      const c9 = screen.view().workList.rows.find(row => row.id === 'c9')!
      expect(c9.served).toBe(false)
      expect(run.task('c9').createdAtMs).toBe(c9Created)
      expect(c9.ageText).toBe(clockText((run.nowMs() - c9Created) / 1_000))
      expect(c9.alerts).toEqual([`A2 released from C9 · 1 ${civilConfig.loadClasses[1]!.noun.one} waiting`])
    })
  })

  test('with a free unit covering the top load, the low remainder takes no divert', async () => {
    await withScene(protectionScene([unitAt('a5', 'A5', carrier, at(5, -1))]), async run => {
      await commitScene(run)
      await createTask(run, kinds.templates.load, 'MIXED', at(0, -1.2), { [top]: 1, [low]: 1 })
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      const row = screen.view().workList.rows.find(entry => entry.label === 'MIXED')!
      expect(screen.view().selected?.id).toBe(row.id)
      expect(row.statusText).toBe(`still needs ${code(low)}×1`)
      expect(offered(screen)).toEqual(['A5'])
    })
  })
})

describe('Board release and move', () => {
  for (const modality of modalities) {
    test(`a committed unit moved to a point asks what to do, and its task reopens; H then pauses it (${modality})`, async () => {
      await withScene([unitAt('e1', 'E1', conditionedServer, at(0)), taskAt('f1', 'F1', kinds.templates.conditioned, at(8))], async run => {
        await accepted(run, ids.send, { units: ['e1'], to: { taskId: 'f1' } })
        await runFor(run, 61_000)
        const screen = await openScreen(run, createWall())
        if (modality === 'keys') {
          await screen.key(']')
          await screen.key('m')
          await screen.mapTarget('e1', onGround(at(1, 1)))
        } else {
          // A tap on open ground with the asset highlighted asks "Move here" at the point; panning never moves it.
          await screen.click({ kind: 'row', list: 'units', id: 'e1' })
          await screen.groundTap(at(1, 1))
          expect(screen.view().mapPrompt).toMatchObject({ unitId: 'e1', label: `${civilConfig.lexicon.move ?? 'Move'} E1 here` })
          expect(screen.calls).toHaveLength(0)
          await screen.click({ kind: 'move-here' })
        }
        expect(screen.view().commit).toMatchObject({ state: 'choice', text: 'Move E1 → the map point', detail: `F1 (${code(top)}) loses E1` })
        expect(screen.view().mapPrompt).toBeNull()
        await screen.wait(pastGuardMs)
        if (modality === 'keys') await screen.key('Enter')
        else await screen.click({ kind: 'option', option: 'do-now' })
        expect(lastCall(screen)).toMatchObject({ input: { units: ['e1'], divert: [{ unitId: 'e1', fromTaskId: 'f1' }] }, result: { ok: true } })
        const reopened = screen.view().workList.rows.find(row => row.id === 'f1')!
        expect([reopened.served, reopened.coverageText]).toEqual([false, `needs 1 more ${civilConfig.taskTemplates.find(entry => entry.id === kinds.templates.conditioned)!.requires[0]!.label.one}`])

        if (modality === 'keys') await screen.key('h')
        else await screen.click({ kind: 'verb', verb: 'hold', id: 'e1' })
        expect(lastCall(screen)).toMatchObject({ capabilityId: ids.hold, input: { unitId: 'e1' }, result: { ok: true } })
      })
    })
  }
})

describe('Board modal, blur and burst', () => {
  for (const modality of modalities) {
    test(`after blur no key commits but a tap does; back in focus an unchanged commitment commits at once (${modality})`, async () => {
      await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
        const screen = await openScreen(run, createWall())
        await screen.key('n')
        const shown = screen.view().commit
        await screen.focus(false)
        expect([screen.view().keysActive, screen.view().commit]).toEqual([false, shown])
        if (modality === 'keys') {
          await screen.key('Enter')
          expect(screen.calls.length).toBe(0)
          await screen.focus(true)
          expect(screen.view().commit).toMatchObject({ text: shown.text, enabled: true, hint: null })
        }
        // A tap acts whether or not the keyboard reaches the World.
        await commit(screen, modality)
        expect(lastCall(screen)).toMatchObject({ input: { units: ['u1'], to: { taskId: 't1' } }, result: { ok: true } })
      })
    })

    test(`a commitment that changed while keys were inactive is guarded once focus returns (${modality})`, async () => {
      const items = [
        unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)),
        taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(-1), { [low]: 1 }),
      ]
      await withScene(items, async run => {
        const wall = createWall()
        const screen = await openScreen(run, wall)
        const other = await openScreen(run, wall)
        await screen.click({ kind: 'row', list: 'work', id: 't1' })
        expect(screen.view().commit.text).toStartWith(`${word('send')} U1 → T1`)
        await screen.focus(false)
        await other.click({ kind: 'row', list: 'work', id: 't2' })
        await other.click({ kind: 'commit' })
        expect(lastCall(other)).toMatchObject({ input: { units: ['u1'], to: { taskId: 't2' } }, result: { ok: true } })
        await screen.sync()
        await screen.wait(pastGuardMs)
        await screen.focus(true)
        expect(screen.view().commit).toMatchObject({ enabled: false, hint: 'Confirm next: T1' })
        expect(screen.view().commit.text).toStartWith(`${word('send')} U2 → T1`)
        await commit(screen, modality)
        expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'Not sent: the list changed · Confirm next: T1'])
        await screen.wait(pastGuardMs)
        await commit(screen, modality)
        expect(lastCall(screen)).toMatchObject({ input: { units: ['u2'], to: { taskId: 't1' } }, result: { ok: true } })
      })
    })
  }

  test('five tasks in 90 s, each dispatched as it appears: every send goes where its row showed, none refused', async () => {
    const fleet = Array.from({ length: 6 }, (_, index) => unitAt(`u${index + 1}`, `U${index + 1}`, carrier, at(index * 3)))
    await withScene(fleet, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'enable-sound' })
      const shownBySend: Array<{ readonly text: string; readonly taskId: string }> = []
      for (let index = 0; index < 5; index++) {
        await createTask(run, kinds.templates.load, `B${index + 1}`, at(index * 3 + 0.5), { [[top, middle, low][index % 3]!]: 1 })
        await runFor(run, 18_000, [screen])
        await screen.wait(pastGuardMs)
        await screen.key('n')
        const selected = screen.view().selected!.id
        shownBySend.push({ text: screen.view().commit.text, taskId: selected })
        await screen.key('Enter')
      }
      expect(screen.sounds()).toBe(5)
      expect(screen.calls).toHaveLength(5)
      screen.calls.forEach((call, index) => {
        const input = call.input as { units: string[]; to: { taskId: string } }
        expect(call.result.ok).toBe(true)
        expect(input.to.taskId).toBe(shownBySend[index]!.taskId)
        expect(shownBySend[index]!.text).toStartWith(`${word('send')} ${input.units.map(id => id.toUpperCase()).join(' + ')} → B${index + 1}`)
      })
      expect(new Set(screen.calls.flatMap(call => (call.input as { units: string[] }).units)).size).toBe(5)
    })
  })
})

describe('Board recommendation stability, selection and wording', () => {
  test('numbered alternatives stay put while the row is selected; one that drops out is no longer shown, and its digit says why, naming the unit once', async () => {
    const items = [
      unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)), unitAt('u3', 'U3', carrier, at(5)),
      taskAt('t1', 'T1', kinds.templates.load, at(1), { [top]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(3.2), { [low]: 1 }),
    ]
    await withScene(items, async run => {
      const wall = createWall()
      const mine = await openScreen(run, wall)
      const other = await openScreen(run, wall)
      await mine.key('n')
      const numbered = () => {
        const selected = mine.view().selected
        if (selected?.kind !== 'task') throw new Error('expected a task row')
        return selected.alternatives.map(entry => [entry.number, entry.label])
      }
      expect(numbered()).toEqual([[1, 'U2'], [2, 'U3']])
      await other.click({ kind: 'row', list: 'work', id: 't2' })
      await other.click({ kind: 'commit' })
      await mine.sync()
      expect(numbered()).toEqual([[2, 'U3']])
      const shown = mine.view().commit
      await mine.key('1')
      expect(mine.view().feedback?.text).toBe('U2 now mobilizing to T2')
      expect(mine.view().commit).toEqual(shown)
      await mine.key('2')
      expect(mine.view().commit.text).toStartWith(`${word('send')} U3 → T1`)
      await mine.key('Escape')
      expect(mine.view().commit).toEqual(shown)
    })
  })

  test('Enter before the recommendation arrives says "Preparing…" and sends nothing; once nothing waits the served row is let go', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await createTask(run, kinds.templates.load, 'T1', at(1), { [low]: 1 })
      const asked = screen.raw({ kind: 'snapshot', objects: run.run.snapshot().objects, currentTime: isoAt(run.nowMs()) })
      expect(asked).toEqual([{ kind: 'recommend', taskId: 'task:1', key: expect.any(String) }])
      const selected = screen.raw({ kind: 'key', key: 'n', code: 'KeyN', shift: false })
      expect(selected).toEqual([{ kind: 'select', objectId: 'task:1' as ObjectId }])
      expect(screen.view().commit).toMatchObject({ state: 'preparing', text: 'Preparing…', enabled: false })
      expect(invokes(screen.raw({ kind: 'key', key: 'Enter', code: 'Enter', shift: false }))).toEqual([])
      expect(screen.view().feedback?.text).toBe('Preparing…')
      await screen.perform(asked)
      expect(screen.view().commit).toMatchObject({ state: 'ready', enabled: true })
      await screen.key('Enter')
      expect(screen.calls).toHaveLength(1)
      // With no call left the served row is let go; N then says so.
      expect(screen.view().selected).toBeNull()
      await screen.key('n')
      expect([screen.view().selected, screen.view().feedback?.text, screen.view().workList.empty]).toEqual([null, word('noWork'), word('noWork')])
      expect(screen.raw({ kind: 'selection', objectId: 'u1' as ObjectId }).filter(effect => effect.kind === 'select')).toEqual([])
    })
  })

  test('Esc cancels a confirmation; a navigation key cancels it and then moves', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 })]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      const ready = screen.view().commit
      expect(ready.text).toStartWith('Divert U1 from LOW')
      await screen.key('Enter')
      expect(screen.view().commit.state).toBe('confirm')
      await screen.key('Escape')
      expect([screen.view().commit.state, screen.view().feedback?.text]).toEqual(['ready', 'Cancelled'])
      await screen.key('Enter')
      await screen.key('ArrowDown')
      expect([screen.view().commit.state, screen.view().selected?.id]).toEqual(['none', 'low'])
      expect(screen.calls).toHaveLength(0)
    })
  })

  test('the event log follows last orders, new tasks and alerts of the records in the picture', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(30), { [low]: 1 })]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      await screen.key('Enter')
      await createTask(run, kinds.templates.load, 'T2', at(1), { [top]: 1 })
      await screen.sync()
      await screen.wait(pastGuardMs)
      await screen.key('n')
      await screen.key('Enter')
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      const template = civilConfig.taskTemplates.find(entry => entry.id === kinds.templates.load)!
      expect(screen.view().log.map(entry => entry.text)).toEqual([
        `T1: U1 released from T1 · 1 ${civilConfig.loadClasses[2]!.noun.one} waiting`,
        'U1: diverted to T2 · from T1',
        `T2: new · ${template.label} · ${code(top)}`,
        'U1: sent to T1',
      ])
      expect(screen.view().alerts.map(alert => [alert.label, alert.code])).toEqual([['T1', 'work_returned']])
    })
  })

  test('motion changes no shown set until a 10 s re-rank finds one at least 30 s faster, and that change arms the guard', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(3)), unitAt('u2', 'U2', carrier, at(5)), taskAt('t1', 'T1', kinds.templates.load, at(0), { [middle]: 1 })], async run => {
      await accepted(run, ids.send, { units: ['u2'], to: { point: pointAt(at(-5)) } })
      const screen = await openScreen(run, createWall())
      await screen.key('n')
      const proposedBy = async () => (await run.query<{ proposal: { units: Array<{ label: string }> } }>('world.einsatz.recommend', { taskId: 't1' })).proposal.units[0]!.label
      const seen: Array<readonly [number, string, string, boolean]> = []
      for (let step = 1; step <= 14; step++) {
        await runFor(run, 10_000, [screen])
        seen.push([step * 10, await proposedBy(), screen.view().commit.text.split(' ')[1]!, screen.view().commit.enabled])
      }
      const swap = seen.findIndex(([, , shown]) => shown === 'U2')
      expect(swap).toBeGreaterThan(0)
      expect(seen.slice(0, swap).some(([, proposed]) => proposed === 'U2')).toBe(true)
      // Before the swap the shown set held while ETAs changed, and nothing armed the guard.
      expect(seen.slice(0, swap).every(([, , shown, enabled]) => shown === 'U1' && enabled)).toBe(true)
      expect(seen.slice(swap).every(([, , shown]) => shown === 'U2')).toBe(true)
      expect(screen.view().commit).toMatchObject({ enabled: false, hint: 'Confirm next: T1' })
    })
  })
})

describe('Board sound and flashes', () => {
  test('sound starts off and says how to enable it; once on, a new task and work returned each sound once, and a new row flashes for 5 s', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await createTask(run, kinds.templates.load, 'T1', at(5), { [low]: 1 })
      await screen.sync()
      expect([screen.view().sound, screen.sounds()]).toEqual([{ on: false, text: 'Sound off · tap to enable' }, 0])
      await screen.click({ kind: 'enable-sound' })
      expect(screen.view().sound).toEqual({ on: true, text: 'Sound on' })

      await screen.wait(3_000)
      await createTask(run, kinds.templates.load, 'T2', at(6), { [low]: 1 })
      await screen.sync()
      const flashing = () => screen.view().workList.rows.filter(row => row.fresh).map(row => row.label)
      expect([screen.sounds(), flashing()]).toEqual([1, ['T1', 'T2']])
      await screen.click({ kind: 'row', list: 'work', id: 'task:2' })
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      expect(screen.sounds()).toBe(1)
      await screen.wait(1_600)
      expect(flashing()).toEqual(['T2'])
      await screen.wait(3_000)
      expect(flashing()).toEqual([])

      await screen.click({ kind: 'verb', verb: 'recall', id: 'u1' })
      expect(run.task('task:2').alerts.map(alert => alert.code)).toEqual(['work_returned'])
      expect(screen.sounds()).toBe(2)
    })
  })
})
