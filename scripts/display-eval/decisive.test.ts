import { describe, expect, test } from 'bun:test'
import { addedEvidenceUse, displayEvidenceOf, keyNames, scoreKey, vignetteEvidenceOf } from './decisive.ts'
import { referencePlantCatalog } from './plant-catalog.ts'
import { KEY_STATUS, type EvidenceKey } from './scenarios.ts'

const catalog = referencePlantCatalog()
const key = (text: string, signals?: ReadonlyArray<string>, match?: 'any' | 'all'): EvidenceKey =>
  ({ key: text, kind: 'signal', rationale: '', status: KEY_STATUS, use: 'P0', ...(signals === undefined ? {} : { signals }), ...(match === undefined ? {} : { match }) })

// A compose call as the probe reads it: the agent trends SG B level (by tag); World adds feed valve B's position
// (a `cause` row); a mimic draws the AFW header and SG A.
const record = {
  input: {
    plantId: 'plant:halden-2', subjects: ['sgB'],
    panels: [{ kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR' }] }, { kind: 'mimic', around: ['auxFeedwaterHeader'] }],
  },
  result: {
    success: true, viewRef: 'call_1_0/display',
    data: {
      signals: [
        { ref: 'SG-B-LVL-NR', tagId: 'SG-B-LVL-NR', path: 'sgB.levelPercent', name: 'SG-B-LVL-NR' },
        { ref: 'feedwaterControlValveB.effectivePositionFraction', tagId: 'MFW-B-CV-POS', path: 'feedwaterControlValveB.effectivePositionFraction', name: 'MFW-B-CV-POS' },
      ],
      equipment: [{ id: 'auxFeedwaterHeader', label: 'AFW header', state: 'flow' }, { id: 'sgA', label: 'SG A', state: 'filled' }],
      view: { state: JSON.stringify({ evidence: [{ path: 'feedwaterControlValveB.effectivePositionFraction', kind: 'cause', reason: 'command and state disagree' }] }) },
      viewContent: { items: [{ names: ['MFW-B-CV-POS', 'feedwaterControlValveB.effectivePositionFraction'], values: [{ value: 0.3512, unit: 'fraction', decimals: 2 }], limits: [], history: false }] },
    },
  },
}

describe('decisive evidence: semantic and mimic-aware', () => {
  const display = displayEvidenceOf(record)

  test('a key is carried by the agent\'s own pen, by World\'s added row (with its kind), by a drawn component, or by the answer only', () => {
    expect(scoreKey(key('SG B level', ['SG-B-LVL-WR', 'sgB.levelPercent']), display, '', catalog)).toMatchObject({ hit: true, by: 'agent' })
    expect(scoreKey(key('feed valve B', ['MFW-B-CV-POS']), display, '', catalog)).toMatchObject({ hit: true, by: 'world', hits: [{ name: 'MFW-B-CV-POS', by: 'world', worldKind: 'cause' }] })
    expect(scoreKey(key('AFW flow', ['AFW-FLOW']), display, '', catalog)).toMatchObject({ hit: true, by: 'mimic' })
    expect(scoreKey(key('SG A level', ['SG-A-LVL-NR']), display, '', catalog)).toMatchObject({ hit: true, by: 'mimic' })
    expect(scoreKey(key('pressure', ['PT-455']), display, 'PT-455 reads 15.5 MPa.\n```leitbild-view\nview call_1_0/display\n```', catalog)).toMatchObject({ hit: true, by: 'answer' })
    expect(scoreKey(key('pressure', ['PT-455']), display, 'Pressure is steady.', catalog)).toMatchObject({ hit: false, hits: [] })
  })

  test('an all-of key needs every name; without a display only the answer can carry a key', () => {
    expect(scoreKey(key('SG A and B levels', ['SG-A-LVL-NR', 'SG-B-LVL-NR'], 'all'), display, '', catalog).hit).toBe(true)
    expect(scoreKey(key('all four', ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR'], 'all'), display, '', catalog).hit).toBe(false)
    expect(scoreKey(key('SG B level', ['SG-B-LVL-NR']), null, 'SG-B-LVL-NR is 40 %.', catalog)).toMatchObject({ hit: true, by: 'answer' })
  })

  test('names inside free text are read with the Plant catalogue; a stale name is reported, not matched', () => {
    expect(keyNames(key('SG-A-LVL-NR, SG-C-LVL-NR or SG-D-LVL-NR as counter-evidence'), catalog)).toEqual(['SG-A-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'])
    expect(keyNames(key('P-14 at 82 % NR named as the limit ahead'), catalog)).toEqual([])
    expect(scoreKey(key('leak', ['SG-A-TUBE-LEAK']), display, '', catalog)).toMatchObject({ hit: false, unknown: ['SG-A-TUBE-LEAK'] })
  })

  test('a World vignette carries a key by its state refs, its topology bindings, or an element its topology draws', () => {
    const vignette = {
      input: { subjects: ['plant:halden-2'], views: [{ kind: 'topology', around: ['feedwaterControlValveB'] }] },
      result: { success: true, viewRef: 'call_1_0/v', data: {
        view: { state: JSON.stringify({ views: [{ kind: 'values', refs: ['plant:halden-2#sgB.levelPercent'] }, { kind: 'topology', objectId: 'plant:halden-2', request: { around: ['feedwaterControlValveB'] } }] }) },
        card: { items: [] },
      } },
    }
    const view = { sections: [{ kind: 'topology', nodes: [{ id: 'n1', element: 'mainFeedwaterPumpA', bindings: [{ ref: 'plant:halden-2#feedwaterControlValveB.effectivePositionFraction' }] }], edges: [] }] }
    const shown = vignetteEvidenceOf(vignette, view)
    expect(scoreKey(key('SG B level', ['SG-B-LVL-NR']), shown, '', catalog)).toMatchObject({ hit: true, by: 'world' })
    expect(scoreKey(key('feed valve B', ['MFW-B-CV-POS']), shown, '', catalog)).toMatchObject({ hit: true })
    expect(scoreKey(key('MFW pump A running', ['mainFeedwaterPumpA.runningState']), shown, '', catalog)).toMatchObject({ hit: true, by: 'mimic' })
    // Without the compiled view only the state's refs count.
    expect(scoreKey(key('feed valve B', ['MFW-B-CV-POS']), vignetteEvidenceOf(vignette), '', catalog).hit).toBe(false)
  })

  test('claim and absence keys wait for a judge', () => {
    expect(scoreKey({ ...key('names the cause'), kind: 'claim' }, display, 'anything', catalog)).toMatchObject({ hit: null })
  })

  test('World-added values are counted by kind with whether the answer cites them', () => {
    const path = 'feedwaterControlValveB.effectivePositionFraction'
    expect(addedEvidenceUse(display, 'Feed valve B (MFW-B-CV-POS) stands at 35 %.')).toEqual([{ kind: 'cause', path, cited: true, citedBy: 'name' }])
    expect(addedEvidenceUse(display, 'Feed valve B stands at 0.35 open.')).toEqual([{ kind: 'cause', path, cited: true, citedBy: 'value' }])
    expect(addedEvidenceUse(display, 'Level falls by 10.35 %.')).toEqual([{ kind: 'cause', path, cited: false }])
  })
})

describe('a vignette over a set of units (fork, multiunit T7.1)', () => {
  const compare = vignetteEvidenceOf({
    input: { subjects: [], views: [{ kind: 'compare', of: { category: 'process-plants', group: 'halden-power-complex' }, signals: ['Pressurizer pressure'] }] },
    result: { success: true, viewRef: 'call_1_0/v1', data: { view: { state: JSON.stringify({ views: [{ kind: 'compare', of: { packId: 'process-plant', categoryId: 'process-plants', group: 'halden-power-complex' }, signals: [{ ref: 'pressurizer.pressureMPa', label: 'Pressurizer pressure' }], rows: 13 }] }) }, card: { items: [] } } },
  })

  test('carries each compared quantity on every member and the set itself', () => {
    expect(scoreKey(key('pressurizer pressure', ['PT-455']), compare, '', catalog)).toMatchObject({ hit: true })
    expect(scoreKey(key('the set', ['of:process-plant/process-plants']), compare, '', catalog)).toMatchObject({ hit: true })
    expect(scoreKey(key('SG A level', ['SG-A-LVL-NR']), compare, '', catalog).hit).toBe(false)
    expect([...compare.objects!]).toEqual(['of:process-plant/process-plants'])
  })
})
