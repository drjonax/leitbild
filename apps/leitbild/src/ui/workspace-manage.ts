// Manage Workspaces (`/workspaces?manage`): every Workspace the Host lists,
// newest first, with when it was created, whether this browser used it
// recently and any Module state that is not ready (a delete that did not
// finish can be run again from here). Only Host metadata is read: listing
// never loads a Module runtime. ManageWorkspaces.svelte renders these rows.
//
// Beside each row goes what its Modules say is going on there
// (GET /api/workspace-activity), polled while Manage is open, so the work
// using the server can be found and cleared. The labels are the Modules' own
// words: nothing here reads a Module's item keys. A Module that cannot be
// asked again keeps its last labels, marked as not current, until it answers.

import type { Workspace, WorkspaceActivityCatalog, WorkspaceActivityEntry } from '@leitbild/contracts'
import type { DeleteItem } from './bulk-delete.ts'
import { ageText, moduleTitle, shortDateTime, workspaceLabel } from './launch-workspace.ts'

export const MANAGE_TITLE = 'Manage Workspaces'
export const MANAGE_INTRO = 'Workspaces are public: anyone can see, open, change or delete them. Deleting a Workspace deletes its simulations and conversations for everyone.'

export interface ManageRow extends DeleteItem {
  readonly id: string
  readonly untitled: boolean
  /** "Created 2 h ago" */
  readonly created: string
  /** "12 Oct, 22:41", for the title attribute. */
  readonly createdExact: string
  readonly recent: boolean
}

/** A Workspace whose Modules are not all ready says why, in a few words; null when it is ready. */
export const moduleStateText = (workspace: Pick<Workspace, 'modules'>): string | null => {
  const states = new Set(workspace.modules.map(state => state.status))
  if (states.has('remove_failed')) return 'Delete did not finish'
  if (states.has('removing')) return 'Deleting…'
  if (states.has('provision_failed')) return 'Setup failed'
  if (states.has('provisioning')) return 'Setting up'
  return null
}

export const manageRows = (
  workspaces: ReadonlyArray<Workspace>,
  options: { readonly recent: ReadonlyArray<string>; readonly now: Date },
): ReadonlyArray<ManageRow> =>
  [...workspaces]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map(workspace => {
      const created = new Date(workspace.createdAt)
      const note = moduleStateText(workspace)
      return {
        key: workspace.id,
        id: workspace.id,
        label: workspaceLabel(workspace),
        untitled: workspace.name === null,
        ...(note === null ? {} : { note }),
        created: `Created ${ageText(created, options.now)}`,
        createdExact: shortDateTime(created),
        recent: options.recent.includes(workspace.id),
      }
    })

/**
 * For the bulk confirmation: how many of the chosen Workspaces this browser
 * has not opened recently (it remembers its last few), so a visitor clearing
 * "theirs" sees when the selection reaches beyond them. Null for one
 * Workspace, or when every one was opened here recently.
 */
export const notRecentText = (chosen: ReadonlyArray<{ readonly id: string }>, recent: ReadonlyArray<string>): string | null => {
  if (chosen.length < 2) return null
  const count = chosen.filter(row => !recent.includes(row.id)).length
  if (count === 0) return null
  return count === chosen.length
    ? `None of these ${count} are among the Workspaces this browser opened recently.`
    : `${count} of these are not among the Workspaces this browser opened recently.`
}

// ---------- What runs in each Workspace ----------

/** How often Manage asks again while it is open and the page is visible. */
export const ACTIVITY_POLL_MS = 15_000
/** How long one request may take before it counts as unanswered. */
export const ACTIVITY_TIMEOUT_MS = 10_000
export const ACTIVITY_CHECKING_TEXT = 'Checking what is running…'
export const NOTHING_RUNNING_TEXT = 'Nothing is running now.'
export const ACTIVITY_UNAVAILABLE_TEXT = "Couldn't check what is running in these Workspaces."
/** After a row's activity for people using a screen reader, when some of it is not current. */
export const STALE_ACTIVITY_SUFFIX = ' (as last checked)'

export type ActivityAnswer =
  | { readonly ok: true; readonly catalog: WorkspaceActivityCatalog }
  | { readonly ok: false; readonly error: unknown }

