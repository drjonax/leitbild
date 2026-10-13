import { describe, expect, test } from 'bun:test'
import { workspaceSchema } from '@leitbild/contracts'
import { workspaceFixture } from './host-fetch-fake.test-support.ts'
import { ageText } from './launch-workspace.ts'
import { manageRows, moduleStateText } from './workspace-manage.ts'

const A = '0b4b9a52-2f7e-4c1a-9d3e-00000000000a'
const B = 'b56b1d2e-0000-4000-8000-00000000000b'
const C = '0b4b9a52-2f7e-4c1a-9d3e-00000000000c'
const NOW = new Date('2026-10-13T12:00:00.000Z')

const workspace = (id: string, createdAt: string, overrides: Parameters<typeof workspaceFixture>[1] = {}) =>
  workspaceSchema.parse({ ...workspaceFixture(id, overrides), createdAt, updatedAt: createdAt })

describe('manage rows', () => {
  test('lists every Workspace newest first, never with a raw id as its name', () => {
    const rows = manageRows([
      workspace(A, '2026-10-01T09:00:00.000Z', { name: 'Grid study' }),
      workspace(B, '2026-10-13T11:58:30.000Z', { name: null }),
      workspace(C, '2026-10-13T09:00:00.000Z', { name: 'New Workspace · 13 Oct, 11:00' }),
    ], { recent: [C], now: NOW })
    expect(rows.map(row => row.id)).toEqual([B, C, A])
    expect(rows[0]).toMatchObject({ key: B, label: 'Untitled · b56b1d', untitled: true, created: 'Created 1 min ago', recent: false })
    expect(rows[1]).toMatchObject({ label: 'New Workspace · 13 Oct, 11:00', created: 'Created 3 h ago', recent: true })
    expect(rows[2]).toMatchObject({ created: 'Created 12 d ago', untitled: false })
    expect(rows.every(row => row.note === undefined)).toBe(true)
  })

  test('a Workspace whose delete did not finish, or whose setup failed, says so', () => {
    const stuck = workspaceSchema.parse({
      ...workspaceFixture(A),
      modules: [
        { moduleId: 'world', status: 'remove_failed', updatedAt: '2026-10-12T20:41:00.000Z', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } },
        { moduleId: 'agents', status: 'ready', updatedAt: '2026-10-12T20:41:00.000Z' },
      ],
    })
    expect(moduleStateText(stuck)).toBe('Delete did not finish')
    expect(moduleStateText(workspaceSchema.parse(workspaceFixture(A, { world: 'provision_failed' })))).toBe('Setup failed')
    expect(moduleStateText(workspaceSchema.parse(workspaceFixture(A, { agents: 'provisioning' })))).toBe('Setting up')
    expect(moduleStateText(workspaceSchema.parse(workspaceFixture(A)))).toBeNull()
    expect(manageRows([stuck], { recent: [], now: NOW })[0]?.note).toBe('Delete did not finish')
  })

  test('ages read in minutes, hours and days, then as a date', () => {
    expect(ageText(new Date('2026-10-13T11:59:40.000Z'), NOW)).toBe('just now')
    expect(ageText(new Date('2026-10-13T11:15:00.000Z'), NOW)).toBe('45 min ago')
    expect(ageText(new Date('2026-10-12T13:00:00.000Z'), NOW)).toBe('23 h ago')
    expect(ageText(new Date('2026-09-13T12:00:00.000Z'), NOW)).toBe('30 d ago')
    expect(ageText(new Date(2026, 7, 2, 12), NOW)).toBe('on 2 Aug')
  })
})
