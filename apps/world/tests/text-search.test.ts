import { describe, expect, test } from 'bun:test'
import { editDistance, letters, literalSearchTerms, matchedWords, matchesLiteralSearch, normalized, words } from '../src/core/model/index.ts'

describe('literal World discovery search', () => {
  test('is case and punctuation insensitive while requiring every supplied term', () => {
    expect(literalSearchTerms('RCP running / Unit-2')).toEqual(['rcp', 'running', 'unit', '2'])
    expect(matchesLiteralSearch('RCP running', ['rcpA.running', 'Reactor coolant pump A status'])).toBe(true)
    expect(matchesLiteralSearch('Unit power', ['Halden Unit 2', 'thermal output'])).toBe(false)
  })
})

describe('word matching for near-miss names', () => {
  test('splits ids, tags and labels into words', () => {
    expect(words('sgA.feedwaterFlowKgPerS')).toEqual(['sg', 'a', 'feedwater', 'flow', 'kg', 'per', 's'])
    expect(normalized('SG-A nr_lvl')).toBe('SGANRLVL')
  })

  test('matches each guessed word to one word of a name, by prefix or abbreviation with the same first letter', () => {
    expect(matchedWords(['fw', 'flow'], words('feedwaterFlow'))).toEqual(['fw', 'flow'])
    expect(matchedWords(['lvl'], ['level'])).toEqual(['lvl'])
    expect(matchedWords(['fw', 'flow'], ['flow'])).toHaveLength(1)
    expect(matchedWords(['wf'], ['feedwater'])).toEqual([])
    expect(letters(['sg', 'level'])).toBe(7)
  })

  test('counts edits between two names', () => {
    expect(editDistance('KJOLBERG', 'KJELBERG')).toBe(1)
    expect(editDistance('', 'ABC')).toBe(3)
  })
})