export interface ShownActivityItem extends WorkspaceActivityEntry {
  /** From an earlier answer: its Module could not be asked again since. */
  readonly stale: boolean
}

/** What Manage shows: the newest answer, with the last labels of any Module the newest request did not reach. */
export interface ShownActivity {
  /** Per Workspace id, its Modules' items in installed-Module order. */
  readonly byWorkspace: ReadonlyMap<string, ReadonlyArray<ShownActivityItem>>
  /** The Modules in the Host's order, with when each last answered (null: never since Manage opened). */
  readonly modules: ReadonlyArray<{ readonly moduleId: string; readonly answeredAt: Date | null; readonly current: boolean }>
  /** The Host itself could not be asked and nothing was known before. */
  readonly unreachable: boolean
}

/**
 * Folds one answer into what is shown. A ready Module's items replace its
 * earlier ones; a Module that failed, or every Module when the request
 * failed, keeps its earlier items, marked stale, until it answers again.
 */
export const nextActivity = (previous: ShownActivity | null, answer: ActivityAnswer, now: Date): ShownActivity => {
  const earlier = new Map((previous?.modules ?? []).map(module => [module.moduleId, module]))
  const order = answer.ok ? answer.catalog.modules.map(outcome => String(outcome.moduleId)) : (previous?.modules ?? []).map(module => module.moduleId)
  const ready = new Set(answer.ok ? answer.catalog.modules.filter(outcome => outcome.status === 'ready').map(outcome => String(outcome.moduleId)) : [])
  const byWorkspace = new Map<string, ShownActivityItem[]>()
  const add = (workspaceId: string, item: ShownActivityItem): void => {
    const items = byWorkspace.get(workspaceId)
    if (items) items.push(item)
    else byWorkspace.set(workspaceId, [item])
  }
  for (const moduleId of order) {
    if (answer.ok && ready.has(moduleId)) {
      for (const workspace of answer.catalog.workspaces) {
        for (const item of workspace.items) if (item.moduleId === moduleId) add(workspace.workspaceId, { ...item, stale: false })
      }
    } else {
      for (const [workspaceId, items] of previous?.byWorkspace ?? []) {
        for (const item of items) if (item.moduleId === moduleId) add(workspaceId, { ...item, stale: true })
      }
    }
  }
  return {
    byWorkspace,
    modules: order.map(moduleId => ready.has(moduleId)
      ? { moduleId, answeredAt: now, current: true }
      : { moduleId, answeredAt: earlier.get(moduleId)?.answeredAt ?? null, current: false }),
    unreachable: !answer.ok && order.length === 0,
  }
}

const hasActive = (items: ReadonlyArray<ShownActivityItem> | undefined): boolean => items?.some(item => item.active) ?? false

const listed = (names: ReadonlyArray<string>): string =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`

const two = (value: number): string => String(value).padStart(2, '0')
/** "23:41" in the browser's local time. */
const clockTime = (at: Date): string => `${two(at.getHours())}:${two(at.getMinutes())}`

export interface ActivityHead {
  /** The listed Workspaces with work running (as last known), in list order: what "Select these" ticks. */
  readonly activeIds: ReadonlyArray<string>
  /** The line above the list, which is always there so the list does not move: running work, nothing, or still checking. */
  readonly summary: { readonly text: string; readonly active: boolean; readonly current: boolean } | null
  /** One quiet line for what could not be checked; it stands in for the summary when nothing is known to run. */
  readonly problem: string | null
}

/** The summary, the "Select these" set and the problem line for the rows shown. */
export const activityHead = (rows: ReadonlyArray<{ readonly id: string }>, shown: ShownActivity | null): ActivityHead => {
  const activeIds = shown === null ? [] : rows.filter(row => hasActive(shown.byWorkspace.get(row.id))).map(row => row.id)
  const unchecked = (shown?.modules ?? []).filter(module => !module.current)
  const since = unchecked.flatMap(module => module.answeredAt === null ? [] : [module.answeredAt.getTime()])
  // Short, so it stays one line on a phone: it is the only line that comes and goes above the list.
  const names = listed(unchecked.map(module => moduleTitle(module.moduleId)))
  const problem = shown === null ? null
    : shown.unreachable ? ACTIVITY_UNAVAILABLE_TEXT
      : unchecked.length === 0 ? null
        : since.length === 0 ? `Couldn't check what ${names} ${unchecked.length === 1 ? 'is' : 'are'} running.`
          : `Couldn't check ${names} since ${clockTime(new Date(Math.min(...since)))}.`
  const count = activeIds.length === 1 ? '1 Workspace' : `${activeIds.length} Workspaces`
  const staleActive = activeIds.some(id => shown?.byWorkspace.get(id)?.some(item => item.active && item.stale))
  const summary = shown === null ? { text: ACTIVITY_CHECKING_TEXT, active: false, current: false }
    : activeIds.length > 0
      ? { text: staleActive ? `Work was running in ${count} when last checked` : `Work is running now in ${count}`, active: true, current: !staleActive }
      : problem === null ? { text: NOTHING_RUNNING_TEXT, active: false, current: true } : null
  return { activeIds, summary, problem }
}

