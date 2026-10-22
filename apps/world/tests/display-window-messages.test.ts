import { describe, expect, test } from 'bun:test'
import { answerDeckEntry } from '../src/ui/process-display/display-deck.ts'
import {
  listingRefusal,
  readDisplayWindowHostMessage,
  VIGNETTE_VIEW_TYPE,
} from '../src/ui/process-display/display-window-messages.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const parent = { name: 'host' }
const expected = { origin: 'https://leitbild.test', parent, workspaceId }

const view = (overrides: Record<string, unknown> = {}, key = 'room/turn/call/key') => ({
  key,
  caption: 'Answer 14:02:31',
  envelope: {
    moduleId: 'world',
    viewType: 'display.vignette',
    subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    title: 'SG B level',
    height: 600,
    state: '{"title":"SG B level","at":{},"views":[]}',
    ...overrides,
  },
})

const fromHost = (data: unknown) => ({ origin: expected.origin, source: parent, data })

describe('display window messages from the Host', () => {
  test('accepts the conversation list and open requests from the Host only', () => {
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:views', views: [view()] }), expected)).toMatchObject({ kind: 'views', views: [{ key: 'room/turn/call/key' }], refused: [] })
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:view-open', view: view() }), expected)).toMatchObject({ kind: 'open', view: { caption: 'Answer 14:02:31' } })
    expect(readDisplayWindowHostMessage({ ...fromHost({ type: 'leitbild:views', views: [] }), origin: 'https://elsewhere.test' }, expected)).toBeNull()
    expect(readDisplayWindowHostMessage({ ...fromHost({ type: 'leitbild:views', views: [] }), source: { name: 'agents frame' } }, expected)).toBeNull()
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:subject-focus' }), expected)).toBeNull()
  })

  test('refuses invalid messages and a request about another Workspace, saying why', () => {
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:views', views: [view(), view()] }), expected))
      .toEqual({ kind: 'rejected', reason: 'display list is invalid: views.1.key: Listed view keys must be unique' })
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:view-open', view: view({ height: 5000 }) }), expected))
      .toMatchObject({ kind: 'rejected', reason: expect.stringContaining('display request is invalid: view.envelope.height') })
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:view-open', view: view({ subject: { workspaceId: 'f1b1e5a8-9a43-4d4e-9d3a-1a7c4b1e2f00', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }) }), expected))
      .toEqual({ kind: 'rejected', reason: 'display request refused: display room/turn/call/key belongs to another Workspace' })
  })

  test('judges listings one by one: one foreign listing never refuses the rest of the list', () => {
    const otherWorkspace = view({ subject: { workspaceId: 'f1b1e5a8-9a43-4d4e-9d3a-1a7c4b1e2f00', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }, 'room/turn/call/other-workspace')
    const grid = view({ viewType: 'electric-grid.display' }, 'room/turn/call/grid')
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:views', views: [view(), otherWorkspace, grid] }), expected)).toMatchObject({
      kind: 'views',
      // A view of another type is listed, and the window says in its place that it cannot show it.
      views: [{ key: 'room/turn/call/key' }, { key: 'room/turn/call/grid' }],
      refused: [{ key: 'room/turn/call/other-workspace', reason: 'display room/turn/call/other-workspace belongs to another Workspace' }],
    })
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:view-open', view: grid }), expected)).toMatchObject({ kind: 'open', view: { key: 'room/turn/call/grid' } })
  })

  test('shows World vignettes about a Run (architecture B2): listed, opened and drawn in a frame of their own', () => {
    const vignette = view({ viewType: VIGNETTE_VIEW_TYPE, title: 'Halden frequency', state: '{"title":"Halden frequency","at":{},"views":[]}' }, 'room/turn/call/vignette')
    expect(VIGNETTE_VIEW_TYPE).toBe('display.vignette')
    expect(listingRefusal(vignette.envelope as never)).toBeNull()
    expect(listingRefusal({ ...vignette.envelope, moduleId: 'agents' } as never)).toBe('it is a display.vignette view published by agents, not by World')
    expect(listingRefusal({ ...vignette.envelope, subject: { ...vignette.envelope.subject, type: 'world.scenario' } } as never)).toBe('it is about a world.scenario, not a Simulation Run')
    expect(readDisplayWindowHostMessage(fromHost({ type: 'leitbild:views', views: [view(), vignette] }), expected)).toMatchObject({ kind: 'views', views: [{ key: 'room/turn/call/key' }, { key: 'room/turn/call/vignette' }], refused: [] })
    // In the deck it is an answer's display like any other, sized by its content.
    expect(answerDeckEntry('run-1', vignette as never)).toMatchObject({ source: 'answer', title: 'Halden frequency', kind: 'advice', refusal: null, otherRun: false })
  })

  test('opens a subject\'s default display on a Run of this Workspace, and refuses one of another Workspace or about no Run (Q23)', () => {
    const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
    const subjectOpen = (resource: Record<string, unknown>, subject = 'plant:halden-2#auxFeedwaterValveA') => fromHost({ type: 'leitbild:view-subject-open', resource, subject, title: 'Review: THROTTLE to 40 % AFW-A-CV' })
    expect(readDisplayWindowHostMessage(subjectOpen(run), expected)).toEqual({ kind: 'subject-open', runId: 'run-1', subject: 'plant:halden-2#auxFeedwaterValveA', title: 'Review: THROTTLE to 40 % AFW-A-CV' })
    expect(readDisplayWindowHostMessage(subjectOpen({ ...run, workspaceId: 'f1b1e5a8-9a43-4d4e-9d3a-1a7c4b1e2f00' }), expected))
      .toEqual({ kind: 'rejected', reason: 'display request refused: plant:halden-2#auxFeedwaterValveA belongs to another Workspace' })
    expect(readDisplayWindowHostMessage(subjectOpen({ ...run, type: 'world.scenario', id: 'halden' }), expected))
      .toEqual({ kind: 'rejected', reason: 'display request refused: plant:halden-2#auxFeedwaterValveA is on a world.scenario, not a Simulation Run' })
    expect(readDisplayWindowHostMessage(subjectOpen(run, 'plant:halden-2'), expected)).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('A subject is <objectId>#<item>') })
    expect(readDisplayWindowHostMessage({ ...subjectOpen(run), origin: 'https://elsewhere.test' }, expected)).toBeNull()
  })

  test('shows nothing but vignettes, and says so: the plant\'s own process display went at the swap', () => {
    const envelope = view().envelope
    expect(listingRefusal({ ...envelope, viewType: 'electric-grid.display' } as never)).toBe('it is a electric-grid.display view, which this window does not show')
    expect(listingRefusal({ ...envelope, viewType: 'process-plant.display' } as never)).toBe('it is a process-plant.display view, which this window does not show')
  })
})
