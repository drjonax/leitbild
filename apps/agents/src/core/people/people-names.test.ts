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
    expect(accepted('Ben 　 Olsen').name).toBe('Ben Olsen')
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
    expect(rejected('　')).toBe('empty')
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
      'Ben​', // zero-width space
      'Be‍n', // zero-width joiner
      'Be‌n', // zero-width non-joiner
      '﻿Ben', // byte order mark
      'Ben‮evil', // right-to-left override
      'Ben⁦x⁩', // isolates
      'Ben\u0000',
      'Ben\nOlsen',
      'Ben\tOlsen',
      'Ben Olsen', // line separator
      'Ben Olsen', // paragraph separator
      'Ben', // private use
      'Ben\ud800', // lone surrogate
      'Ben͸', // unassigned
    ]) expect(rejected(raw)).toBe('invalid_characters')
  })

  test('allocates the lowest free User<N>, skipping taken names case-insensitively', () => {
    expect(allocateDefaultPersonName(new Set())).toBe('User1')
    expect(allocateDefaultPersonName(new Set(['user1', 'user2', 'user4']))).toBe('User3')
    expect(allocateDefaultPersonName(new Set([accepted('USER1').key]))).toBe('User2')
  })
})
