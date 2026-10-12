import { describe, expect, test } from 'bun:test'
import {
  embeddedViewContentSchema,
  embeddedViewEnvelopeSchema,
  embeddedViewFragment,
  embeddedViewPath,
  embeddedViewPublicationSchema,
  parseEmbeddedViewFragment,
  embeddedViewOpenMessageSchema,
  embeddedViewsMessageSchema,
  embeddedViewWindowMaximiseMessageSchema,
  EMBEDDED_VIEW_LISTING_MAX,
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

  test('says how a trend\'s rate is changing, so a reversing trend\'s direction is not taken for where it goes now', () => {
    const reversing = { ...content, items: [{ ...content.items[0]!, trend: { rate: -0.4, unit: '°C', direction: 'falling' as const, change: 'reversing' as const } }] }
    expect(embeddedViewContentSchema.parse(reversing)).toEqual(reversing)
    expect(embeddedViewContentSchema.safeParse({ ...content, items: [{ ...content.items[0]!, trend: { rate: -0.4, unit: '°C', direction: 'falling', change: 'turning' } }] }).success).toBe(false)
  })

  test('says how far back an item\'s recorded samples reach, only for an item whose history it shows', () => {
    const recorded = { ...content, items: [{ ...content.items[0]!, recordedMs: 180_000 }] }
    expect(embeddedViewContentSchema.parse(recorded)).toEqual(recorded)
    expect(embeddedViewContentSchema.safeParse({ ...content, items: [{ ...content.items[0]!, history: false, recordedMs: 180_000 }] }).success).toBe(false)
  })

  test('rejects a lead that is not one of the items, and unknown fields', () => {
    expect(embeddedViewContentSchema.safeParse({ ...content, lead: { item: 1, reason: 'x' } }).success).toBe(false)
    expect(embeddedViewContentSchema.safeParse({ ...content, note: 'x' }).success).toBe(false)
  })
})

describe('embedded view window messages', () => {
  const listing = { key: 'room-1/turn-1/call_1_0/display', envelope, caption: 'Answer 14:02:31' }

  test('list views oldest first with unique keys', () => {
    expect(embeddedViewsMessageSchema.parse({ type: 'leitbild:views', views: [listing] }).views[0]?.key).toBe(listing.key)
    expect(embeddedViewsMessageSchema.safeParse({ type: 'leitbild:views', views: [listing, listing] }).success).toBe(false)
    const many = Array.from({ length: EMBEDDED_VIEW_LISTING_MAX + 1 }, (_, index) => ({ ...listing, key: `k${index}` }))
    expect(embeddedViewsMessageSchema.safeParse({ type: 'leitbild:views', views: many }).success).toBe(false)
  })

  test('open a view from a self-contained listing whose envelope is checked', () => {
    expect(embeddedViewOpenMessageSchema.safeParse({ type: 'leitbild:view-open', view: listing }).success).toBe(true)
    expect(embeddedViewOpenMessageSchema.safeParse({ type: 'leitbild:view-open', view: { ...listing, envelope: { ...envelope, height: 9_999 } } }).success).toBe(false)
    expect(embeddedViewOpenMessageSchema.safeParse({ type: 'leitbild:view-open', view: { ...listing, url: 'https://evil.example' } }).success).toBe(false)
    expect(embeddedViewOpenMessageSchema.safeParse({ type: 'leitbild:view-open', key: listing.key }).success).toBe(false)
  })

  test('maximise names the wanted state', () => {
    expect(embeddedViewWindowMaximiseMessageSchema.parse({ type: 'leitbild:view-window-maximise', maximised: true }).maximised).toBe(true)
    expect(embeddedViewWindowMaximiseMessageSchema.safeParse({ type: 'leitbild:view-window-maximise' }).success).toBe(false)
  })
})
