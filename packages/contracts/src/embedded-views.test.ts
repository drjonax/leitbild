import { describe, expect, test } from 'bun:test'
import {
  embeddedViewContentSchema,
  embeddedViewEnvelopeSchema,
  embeddedViewFragment,
  embeddedViewPath,
  embeddedViewPublicationSchema,
  parseEmbeddedViewFragment,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from './embedded-views.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const envelope = {
  moduleId: 'world',
  viewType: 'process-plant.display',
  subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
  title: 'SG B level',
  height: 300,
  state: '{"composition":{}}',
}

describe('embedded view envelope', () => {
  test('builds a same-origin route from validated identities only', () => {
    const parsed = embeddedViewEnvelopeSchema.parse(envelope)
    expect(embeddedViewPath(parsed)).toBe(`/workspaces/${workspaceId}/world/embed/process-plant.display`)
  })

  test('round-trips through the URL fragment', () => {
    const parsed = embeddedViewEnvelopeSchema.parse(envelope)
    expect(parseEmbeddedViewFragment(embeddedViewFragment(parsed))).toEqual(parsed)
  })

  test('rejects subjects owned by another Module', () => {
    const result = embeddedViewEnvelopeSchema.safeParse({
      ...envelope,
      subject: { workspaceId, moduleId: 'agents', type: 'agents.room', id: 'room-1' },
    })
    expect(result.success).toBe(false)
  })

  test('rejects view types that could escape the route', () => {
    for (const viewType of ['../agents', 'process-plant/display', '//evil.example', 'display']) {
      expect(embeddedViewEnvelopeSchema.safeParse({ ...envelope, viewType }).success).toBe(false)
    }
  })

  test('rejects oversized state and unknown fields', () => {
    expect(embeddedViewEnvelopeSchema.safeParse({ ...envelope, state: 'x'.repeat(EMBEDDED_VIEW_STATE_MAX_LENGTH + 1) }).success).toBe(false)
    expect(embeddedViewEnvelopeSchema.safeParse({ ...envelope, url: 'https://evil.example' }).success).toBe(false)
  })

  test('rejects fragments without the view key', () => {
    expect(() => parseEmbeddedViewFragment('#state=x')).toThrow('view=')
  })
})

describe('embedded view publication', () => {
  test('completes into an envelope with the invoked Resource', () => {
    const { moduleId: _moduleId, subject, ...publication } = envelope
    expect(embeddedViewPublicationSchema.safeParse(publication).success).toBe(true)
    expect(embeddedViewEnvelopeSchema.parse({ ...publication, moduleId: subject.moduleId, subject })).toEqual(embeddedViewEnvelopeSchema.parse(envelope))
  })
})

describe('embedded view content', () => {
  const content = {
    items: [{ names: ['PT-455', 'Pressurizer pressure'], values: [{ value: 15.7, unit: 'MPa' }], limits: [{ value: 16, unit: 'MPa' }], history: true }],
    span: { shownMs: 60_000, horizonMs: 600_000 },
    lead: { item: 0, reason: 'PT-455: 15.7 MPa, HI ALM 16 MPa · 0.285 below' },
  }

  test('describes items by their names and the values the view shows', () => {
    expect(embeddedViewContentSchema.parse(content)).toEqual(content)
  })

  test('rejects a lead that is not one of the items, and unknown fields', () => {
    expect(embeddedViewContentSchema.safeParse({ ...content, lead: { item: 1, reason: 'x' } }).success).toBe(false)
    expect(embeddedViewContentSchema.safeParse({ ...content, note: 'x' }).success).toBe(false)
  })
})
