import { describe, expect, test } from 'bun:test'
import { launchDestination, workspacePath, workspaceUrl } from './launch-destination.ts'

const run = { moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const room = { moduleId: 'agents', type: 'agents.room', id: 'room-1' }

describe('launch destination', () => {
  test('opens a created Run in the World pane of its Workspace', () => {
    expect(launchDestination('ws', [run])).toBe('/workspaces/ws?world=run-1')
    expect(launchDestination('ws', [run, room])).toBe('/workspaces/ws?world=run-1&agents=room-1')
  })

  test('keeps the current Run for a created conversation, but never carries a conversation into a new Run', () => {
    expect(launchDestination('ws', [room], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=open-run&agents=room-1')
    expect(launchDestination('ws', [run], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=run-1')
    expect(launchDestination('ws', [], { world: 'open-run', agents: 'old-room' })).toBe('/workspaces/ws?world=open-run&agents=old-room')
    expect(launchDestination('ws', [])).toBe('/workspaces/ws')
  })

  test('ignores unrelated created resources and encodes identities', () => {
    expect(launchDestination('ws', [{ moduleId: 'world', type: 'world.scenario', id: 's' }])).toBe('/workspaces/ws')
    expect(workspacePath('a/b c')).toBe('/workspaces/a%2Fb%20c')
    expect(new URL(workspaceUrl('ws', { agents: 'room/id & test' }), 'https://leitbild.app').searchParams.get('agents')).toBe('room/id & test')
  })
})
