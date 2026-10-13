import { describe, expect, test } from 'bun:test'
import { workspaceActivityCatalogSchema, workspaceSchema, type WorkspaceActivityCatalog } from '@leitbild/contracts'
import { fakeFetch, hostError, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import { ageText } from './launch-workspace.ts'
import {
  ACTIVITY_PATH, activeRowIds, activityByWorkspace, activityFailureText, activitySummary, activityText, createActivityPoller,
  manageRows, moduleStateText, notRecentText, readWorkspaceActivity, selectActiveLabel, withActivityNotes, type ActivityAnswer,
} from './workspace-manage.ts'

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
    expect(moduleStateText(workspaceSchema.parse(workspaceFixture(A, { agents: 'removing' })))).toBe('Deleting…')
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
    expect(ageText(new Date('2026-10-13T12:05:00.000Z'), NOW)).toBe('in 5 min')
    expect(ageText(new Date('2026-10-14T15:00:00.000Z'), NOW)).toBe('in 1 d')
  })
})

describe('the bulk confirmation\'s note', () => {
  test('says how many of the chosen this browser did not open recently', () => {
    expect(notRecentText([{ id: A }, { id: B }, { id: C }], [A])).toBe('2 of these are not among the Workspaces this browser opened recently.')
    expect(notRecentText([{ id: A }, { id: B }], [])).toBe('None of these 2 are among the Workspaces this browser opened recently.')
  })

  test('says nothing for one Workspace, or when all were opened here recently', () => {
    expect(notRecentText([{ id: A }], [])).toBeNull()
    expect(notRecentText([{ id: A }, { id: B }], [B, A])).toBeNull()
  })
})

// Test fixtures only: the labels are whatever a Module says; nothing here knows their keys.
const running = { moduleId: 'world', key: 'simulations-running', label: '2 simulations running', count: 2, active: true }
const total = { moduleId: 'world', key: 'simulations', label: '5 simulations', count: 5, active: false }
const answering = { moduleId: 'agents', key: 'assistant-answering', label: 'Assistant answering', count: 1, active: true }
const catalog = (workspaces: ReadonlyArray<{ readonly workspaceId: string; readonly items: ReadonlyArray<object> }>, failed: ReadonlyArray<string> = []): WorkspaceActivityCatalog =>
  workspaceActivityCatalogSchema.parse({
    modules: ['world', 'agents'].map(moduleId => failed.includes(moduleId)
      ? { moduleId, status: 'failed', failure: { code: 'module_query_failed', message: 'Module activity query returned HTTP 404', status: 404, retryable: false } }
      : { moduleId, status: 'ready' }),
    workspaces,
  })

