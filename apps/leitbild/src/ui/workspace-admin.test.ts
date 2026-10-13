import { describe, expect, test } from 'bun:test'
import { CAPACITY_TEXT, GENERIC_ERROR_TEXT, TRANSPORT_LOST_TEXT } from './error-text.ts'
import { fakeFetch, hostError, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import { createWorkspaceAdmin, DELETE_INCOMPLETE_TEXT, workspaceShareUrl } from './workspace-admin.ts'

const ID = '0b4b9a52-2f7e-4c1a-9d3e-000000000001'

describe('rename', () => {
  test('sends the trimmed name and returns the validated Workspace', async () => {
    const host = fakeFetch().on('PATCH', `/api/workspaces/${ID}`, json({ workspace: workspaceFixture(ID, { name: 'Grid study' }) }))
    const workspace = await createWorkspaceAdmin(host.fetch).rename(ID, '  Grid study ')
    expect(workspace.name).toBe('Grid study')
    expect(host.calls[0]?.body).toEqual({ name: 'Grid study' })
  })

  test('an empty name makes the Workspace untitled', async () => {
    const host = fakeFetch().on('PATCH', `/api/workspaces/${ID}`, json({ workspace: workspaceFixture(ID, { name: null }) }))
    expect((await createWorkspaceAdmin(host.fetch).rename(ID, '   ')).name).toBeNull()
    expect(host.calls[0]?.body).toEqual({ name: null })
  })

  test('a refusal is thrown with its Host code', async () => {
    const host = fakeFetch().on('PATCH', `/api/workspaces/${ID}`, hostError(404, 'workspace_not_found', 'Workspace not found'))
    await expect(createWorkspaceAdmin(host.fetch).rename(ID, 'x')).rejects.toMatchObject({ status: 404, code: 'workspace_not_found' })
  })
})

describe('delete', () => {
  test('204 is deleted, the Host\'s 404 workspace_not_found is already gone', async () => {
    const deleted = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, new Response(null, { status: 204 }))
    expect(await createWorkspaceAdmin(deleted.fetch).remove(ID)).toEqual({ kind: 'deleted' })
    const gone = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, hostError(404, 'workspace_not_found', 'Workspace not found'))
    expect(await createWorkspaceAdmin(gone.fetch).remove(ID)).toEqual({ kind: 'gone' })
  })

  test('any other 404 (an unknown route, a stale page) is a failure, never "deleted"', async () => {
    for (const code of ['route_not_found', 'capability_not_found']) {
      const host = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, hostError(404, code, 'Route not found'))
      expect(await createWorkspaceAdmin(host.fetch).remove(ID)).toEqual({ kind: 'failed', text: 'Route not found' })
    }
  })

  test('a partial delete says so in plain words', async () => {
    const host = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, hostError(502, 'workspace_delete_incomplete', 'One or more Modules could not remove their Workspace state'))
    expect(await createWorkspaceAdmin(host.fetch).remove(ID)).toEqual({ kind: 'failed', text: DELETE_INCOMPLETE_TEXT })
  })

  test('capacity, lost connections and odd answers are plain text, never raw diagnostics', async () => {
    const busy = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, hostError(503, 'workspace_capacity_exceeded', 'capacity'))
    expect(await createWorkspaceAdmin(busy.fetch).remove(ID)).toMatchObject({ kind: 'failed', text: CAPACITY_TEXT })
    const lost = createWorkspaceAdmin(async () => { throw new Error('The socket connection was closed unexpectedly. For more information, pass `verbose: true`') })
    expect(await lost.remove(ID)).toMatchObject({ kind: 'failed', text: TRANSPORT_LOST_TEXT })
    const odd = fakeFetch().on('DELETE', `/api/workspaces/${ID}`, json({ ok: true }))
    const error = console.error
    console.error = () => {}
    try { expect(await createWorkspaceAdmin(odd.fetch).remove(ID)).toEqual({ kind: 'failed', text: GENERIC_ERROR_TEXT }) }
    finally { console.error = error }
  })
})

test('the share link stays on the visitor\'s own host', () => {
  expect(workspaceShareUrl('https://leitbild.ai', ID)).toBe(`https://leitbild.ai/workspaces/${ID}`)
  expect(workspaceShareUrl('http://localhost:5173', ID)).toBe(`http://localhost:5173/workspaces/${ID}`)
})
