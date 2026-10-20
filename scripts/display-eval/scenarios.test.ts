import { describe, expect, test } from 'bun:test'
import { allScenarios, devScenarios, FLAKY_SCENARIO_IDS, KEY_STATUS, NEAR_DUPLICATES } from './scenarios.ts'
import { keyNames } from './decisive.ts'
import { referencePlantCatalog } from './plant-catalog.ts'

const catalog = referencePlantCatalog()

describe('display evaluation scenarios', () => {
  test('31 scenarios: 24 dev, 7 near-duplicates of dev scenarios', () => {
    expect(allScenarios).toHaveLength(31)
    expect(new Set(allScenarios.map(scenario => scenario.id)).size).toBe(31)
    expect(devScenarios).toHaveLength(24)
    expect(Object.keys(NEAR_DUPLICATES)).toHaveLength(7)
    for (const [id, { of }] of Object.entries(NEAR_DUPLICATES)) {
      expect(allScenarios.find(scenario => scenario.id === id)?.set).toBe('near-duplicate')
      expect(devScenarios.some(scenario => scenario.id === of)).toBe(true)
    }
  })

  test('every pre-named flaky scenario runs in the dev set, and only those are flagged', () => {
    expect(FLAKY_SCENARIO_IDS.size).toBe(7)
    for (const id of FLAKY_SCENARIO_IDS) expect(devScenarios.find(scenario => scenario.id === id)?.flaky).toBe(true)
    expect(allScenarios.filter(scenario => scenario.flaky).map(scenario => scenario.id).sort()).toEqual([...FLAKY_SCENARIO_IDS].sort())
  })

  test('every key is AI-drafted pending the SME, and every signal key names signals the Plant has', () => {
    for (const scenario of allScenarios) {
      for (const key of scenario.evidence) {
        expect(key.status).toBe(KEY_STATUS)
        if (key.kind !== 'signal') continue
        const names = keyNames(key, catalog)
        expect({ scenario: scenario.id, key: key.key, stale: names.filter(name => catalog.signal(name) === undefined) }).toEqual({ scenario: scenario.id, key: key.key, stale: [] })
        expect(names.length).toBeGreaterThan(0)
      }
    }
  })

  test('every dev scenario that expects a display has a scored signal key', () => {
    for (const scenario of devScenarios.filter(entry => entry.expect === 'display')) {
      expect({ id: scenario.id, signalKeys: scenario.evidence.filter(key => key.kind === 'signal' && key.use === 'P0').length > 0 }).toEqual({ id: scenario.id, signalKeys: true })
    }
  })
})
