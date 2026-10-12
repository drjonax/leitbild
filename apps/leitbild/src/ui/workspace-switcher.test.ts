import { describe, expect, test } from 'bun:test'
import {
  filterRows, matchCountText, SWITCHER_FOOTNOTE, SWITCHER_INTRO, switcherGroups, switcherKeyTarget, switcherRow,
} from './workspace-switcher.ts'

const A = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const B = 'b56b1d2e-0000-4000-8000-00000000000b'
const C = '0b4b9a52-2f7e-4c1a-9d3e-00000000000c'
const GONE = '0b4b9a52-2f7e-4c1a-9d3e-0000000000ff'
const workspaces = [
  { id: A, name: 'Grid study', createdAt: '2026-10-02T10:00:00.000Z' },
  { id: B, name: null, createdAt: '2026-10-12T21:00:00.000Z' },
  { id: C, name: 'einsatz trial', createdAt: '2026-09-30T10:00:00.000Z' },
]

describe('switcher rows', () => {
  test('never shows a raw id as the label (C13)', () => {
    const row = switcherRow(workspaces[1]!, null)
    expect(row).toMatchObject({ label: 'Untitled · b56b1d', untitled: true, initial: 'U' })
    expect(row.label).not.toContain(B)
    expect(switcherRow(workspaces[2]!, null).initial).toBe('E')
  })

  test('says when a Workspace was created, in the copy style', () => {
    expect(switcherRow({ id: A, name: 'x', createdAt: new Date(2026, 9, 12, 22, 41).toISOString() }, null).meta).toBe('Created 12 Oct')
  })

  test('recent rows keep this browser’s order and drop Workspaces that no longer exist', () => {
    const groups = switcherGroups(workspaces, { recent: [C, GONE, A], current: A })
    expect(groups.recent.map(row => row.id)).toEqual([C, A])
    expect(groups.recent.find(row => row.id === A)?.current).toBe(true)
  })

  test('the public list holds every Workspace, newest first', () => {
    expect(switcherGroups(workspaces, { recent: [], current: null }).all.map(row => row.id)).toEqual([B, A, C])
  })

  test('search matches names case-insensitively, and the short id of an unnamed one', () => {
    const { all } = switcherGroups(workspaces, { recent: [], current: null })
    expect(filterRows(all, 'GRID').map(row => row.id)).toEqual([A])
    expect(filterRows(all, 'b56b1d').map(row => row.id)).toEqual([B])
    expect(filterRows(all, '  ')).toHaveLength(3)
  })

  test('announces the result count', () => {
    expect(matchCountText(0)).toBe('No Workspace matches')
    expect(matchCountText(1)).toBe('1 Workspace matches')
    expect(matchCountText(3)).toBe('3 Workspaces match')
  })
})

describe('switcher copy and keys', () => {
  test('explains Workspaces and says they are public and deletable (C2)', () => {
    expect(SWITCHER_INTRO).toContain('Starting a demo creates one')
    expect(SWITCHER_FOOTNOTE).toBe('Workspaces are public: anyone can see, open, change or delete them.')
  })

  test('↑/↓ move between the search field and rows; Home/End jump', () => {
    expect(switcherKeyTarget('ArrowDown', -1, 4)).toBe(0)
    expect(switcherKeyTarget('ArrowDown', 3, 4)).toBe(3)
    expect(switcherKeyTarget('ArrowUp', 2, 4)).toBe(1)
    expect(switcherKeyTarget('ArrowUp', 0, 4)).toBe(0)
    expect(switcherKeyTarget('End', 0, 4)).toBe(3)
    expect(switcherKeyTarget('Home', 3, 4)).toBe(0)
    expect(switcherKeyTarget('a', 0, 4)).toBeNull()
    expect(switcherKeyTarget('ArrowDown', -1, 0)).toBeNull()
  })
})
