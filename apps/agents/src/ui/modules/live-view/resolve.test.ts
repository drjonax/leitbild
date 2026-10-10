import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { createViewResolutionCache, resolveViewReference, type ViewResolution } from './resolve.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const envelope = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}', moduleId: 'world', subject: run }
const origin = { roomId: 'room-1', turnId: 'turn-1', workspaceId }
const ref = { callId: 'call_1_0', key: 'display' }

const evidence = (results: ReadonlyArray<unknown>, tool = 'workspace_call') => ({ id: 'call_1_0', tool, arguments: {}, result: { success: true, data: { results } } })

const fetching = (status: number, body: unknown) => {
  const paths: string[] = []
  return { paths, fetchJson: async (path: string) => { paths.push(path); return { status, body } } }
}

describe('resolving leitbild-view references', () => {
  test('reads the envelope from the answer turn evidence, never from the fence', async () => {
    const { paths, fetchJson } = fetching(200, evidence([{ key: 'display', embeddedView: envelope }]))
    const result = await resolveViewReference(ref, origin, fetchJson)
    expect(result).toMatchObject({ kind: 'view', envelope: { title: 'Pressure', subject: run } })
    expect(paths).toEqual(['/rooms/room-1/executions/turn-1/calls/call_1_0'])
  })

  test('names why a display cannot be shown', async () => {
    expect(await resolveViewReference(ref, origin, fetching(404, null).fetchJson)).toMatchObject({ code: 'view_evidence_unavailable' })
    expect(await resolveViewReference(ref, origin, fetching(503, null).fetchJson)).toMatchObject({ code: 'view_evidence_unreadable' })
    expect(await resolveViewReference({ ...ref, key: 'other' }, origin, fetching(200, evidence([{ key: 'display', embeddedView: envelope }])).fetchJson)).toMatchObject({ code: 'view_evidence_mismatch' })
    expect(await resolveViewReference(ref, origin, fetching(200, evidence([{ key: 'display', embeddedView: envelope }], 'web_fetch')).fetchJson)).toMatchObject({ code: 'view_evidence_mismatch' })
    expect(await resolveViewReference(ref, { ...origin, workspaceId: newWorkspaceId() }, fetching(200, evidence([{ key: 'display', embeddedView: envelope }])).fetchJson)).toMatchObject({ code: 'view_workspace_mismatch' })
  })
})

describe('the resolution cache shared by chips and the display list', () => {
  test('resolves each key once, whoever asks and however often the chat re-renders', async () => {
    const asked: string[] = []
    const cache = createViewResolutionCache<{ readonly key: string }>(async fence => {
      asked.push(fence.key)
      return { kind: 'view', envelope: envelope as never }
    })
    const first = cache.resolve({ key: 'room-1/turn-1/call_1_0/display' })
    const again = cache.resolve({ key: 'room-1/turn-1/call_1_0/display' })
    expect(again).toBe(first)
    await cache.resolve({ key: 'room-1/turn-2/call_1_0/display' })
    expect(asked).toEqual(['room-1/turn-1/call_1_0/display', 'room-1/turn-2/call_1_0/display'])
  })

  test('turns a failed read into a refusal instead of a display that never leaves "Preparing"', async () => {
    let calls = 0
    const cache = createViewResolutionCache<{ readonly key: string }>(async () => {
      calls += 1
      throw new TypeError('Failed to fetch')
    })
    const refused: ViewResolution = await cache.resolve({ key: 'k' })
    expect(refused).toMatchObject({ kind: 'refused', code: 'view_evidence_unreachable' })
    expect(refused.kind === 'refused' ? refused.message : '').toContain('Failed to fetch')
    // Kept like a success, so the chip and the list agree until a reload.
    expect(await cache.resolve({ key: 'k' })).toBe(refused)
    expect(calls).toBe(1)
  })

  test('also contains a resolver that throws before returning a promise', async () => {
    const cache = createViewResolutionCache<{ readonly key: string }>((() => { throw new Error('no Workspace URL') }) as never)
    expect(await cache.resolve({ key: 'k' })).toMatchObject({ kind: 'refused', code: 'view_evidence_unreachable' })
  })
})
