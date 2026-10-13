// The Workspace page's own Host calls: rename, delete and the share link.
// Delete reports an explicit outcome; nothing here retries or guesses.

import type { Workspace } from '@leitbild/contracts'
import { isAlreadyGone, type RemoveOutcome } from './bulk-delete.ts'
import { GENERIC_ERROR_TEXT, plainError } from './error-text.ts'
import { readHostJson } from './launch-workspace.ts'
import { workspacePath } from './launch-destination.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const DELETE_INCOMPLETE_TEXT = 'Part of this Workspace could not be removed. Try again.'
/** The Host's answer for a Workspace that does not exist: deleted by someone else first. */
const WORKSPACE_GONE_CODE = 'workspace_not_found'

export interface WorkspaceAdmin {
  /** An empty name makes the Workspace untitled. */
  rename(workspaceId: string, name: string): Promise<Workspace>
  remove(workspaceId: string): Promise<RemoveOutcome>
}

export const createWorkspaceAdmin = (fetchImpl: FetchLike = (input, init) => fetch(input, init)): WorkspaceAdmin => ({
  rename: async (workspaceId, name) => {
    const response = await fetchImpl(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() || null }),
    })
    const body = await readHostJson(response) as { workspace?: unknown }
    const { workspaceSchema } = await import('@leitbild/contracts')
    return workspaceSchema.parse(body.workspace)
  },
  remove: async workspaceId => {
    try {
      const response = await fetchImpl(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
      if (response.status === 204) return { kind: 'deleted' }
      await readHostJson(response)
      console.error(`Unexpected Workspace delete response: HTTP ${response.status}`)
      return { kind: 'failed', text: GENERIC_ERROR_TEXT }
    } catch (error) {
      if (isAlreadyGone(error, WORKSPACE_GONE_CODE)) return { kind: 'gone' }
      const plain = plainError(error)
      return { kind: 'failed', text: plain.code === 'workspace_delete_incomplete' ? DELETE_INCOMPLETE_TEXT : plain.text }
    }
  },
})

/** The address to share: this Workspace on the visitor's own host. */
export const workspaceShareUrl = (origin: string, workspaceId: string): string => new URL(workspacePath(workspaceId), origin).href
