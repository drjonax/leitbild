import { describe, expect, test } from 'bun:test'
import { assistantDestination, assistantPrompt, guideConversationTitle, handoffStatusText, openAssistantConversation } from './assistant-handoff.ts'
import { fakeFetch, hostError, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import { createWorkspaceApi } from './launch-workspace.ts'
import { createWorkspaceMemory } from './workspace-memory.ts'

describe('Wiki Assistant context', () => {
  test('includes only the visible source reference and exact publication, not document contents', () => {
    const page = { path: 'world/packs/process-plant/reference-designs/ld-01/index.md', title: 'LD-01', revision: 'published-revision' }
    expect(assistantPrompt('Which cooling paths are specified?', { kind: 'wiki', page })).toBe(
      'Which cooling paths are specified?\n\nWiki page I am viewing: LD-01\nSource: knowledge/world/packs/process-plant/reference-designs/ld-01/index.md\nKnowledge revision: published-revision',
    )
  })
  test('does not invent a source when the page has not loaded', () => {
    expect(assistantPrompt('Help me find the wiki', { kind: 'wiki', page: null })).toBe('Help me find the wiki')
  })
  test('retains the workspace header and opens only Agents, not an empty World', () => {
    expect(assistantDestination('workspace-id', 'room-id')).toBe('/workspaces/workspace-id?agents=room-id')
    const url = new URL(assistantDestination('workspace-id', 'room/id & test'), 'https://leitbild.app')
    expect(url.searchParams.get('agents')).toBe('room/id & test')
    expect(url.searchParams.has('world')).toBe(false)
  })
})

describe('Getting started guide context', () => {
  test('says visibly where a question came from', () => {
    expect(assistantPrompt('How can I see exactly what went into one of your answers?', { kind: 'guide-suggestion' })).toBe(
      'How can I see exactly what went into one of your answers?\n\nAsked from: Getting started guide · suggested question',
    )
    expect(assistantPrompt('Can I model a BWR?', { kind: 'guide-question', lastPageTitle: 'The nuclear plant' })).toBe(
      'Can I model a BWR?\n\nAsked from: Getting started guide · own question · last page viewed: “The nuclear plant”',
    )
    expect(assistantPrompt('Hello', { kind: 'guide-question', lastPageTitle: null })).toBe(
      'Hello\n\nAsked from: Getting started guide · own question · no page viewed',
    )
  })

  test('names a new conversation after the question, within the 80 characters Agents allows', () => {
    expect(guideConversationTitle('  Where does the grid data   come from? ')).toBe('Getting started: Where does the grid data come from?')
    const long = guideConversationTitle('How do I run an Einsatz exercise with several people on their own iPads, and what does each person see?')
    expect(long).toBe('Getting started: How do I run an Einsatz exercise with several people on their…')
    expect(long.length).toBeLessThanOrEqual(80)
    expect(guideConversationTitle('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })

  test('has one status sentence per step', () => {
    const workspace = workspaceFixture(WS, { name: null }) as never
    expect(handoffStatusText({ kind: 'using-workspace', workspace })).toBe('Using Untitled · 0b4b9a.')
    expect(handoffStatusText({ kind: 'creating-workspace' })).toBe('Creating a Workspace…')
    expect(handoffStatusText({ kind: 'opening-conversation', workspace })).toBe('Opening a new conversation…')
    expect(handoffStatusText({ kind: 'sending-question', workspace })).toBe('Sending your question…')
  })
})

const WS = '0b4b9a52-2f7e-4c1a-9d3e-000000000001'
const capabilities = (scope = 'workspace') => json({ capabilities: [{ id: 'agents.assistance.open', scope: { kind: scope } }], modules: [] })
const handoffPorts = () => {
  const host = fakeFetch()
  const data = new Map<string, string>()
  const memory = createWorkspaceMemory({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } })
  const steps: string[] = []
  return {
    host, memory, steps,
    ports: { api: createWorkspaceApi(host.fetch), memory, fetch: host.fetch, now: () => new Date(2026, 9, 12, 22, 41), onstep: (step: { kind: string }) => { steps.push(step.kind) } },
  }
}

describe('Assistant hand-off', () => {
  test('a guide question opens a fresh, titled conversation in a new Workspace and remembers it', async () => {
    const { host, memory, steps, ports } = handoffPorts()
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(WS, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, json({ result: { resource: { workspaceId: WS, id: 'room-7' } } }))
    const result = await openAssistantConversation({
      text: '  What can I try in Leitbild in my first ten minutes?  ', origin: { kind: 'guide-suggestion' }, conversation: 'new',
    }, ports)
    expect(result).toMatchObject({ roomId: 'room-7', created: true, destination: `/workspaces/${WS}?agents=room-7` })
    expect(host.calls.at(-1)!.body).toEqual({
      input: {
        prompt: 'What can I try in Leitbild in my first ten minutes?\n\nAsked from: Getting started guide · suggested question',
        conversation: 'new', title: 'Getting started: What can I try in Leitbild in my first ten minutes?',
      },
      actor: { kind: 'human' },
    })
    expect(steps).toEqual(['creating-workspace', 'created-workspace', 'opening-conversation', 'sending-question'])
    expect(memory.remembered()).toBe(WS)
  })

  test('the wiki keeps today\'s request: the remembered Workspace\'s conversation and the unchanged message', async () => {
    const { host, memory, ports } = handoffPorts()
    memory.remember(WS, 'picked')
    host.on('GET', `/api/workspaces/${WS}`, json({ workspace: workspaceFixture(WS) }))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, json({ result: { resource: { workspaceId: WS, id: 'room-1' } } }))
    const page = { path: 'index.md', title: 'Leitbild', revision: 'rev' }
    await openAssistantConversation({ text: 'Help', origin: { kind: 'wiki', page }, conversation: 'reuse' }, ports)
    expect(host.calls.at(-1)!.body).toEqual({
      input: { prompt: 'Help\n\nWiki page I am viewing: Leitbild\nSource: knowledge/index.md\nKnowledge revision: rev' },
      actor: { kind: 'human' },
    })
  })

  test('refuses an empty question or an over-long title before any request', async () => {
    const { host, ports } = handoffPorts()
    await expect(openAssistantConversation({ text: '   ', origin: { kind: 'guide-suggestion' }, conversation: 'new' }, ports)).rejects.toThrow('Type a question first')
    await expect(openAssistantConversation({ text: 'Hi', origin: { kind: 'guide-suggestion' }, conversation: 'new', title: 'x'.repeat(81) }, ports))
      .rejects.toThrow('1–80 characters')
    expect(host.calls).toHaveLength(0)
  })

  test('a chip may name its conversation with its label', async () => {
    const { host, ports } = handoffPorts()
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(WS) }, 201))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, json({ result: { resource: { workspaceId: WS, id: 'room-2' } } }))
    await openAssistantConversation({
      text: 'Where does Leitbild\'s Norwegian grid model come from?', title: 'Where does the grid data come from?',
      origin: { kind: 'guide-suggestion' }, conversation: 'new',
    }, ports)
    expect((host.calls.at(-1)!.body as { input: { title: string } }).input.title).toBe('Where does the grid data come from?')
  })

  test('a Workspace without the Workspace-scoped Assistant is a visible error, and nothing is sent', async () => {
    const { host, memory, ports } = handoffPorts()
    memory.remember(WS, 'picked')
    host.on('GET', `/api/workspaces/${WS}`, json({ workspace: workspaceFixture(WS) }))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities('room'))
    const error = await openAssistantConversation({ text: 'Hi', origin: { kind: 'guide-suggestion' }, conversation: 'new' }, ports).catch(cause => cause)
    expect(error).toMatchObject({ code: 'assistant_unavailable', message: 'The Leitbild Assistant is not available in this Workspace right now.' })
    expect(host.calls.some(call => call.method === 'POST')).toBe(false)
  })

  test('a failed invoke surfaces the Host error with its status and code', async () => {
    const { host, ports } = handoffPorts()
    const memory = createWorkspaceMemory(null)
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(WS) }, 201))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, hostError(504, 'module_outcome_unknown', 'Lost the connection'))
    const error = await openAssistantConversation({ text: 'Hi', origin: { kind: 'guide-suggestion' }, conversation: 'new' }, { ...ports, memory }).catch(cause => cause)
    expect(error).toMatchObject({ status: 504, code: 'module_outcome_unknown' })
  })

  test('rejects a conversation from another Workspace', async () => {
    const { host, memory, ports } = handoffPorts()
    memory.remember(WS, 'picked')
    host.on('GET', `/api/workspaces/${WS}`, json({ workspace: workspaceFixture(WS) }))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, capabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, json({ result: { resource: { workspaceId: 'elsewhere', id: 'room' } } }))
    await expect(openAssistantConversation({ text: 'Hi', origin: { kind: 'guide-suggestion' }, conversation: 'new' }, ports)).rejects.toThrow('did not return a conversation')
  })
})
