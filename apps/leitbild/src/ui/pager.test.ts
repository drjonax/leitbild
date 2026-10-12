import { describe, expect, test } from 'bun:test'
import { pageIndex, pagerKeyIntent, pagerView } from './pager.ts'

const pages = ['start', 'world', 'plant', 'ai', 'more', 'ask'] as const
const key = (value: string, extra: Partial<Parameters<typeof pagerKeyIntent>[0]> = {}) => ({
  key: value, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: null, ...extra,
})

describe('guide pager', () => {
  test('finds pages by id or number; unknown ids open page 1', () => {
    expect(pageIndex(pages, 'ai')).toBe(3)
    expect(pageIndex(pages, 'nonsense')).toBe(0)
    expect(pageIndex(pages, null)).toBe(0)
    expect(pageIndex(pages, 9)).toBe(5)
    expect(pageIndex(pages, -2)).toBe(0)
    expect(() => pageIndex([], 'start')).toThrow()
  })

  test('describes the neighbours and the position', () => {
    expect(pagerView(pages, 0)).toMatchObject({ id: 'start', previousId: null, nextId: 'world', isFirst: true, isLast: false, position: '1 / 6' })
    expect(pagerView(pages, 5)).toMatchObject({ id: 'ask', previousId: 'more', nextId: null, isLast: true, position: '6 / 6' })
  })

  test('pages with ←/→ only without modifiers and outside fields', () => {
    expect(pagerKeyIntent(key('ArrowLeft'))).toBe('previous')
    expect(pagerKeyIntent(key('ArrowRight'))).toBe('next')
    expect(pagerKeyIntent(key('ArrowRight', { altKey: true }))).toBeNull()
    expect(pagerKeyIntent(key('ArrowRight', { isComposing: true }))).toBeNull()
    expect(pagerKeyIntent(key('ArrowDown'))).toBeNull()
  })
})