/** The button beside Select all that ticks exactly those Workspaces. */
export const selectActiveLabel = (activeCount: number): string => activeCount === 1 ? 'Select this one' : `Select these ${activeCount}`

/** A row's items in words: "2 simulations running · 5 simulations"; null when its Modules report nothing. */
export const activityText = (items: ReadonlyArray<WorkspaceActivityEntry> | undefined): string | null =>
  items === undefined || items.length === 0 ? null : items.map(item => item.label).join(' · ')

/**
 * The rows the delete dialog lists, each with its state and its activity as
 * its note ("Delete did not finish · 2 simulations running"), as read when
 * the dialog opens.
 */
export const withActivityNotes = <T extends ManageRow>(
  rows: ReadonlyArray<T>, byWorkspace: ReadonlyMap<string, ReadonlyArray<WorkspaceActivityEntry>>,
): ReadonlyArray<T> => rows.map(row => {
  const note = [row.note, activityText(byWorkspace.get(row.id))].filter(part => part !== undefined && part !== null).join(' · ')
  return note === '' ? row : { ...row, note }
})

export interface ActivityPoller {
  /** Asks now, replacing a request still out. */
  refresh(): void
  /** Asks now, then every interval while the page is visible. */
  start(): void
  /** For `visibilitychange`: a page shown again asks at once, replacing a request still out. */
  visibilityChanged(): void
  /** Stops asking and aborts a request still out. */
  stop(): void
}

/**
 * Polls the activity while Manage is open: at once, then every interval,
 * skipping a tick while the page is hidden or a request is out. At most one
 * request is out: each has its own AbortController and a timeout, and is
 * aborted when a newer one replaces it or polling stops. Only the request
 * still current when it settles is delivered.
 */
export const createActivityPoller = (ports: {
  readonly read: (signal: AbortSignal) => Promise<WorkspaceActivityCatalog>
  readonly onanswer: (answer: ActivityAnswer) => void
  readonly hidden: () => boolean
  readonly every?: (ms: number, tick: () => void) => () => void
  readonly intervalMs?: number
  readonly timeoutMs?: number
}): ActivityPoller => {
  const every = ports.every ?? ((ms, tick) => {
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  })
  let running = false
  let current: AbortController | null = null
  let cancel: (() => void) | null = null
  const ask = (): void => {
    current?.abort()
    const controller = new AbortController()
    current = controller
    const settle = (answer: ActivityAnswer): void => {
      if (current !== controller) return
      current = null
      ports.onanswer(answer)
    }
    let reading: Promise<WorkspaceActivityCatalog>
    try { reading = ports.read(AbortSignal.any([controller.signal, AbortSignal.timeout(ports.timeoutMs ?? ACTIVITY_TIMEOUT_MS)])) }
    catch (error) { reading = Promise.reject(error) }
    reading.then(catalog => settle({ ok: true, catalog }), (error: unknown) => settle({ ok: false, error }))
  }
  return {
    refresh: () => { if (running) ask() },
    start: () => {
      if (running) return
      running = true
      ask()
      cancel = every(ports.intervalMs ?? ACTIVITY_POLL_MS, () => { if (!ports.hidden() && current === null) ask() })
    },
    visibilityChanged: () => { if (running && !ports.hidden()) ask() },
    stop: () => {
      running = false
      const out = current
      current = null
      out?.abort()
      cancel?.()
      cancel = null
    },
  }
}
