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
  })

  test('the cluster variant matches a number against any key of the cluster after it, and skips numbers in names', () => {
    const grouped = scoreCitations('Loading is 112.55 % and pressure 15.50 MPa ⟦k2⟧ ⟦k1⟧; Unit 2 ⟦k3⟧ holds.', [card])
    expect(grouped.flagged.map(flag => flag.number)).toEqual(['15.50'])
    expect(grouped.flaggedCluster).toEqual([])
    expect(scoreCitations('Pressure 16.00 MPa ⟦k1⟧ ⟦k2⟧.', [card]).flaggedCluster.map(flag => flag.number)).toEqual(['16.00'])
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
