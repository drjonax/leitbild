import { describe, expect, test } from 'bun:test'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { civilConfig, civilKinds, civilWith, createWall, openScreen, pastGuardMs, runFor, taskAt, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { isoAt, openRun, type OpenRun } from '../fixtures/run-harness.ts'
import type { BoardEffect } from './types.ts'

/**
 * Recommendation stability and validation: a row is asked again only when
 * something it depends on changes, never for units that could not count
 * towards it; an answer is validated where it enters, and an answer that
 * does not parse, like a failed ask, shows on the row and is retried after
 * 10 s of Run time.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer } = kinds.types
const [, , low] = kinds.classes as [string, string, string]
const word = (key: keyof NonNullable<typeof civilConfig.lexicon>) => civilConfig.lexicon[key]!
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]

const withScene = async (items: ReadonlyArray<Record<string, unknown>>, body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ definition: civilWith(items) })
  try { await body(run) } finally { await run.close() }
}
const accepted = async (run: OpenRun, capabilityId: string, input: unknown): Promise<void> => {
  const result = await run.invoke(capabilityId, input)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
const snapshotOf = (run: OpenRun, screen: Screen) => screen.raw({ kind: 'snapshot', objects: run.run.snapshot().objects, currentTime: isoAt(run.nowMs()) })
const asked = (effects: ReadonlyArray<BoardEffect>) => effects.flatMap(effect => effect.kind === 'recommend' ? [effect] : [])

describe('Board recommendation keys', () => {
  test('dispatching a unit that could never count towards the selected row neither asks for it again nor touches its commit element', async () => {
    const items = [
      unitAt('u1', 'U1', carrier, at(0)), unitAt('u2', 'U2', carrier, at(3)), unitAt('p1', 'P1', pairServer, at(1)),
      taskAt('t1', 'T1', kinds.templates.load, at(1), { [low]: 1 }), taskAt('o1', 'O1', kinds.templates.single, at(2)),
    ]
    await withScene(items, async run => {
      const screen = await openScreen(run, createWall())
      await screen.click({ kind: 'row', list: 'work', id: 't1' })
      await screen.wait(pastGuardMs)
      const shown = screen.view().commit
      expect(shown).toMatchObject({ state: 'ready', enabled: true })
      await accepted(run, ids.send, { units: ['p1'], to: { taskId: 'o1' } })
      const effects = snapshotOf(run, screen)
      expect(asked(effects).map(effect => effect.taskId)).not.toContain('t1')
      expect(screen.view().commit).toEqual(shown)

      // A unit that could count towards it, dispatched elsewhere, is asked about at once.
      await accepted(run, ids.send, { units: ['u2'], to: { point: { type: 'Point', coordinates: at(5, 5) } } })
      await accepted(run, ids.taskCreate, { template: kinds.templates.load, label: 'T2', at: { type: 'Point', coordinates: at(-1) }, loads: { [low]: 1 } })
      await accepted(run, ids.send, { units: ['u2'], to: { taskId: 'task:1' } })
      expect(asked(snapshotOf(run, screen)).map(effect => effect.taskId)).toContain('t1')
    })
  })
})

describe('Board recommendation answers', () => {
  test('an answer that does not parse shows on its row as no recommendation, commits nothing, and is asked again 10 s later', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await accepted(run, ids.taskCreate, { template: kinds.templates.load, label: 'T1', at: { type: 'Point', coordinates: at(1) }, loads: { [low]: 1 } })
      const [ask] = asked(snapshotOf(run, screen))
      expect(ask).toMatchObject({ taskId: 'task:1' })
      screen.raw({ kind: 'recommendation', taskId: 'task:1', key: ask!.key, answer: { taskId: 'task:1', proposal: { units: 'U1' } } })
      const row = () => screen.view().workList.rows.find(entry => entry.id === 'task:1')!
      expect(row().statusText).toStartWith('No recommendation: the answer does not parse (')
      await screen.key('n')
      expect(screen.view().commit).toMatchObject({ state: 'none', text: row().statusText, enabled: false })
      await screen.key('Enter')
      expect(screen.calls).toHaveLength(0)

      await runFor(run, 5_000)
      expect(asked(snapshotOf(run, screen))).toEqual([])
      await runFor(run, 5_000)
      const again = asked(snapshotOf(run, screen))
      expect(again.map(effect => effect.taskId)).toEqual(['task:1'])
      await screen.perform(again)
      expect(row().statusText).toBeNull()
      expect(screen.view().commit.text).toStartWith(`⏎ ${word('send')} U1 → T1`)
    })
  })

  test('a failed ask shows its reason on the row and is retried 10 s later, as is an answer for another task', async () => {
    await withScene([unitAt('u1', 'U1', carrier, at(0))], async run => {
      const screen = await openScreen(run, createWall())
      await accepted(run, ids.taskCreate, { template: kinds.templates.load, label: 'T1', at: { type: 'Point', coordinates: at(1) }, loads: { [low]: 1 } })
      const [ask] = asked(snapshotOf(run, screen))
      screen.raw({ kind: 'recommendation-failed', taskId: 'task:1', key: ask!.key, reason: 'runtime_unavailable: The Einsatz runtime is unavailable; inspect runtime health' })
      const row = () => screen.view().workList.rows.find(entry => entry.id === 'task:1')!
      expect(row().statusText).toBe('No recommendation: The Einsatz runtime is unavailable; inspect runtime health')
      await screen.key('n')
      await screen.key('Enter')
      expect([screen.calls.length, screen.view().feedback?.text]).toEqual([0, 'No recommendation: The Einsatz runtime is unavailable; inspect runtime health'])

      await runFor(run, 10_000)
      const [retry] = asked(snapshotOf(run, screen))
      expect(retry).toMatchObject({ taskId: 'task:1' })
      const answer = await run.query<Record<string, unknown>>('world.einsatz.recommend', { taskId: 'task:1' })
      screen.raw({ kind: 'recommendation', taskId: 'task:1', key: retry!.key, answer: { ...answer, taskId: 't9' } })
      expect(row().statusText).toBe('No recommendation: the answer is for t9')

      await runFor(run, 10_000)
      await screen.perform(asked(snapshotOf(run, screen)))
      expect(row().statusText).toBeNull()
      expect(screen.view().commit.text).toStartWith(`⏎ ${word('send')} U1 → T1`)
    })
  })
})
