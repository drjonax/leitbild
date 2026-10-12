// The Workspaces switcher's rows (plan v2 §3): recent in this browser first,
// then every public Workspace behind a collapsed disclosure. Never a raw id as
// a label; no rename or delete here.

import { shortDate, workspaceLabel } from './launch-workspace.ts'

/** Search appears only when the list is long enough to need it. */
export const SEARCH_THRESHOLD = 7

export const SWITCHER_INTRO = 'A Workspace holds your simulations and AI conversations. Starting a demo creates one.'
export const SWITCHER_FOOTNOTE = 'Workspaces are public: anyone can see, open, change or delete them.'

/** The fields a row needs from a Host Workspace record. */
export interface SwitcherWorkspace {
  readonly id: string
  readonly name: string | null
  readonly createdAt: string
}

export interface SwitcherRow {
  readonly id: string
  readonly label: string
  readonly untitled: boolean
  /** "Created 12 Oct" */
  readonly meta: string
  readonly initial: string
  readonly current: boolean
}

export const switcherRow = (workspace: SwitcherWorkspace, current: string | null): SwitcherRow => ({
  id: workspace.id,
  label: workspaceLabel(workspace),
  untitled: workspace.name === null,
  meta: `Created ${shortDate(new Date(workspace.createdAt))}`,
  initial: (workspace.name?.trim()[0] ?? 'U').toUpperCase(),
  current: workspace.id === current,
})

/**
 * Recent rows follow this browser's order and keep only Workspaces that still
 * exist; the public list holds every Workspace, newest first.
 */
export const switcherGroups = (
  workspaces: ReadonlyArray<SwitcherWorkspace>,
  options: { readonly recent: ReadonlyArray<string>; readonly current: string | null },
): { readonly recent: ReadonlyArray<SwitcherRow>; readonly all: ReadonlyArray<SwitcherRow> } => {
  const byId = new Map(workspaces.map(workspace => [workspace.id, workspace]))
  const recent = options.recent.flatMap(id => {
    const workspace = byId.get(id)
    return workspace ? [switcherRow(workspace, options.current)] : []
  })
  const all = [...workspaces]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(workspace => switcherRow(workspace, options.current))
  return { recent, all }
}

/** Rows whose label (or short id) contains the query, case-insensitive. */
export const filterRows = (rows: ReadonlyArray<SwitcherRow>, query: string): ReadonlyArray<SwitcherRow> => {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return rows
  return rows.filter(row => row.label.toLocaleLowerCase().includes(needle) || row.id.startsWith(needle))
}

/** For the search's `role="status"`. */
export const matchCountText = (count: number): string =>
  count === 0 ? 'No Workspace matches' : count === 1 ? '1 Workspace matches' : `${count} Workspaces match`

/** Arrow-key movement through the search field and the rows; null leaves focus alone. */
export const switcherKeyTarget = (key: string, index: number, count: number): number | null => {
  if (count === 0) return null
  if (key === 'ArrowDown') return index < 0 ? 0 : Math.min(index + 1, count - 1)
  if (key === 'ArrowUp') return index <= 0 ? 0 : index - 1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
