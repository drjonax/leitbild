// Manage Workspaces (`/workspaces?manage`): every Workspace the Host lists,
// newest first, with when it was created, whether this browser used it
// recently and any Module state that is not ready (a delete that did not
// finish can be run again from here). Only Host metadata is read: listing
// never loads a Module runtime. ManageWorkspaces.svelte renders these rows.
//
// Beside each row goes what its Modules say is going on there
// (GET /api/workspace-activity), polled while Manage is open, so the work
// using the server can be found and cleared. The labels are the Modules' own
// words: nothing here reads a Module's item keys.

import type { ModuleQueryOutcome, Workspace, WorkspaceActivityCatalog, WorkspaceActivityEntry } from '@leitbild/contracts'
import type { DeleteItem } from './bulk-delete.ts'
import { ageText, readHostJson, shortDateTime, workspaceLabel } from './launch-workspace.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

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

export const ACTIVITY_PATH = '/api/workspace-activity'
/** How often Manage asks again while it is open and the page is visible. */
export const ACTIVITY_POLL_MS = 15_000
export const ACTIVITY_UNAVAILABLE_TEXT = "Couldn't check what is running in these Workspaces."

/** What every Module says is going on per Workspace, validated by the contract (loaded lazily, like the Workspace list's). */
export const readWorkspaceActivity = async (fetchImpl: FetchLike, signal?: AbortSignal): Promise<WorkspaceActivityCatalog> => {
  const response = await fetchImpl(ACTIVITY_PATH, signal === undefined ? { method: 'GET' } : { method: 'GET', signal })
  const body = await readHostJson(response)
  const { workspaceActivityCatalogSchema } = await import('@leitbild/contracts')
  return workspaceActivityCatalogSchema.parse(body)
}

/** Per Workspace id, its Modules' items in the order the Host gave them. */
export const activityByWorkspace = (catalog: WorkspaceActivityCatalog | null): ReadonlyMap<string, ReadonlyArray<WorkspaceActivityEntry>> =>
  new Map((catalog?.workspaces ?? []).map(workspace => [workspace.workspaceId, workspace.items]))

const hasActive = (items: ReadonlyArray<WorkspaceActivityEntry> | undefined): boolean => items?.some(item => item.active) ?? false

/** The listed Workspaces with work running now, in list order: what "Select these" ticks. */
export const activeRowIds = (
  rows: ReadonlyArray<{ readonly id: string }>, byWorkspace: ReadonlyMap<string, ReadonlyArray<WorkspaceActivityEntry>>,
): ReadonlyArray<string> => rows.filter(row => hasActive(byWorkspace.get(row.id))).map(row => row.id)

/** "Work is running now in 2 Workspaces"; null when nothing is. */
export const activitySummary = (activeCount: number): string | null =>
  activeCount === 0 ? null : `Work is running now in ${activeCount === 1 ? '1 Workspace' : `${activeCount} Workspaces`}`

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

/** A Module named by its id, as people read it: "world" → "World", "process-plant" → "Process plant". */
const moduleName = (moduleId: string): string => {
  const words = moduleId.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const listed = (names: ReadonlyArray<string>): string =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`

/** One quiet line for the Modules that could not say what they run: "Couldn't check what World is running."; null when all did. */
export const activityFailureText = (modules: ReadonlyArray<ModuleQueryOutcome>): string | null => {
  const failed = modules.filter(outcome => outcome.status === 'failed').map(outcome => moduleName(outcome.moduleId))
  if (failed.length === 0) return null
  return `Couldn't check what ${listed(failed)} ${failed.length === 1 ? 'is' : 'are'} running.`
}

export type ActivityAnswer =
  | { readonly ok: true; readonly catalog: WorkspaceActivityCatalog }
  | { readonly ok: false; readonly error: unknown }

export interface ActivityPoller {
  /** Asks now; whatever an older request answers later is dropped. */
  refresh(): void
  /** Asks now, then every interval while the page is visible. */
  start(): void
  /** For `visibilitychange`: a page shown again asks at once. */
  visibilityChanged(): void
  /** Stops asking and drops any answer still on its way. */
  stop(): void
}

/**
 * Polls the activity while Manage is open: at once, then every interval,
 * skipping ticks while the page is hidden or the last request is still out.
 * Only the newest request's answer is delivered, and none after stop.
 */
export const createActivityPoller = (ports: {
  readonly read: () => Promise<WorkspaceActivityCatalog>
  readonly onanswer: (answer: ActivityAnswer) => void
  readonly hidden: () => boolean
  readonly every?: (ms: number, tick: () => void) => () => void
  readonly intervalMs?: number
}): ActivityPoller => {
  const every = ports.every ?? ((ms, tick) => {
    const id = setInterval(tick, ms)
    return () => clearInterval(id)
  })
  let latest = 0
  let running = false
  let waiting = false
  let cancel: (() => void) | null = null
  const refresh = (): void => {
    const token = ++latest
    waiting = true
    const settle = (answer: ActivityAnswer): void => {
      if (token !== latest) return
      waiting = false
      if (running) ports.onanswer(answer)
    }
    ports.read().then(catalog => settle({ ok: true, catalog }), (error: unknown) => settle({ ok: false, error }))
  }
  return {
    refresh: () => { if (running) refresh() },
    start: () => {
      if (running) return
      running = true
      refresh()
      // A tick while the last request is still out waits for it: an answer slower than the interval is still shown.
      cancel = every(ports.intervalMs ?? ACTIVITY_POLL_MS, () => { if (!ports.hidden() && !waiting) refresh() })
    },
    visibilityChanged: () => { if (running && !ports.hidden()) refresh() },
    stop: () => {
      running = false
      waiting = false
      latest += 1
      cancel?.()
      cancel = null
    },
  }
}
