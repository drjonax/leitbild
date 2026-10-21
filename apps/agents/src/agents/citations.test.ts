import { describe, expect, test } from 'bun:test'
import { citationIssues, readingFlags, type CitedItem } from './citations.ts'

// T10's card (scripts/display-eval/citations.test.ts), with the declared limits on the item as the contracts card carries them.
const items: ReadonlyArray<CitedItem> = [
  { key: 'k1', label: 'Unit 2 · Pressurizer pressure', reading: '15.50 MPa', numbers: [{ value: 15.5, decimals: 2 }] },
  { key: 'k2', label: 'Unit 2 · Hasle loading', reading: '112.55 %', numbers: [{ value: 112.55, decimals: 2 }], limits: [{ value: 100, decimals: 0 }] },
  { key: 'k3', label: 'Unit 2 · Rods on bottom', reading: 'yes · since 10:02:13', numbers: [] },
]
const flagged = (answer: string, cited: ReadonlyArray<CitedItem> = items) => citationIssues(answer, cited).contradictions.map(entry => entry.number)

describe('citation check (guard v3, pack-neutral naming)', () => {
  test('a number matches its item at the decimals it is written with; fewer decimals that round to it hold', () => {
    expect(citationIssues('Pressure is 15.5 MPa ⟦k1⟧ and loading 112.6 % ⟦k2⟧.', items)).toEqual({ unknownKeys: [], contradictions: [] })
  })

  test('a number its key contradicts is named with what the line reads', () => {
    expect(citationIssues('Pressure is 15.7 MPa ⟦k1⟧.', items).contradictions).toEqual([
      { number: '15.7', keys: ['k1'], issue: '15.7 is cited with ⟦k1⟧, but k1 reads "15.50 MPa" (Unit 2 · Pressurizer pressure).' },
    ])
  })

  test('clock times, refs and ids are no numbers; a state line carries none; unknown keys are listed once', () => {
    expect(flagged('Rods on bottom since 10:02:13 ⟦k3⟧; plant:halden-2#pressurizer.pressureMPa reads 15.50 MPa ⟦k1⟧.')).toEqual([])
    expect(citationIssues('Pressure is 15.50 MPa ⟦k1⟧, see ⟦k9⟧ and ⟦k9⟧.', items).unknownKeys).toEqual(['k9'])
    // A key range is no key group: the number answers to nothing.
    expect(flagged('All eight lines tripped ⟦k1–k8⟧ at 7 %.')).toEqual([])
  })

  test('a key before or after its number within its cell or clause; the nearer eligible group wins', () => {
    expect(flagged('Pressure ⟦k1⟧ is 15.5 MPa, and loading ⟦k2⟧ is 112.6 %.')).toEqual([])
    expect(flagged('Pressure ⟦k1⟧ is 15.5 MPa while loading is 112.6 % ⟦k2⟧.')).toEqual([])
    // Grouped keys after a clause: a number holds against any key of its group.
    expect(flagged('Loading is 112.55 % and pressure 15.50 MPa ⟦k2⟧ ⟦k1⟧.')).toEqual([])
    expect(flagged('Pressure is 16.2 MPa ⟦k1⟧ ⟦k2⟧.')).toEqual(['16.2'])
    // In a table the unit is the cell: a key in the label cell cites nothing, a row number is a name.
    expect(flagged('| Reading | Value |\n|---|---|\n| Pressure ⟦k1⟧ | 15.50 MPa |\n| 1 | Loading 112.6 % ⟦k2⟧ |')).toEqual([])
  })

  test('ranges hold by both ends; a limit after a limit word may match a declared limit; derived differences', () => {
    expect(flagged('Pressure and loading span 15.5–112.6 ⟦k1⟧ ⟦k2⟧.')).toEqual([])
    expect(flagged('Pressure and loading span 15.5–120 ⟦k1⟧ ⟦k2⟧.')).toEqual(['15.5–120'])
    expect(flagged('Loading is 112.6 %, above its 100 % rating ⟦k2⟧.')).toEqual([])
    expect(flagged('Loading is 112.6 %, then 100 % ⟦k2⟧.')).toEqual(['100'])
    expect(flagged('Loading is 112.6 %, or 12.6 percentage points above 100 % ⟦k2⟧.')).toEqual([])
    expect(flagged('Loading is 112.6 %, or 15.6 percentage points above 100 % ⟦k2⟧.')).toEqual(['15.6'])
    // Without both values in its clause a difference is unchecked, never flagged.
    expect(flagged('Loading is 12.6 points above full loading ⟦k2⟧.')).toEqual([])
  })

  test('a difference is checked only against two cited values of its own keys, never another item\'s number (E1)', () => {
    const lines: ReadonlyArray<CitedItem> = [
      { key: 'k7', label: 'Sylling – Tegneby (1) · loading', reading: '130.9 %', numbers: [{ value: 130.9, decimals: 1 }], limits: [{ value: 100, decimals: 0 }] },
      { key: 'k8', label: 'Hasle – Rød (1) · loading', reading: '91.3 %', numbers: [{ value: 91.3, decimals: 1 }], limits: [{ value: 100, decimals: 0 }] },
      { key: 'k15', label: 'Sylling – Tegneby (1) · above-emergency alarm', reading: 'alarm', numbers: [] },
    ]
    // E1's two false positives: differences from the unwritten 100 % limit, with the other line's value in the clause.
    expect(flagged('The closest readings to a branch-loading limit are **Sylling–Tegneby (1)** at 130.9% ⟦k7⟧—already 30.9 percentage points ⟦k7⟧ over—and **Hasle–Rød (1)** at 91.3% ⟦k8⟧, 8.7 points ⟦k8⟧ below.', lines)).toEqual([])
    expect(flagged('Hasle–Rød (1) is at 91.3% ⟦k8⟧, 8.7 points ⟦k8⟧ below.', lines)).toEqual([])
    // Two cited values of the same key still check it: right holds, wrong is flagged.
    expect(flagged('Loading is 130.9 %, or 30.9 percentage points above 100 % ⟦k7⟧.', lines)).toEqual([])
    expect(flagged('Loading is 130.9 %, or 39.6 percentage points above 100 % ⟦k7⟧.', lines)).toEqual(['39.6'])
    // A difference whose keys cite one value is unchecked, even beside another line's value.
    expect(flagged('Sylling–Tegneby (1) at 130.9 % ⟦k7⟧ is 39.6 points ⟦k7⟧ above Hasle–Rød (1) at 91.3 % ⟦k8⟧.', lines)).toEqual([])
  })

  test('names: unit and display words and the card\'s own labels name numbers; pack words do not', () => {
    expect(flagged('Units 1 and 2 read 15.50 MPa ⟦k1⟧.')).toEqual([])
    expect(flagged('Unit 2 ⟦k1⟧ reads 15.50 MPa ⟦k1⟧.')).toEqual([])
    expect(flagged('Display 2 shows loading at 112.6 % ⟦k2⟧.')).toEqual([])
    // "Loop" is a pack word: 3 is read as a value and flagged against k1 ...
    expect(flagged('Loop 3 pressure is 15.50 MPa ⟦k1⟧.')).toEqual(['3'])
    // ... unless the card's label names it, with the word after it or in parentheses as written.
    const loop: ReadonlyArray<CitedItem> = [{ ...items[0]!, label: 'Loop 3 pressure' }]
    expect(flagged('Loop 3 pressure is 15.50 MPa ⟦k1⟧.', loop)).toEqual([])
    const line: ReadonlyArray<CitedItem> = [{ ...items[1]!, label: 'Ertsmyra trafostasjon 420 kV · Sylling – Tegneby (1)' }]
    expect(flagged('Ertsmyra 420 kV: Sylling–Tegneby (1) is at 112.6 % ⟦k2⟧.', line)).toEqual([])
    // Known risk (E0): a name written otherwise than its label ("circuit 1" for "(1)") and cited to an item with
    // numbers is flagged; the correction then asks for the value as the line reads it.
    expect(flagged('Sylling–Tegneby circuit 1 is at 112.6 % ⟦k2⟧.', line)).toEqual(['1'])
  })

  test('a number is a name when the whole token it forms with the word before it occurs in a card label', () => {
    const speed = (label: string): ReadonlyArray<CitedItem> => [{ key: 'k3', label, reading: '0.0 m/s', numbers: [{ value: 0, decimals: 1 }] }]
    // (1) "A-21" as the label writes it names 21; the speed its line contradicts is still flagged.
    expect(flagged('Unit A-21 runs at 5.0 m/s ⟦k3⟧.', speed('Unit A-21 · Unit A-21 speed'))).toEqual(['5.0'])
    expect(flagged('Unit A-21 runs at 0.0 m/s ⟦k3⟧.', speed('Unit A-21 · Unit A-21 speed'))).toEqual([])
    // (2) The word alone in a label is never enough: "Pump A" does not name 75, so 75 against 72 is flagged.
    const pump: ReadonlyArray<CitedItem> = [{ key: 'k2', label: 'Pump A · speed', reading: '72 %', numbers: [{ value: 72, decimals: 0 }] }]
    expect(flagged('Pump A 75 % ⟦k2⟧.', pump)).toEqual(['75'])
    // A token matches whole: "A-21" is not named by a label "A-210" or "ZA-21".
    expect(flagged('Unit A-21 runs at 0.0 m/s ⟦k3⟧.', speed('Unit A-210 · speed'))).toEqual(['21'])
    expect(flagged('Unit A-21 runs at 0.0 m/s ⟦k3⟧.', speed('Unit ZA-21 · speed'))).toEqual(['21'])
    // (3) "Ambulance 21" names 21 through its label.
    const distance: ReadonlyArray<CitedItem> = [{ key: 'k5', label: 'Ambulance 21 · Distance', reading: '4.2 km', numbers: [{ value: 4.2, decimals: 1 }] }]
    expect(flagged('Ambulance 21 is 4.2 km away ⟦k5⟧.', distance)).toEqual([])
    expect(flagged('Ambulance 21 is 6.0 km away ⟦k5⟧.', distance)).toEqual(['6.0'])
  })

  test('every answer is read in English and Norwegian: only a number both readings flag is a contradiction', () => {
    const reserve: ReadonlyArray<CitedItem> = [{ key: 'k4', label: 'Reserve', reading: '2291 MW', numbers: [{ value: 2291, decimals: 0 }] }]
    expect(flagged('A reserve margin of 2,291 MW ⟦k4⟧.', reserve)).toEqual([])
    expect(flagged('Reservemarginen er 2 291 MW ⟦k4⟧.', reserve)).toEqual([])
    expect(flagged('Trykket er 15,5 MPa ⟦k1⟧.')).toEqual([])
    expect(flagged('A reserve margin of 2,391 MW ⟦k4⟧.', reserve)).toEqual(['2,391'])
    // The fuller reading names the number.
    expect(flagged('Trykket er 17,2 MPa ⟦k1⟧.')).toEqual(['17,2'])
    // One reading alone flags what the other reads as a value: English splits "2 291", Norwegian reads "2,291" as 2.291.
    const byKey = new Map(reserve.map(item => [item.key, item]))
    expect(readingFlags('Reservemarginen er 2 291 MW ⟦k4⟧.', byKey, 'en').map(flag => flag.number)).toEqual(['2', '291'])
    expect(readingFlags('A reserve margin of 2,291 MW ⟦k4⟧.', byKey, 'nb').map(flag => flag.number)).toEqual(['2,291'])
  })
})
