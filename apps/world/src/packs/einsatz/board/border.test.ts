import { describe, expect, test } from 'bun:test'
import type { OperationalObject } from '../../../core/model/index.ts'
import { sideViewOfSnapshot } from '../../../core/simulation-runs/side-view.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { roeWords } from '../lexicon.ts'
import { createWall, openScreen, roleScreen, runFor, unitAt, type Screen } from '../fixtures/board-harness.ts'
import { borderDefinitions, commanderOf } from '../fixtures/border-harness.ts'
import { at, blue, red, types } from '../fixtures/combat-harness.ts'
import scripted from '../../../scenarios/halden-border.scenario.json'
import { openRun, type OpenRun } from '../fixtures/run-harness.ts'
import { einsatzPackId } from '../ids.ts'
import { readBoardRecords } from './records.ts'

/**
 * The Board on a sided Run with sensors (halden-border, Red scripted): the
 * Run's tracks and the truth-only track indexes are Einsatz objects the
 * Board passes over by type, on the Controller's screen, which holds both,
 * and on a side's, which holds its own tracks. Any other unknown Einsatz
 * record is still an error. A side's engagement orders reach its own log and
 * the Controller's, the priority target named by the track's label.
 */

const typeOf = (object: OperationalObject): unknown => (object.packData as { readonly type?: unknown }).type
const einsatzTypes = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<unknown> =>
  [...new Set(objects.filter(object => object.packId === einsatzPackId).map(typeOf))].sort()

/** Runs the scripted border until both sides hold a track: Red's column meets Blue's screen. */
const untilTracked = async (run: OpenRun): Promise<void> => {
  const tracked = (side: string) => run.run.snapshot().objects.some(object => typeOf(object) === 'track' && object.audience !== undefined && object.audience !== 'public' && object.audience.includes(side))
  for (let minute = 0; minute < 30 && !(tracked('blue') && tracked('red')); minute++) await runFor(run, 60_000)
  if (!tracked('blue') || !tracked('red')) throw new Error('halden-border tracked no unit of either side in 30 minutes')
}

/** halden-border with these items and no timeline: its roles, sides and configuration over a scene a test builds. */
const borderWith = (items: ReadonlyArray<Record<string, unknown>>): unknown => ({ ...scripted, packs: [{ ...scripted.packs[0]!, items }], timeline: undefined })
const northOf = (metres: number): [number, number] => [...at(metres).coordinates]

describe('Board on halden-border', () => {
  test('the Controller\'s and a side\'s Board read a snapshot holding tracks and track indexes, showing only units and tasks', async () => {
    const run = await openRun({ definition: scripted })
    try {
      await untilTracked(run)
      const truth = run.run.snapshot().objects
      expect(einsatzTypes(truth)).toEqual(['task', 'track', 'track-index', 'unit'])
      expect(einsatzTypes(sideViewOfSnapshot(run.run.snapshot(), ['blue']).objects)).toEqual(['task', 'track', 'unit'])

      // Every role of the Definition: the Controller and each side's operators.
      for (const role of scripted.roles) {
        const screen = await openScreen(run, createWall(), { actor: roleScreen(run, role.id) })
        await runFor(run, 2_000, [screen])
        const view = screen.view()
        const records = readBoardRecords(run.run.snapshot().objects)
        const shown = [...view.workList.rows.map(row => row.id), ...view.unitBoard.rows.map(row => row.id)]
        expect(shown.every(id => records.units.has(id) || records.tasks.has(id))).toBe(true)
        expect(shown.some(id => id.startsWith('track'))).toBe(false)
      }
    } finally {
      await run.close()
    }
  }, 120_000)

  test('an Einsatz record of a type the engine does not write is still an error', async () => {
    const run = await openRun({ definition: scripted })
    try {
      await untilTracked(run)
      const track = run.run.snapshot().objects.find(object => typeOf(object) === 'track')!
      const stranger = { ...track, id: 'stranger' as OperationalObject['id'], packData: { ...(track.packData as object), type: 'sighting' } }
      expect(() => readBoardRecords([...run.run.snapshot().objects, stranger])).toThrow('Einsatz object stranger has a record the Board cannot read')
    } finally {
      await run.close()
    }
  }, 120_000)

  test('a side\'s rules of engagement and priority target reach its own log and the Controller\'s, naming the track it holds, and never the other side\'s', async () => {
    const run = await openRun({ definition: borderWith([unitAt('b1', 'B1', types.blueGun, northOf(0), { side: blue }), unitAt('r1', 'R1', types.redGun, northOf(400), { side: red })]) })
    try {
      // The roles commanding each side's shooters, and the Controller, found by authority and class.
      const commander = commanderOf(borderDefinitions.scripted, blue, 'effector').roles[0]!.id
      const opponent = commanderOf(borderDefinitions.scripted, red, 'effector').roles[0]!.id
      const truth = scripted.roles.find(role => role.class === 'controller')!.id
      const screens: Record<'own' | 'other' | 'truth', Screen> = {
        own: await openScreen(run, createWall(), { actor: roleScreen(run, commander) }),
        other: await openScreen(run, createWall(), { actor: roleScreen(run, opponent) }),
        truth: await openScreen(run, createWall(), { actor: roleScreen(run, truth) }),
      }
      const all = Object.values(screens)
      const identified = () => run.run.snapshot().objects.find(object => typeOf(object) === 'track' && object.audience !== undefined && object.audience !== 'public'
        && object.audience.includes(blue) && (object.packData as { readonly tier?: unknown }).tier === 'identified')
      for (let step = 0; step < 30 && identified() === undefined; step++) await runFor(run, 2_000, all)
      const track = identified()
      if (track === undefined) throw new Error('Blue identified no Red unit in a minute')
      const order = async (capabilityId: string, input: unknown): Promise<void> => {
        const result = await run.invoke(capabilityId, input, roleScreen(run, commander))
        if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
        for (const screen of all) await screen.sync()
      }
      // One snapshot before and one after each order, so each line comes from comparing two record sets.
      await order(ids.setRoe, { unitId: 'b1', roe: 'free' })
      await order(ids.engage, { unitId: 'b1', trackId: track.id })
      const lines = (screen: Screen) => screen.view().log.filter(entry => entry.recordId === 'b1').map(entry => entry.text)
      const expected = [`B1: engaging ${track.label}`, `B1: set · ${roeWords.free}`]
      expect(lines(screens.own).slice(0, 2)).toEqual(expected)
      expect(lines(screens.truth).slice(0, 2)).toEqual(expected)
      expect(lines(screens.other)).toEqual([])
    } finally {
      await run.close()
    }
  }, 120_000)
})
