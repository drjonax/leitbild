import { describe, expect, test } from 'bun:test'
import { assignWords, editDistance, letters, literalSearchTerms, matchedWords, matchesLiteralSearch, normalized, wordMatch, words } from '../src/core/model/index.ts'

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

describe('graded word matching for Run-wide search', () => {
  const word = (spelling: string, abbreviates = false) => ({ spellings: [spelling], abbreviates })
  test('grades the same word (plurals aside), a prefix and an abbreviation', () => {
    expect([wordMatch('pressure', word('pressure')), wordMatch('pumps', word('pump')), wordMatch('buses', word('bus'))]).toEqual([3, 3, 3])
    expect(wordMatch('feed', word('feedwater'))).toBe(2)
    expect(wordMatch('fw', word('feedwater'))).toBe(1)
  })

  test('a name\'s word abbreviates a query word only as a tag, beginning it or keeping half its letters', () => {
    expect(wordMatch('skogssater', word('soa'))).toBe(0)
    expect(wordMatch('skagerrak', word('sg', true))).toBe(0)
    expect(wordMatch('pressure', word('per'))).toBe(0)
    expect([wordMatch('pressure', word('press', true)), wordMatch('position', word('pos', true)), wordMatch('level', word('lvl', true))]).toEqual([1, 1, 1])
  })

  test('assigns query words one-to-one, exact matches before abbreviations', () => {
    expect(assignWords(['flow', 'fw'], [word('flow'), word('feedwater')])).toEqual([{ word: 0, quality: 3 }, { word: 1, quality: 1 }])
    expect(assignWords(['fw', 'flow'], [word('flow')])).toEqual([null, { word: 0, quality: 3 }])
  })
})

