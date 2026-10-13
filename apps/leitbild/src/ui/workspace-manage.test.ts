import { describe, expect, test } from 'bun:test'
import { workspaceActivityCatalogSchema, workspaceSchema, type WorkspaceActivityCatalog } from '@leitbild/contracts'
import { workspaceFixture } from './host-fetch-fake.test-support.ts'
import { ageText } from './launch-workspace.ts'
import {
  ACTIVITY_CHECKING_TEXT, ACTIVITY_UNAVAILABLE_TEXT, activityHead, activityText, createActivityPoller, manageRows, moduleStateText,
  nextActivity, NOTHING_RUNNING_TEXT, notRecentText, selectActiveLabel, withActivityNotes, type ActivityAnswer,
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
const failure = { code: 'module_query_failed', message: 'Module activity query returned HTTP 404', status: 404, retryable: false }
const catalog = (workspaces: ReadonlyArray<{ readonly workspaceId: string; readonly items: ReadonlyArray<object> }>, failed: ReadonlyArray<string> = []): WorkspaceActivityCatalog =>
  workspaceActivityCatalogSchema.parse({
    modules: ['world', 'agents'].map(moduleId => failed.includes(moduleId) ? { moduleId, status: 'failed', failure } : { moduleId, status: 'ready' }),
    workspaces,
  })
const ok = (value: WorkspaceActivityCatalog): ActivityAnswer => ({ ok: true, catalog: value })
const at = (hours: number, minutes: number) => new Date(2026, 9, 13, hours, minutes)
const labels = (shown: ReturnType<typeof nextActivity>, id: string) => (shown.byWorkspace.get(id) ?? []).map(item => `${item.label}${item.stale ? ' (stale)' : ''}`)

describe('what runs in each Workspace', () => {
  const rows = manageRows([
    workspace(A, '2026-10-01T09:00:00.000Z', { name: 'Grid study' }),
    workspace(B, '2026-10-13T11:58:30.000Z', { name: 'Plant drill', world: 'provision_failed' }),
    workspace(C, '2026-10-13T09:00:00.000Z', { name: 'Quiet one' }),
  ], { recent: [], now: NOW })
  const busy = nextActivity(null, ok(catalog([
    { workspaceId: A, items: [running, total] },
    { workspaceId: C, items: [total] },
    { workspaceId: B, items: [answering] },
  ])), at(23, 41))

  test('the summary counts the listed Workspaces with work running now, and "Select these" ticks exactly those', () => {
    expect(activityHead(rows, busy)).toEqual({ activeIds: [B, A], summary: { text: 'Work is running now in 2 Workspaces', active: true, current: true }, problem: null })
    // A Workspace no longer listed is not counted, whatever its Modules still report.
    expect(activityHead(rows.filter(row => row.id !== A), busy).summary?.text).toBe('Work is running now in 1 Workspace')
    expect(selectActiveLabel(2)).toBe('Select these 2')
    expect(selectActiveLabel(1)).toBe('Select this one')
  })

  test('the line above the list is always there: checking, nothing running, or running work', () => {
    expect(activityHead(rows, null)).toEqual({ activeIds: [], summary: { text: ACTIVITY_CHECKING_TEXT, active: false, current: false }, problem: null })
    const quiet = nextActivity(null, ok(catalog([{ workspaceId: C, items: [total] }])), at(23, 41))
    expect(activityHead(rows, quiet)).toEqual({ activeIds: [], summary: { text: NOTHING_RUNNING_TEXT, active: false, current: true }, problem: null })
  })

  test('a row reads its Modules\' own labels in installed-Module order, and nothing when they report nothing', () => {
    expect(activityText(busy.byWorkspace.get(A))).toBe('2 simulations running · 5 simulations')
    expect(activityText(busy.byWorkspace.get(C))).toBe('5 simulations')
    expect(activityText(busy.byWorkspace.get('elsewhere'))).toBeNull()
    const both = nextActivity(null, ok(catalog([{ workspaceId: A, items: [running, answering] }])), at(23, 41))
    expect(activityText(both.byWorkspace.get(A))).toBe('2 simulations running · Assistant answering')
  })

  test('the delete dialog notes each Workspace\'s state and activity', () => {
    const noted = withActivityNotes(rows, busy.byWorkspace)
    expect(noted.map(row => [row.label, row.note])).toEqual([
      ['Plant drill', 'Setup failed · Assistant answering'],
      ['Quiet one', '5 simulations'],
      ['Grid study', '2 simulations running · 5 simulations'],
    ])
    const untouched = withActivityNotes(rows, new Map())
    expect(untouched.map(row => row.note)).toEqual(['Setup failed', undefined, undefined])
    expect(untouched[1]).toBe(rows[1]!)
  })

  test('a failed request keeps the last labels, marked as not current, until the next good answer', () => {
    const failed = nextActivity(busy, { ok: false, error: new Error('Failed to fetch') }, at(23, 42))
    expect(labels(failed, A)).toEqual(['2 simulations running (stale)', '5 simulations (stale)'])
    expect(activityHead(rows, failed)).toEqual({
      activeIds: [B, A],
      summary: { text: 'Work was running in 2 Workspaces when last checked', active: true, current: false },
      problem: "Couldn't check World and Agents since 23:41.",
    })
    const again = nextActivity(failed, { ok: false, error: new Error('Failed to fetch') }, at(23, 43))
    expect(activityHead(rows, again).problem).toBe("Couldn't check World and Agents since 23:41.")
    const back = nextActivity(again, ok(catalog([{ workspaceId: C, items: [total] }])), at(23, 44))
    expect([labels(back, A), labels(back, C)]).toEqual([[], ['5 simulations']])
    expect(activityHead(rows, back)).toEqual({ activeIds: [], summary: { text: NOTHING_RUNNING_TEXT, active: false, current: true }, problem: null })
  })

  test('a Module that could not answer keeps its own last labels, and is named in one quiet line', () => {
    const worldDown = nextActivity(busy, ok(catalog([{ workspaceId: B, items: [answering] }], ['world'])), at(23, 45))
    expect(labels(worldDown, A)).toEqual(['2 simulations running (stale)', '5 simulations (stale)'])
    expect(labels(worldDown, B)).toEqual(['Assistant answering'])
    expect(activityHead(rows, worldDown).problem).toBe("Couldn't check World since 23:41.")
    expect(activityHead(rows, worldDown).summary?.text).toBe('Work was running in 2 Workspaces when last checked')
    // Agents' fresh item comes after World's stale ones: installed-Module order holds.
    const mixed = nextActivity(busy, ok(catalog([{ workspaceId: A, items: [answering] }], ['world'])), at(23, 45))
    expect(labels(mixed, A)).toEqual(['2 simulations running (stale)', '5 simulations (stale)', 'Assistant answering'])

    const neverAnswered = nextActivity(null, ok(catalog([], ['world', 'agents'])), at(23, 45))
    expect(activityHead(rows, neverAnswered)).toEqual({ activeIds: [], summary: null, problem: "Couldn't check what World and Agents are running." })
    expect(activityHead(rows, nextActivity(null, { ok: false, error: new Error('Failed to fetch') }, at(23, 45))))
      .toEqual({ activeIds: [], summary: null, problem: ACTIVITY_UNAVAILABLE_TEXT })
  })
})

describe('the activity poller', () => {
  const setup = (options: { hidden?: boolean; timeoutMs?: number } = {}) => {
    const state = { hidden: options.hidden ?? false, tick: null as (() => void) | null, cancelled: false }
    const pending: Array<{ signal: AbortSignal; resolve: (value: WorkspaceActivityCatalog) => void }> = []
    const answers: ActivityAnswer[] = []
    const poller = createActivityPoller({
      read: signal => new Promise((resolve, reject) => {
        pending.push({ signal, resolve })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
      onanswer: answer => { answers.push(answer) },
      hidden: () => state.hidden,
      every: (ms, tick) => {
        expect(ms).toBe(15_000)
        state.tick = tick
        return () => { state.cancelled = true }
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    return { state, pending, answers, poller }
  }
  const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

  test('asks at once, then on every tick while the page is visible and nothing is out', async () => {
    const { state, pending, answers, poller } = setup()
    poller.start()
    expect(pending).toHaveLength(1)
    state.tick!()
    expect(pending).toHaveLength(1)
    pending[0]!.resolve(catalog([]))
    await settle()
    expect(answers).toEqual([ok(catalog([]))])
    state.hidden = true
    state.tick!()
    expect(pending).toHaveLength(1)
    state.hidden = false
    state.tick!()
    expect(pending).toHaveLength(2)
  })

  test('refresh and a page shown again replace a request still out instead of overlapping it', async () => {
    const { state, pending, answers, poller } = setup({ hidden: true })
    poller.start()
    poller.visibilityChanged()
    expect(pending).toHaveLength(1)
    state.hidden = false
    poller.visibilityChanged()
    expect(pending).toHaveLength(2)
    expect(pending[0]!.signal.aborted).toBe(true)
    poller.refresh()
    expect(pending[1]!.signal.aborted).toBe(true)
    expect(pending.filter(item => !item.signal.aborted)).toHaveLength(1)
    pending[2]!.resolve(catalog([{ workspaceId: A, items: [running] }]))
    await settle()
    expect(answers).toEqual([ok(catalog([{ workspaceId: A, items: [running] }]))])
  })

  test('a request that takes too long is aborted and counts as unanswered', async () => {
    const { pending, answers, poller } = setup({ timeoutMs: 5 })
    poller.start()
    await settle(30)
    expect(pending[0]!.signal.aborted).toBe(true)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ ok: false })
    expect((answers[0] as { error: DOMException }).error.name).toBe('TimeoutError')
  })

  test('stop aborts the request still out and nothing is delivered after it', async () => {
    const { state, pending, answers, poller } = setup()
    poller.start()
    poller.stop()
    expect(state.cancelled).toBe(true)
    expect(pending[0]!.signal.aborted).toBe(true)
    await settle()
    expect(answers).toEqual([])
    poller.refresh()
    expect(pending).toHaveLength(1)
  })
})
