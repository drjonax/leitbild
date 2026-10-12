import { describe, expect, test } from 'bun:test'
import { civilConfig, civilKinds, civilWith, taskAt, unitAt } from '../fixtures/board-harness.ts'
import { openRun } from '../fixtures/run-harness.ts'
import { openModeViewer } from '../picture.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { readBoardRecords, type BoardRecords, type BoardUnit } from './records.ts'
import { createBoardRules } from './rules.ts'
import { couldBecomeEligible, isFreeIn, statusText, unservableText } from './work-list.ts'

/**
 * Why no unit comes, kept apart: none could ever serve, none is free, or a
 * unit is not eligible for a reason a change can fix. A destroyed unit, or
 * one that cannot move, is listed as not eligible by the engine but never
 * stands in for one that could serve.
 */

const kinds = civilKinds(civilConfig)
const { conditionedServer, site } = kinds.types
const acute = civilConfig.loadClasses[0]!
/** What the conditioned template still needs, in its own words: "1 <one of its requirement's label>". */
const remainder = `1 ${civilConfig.taskTemplates.find(entry => entry.id === kinds.templates.conditioned)!.requires[0]!.label.one}`
const unservable = `No unit can serve: needs ${remainder}`
const at = (eastKm: number, northKm = 0): [number, number] => [11.38 + eastKm / 57.12, 59.12 + northKm / 110.54]
const rules = createBoardRules(civilConfig, openModeViewer, () => [])

/** The scene's records, as a paused Run writes them, with these changes to its units. */
const sceneRecords = async (changes: Readonly<Record<string, Partial<BoardUnit>>>): Promise<BoardRecords> => {
  const items = [unitAt('e1', 'E1', conditionedServer, at(0)), unitAt('e2', 'E2', conditionedServer, at(1)), unitAt('h1', 'H1', site, at(2)), taskAt('fire', 'FIRE', kinds.templates.conditioned, at(3))]
  const run = await openRun({ definition: civilWith(items), paused: true })
  try {
    const records = readBoardRecords(run.run.snapshot().objects)
    return { ...records, units: new Map([...records.units].map(([id, unit]) => [id, { ...unit, ...changes[id] }])) }
  } finally {
    await run.close()
  }
}

const answer = (fields: Partial<Recommendation>): Recommendation => ({
  taskId: 'fire',
  rank: { id: acute.id, code: acute.code },
  need: { id: acute.id, code: acute.code },
  proposal: { units: [], covers: false, remainder: [remainder] },
  alternatives: [],
  ineligible: [],
  committed: [],
  next: [],
  servable: false,
  ...fields,
})
const notEligible = (unitId: string, reason: string) => ({ unitId, label: unitId.toUpperCase(), reasons: [reason] })
const shortOfWater = (unitId: string) => notEligible(unitId, `${unitId.toUpperCase()} · Water 1000 L · needs ≥ 2000 L`)

describe('Board wording for a call no unit comes to', () => {
  test('a destroyed sole provider, or one that cannot move, leaves the call one no unit can serve, row and alert alike', async () => {
    const records = await sceneRecords({ e1: { integrity: 'destroyed' } })
    const could = couldBecomeEligible(rules, records)
    expect(['e1', 'e2', 'h1', 'nobody'].map(could)).toEqual([false, true, false, false])
    for (const listed of [[notEligible('e1', 'E1 is destroyed')], [notEligible('h1', 'H1 cannot move')], [notEligible('e1', 'E1 is destroyed'), notEligible('h1', 'H1 cannot move')]]) {
      const shown = answer({ ineligible: listed })
      expect(unservableText(shown, could)).toBe(unservable)
      expect(statusText(shown, unitId => isFreeIn(records, unitId), could)).toBe(unservable)
    }
  })

  test('a unit short of a condition could become eligible: free, its reason is the row\'s; busy, it is named before a destroyed one', async () => {
    const free = await sceneRecords({ e1: { integrity: 'destroyed' } })
    const shown = answer({ ineligible: [notEligible('e1', 'E1 is destroyed'), shortOfWater('e2')] })
    expect(unservableText(shown, couldBecomeEligible(rules, free))).toBeNull()
    expect(statusText(shown, unitId => isFreeIn(free, unitId), couldBecomeEligible(rules, free))).toBe('No eligible unit · E2 · Water 1000 L · needs ≥ 2000 L')
    const busy = await sceneRecords({ e1: { integrity: 'destroyed' }, e2: { taskId: 'elsewhere' } })
    expect(statusText(shown, unitId => isFreeIn(busy, unitId), couldBecomeEligible(rules, busy))).toBe('No eligible unit · E2 · Water 1000 L · needs ≥ 2000 L')
  })

  test('units that could come but are busy say so; a side that could serve with none of the screen\'s units listed says none is free', async () => {
    const records = await sceneRecords({})
    const could = couldBecomeEligible(rules, records)
    const isFree = (unitId: string) => isFreeIn(records, unitId)
    expect(statusText(answer({ committed: [{ unitId: 'e1', label: 'E1', reason: 'E1 now on task at C-2' }], servable: true }), isFree, could)).toBe('No free unit · 1 busy')
    expect(statusText(answer({ servable: true }), isFree, could)).toBe('No free unit')
  })
})
