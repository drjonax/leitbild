import { describe, expect, test } from 'bun:test'
import { majority, median, pairedComparison, quantile, wilson } from './stats.ts'

describe('display-eval statistics', () => {
  test('Wilson interval matches the closed form', () => {
    expect(wilson(21, 23)).toEqual({ hits: 21, n: 23, rate: 0.913, low: 0.732, high: 0.976 })
    expect(wilson(0, 6)).toMatchObject({ rate: 0, low: 0 })
    expect(wilson(0, 0)).toEqual({ hits: 0, n: 0, rate: null, low: null, high: null })
    expect(() => wilson(3, 2)).toThrow()
  })

  test('median and nearest-rank quantile', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
  })

  test('a scenario scores the majority of its runs; a tie needs a third run', () => {
    expect(majority([true, true, false])).toBe('pass')
    expect(majority([true, false])).toBe('tie')
    expect(majority([null, false])).toBe('fail')
    expect(majority([null])).toBeNull()
  })

  test('net regression is only-new-fails minus only-new-passes, ties and one-sided items set apart', () => {
    const old = new Map([['a', 'pass'], ['b', 'pass'], ['c', 'fail'], ['d', 'tie'], ['e', 'pass'], ['f', null]] as const)
    const candidate = new Map([['a', 'pass'], ['b', 'fail'], ['c', 'pass'], ['d', 'pass'], ['e', 'fail'], ['f', 'pass']] as const)
    const result = pairedComparison(old, candidate)
    expect(result).toEqual({ onlyNewFails: ['b', 'e'], onlyNewPasses: ['c'], bothPass: 1, bothFail: 0, needsThirdRun: ['d'], unpaired: ['f'], netRegression: 1 })
  })
})
