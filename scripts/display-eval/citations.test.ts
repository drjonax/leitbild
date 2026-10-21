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

  test('guard v3: a key before or after its number in its cell or clause; ordinals and row numbers are names; derived differences', () => {
    const limits = new Map([['k2', [{ value: 100, decimals: 0 }]]])
    const score = (answer: string) => scoreCitations(answer, [card], 'en', limits)
    // Keys before their numbers: v2 reads 15.5 against the next clause key and flags it; v3 does not.
    const leading = score('Pressure ⟦k1⟧ is 15.5 MPa, and loading ⟦k2⟧ is 112.6 %.')
    expect(leading.v2.flagged.map(flag => flag.number)).toEqual(['15.5'])
    expect(leading.v3).toMatchObject({ cited: 2, flagged: [], displayed: 2, keyed: 2, keyedAfter: 0 })
    // The nearer eligible group wins; a group a number before it already answers to is no key for the next number.
    expect(score('Pressure ⟦k1⟧ is 15.5 MPa while loading is 112.6 % ⟦k2⟧.').v3).toMatchObject({ cited: 2, flagged: [], keyedAfter: 1 })
    expect(score('Pressure is 15.5 MPa ⟦k1⟧ and loading 112.6 %.').v3).toMatchObject({ cited: 1, flagged: [], displayed: 2, keyed: 1 })
    // In a table the unit is the cell: a key in the label cell cites nothing, a row number is a name.
    const table = score('| Reading | Value |\n|---|---|\n| Pressure ⟦k1⟧ | 15.50 MPa |\n| 1 | Loading 112.6 % ⟦k2⟧ |')
    expect(table.v2.flagged.map(flag => flag.number)).toEqual(['1'])
    expect(table.v3).toMatchObject({ cited: 1, namesSkipped: 1, flagged: [], displayed: 2, keyed: 1 })
    expect(score('Display 2 shows loading at 112.6 % ⟦k2⟧.').v3).toMatchObject({ cited: 1, namesSkipped: 1, flagged: [] })
    // A derived difference holds when its unit shows both values, is flagged when it differs, and is unchecked without them.
    expect(score('Loading is 112.6 %, or 12.6 percentage points above 100 % ⟦k2⟧.').v3).toMatchObject({ derivedChecked: 1, derivedUnchecked: [], flagged: [] })
    expect(score('Loading is 112.6 %, or 15.6 percentage points above 100 % ⟦k2⟧.').v3.flagged).toMatchObject([{ number: '15.6', derived: true }])
    expect(score('Loading is 12.6 points above full loading ⟦k2⟧.').v3).toMatchObject({ derivedChecked: 0, flagged: [], derivedUnchecked: [{ number: '12.6' }] })
    // A contradiction is still flagged.
    expect(score('Pressure is 16.2 MPa ⟦k1⟧.').v3.flagged).toMatchObject([{ number: '16.2', derived: false }])
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
