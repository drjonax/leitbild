import { expect, test } from 'bun:test'
import { composingKeystroke } from './ime.ts'

test('a keystroke inside an IME composition, or Safari\'s keyCode 229 that ends one, never submits', () => {
  expect(composingKeystroke({ isComposing: true, keyCode: 13 })).toBe(true)
  expect(composingKeystroke({ isComposing: false, keyCode: 229 })).toBe(true)
  expect(composingKeystroke({ isComposing: false, keyCode: 13 })).toBe(false)
})
