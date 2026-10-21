/**
 * T01: which listings the display window opens, one at a time, and the
 * reason it gives for one it refuses. Per listing, so the facts hold whether
 * a refused listing refuses its whole list (today) or only itself.
 */
import { listingRefusal, readDisplayWindowHostMessage } from '../../src/ui/process-display/display-window-messages.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const parent = { name: 'host' }
const expected = { origin: 'https://leitbild.test', parent, workspaceId }

const listing = (overrides: Record<string, unknown> = {}) => ({
  key: 'room/turn/call/key',
  caption: 'Answer 14:02:31',
  envelope: {
    moduleId: 'world', viewType: 'process-plant.display',
    subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    title: 'SG B level', height: 600, state: '{"composition":{}}',
    ...overrides,
  },
})

export const LISTINGS: Readonly<Record<string, ReturnType<typeof listing>>> = {
  'a process display about a Run of this Workspace': listing(),
  'another Workspace': listing({ subject: { workspaceId: 'f1b1e5a8-9a43-4d4e-9d3a-1a7c4b1e2f00', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }),
  'not a World view': listing({ moduleId: 'agents' }),
  'another view type': listing({ viewType: 'electric-grid.display' }),
  'not about a Run': listing({ subject: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'halden' } }),
  'too tall': listing({ height: 5000 }),
}

export const observeListings = (): Record<string, unknown> => Object.fromEntries(Object.entries(LISTINGS).map(([name, view]) => {
  const read = readDisplayWindowHostMessage({ origin: expected.origin, source: parent, data: { type: 'leitbild:view-open', view } }, expected)
  if (read === null || read.kind !== 'open') return [name, read === null ? null : read.kind === 'rejected' ? { opens: false, reason: read.reason } : { opens: false }]
  // Opened, the window shows a frame, or in its place why it cannot show the listing (a view of another type).
  const refusal = listingRefusal(read.view.envelope)
  return [name, refusal === null ? { opens: true } : { opens: true, shown: false, reason: refusal }]
}))
