import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parityCases } from './fixtures/diagram-parity/cases.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T02, geometry identity: the same intents, scopes and windows draw byte for
// byte what expected.json recorded. A commit that changes a drawing on
// purpose rewrites the file (write-expected.ts) and names the drawings it
// changed and why; any other difference is a regression.
const expected = JSON.parse(readFileSync(new URL('./fixtures/diagram-parity/expected.json', import.meta.url), 'utf8')) as Record<string, string>
const cases = parityCases()

describe('drawings keep their geometry', () => {
  test('every recorded drawing is still a case, and every case is recorded', () => {
    const keys = new Set(cases.map(entry => entry.key))
    expect(keys.size).toBe(cases.length)
    expect(Object.keys(expected).filter(key => !keys.has(key))).toEqual([])
    expect(cases.filter(entry => expected[entry.key] === undefined).map(entry => entry.key)).toEqual([])
  })

  for (const family of ['probe', 'sweep', 'overview', 'detail']) {
    test(`${family}: draws as recorded`, () => {
      const changed = cases
        .filter(entry => entry.key.startsWith(`${family} `))
        .flatMap(entry => {
          const record = entry.record()
          return record === expected[entry.key] ? [] : [{ key: entry.key, expected: expected[entry.key], record }]
        })
      expect(changed).toEqual([])
    })
  }
})
