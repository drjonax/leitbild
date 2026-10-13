import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { uuidV4 } from './people-browser.ts'

describe('screen ids', () => {
  test('are version 4 UUIDs built from getRandomValues, valid where crypto.randomUUID is missing', () => {
    const ids = Array.from({ length: 50 }, () => uuidV4(bytes => crypto.getRandomValues(bytes)))
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(z.uuid().safeParse(id).success).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('set the version and variant bits whatever the random bytes are', () => {
    expect(uuidV4(bytes => bytes.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(uuidV4(bytes => bytes.fill(0))).toBe('00000000-0000-4000-8000-000000000000')
  })
})