describe('what runs in each Workspace', () => {
  const rows = manageRows([
    workspace(A, '2026-10-01T09:00:00.000Z', { name: 'Grid study' }),
    workspace(B, '2026-10-13T11:58:30.000Z', { name: 'Plant drill', world: 'provision_failed' }),
    workspace(C, '2026-10-13T09:00:00.000Z', { name: 'Quiet one' }),
  ], { recent: [], now: NOW })
  const byWorkspace = activityByWorkspace(catalog([
    { workspaceId: A, items: [running, total] },
    { workspaceId: C, items: [total] },
    { workspaceId: B, items: [answering] },
  ]))

  test('the summary counts the listed Workspaces with work running now', () => {
    expect(activeRowIds(rows, byWorkspace)).toEqual([B, A])
    expect(activitySummary(2)).toBe('Work is running now in 2 Workspaces')
    expect(activitySummary(1)).toBe('Work is running now in 1 Workspace')
    expect(activitySummary(0)).toBeNull()
    expect(activeRowIds(rows, activityByWorkspace(null))).toEqual([])
    // A Workspace no longer listed is not counted, whatever its Modules still report.
    expect(activeRowIds(rows.filter(row => row.id !== A), byWorkspace)).toEqual([B])
  })

  test('"Select these" names how many it ticks', () => {
    expect(selectActiveLabel(2)).toBe('Select these 2')
    expect(selectActiveLabel(1)).toBe('Select this one')
  })

  test('a row reads its Modules\' own labels in order, and nothing when they report nothing', () => {
    expect(activityText(byWorkspace.get(A))).toBe('2 simulations running · 5 simulations')
    expect(activityText(byWorkspace.get(C))).toBe('5 simulations')
    expect(activityText(activityByWorkspace(catalog([])).get(A))).toBeNull()
  })

  test('the delete dialog notes each Workspace\'s state and activity', () => {
    const noted = withActivityNotes(rows, byWorkspace)
    expect(noted.map(row => [row.label, row.note])).toEqual([
      ['Plant drill', 'Setup failed · Assistant answering'],
      ['Quiet one', '5 simulations'],
      ['Grid study', '2 simulations running · 5 simulations'],
    ])
    const untouched = withActivityNotes(rows, new Map())
    expect(untouched.map(row => row.note)).toEqual(['Setup failed', undefined, undefined])
    expect(untouched[1]).toBe(rows[1]!)
  })

  test('a Module that could not answer is named in one quiet line', () => {
    expect(activityFailureText(catalog([]).modules)).toBeNull()
    expect(activityFailureText(catalog([], ['world']).modules)).toBe("Couldn't check what World is running.")
    expect(activityFailureText(catalog([], ['world', 'agents']).modules)).toBe("Couldn't check what World and Agents are running.")
    expect(activityFailureText([
      { moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } },
      { moduleId: 'agents', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } },
      { moduleId: 'process-plant', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } },
    ] as never)).toBe("Couldn't check what World, Agents and Process plant are running.")
  })

  test('reads the Host\'s activity through the contract and reports a refusal', async () => {
    const answer = catalog([{ workspaceId: A, items: [running] }], ['agents'])
    expect(await readWorkspaceActivity(fakeFetch().on('GET', ACTIVITY_PATH, json(answer)).fetch)).toEqual(answer)
    await expect(readWorkspaceActivity(fakeFetch().on('GET', ACTIVITY_PATH, hostError(500, 'internal_error', 'Internal Workspace Host error')).fetch))
      .rejects.toMatchObject({ status: 500, code: 'internal_error' })
    await expect(readWorkspaceActivity(fakeFetch().on('GET', ACTIVITY_PATH, json({ workspaces: [] })).fetch)).rejects.toThrow()
  })
})

describe('the activity poller', () => {
  const setup = (options: { hidden?: boolean } = {}) => {
    const state = { hidden: options.hidden ?? false, tick: null as (() => void) | null, cancelled: false }
    const pending: Array<{ resolve: (value: WorkspaceActivityCatalog) => void; reject: (error: unknown) => void }> = []
    const answers: ActivityAnswer[] = []
    const poller = createActivityPoller({
      read: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }),
      onanswer: answer => { answers.push(answer) },
      hidden: () => state.hidden,
      every: (ms, tick) => {
        expect(ms).toBe(15_000)
        state.tick = tick
        return () => { state.cancelled = true }
      },
    })
    return { state, pending, answers, poller }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  test('asks at once, then on every tick while the page is visible and nothing is out', async () => {
    const { state, pending, answers, poller } = setup()
    poller.start()
    expect(pending).toHaveLength(1)
    state.tick!()
    expect(pending).toHaveLength(1)
    pending[0]!.resolve(catalog([]))
    await settle()
    expect(answers).toEqual([{ ok: true, catalog: catalog([]) }])
    state.hidden = true
    state.tick!()
    expect(pending).toHaveLength(1)
    state.hidden = false
    state.tick!()
    expect(pending).toHaveLength(2)
  })

  test('a page shown again asks at once; a hidden one does not', () => {
    const { state, pending, poller } = setup({ hidden: true })
    poller.start()
    pending[0]!.resolve(catalog([]))
    poller.visibilityChanged()
    expect(pending).toHaveLength(1)
    state.hidden = false
    poller.visibilityChanged()
    expect(pending).toHaveLength(2)
  })

  test('only the newest request\'s answer is shown, and none after stop', async () => {
    const { state, pending, answers, poller } = setup()
    poller.start()
    poller.refresh()
    pending[1]!.resolve(catalog([{ workspaceId: A, items: [running] }]))
    pending[0]!.resolve(catalog([]))
    await settle()
    expect(answers).toEqual([{ ok: true, catalog: catalog([{ workspaceId: A, items: [running] }]) }])

    poller.refresh()
    pending[2]!.reject(new Error('Failed to fetch'))
    await settle()
    expect(answers[1]).toMatchObject({ ok: false })

    poller.refresh()
    poller.stop()
    expect(state.cancelled).toBe(true)
    pending[3]!.resolve(catalog([]))
    await settle()
    expect(answers).toHaveLength(2)
    poller.refresh()
    expect(pending).toHaveLength(4)
  })
})
