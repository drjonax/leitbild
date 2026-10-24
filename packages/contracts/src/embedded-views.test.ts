import { describe, expect, test } from 'bun:test'
import {
  embeddedViewEnvelopeSchema,
  embeddedViewFragment,
  embeddedViewPath,
  embeddedViewPublicationSchema,
  parseEmbeddedViewFragment,
  embeddedViewOpenMessageSchema,
  embeddedViewSubjectOpenMessageSchema,
  embeddedViewsMessageSchema,
  embeddedViewWindowMaximiseMessageSchema,
  embeddedViewWindowName,
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

  test('pops out into one browser window per view, whoever opens it', () => {
    const parsed = embeddedViewEnvelopeSchema.parse(envelope)
    expect(embeddedViewWindowName(parsed)).toMatch(/^leitbild-view-[0-9a-f]{8}$/)
    expect(embeddedViewWindowName(embeddedViewEnvelopeSchema.parse({ ...envelope }))).toBe(embeddedViewWindowName(parsed))
    expect(embeddedViewWindowName(embeddedViewEnvelopeSchema.parse({ ...envelope, state: '{"composition":{"x":1}}' }))).not.toBe(embeddedViewWindowName(parsed))
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

  test('open a subject\'s default display: an object of the Resource and an item of it, strictly (Q23)', () => {
    const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
    const open = { type: 'leitbild:view-subject-open' as const, resource: run, subject: 'plant:halden-2#auxFeedwaterValveA', title: 'Review: THROTTLE to 40 % AFW-A-CV' }
    expect(JSON.parse(JSON.stringify(embeddedViewSubjectOpenMessageSchema.parse(open)))).toEqual(open)
    for (const subject of ['plant:halden-2', '#auxFeedwaterValveA', 'plant:halden-2#', 'plant:halden-2#a#b', 'plant:halden-2#aux valve']) {
      expect(embeddedViewSubjectOpenMessageSchema.safeParse({ ...open, subject }).success).toBe(false)
    }
    expect(embeddedViewSubjectOpenMessageSchema.safeParse({ ...open, resource: { ...run, type: 'agents.room' } }).success).toBe(false)
    expect(embeddedViewSubjectOpenMessageSchema.safeParse({ ...open, view: listing }).success).toBe(false)
    expect(embeddedViewSubjectOpenMessageSchema.safeParse({ ...open, title: '' }).success).toBe(false)
  })

  test('maximise names the wanted state', () => {
    expect(embeddedViewWindowMaximiseMessageSchema.parse({ type: 'leitbild:view-window-maximise', maximised: true }).maximised).toBe(true)
    expect(embeddedViewWindowMaximiseMessageSchema.safeParse({ type: 'leitbild:view-window-maximise' }).success).toBe(false)
  })
})
