import { describe, expect, test } from 'bun:test'
import type { Card } from './cards.ts'
import { scoreCitations } from './citations.ts'
import { assetLineRefs } from './frozen-runs.ts'

const card: Card = {
  at: { at: '2026-01-01T10:05:00.000Z', clock: 'simulation' }, more: 0, adjusted: [],
  items: [
    { key: 'k1', label: 'Unit 2 · Pressurizer pressure', reading: '15.50 MPa', unit: 'MPa', numbers: [{ value: 15.5, decimals: 2 }], subject: { ref: 'plant:halden-2#pressurizer.pressureMPa' } },
    { key: 'k2', label: 'Unit 2 · Hasle loading', reading: '112.55 %', unit: '%', numbers: [{ value: 112.55, decimals: 2 }] },
    { key: 'k3', label: 'Unit 2 · Rods on bottom', reading: 'yes · since 10:02:13', numbers: [] },
  ],
}

describe('T10: the guard and the citation measures', () => {
  test('a number next to a key matches the item at its typed precision; fewer decimals that round to it count', () => {
    const score = scoreCitations('Pressure is 15.5 MPa ⟦k1⟧ and loading 112.6 % ⟦k2⟧.', [card])
    expect(score).toMatchObject({ exact: 2, malformed: 0, keyedNumbers: 2, displayedNumbers: 2, keyedDisplayed: 2, flagged: [] })
  })

  test('a number that contradicts its key is flagged; a retyped value without its key lowers key use', () => {
    const score = scoreCitations('Pressure is 15.7 MPa ⟦k1⟧. Loading stands at 112.55 %.', [card])
    expect(score.flagged.map(flag => flag.key)).toEqual(['k1'])
    expect([score.displayedNumbers, score.keyedDisplayed]).toEqual([1, 0])
  })

  test('clock times, refs and ids are no numbers; a state key carries no number', () => {
    const score = scoreCitations('Rods on bottom since 10:02:13 ⟦k3⟧; plant:halden-2#pressurizer.pressureMPa reads 15.50 MPa ⟦k1⟧.', [card])
    expect(score).toMatchObject({ keyedNumbers: 1, flagged: [], displayedNumbers: 1 })
  })

  test('malformed key marks and unknown keys are counted; Norwegian decimal commas read as decimals', () => {
    const score = scoreCitations('Trykket er 15,5 MPa [k1] og belastningen 112,6 % ⟦k2⟧, se også ⟦k9⟧.', [card], 'nb')
    expect(score).toMatchObject({ exact: 2, malformed: 1, unknownKeys: ['k9'], flagged: [] })
    // A key range is no key.
    expect(scoreCitations('All eight lines tripped ⟦k1–k8⟧.', [card])).toMatchObject({ exact: 0, malformed: 1 })
  })

  test('guard v2: a number holds against any key of the group after its clause; ranges by both ends; limits after a limit word; names skipped', () => {
    const limits = new Map([['k2', [{ value: 100, decimals: 0 }]]])
    const v2 = (answer: string, language: 'en' | 'nb' = 'en') => scoreCitations(answer, [card], language, limits).v2
    // Grouped keys after a clause: the as-specified guard flags 15.50 against k2, v2 does not.
    expect(scoreCitations('Loading is 112.55 % and pressure 15.50 MPa ⟦k2⟧ ⟦k1⟧.', [card]).flagged.map(flag => flag.number)).toEqual(['15.50'])
    expect(v2('Loading is 112.55 % and pressure 15.50 MPa ⟦k2⟧ ⟦k1⟧.')).toEqual({ cited: 2, namesSkipped: 0, flagged: [] })
    // A range holds when both ends match items of its group; one end off flags it.
    expect(v2('Pressure and loading span 15.5–112.6 ⟦k1⟧ ⟦k2⟧.').flagged).toEqual([])
    expect(v2('Pressure and loading span 15.5–120 ⟦k1⟧ ⟦k2⟧.').flagged.map(flag => flag.number)).toEqual(['15.5–120'])
    // A limit after a limit word may match a declared threshold; the same number without one may not.
    expect(v2('Loading is 112.6 %, above its 100 % rating ⟦k2⟧.').flagged).toEqual([])
    expect(v2('Loading is 112.6 %, then 100 % ⟦k2⟧.').flagged.map(flag => flag.number)).toEqual(['100'])
    // A number in a name is no cited number; a key range is no group; a contradiction is still flagged.
    expect(v2('Unit 2 ⟦k1⟧ reads 15.50 MPa ⟦k1⟧.')).toMatchObject({ cited: 1, namesSkipped: 1, flagged: [] })
    expect(v2('All lines tripped ⟦k1–k3⟧ at 7 %.').cited).toBe(0)
    expect(v2('Pressure is 16.2 MPa ⟦k1⟧ ⟦k2⟧.').flagged.map(flag => flag.number)).toEqual(['16.2'])
    // Revision 2 names: a list of unit numbers, and numbers as a card label writes them.
    expect(v2('Halden Units 1 and 2 read 15.50 MPa ⟦k1⟧.')).toMatchObject({ namesSkipped: 2, flagged: [] })
    const named: Card = { ...card, items: [{ ...card.items[1]!, label: 'Ertsmyra trafostasjon 420 kV · Sylling – Tegneby (1)' }] }
    expect(scoreCitations('Ertsmyra 420 kV: Sylling–Tegneby (1) is at 112.6 % ⟦k2⟧.', [named], 'en', limits).v2).toMatchObject({ namesSkipped: 2, flagged: [] })
  })

  test('thousands groups read as one number: commas in English, spaces in Norwegian', () => {
    const big: Card = { ...card, items: [{ key: 'k4', label: 'Reserve', reading: '2291 MW', unit: 'MW', numbers: [{ value: 2291, decimals: 0 }] }] }
    expect(scoreCitations('A reserve margin of 2,291 MW ⟦k4⟧.', [big]).flagged).toEqual([])
    expect(scoreCitations('Reservemarginen er 2 291 MW ⟦k4⟧.', [big], 'nb').flagged).toEqual([])
    expect(scoreCitations('A reserve margin of 2,391 MW ⟦k4⟧.', [big]).flagged.map(flag => flag.number)).toEqual(['2,391'])
  })
})

describe('T08: asset lines carry full refs', () => {
  test('a ref cut at the line cap is no ref', () => {
    const text = 'Run · simulation time x · PAUSED\n- plant:halden-1 · Halden Unit 1 · Normal · no alerts · lead: plant:halden-1#core.powerRangePercent, plant:halden-1#vessel.c…\n- grid:g · Grid · Normal · no alerts · lead: grid:g#grid.frequency\n- Ambulances (ambulance): 6 · Available 6'
    const lines = assetLineRefs(text)
    expect(lines.map(line => [line.objectId, line.refs.length, line.full])).toEqual([['plant:halden-1', 1, false], ['grid:g', 1, true]])
    expect(lines[0]!.cut).toEqual(['plant:halden-1#vessel.c…'])
  })
})
