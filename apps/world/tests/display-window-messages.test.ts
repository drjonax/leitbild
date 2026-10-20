import { describe, expect, test } from 'bun:test'
import { COMPOSED_DISPLAY_VIEW_TYPE } from '../src/packs/process-plant/displays/composition.ts'
import {
  listingRefusal,
  PROCESS_DISPLAY_VIEW_TYPE,
  readDisplayWindowHostMessage,
} from '../src/ui/process-display/display-window-messages.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const parent = { name: 'host' }
const expected = { origin: 'https://leitbild.test', parent, workspaceId }

const view = (overrides: Record<string, unknown> = {}, key = 'room/turn/call/key') => ({
  key,
  caption: 'Answer 14:02:31',
  envelope: {
    moduleId: 'world',
    viewType: 'process-plant.display',
    subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    title: 'SG B level',
    height: 600,
    state: '{"composition":{}}',
    ...overrides,
  },
})

const fromHost = (data: unknown) => ({ origin: expected.origin, source: parent, data })

describe('display window messages from the Host', () => {
  test('names the Pack view type it accepts', () => {
    expect(PROCESS_DISPLAY_VIEW_TYPE).toBe(COMPOSED_DISPLAY_VIEW_TYPE)
  })

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

  test('shows World process displays about a Run and says why it shows nothing else', () => {
    const envelope = view().envelope
    expect(listingRefusal(envelope as never)).toBeNull()
    expect(listingRefusal({ ...envelope, viewType: 'electric-grid.display' } as never)).toBe('it is a electric-grid.display view, which this window does not show')
    expect(listingRefusal({ ...envelope, moduleId: 'agents' } as never)).toBe('it is a process-plant.display view published by agents, not by World')
    expect(listingRefusal({ ...envelope, subject: { ...envelope.subject, type: 'world.scenario' } } as never)).toBe('it is about a world.scenario, not a Simulation Run')
  })
})
