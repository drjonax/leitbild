import { describe, expect, test } from 'bun:test'
import { rescoreRow, type Recorded } from './rescore.ts'
import { KEY_STATUS, type EvalScenario, type EvidenceKey } from './scenarios.ts'

const key = (text: string, signals: ReadonlyArray<string>): EvidenceKey => ({ key: text, kind: 'signal', signals, rationale: '', status: KEY_STATUS, use: 'P0' })
const scenario: EvalScenario = {
  id: 'x', prompt: 'Unit 2: SG B level?', expect: 'display', fault: { actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, advanceMinutes: 3,
  set: 'holdout', flaky: false, evidence: [key('SG B level', ['SG-B-LVL-NR'])],
}
const recorded: Recorded = {
  scenario,
  row: { id: 'x', decisivePass: true } as never,
  answer: { content: 'Level falls.\n```leitbild-view\nview call_1_0/display\n```' },
  composes: [{
    input: { panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR' }] }] },
    result: { success: true, viewRef: 'call_1_0/display', data: { signals: [{ ref: 'SG-B-LVL-NR', tagId: 'SG-B-LVL-NR', path: 'sgB.levelPercent' }], equipment: [], view: { state: '{}' } } },
  }],
}

describe('re-scoring a recorded stage with corrected keys', () => {
  test('a corrected key is scored from the recorded display, with no new run', () => {
    const corrected = { ...scenario, evidence: [key('SG B level', ['SG-B-LVL-NR']), key('feed valve B', ['MFW-B-CV-POS'])] }
    expect(rescoreRow(recorded, corrected)).toMatchObject({ decisiveSignalKeys: 2, decisiveSignalHits: 1, decisivePass: false })
  })

  test('a changed prompt or parameter needs a new run', () => {
    expect(rescoreRow(recorded, { ...scenario, prompt: 'Unit 2: SG B level now?' })).toBeNull()
    expect(rescoreRow(recorded, { ...scenario, advanceMinutes: 4 })).toBeNull()
  })
})
