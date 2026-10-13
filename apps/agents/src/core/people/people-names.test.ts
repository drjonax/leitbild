import { describe, expect, test } from 'bun:test'
import { allocateDefaultPersonName, normalisePersonName, personNameKey } from './people-names.ts'

const accepted = (raw: string) => {
  const result = normalisePersonName(raw)
  if (!result.ok) throw new Error(`expected ${JSON.stringify(raw)} to be accepted, got ${result.reason}`)
  return result
}
const rejected = (raw: string) => {
  const result = normalisePersonName(raw)
  if (result.ok) throw new Error(`expected ${JSON.stringify(raw)} to be rejected, got ${result.name}`)
  return result.reason
}

describe('Person names', () => {
  test('applies NFKC, trims and collapses runs of spaces to one', () => {
    expect(accepted('  Ｂｅｎ   Ｏｌｓｅｎ ').name).toBe('Ben Olsen')
    expect(accepted('Ben\u00a0\u3000 Olsen').name).toBe('Ben Olsen')
    // NFKC folds the ligature, so the stored name is plain text.
    expect(accepted('ﬁona').name).toBe('fiona')
    expect(accepted('Åse').name).toBe('Åse'.normalize('NFKC'))
  })

  test('keys uniqueness on the normalised name, lower-cased without a locale', () => {
    expect(accepted('BEN').key).toBe('ben')
    expect(accepted('Ｂｅｎ').key).toBe(accepted('ben').key)
    expect(personNameKey('İstanbul')).toBe('İstanbul'.toLowerCase())
  })

  test('rejects empty names, also after normalisation', () => {
    expect(rejected('')).toBe('empty')
    expect(rejected('   ')).toBe('empty')
    expect(rejected('\u3000')).toBe('empty')
  })

  test('limits a name to 32 code points, counting astral characters once', () => {
    expect(accepted('a'.repeat(32)).name).toHaveLength(32)
    expect(rejected('a'.repeat(33))).toBe('too_long')
    const emoji = '🙂'.repeat(32)
    expect(accepted(emoji).name).toBe(emoji)
    expect(rejected('🙂'.repeat(33))).toBe('too_long')
  })

  test('rejects zero-width, bidi-override, control, separator, private-use and unassigned characters', () => {
    for (const raw of [
      'Ben\u200b', // zero-width space
      'Be\u200dn', // zero-width joiner
      'Be\u200cn', // zero-width non-joiner
      '\ufeffBen', // byte order mark
      'Ben\u202eevil', // right-to-left override
      'Ben\u2066x\u2069', // isolates
      'Ben\u0000',
      'Ben\nOlsen',
      'Ben\tOlsen',
      'Ben\u2028Olsen', // line separator
      'Ben\u2029Olsen', // paragraph separator
      'Ben\ue000', // private use
      'Ben\ud800', // lone surrogate
      'Ben\u0378', // unassigned
      'Ben\u034f', // combining grapheme joiner
      'Ben\ufe00', // variation selector
      'Ben\u{e0100}', // variation selector supplement
      'Ben\u180b', // Mongolian free variation selector
      'Ben\u115f', // Hangul choseong filler
      'Ben\u1160', // Hangul jungseong filler
      '\u2764\ufe0f', // red heart with VS16: refused with the variation selectors
    ]) expect(rejected(raw)).toBe('invalid_characters')
  })

  test('rejects a name that shows nothing, however it is made', () => {
    expect(rejected('\u3164')).toBe('invalid_characters') // Hangul filler
    expect(rejected('\u3164\u3164 \u3164')).toBe('invalid_characters')
    expect(rejected('\u2800')).toBe('invalid_characters') // Braille blank
    expect(rejected('\u2800 \u2800')).toBe('invalid_characters')
    expect(rejected('\u0301')).toBe('invalid_characters') // a lone combining mark
  })

  test('accepts letters, numbers, punctuation and plain emoji', () => {
    expect(accepted('Anna \u{1f680}').name).toBe('Anna \u{1f680}')
    expect(accepted('\u{1f680}').name).toBe('\u{1f680}')
    expect(accepted('Ben (turbine)').name).toBe('Ben (turbine)')
    expect(accepted('\u00d8yvind-7').name).toBe('\u00d8yvind-7')
    expect(accepted('\u674e\u96f7').name).toBe('\u674e\u96f7')
    expect(accepted('\u2800x').name).toBe('\u2800x')
  })

  test('allocates the lowest free User<N>, skipping taken names case-insensitively', () => {
    expect(allocateDefaultPersonName(new Set())).toBe('User1')
    expect(allocateDefaultPersonName(new Set(['user1', 'user2', 'user4']))).toBe('User3')
    expect(allocateDefaultPersonName(new Set([accepted('USER1').key]))).toBe('User2')
  })
})
