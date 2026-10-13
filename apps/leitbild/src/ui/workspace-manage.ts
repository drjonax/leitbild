// Manage Workspaces (`/workspaces?manage`): every Workspace the Host lists,
// newest first, with when it was created, whether this browser used it
// recently and any Module state that is not ready (a delete that did not
// finish can be run again from here). Only Host metadata is read: listing
// never loads a Module runtime. ManageWorkspaces.svelte renders these rows.

import type { Workspace } from '@leitbild/contracts'
import type { DeleteItem } from './bulk-delete.ts'
import { ageText, shortDateTime, workspaceLabel } from './launch-workspace.ts'

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
