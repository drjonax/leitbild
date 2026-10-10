import { describe, expect, test } from 'bun:test'
import { EMBEDDED_VIEW_MAX_HEIGHT, EMBEDDED_VIEW_MIN_HEIGHT, EMBEDDED_VIEW_STATE_MAX_LENGTH, embeddedViewEnvelopeSchema, newWorkspaceId } from '@leitbild/contracts'
import { checkViewEnvelope, parseViewFenceBody, viewRefFor } from './view-fence.ts'
import { embeddedViewFor } from './view-envelope.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const publication = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}' }

describe('leitbild-view fences', () => {
  test('round-trip a viewRef through the fence body', () => {
    const ref = viewRefFor('call_3_1', 'sg b/level')
    expect(ref).toBe('call_3_1/sg%20b%2Flevel')
    expect(parseViewFenceBody(`view ${ref}\n`)).toEqual({ kind: 'reference', ref: { callId: 'call_3_1', key: 'sg b/level' } })
  })

  test('reject bodies that are not a single view reference', () => {
    for (const body of ['https://evil.example', 'view /workspaces/x/world/embed/a', '{"view":"x"}', 'view call_1_0/a\nview call_1_0/b', 'view call_1_0/%E0%A4%A']) {
      expect(parseViewFenceBody(body).kind).toBe('invalid')
    }
  })

  test('complete a publication with the invoked Resource and reject malformed ones explicitly', () => {
    const completed = embeddedViewFor({ view: publication }, run as never)
    expect(completed).toMatchObject({ kind: 'view', envelope: { ...publication, moduleId: 'world', subject: run } })
    expect(embeddedViewFor({ shows: [] }, run as never)).toEqual({ kind: 'none' })
    expect(embeddedViewFor({ view: { ...publication, height: 9_999 } }, run as never).kind).toBe('invalid')
  })

  test('name the rule that refuses an envelope', () => {
    const envelope = { ...publication, moduleId: 'world', subject: run }
    expect(checkViewEnvelope(envelope, workspaceId).kind).toBe('view')
    expect(checkViewEnvelope(envelope, newWorkspaceId())).toMatchObject({ kind: 'refused', code: 'view_workspace_mismatch' })
    const agentsSubject = { ...run, moduleId: 'agents', type: 'agents.room' }
    expect(checkViewEnvelope({ ...envelope, moduleId: 'agents', subject: agentsSubject }, workspaceId)).toMatchObject({ kind: 'refused', code: 'view_module_not_embeddable' })
    expect(checkViewEnvelope({ ...envelope, url: 'https://evil.example' }, workspaceId)).toMatchObject({ kind: 'refused', code: 'view_envelope_invalid' })
  })

  test('the browser structural check agrees with the contract schema', () => {
    const envelope = { ...publication, moduleId: 'world', subject: run }
    const variants: ReadonlyArray<Record<string, unknown>> = [
      envelope,
      { ...envelope, viewType: '../agents' },
      { ...envelope, viewType: 'display' },
      { ...envelope, height: EMBEDDED_VIEW_MIN_HEIGHT - 1 },
      { ...envelope, height: EMBEDDED_VIEW_MIN_HEIGHT },
      { ...envelope, height: 721 },
      { ...envelope, height: EMBEDDED_VIEW_MAX_HEIGHT },
      { ...envelope, height: EMBEDDED_VIEW_MAX_HEIGHT + 1 },
      { ...envelope, height: 340.5 },
      { ...envelope, title: '' },
      { ...envelope, state: 'x'.repeat(EMBEDDED_VIEW_STATE_MAX_LENGTH) },
      { ...envelope, state: 'x'.repeat(EMBEDDED_VIEW_STATE_MAX_LENGTH + 1) },
      { ...envelope, extra: true },
      { ...envelope, subject: { ...run, id: '../run' } },
      { ...envelope, subject: { ...run, type: 'agents.room' } },
      { ...envelope, subject: { ...run, workspaceId: 'not-a-uuid' } },
      { ...envelope, moduleId: 'World' },
    ]
    for (const variant of variants) {
      expect([variant, checkViewEnvelope(variant, workspaceId).kind === 'view']).toEqual([variant, embeddedViewEnvelopeSchema.safeParse(variant).success])
    }
  })
})
