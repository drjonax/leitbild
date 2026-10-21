import { describe, expect, test } from 'bun:test'
import { KEY_STATUS, type EvidenceKey } from './scenarios.ts'
import { worryVerdict } from './worry.ts'

// Made-up keys on dev-set equipment: the worry set's own keys are private (plan v3.1 §6).
const claim = (patterns: ReadonlyArray<string>): EvidenceKey => ({ key: 'names the SG B feed valve runback', kind: 'claim', rationale: '', status: KEY_STATUS, use: 'P1+', patterns })
const absence = (patterns: ReadonlyArray<string>): EvidenceKey => ({ key: 'calls no other generator abnormal', kind: 'absence', rationale: '', status: KEY_STATUS, use: 'P1+', patterns })
const keys = [claim(['SG B|steam generator B', 'valve|ventil', 'run ?back|35 ?%']), absence(['SG [ACD]|steam generators? [ACD]', 'low|falling|abnormal|lav|synker'])]

describe('the worry verdict (G1)', () => {
  test('a claim holds when one clause, read with the next, matches every pattern', () => {
    expect(worryVerdict(keys, 'SG B: its feed valve ran back to 35 %. The other three generators hold level.').pass).toBe(true)
    // A bullet's label and its text are one claim.
    expect(worryVerdict(keys, '- **Steam generator B**\n- feed valve runback to 35 %').pass).toBe(true)
    // The parts scattered over the answer are no claim.
    expect(worryVerdict(keys, 'SG B level is falling. Unit 2 power is steady. Turbine load is normal. A valve on loop C is shut.').keys[0]!.hit).toBe(false)
  })

  test('an absence breaks only on an affirmative clause; a denial or a condition asserts nothing', () => {
    expect(worryVerdict(keys, 'SG B feed valve runback to 35 %. SG A, C and D are not low.').pass).toBe(true)
    expect(worryVerdict(keys, 'SG B feed valve runback to 35 %. If it goes on, SG A could fall too.').pass).toBe(true)
    expect(worryVerdict(keys, 'SG B feed valve runback to 35 %. Ingen av SG A, C eller D er lav.').pass).toBe(true)
    expect(worryVerdict(keys, 'SG B feed valve runback to 35 %. SG A, C and D show zero low-level alarms.').pass).toBe(true)
    const broken = worryVerdict(keys, 'SG B feed valve runback to 35 %. SG C level is low as well.')
    expect(broken.pass).toBe(false)
    expect(broken.keys[1]).toMatchObject({ kind: 'absence', hit: false, clauses: ['SG C level is low as well.'] })
  })

  test('a ranking rule holds when the claim comes before what its then-patterns name, or they are not named', () => {
    const ranked: EvidenceKey = { ...claim(['SG B', 'runback']), then: ['turbine', 'vibration'] }
    expect(worryVerdict([ranked], '1. SG B feed runback, level falling.\n2. Turbine vibration high.').pass).toBe(true)
    expect(worryVerdict([ranked], '1. Turbine vibration high.\n2. SG B feed runback, level falling.').pass).toBe(false)
    expect(worryVerdict([ranked], 'Turbine vibration is high, and SG B has a feed runback.').pass).toBe(false)
    expect(worryVerdict([ranked], 'SG B has a feed runback; turbine vibration is high too.').pass).toBe(true)
    expect(worryVerdict([ranked], 'SG B feed runback.').pass).toBe(true)
  })

  test('view fences are no answer text, and a set without pattern keys never passes', () => {
    expect(worryVerdict(keys, '```leitbild-view\nview SG B feed valve runback\n```').pass).toBe(false)
    const { patterns: _patterns, ...unpatterned } = keys[0]!
    expect(worryVerdict([unpatterned], 'SG B feed valve runback to 35 %.')).toEqual({ keys: [], pass: false })
  })
})
