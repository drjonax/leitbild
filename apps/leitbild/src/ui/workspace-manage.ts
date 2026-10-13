// Manage Workspaces (`/workspaces?manage`): every Workspace the Host lists,
// newest first, with when it was created, whether this browser used it
// recently and any Module state that is not ready (a delete that did not
// finish can be run again from here). Only Host metadata is read: listing
// never loads a Module runtime. ManageWorkspaces.svelte renders these rows.

import type { Workspace } from '@leitbild/contracts'
import type { DeleteItem } from './bulk-delete.ts'
import { shortDate, shortDateTime, workspaceLabel } from './launch-workspace.ts'

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

/** "just now", "5 min ago", "3 h ago", "2 d ago"; older than a month, the date. */
export const ageText = (at: Date, now: Date): string => {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days <= 30 ? `${days} d ago` : `on ${shortDate(at)}`
}

/** A Workspace whose Modules are not all ready says why, in a few words; null when it is ready. */
export const moduleStateText = (workspace: Pick<Workspace, 'modules'>): string | null => {
  const states = new Set(workspace.modules.map(state => state.status))
  if (states.has('remove_failed') || states.has('removing')) return 'Delete did not finish'
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
