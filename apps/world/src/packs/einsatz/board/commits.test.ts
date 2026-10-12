import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, openScreen, pastGuardMs, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import type { BoardEffect } from './types.ts'

/**
 * One commitment, one call: a call locks its task until the Run shows it,
 * whatever the operator does meanwhile; a second press on a verb sends
 * nothing; a confirmation whose row leaves the work list goes with it and
 * says why; and the commitment changing under the operator arms the guard.
 */

const kinds = civilKinds(civilConfig)
const { carrier } = kinds.types
const [top, middle, low] = kinds.classes as [string, string, string]
const word = (key: keyof NonNullable<typeof civilConfig.lexicon>) => civilConfig.lexicon[key]!
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
const commit = async (screen: Screen, modality: Modality): Promise<void> =>
  modality === 'keys' ? await screen.key('Enter') : await screen.click({ kind: 'commit' })
const select = async (screen: Screen, modality: Modality, taskId: string): Promise<void> =>
  modality === 'keys' ? await screen.key('n') : await screen.click({ kind: 'row', list: 'work', id: taskId })
const invokes = (effects: ReadonlyArray<BoardEffect>) => effects.filter(effect => effect.kind === 'invoke')

describe('Board call locks', () => {
  for (const modality of modalities) {
    test(`a call accepted but not yet shown locks its task: selecting it again and committing sends nothing (${modality})`, async () => {
      await withScene([unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(4)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 })], async run => {
        const screen = await openScreen(run, createWall())
        // The Run's next snapshot reaches the screen only after the command's result.
        screen.freeze(true)
        await select(screen, modality, 't1')
        await commit(screen, modality)
        expect(screen.calls.map(call => call.result.ok)).toEqual([true])
        await select(screen, modality, 't1')
        expect(screen.view().selected?.id).toBe('t1')
        expect(screen.view().commit).toMatchObject({ state: 'sending', text: `✓ ${word('send')} U1 → T1`, enabled: false })
        await commit(screen, modality)
        expect(screen.calls).toHaveLength(1)
        screen.freeze(false)
        await screen.sync()
        expect(screen.view().workList.rows.find(row => row.id === 't1')?.served).toBe(true)
        await commit(screen, modality)
        expect(screen.calls).toHaveLength(1)
      })
    })
  }

  test('a double press on Recall or on Close sends one call, and the line keeps saying what is on its way', async () => {
    const items = [unitAt('u1', 'U1', carrier, at(0)), taskAt('t1', 'T1', kinds.templates.load, at(5), { [low]: 1 }), taskAt('r1', 'R1', kinds.templates.report, at(1))]
    await withScene(items, async run => {
      await accepted(run, ids.send, { units: ['u1'], to: { taskId: 't1' } })
      const screen = await openScreen(run, createWall())
      const recall = { kind: 'click', target: { kind: 'verb', verb: 'recall', id: 'u1' } } as const
      const first = screen.raw(recall)
      expect([invokes(first).length, invokes(screen.raw(recall)).length]).toEqual([1, 0])
      expect(screen.view().feedback).toEqual({ text: 'Recall U1…', tone: 'pending' })
      await screen.perform(first)
      expect(screen.view().feedback).toEqual({ text: '✓ Recall U1', tone: 'done' })

      const close = { kind: 'click', target: { kind: 'verb', verb: 'close', id: 'r1' } } as const
      const closing = screen.raw(close)
      expect([invokes(closing).length, invokes(screen.raw(close)).length]).toEqual([1, 0])
      await screen.perform(closing)
      // Accepted, not yet shown: still locked.
      expect(invokes(screen.raw(close))).toEqual([])
      expect(screen.view().feedback).toEqual({ text: '✓ Close R1', tone: 'done' })
      await screen.sync()
      expect(screen.calls.map(call => [call.capabilityId, call.result.ok])).toEqual([[ids.recall, true], [ids.taskClose, true]])
      expect(run.task('r1').closedAtMs).toBeDefined()
    })
  })
})

describe('Board confirmations', () => {
  for (const modality of modalities) {
    test(`a confirmation whose row closes meanwhile is cancelled with the reason, and Enter sends nothing (${modality})`, async () => {
      await withScene([unitAt('u1', 'U1', carrier, at(0)), taskAt('low', 'LOW', kinds.templates.load, at(25), { [low]: 1 }), taskAt('top', 'TOP', kinds.templates.load, at(2), { [top]: 1 })], async run => {
        await accepted(run, ids.send, { units: ['u1'], to: { taskId: 'low' } })
        const screen = await openScreen(run, createWall())
        await select(screen, modality, 'top')
        await commit(screen, modality)
        expect(screen.view().commit.state).toBe('confirm')
        await accepted(run, ids.taskClose, { taskId: 'top' })
        await screen.sync()
        expect(screen.view().feedback).toEqual({ text: 'TOP closed · confirmation cancelled', tone: 'info' })
        expect([screen.view().selected, screen.view().commit.state]).toEqual([null, 'none'])
        await screen.wait(pastGuardMs)
        await commit(screen, modality)
        expect(screen.calls).toHaveLength(0)
      })
    })

    test(`closing a task with waiting load asks to confirm what is dropped (${modality})`, async () => {
      await withScene([unitAt('u1', 'U1', carrier, at(30)), taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 2 })], async run => {
        const screen = await openScreen(run, createWall())
        if (modality === 'keys') {
          await screen.key('n')
          await screen.key('c')
        } else {
          await screen.click({ kind: 'row', list: 'work', id: 't1' })
          await screen.click({ kind: 'verb', verb: 'close', id: 't1' })
        }
        expect(screen.view().commit).toMatchObject({ state: 'confirm', text: `⏎ Confirm: Close T1 · T1 · 2 ${civilConfig.loadClasses[2]!.noun.other} dropped`, enabled: false })
        expect(screen.calls).toHaveLength(0)
        await screen.wait(pastGuardMs)
        await commit(screen, modality)
        expect(screen.calls.at(-1)).toMatchObject({ capabilityId: ids.taskClose, input: { taskId: 't1' }, result: { ok: true } })
        expect(run.task('t1').closedAtMs).toBeDefined()
      })
    })
  }
})

describe('Board guard on external change', () => {
  for (const modality of modalities) {
    test(`another screen taking the selected row's shown unit arms the guard over the new proposal (${modality})`, async () => {
      const items = [
        unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)),
        taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('t2', 'T2', kinds.templates.load, at(-1), { [middle]: 1 }),
      ]
      await withScene(items, async run => {
        const wall = createWall()
        const screen = await openScreen(run, wall)
        const other = await openScreen(run, wall)
        await screen.click({ kind: 'row', list: 'work', id: 't1' })
        await screen.wait(pastGuardMs)
        expect(screen.view().commit).toMatchObject({ enabled: true })
        expect(screen.view().commit.text).toStartWith(`⏎ ${word('send')} U1 → T1`)
        await other.click({ kind: 'row', list: 'work', id: 't2' })
        await other.click({ kind: 'commit' })
        await screen.sync()
        expect(screen.view().commit).toMatchObject({ enabled: false, hint: 'Confirm next: T1' })
        expect(screen.view().commit.text).toStartWith(`⏎ ${word('send')} U2 → T1`)
        await commit(screen, modality)
        expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'Not sent: the list changed · Confirm next: T1'])
        await screen.wait(pastGuardMs)
        await commit(screen, modality)
        expect(screen.calls.at(-1)).toMatchObject({ input: { units: ['u2'], to: { taskId: 't1' } }, result: { ok: true } })
      })
    })
  }
})
