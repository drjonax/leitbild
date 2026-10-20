import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rowCases } from './fixtures/mimic-row-identity/cases.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// T02, row identity: every item binds and writes what expected.json recorded,
// every stub and pipe too, item by item, so a difference names what moved. A
// commit that changes rows on purpose rewrites the file (write-expected.ts)
// and lists each change and why (R15); any other difference is a regression.
const expected = JSON.parse(readFileSync(new URL('./fixtures/mimic-row-identity/expected.json', import.meta.url), 'utf8')) as Record<string, string>
const cases = rowCases()

describe('drawn items keep their bindings and rows', () => {
  test('every recorded case is still a case, and every case is recorded', () => {
    expect(Object.keys(expected).filter(key => !cases.some(entry => entry.key === key))).toEqual([])
    expect(cases.filter(entry => expected[entry.key] === undefined).map(entry => entry.key)).toEqual([])
  })

  for (const family of ['probe', 'overview', 'detail', 'tag display']) {
    test(`${family}: binds and writes as recorded`, () => {
      const changed = cases.filter(entry => entry.key.startsWith(`${family} `)).flatMap(entry => {
        const record = entry.record()
        if (record === expected[entry.key]) return []
        const was = new Set(expected[entry.key]!.split(' '))
        const now = new Set(record.split(' '))
        return [{ key: entry.key, gone: [...was].filter(part => !now.has(part)), new: [...now].filter(part => !was.has(part)) }]
      })
      expect(changed).toEqual([])
    })
  }
})
