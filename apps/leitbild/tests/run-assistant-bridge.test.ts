import { describe, expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { createRunAssistantBridge } from '../src/ui/run-assistant-bridge.ts'

const workspaceId = newWorkspaceId()
const runRef = (id: string, inWorkspace: string = workspaceId) => ({ workspaceId: inWorkspace, moduleId: 'world', type: 'world.simulation-run', id })
const ready = { type: 'leitbild:view-window-ready' }
const openFor = (run: ReturnType<typeof runRef>) => ({ type: 'leitbild:run-assistant-open', run })
const offer = (available: boolean) => ({ type: 'leitbild:run-assistant-offer', available })

// Lets the bridge's asynchronous open settle.
const settle = async (): Promise<void> => { for (let turn = 0; turn < 3; turn += 1) await Promise.resolve() }

const harness = (options: { runId?: string | null; available?: boolean; openFailure?: string } = {}) => {
  const state = {
    runId: options.runId === undefined ? 'run-1' : options.runId,
    available: options.available ?? true,
    world: [] as Array<{ readonly type: string; readonly available: boolean }>,
    errors: [] as string[],
    opens: 0,
    shownAgents: 0,
    // Resolves the open under way; null while none waits.
    finishOpen: null as (() => void) | null,
    holdOpens: false,
  }
  const bridge = createRunAssistantBridge({
    workspaceId: () => workspaceId,
    worldRunId: () => state.runId,
    available: () => state.available,
    postToWorld: message => { state.world.push(message) },
    openAssistant: async () => {
      state.opens += 1
      if (state.holdOpens) await new Promise<void>(resolve => { state.finishOpen = resolve })
      if (options.openFailure !== undefined) throw new Error(options.openFailure)
    },
    showAgents: () => { state.shownAgents += 1 },
    reportError: message => { state.errors.push(message) },
  })
  return { bridge, state }
}

describe('Run Assistant bridge', () => {
  test('tells a listening World page whether it may offer the Assistant, and again on every ready and change', () => {
    const { bridge, state } = harness({ available: false })
    bridge.availabilityChanged()
    expect(state.world).toEqual([])

    bridge.fromWorld(ready)
    expect(state.world).toEqual([offer(false)])

    state.available = true
    bridge.availabilityChanged()
    expect(state.world).toEqual([offer(false), offer(true)])

    bridge.worldFrameUnloaded()
    state.available = false
    bridge.availabilityChanged()
    expect(state.world).toHaveLength(2)
    bridge.fromWorld(ready)
    expect(state.world.at(-1)).toEqual(offer(false))
    expect(state.errors).toEqual([])
  })

  test('a malformed ready is no sign that the page listens', () => {
    const { bridge, state } = harness()
    bridge.fromWorld({ ...ready, extra: true })
    bridge.availabilityChanged()
    expect(state.world).toEqual([])
    expect(state.errors).toEqual([])
  })

  test('posts freshly parsed plain messages', () => {
    const { bridge, state } = harness()
    bridge.fromWorld(ready)
    expect(structuredClone(state.world[0])).toEqual(offer(true))
  })

  test('shows the shown Run\'s Assistant and brings back a pane the split collapsed', async () => {
    const { bridge, state } = harness()
    bridge.fromWorld(openFor(runRef('run-1')))
    await settle()
    expect(state.opens).toBe(1)
    expect(state.shownAgents).toBe(1)
    expect(state.errors).toEqual([])
  })

  test('opens once while an open is under way, and again after it', async () => {
    const { bridge, state } = harness()
    state.holdOpens = true
    bridge.fromWorld(openFor(runRef('run-1')))
    bridge.fromWorld(openFor(runRef('run-1')))
    await settle()
    expect(state.opens).toBe(1)
    state.finishOpen?.()
    await settle()
    expect(state.shownAgents).toBe(1)

    state.holdOpens = false
    bridge.fromWorld(openFor(runRef('run-1')))
    await settle()
    expect(state.opens).toBe(2)
    expect(state.shownAgents).toBe(2)
  })

  test('reports an open that failed and leaves the panes as they are', async () => {
    const { bridge, state } = harness({ openFailure: 'Room scope controls are unavailable' })
    bridge.fromWorld(openFor(runRef('run-1')))
    await settle()
    expect(state.shownAgents).toBe(0)
    expect(state.errors).toEqual(['Assistant could not be opened: Room scope controls are unavailable'])
  })

  test('refuses visibly a request for another Run, another Workspace or a Run without its Assistant', async () => {
    const { bridge, state } = harness()
    bridge.fromWorld(openFor(runRef('run-2')))
    bridge.fromWorld(openFor(runRef('run-1', newWorkspaceId())))
    bridge.fromWorld(openFor({ ...runRef('run-1'), moduleId: 'agents', type: 'agents.room' }))
    state.available = false
    bridge.fromWorld(openFor(runRef('run-1')))
    state.available = true
    state.runId = null
    bridge.fromWorld(openFor(runRef('run-1')))
    await settle()
    expect(state.opens).toBe(0)
    expect(state.errors).toEqual([
      'Assistant request refused: it names a Run other than the one shown',
      'Assistant request refused: the Run belongs to another Workspace',
      'Assistant request refused: it names a Run other than the one shown',
      'Assistant could not be opened: this Run offers no Assistant',
      'Assistant request refused: it names a Run other than the one shown',
    ])
  })

  test('refuses invalid requests and messages the World page does not send, and leaves others alone', async () => {
    const { bridge, state } = harness()
    bridge.fromWorld({ type: 'leitbild:run-assistant-open' })
    bridge.fromWorld({ ...openFor(runRef('run-1')), room: 'room-1' })
    bridge.fromWorld(offer(true))
    bridge.fromWorld({ type: 'leitbild:view-window-maximise', maximised: true })
    bridge.fromWorld({ type: 'leitbild:scenario-dirty', dirty: true })
    bridge.fromWorld('leitbild:run-assistant-open')
    bridge.fromWorld(null)
    await settle()
    expect(state.opens).toBe(0)
    expect(state.world).toEqual([])
    expect(state.errors).toEqual([
      'Assistant request refused: run: Invalid input: expected object, received undefined',
      'Assistant request refused: Unrecognized key: "room"',
      'Assistant message refused: the World page does not send leitbild:run-assistant-offer',
    ])
  })
})
