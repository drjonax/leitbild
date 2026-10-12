import { describe, expect, test } from 'bun:test'
import { openAssistantConversation } from './assistant-handoff.ts'
import { askDestination, askProgress, guideConversationUrl, guideHandoffRequest, INITIAL_ASK_PROGRESS, questionError, questionText } from './guide-ask.ts'
import { guidePage, type GuidePrompt } from './guide-content.ts'
import { fakeFetch, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import { createWorkspaceApi } from './launch-workspace.ts'
import { createWorkspaceMemory } from './workspace-memory.ts'

const WS = '0b4b9a3c-55aa-4e2b-9c1d-2f3e4a5b6c7d'
const page = guidePage('ask')
const firstPrompt = (): GuidePrompt => {
  if (page.kind !== 'ask') throw new Error('The last page is the Ask page')
  return page.prompts[0]!
}

const memoryStore = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}

const agentsCapabilities = () => json({ capabilities: [{ id: 'agents.assistance.open', scope: { kind: 'workspace' } }] })

describe('what the Ask page sends', () => {
  test('a chip sends its prompt and names the conversation after its label', () => {
    const request = guideHandoffRequest({ kind: 'suggestion', prompt: firstPrompt() }, { workspaceId: null, forceNewWorkspace: false })
    expect(request).toEqual({
      text: 'What can I try in Leitbild in my first ten minutes? Point me to the demos and wiki pages that fit.',
      title: 'Getting started: What can I try in my first ten minutes?',
      origin: { kind: 'guide-suggestion' },
      conversation: 'new', workspaceId: null, forceNewWorkspace: false,
    })
  })

  test('a typed question says which chapter was viewed last and is named after its first words', () => {
    const request = guideHandoffRequest(
      { kind: 'question', text: 'Can two people share one plant?', lastPageTitle: 'The nuclear plant' },
      { workspaceId: WS, forceNewWorkspace: true },
    )
    expect(request).toEqual({
      text: 'Can two people share one plant?', origin: { kind: 'guide-question', lastPageTitle: 'The nuclear plant' },
      conversation: 'new', workspaceId: WS, forceNewWorkspace: true,
    })
    expect(questionText({ kind: 'question', text: '  Can two people share one plant? ', lastPageTitle: null })).toBe('Can two people share one plant?')
  })

  test('an empty or over-long question is refused with visible text', () => {
    expect(questionError('   ')).toBe('Type a question first')
    expect(questionError('x'.repeat(501))).toBe('Use at most 500 characters')
    expect(questionError('Where is Halden?')).toBeNull()
  })

  test('one chip click opens a fresh, titled conversation with its visible "Asked from" line (C7)', async () => {
    const host = fakeFetch()
      .on('POST', '/api/workspaces', json({ workspace: workspaceFixture(WS, { name: 'New Workspace · 13 Oct, 00:10' }) }, 201))
      .on('GET', `/api/workspaces/${WS}/capabilities?moduleId=agents`, agentsCapabilities())
      .on('POST', `/api/workspaces/${WS}/capabilities/agents.assistance.open/invoke`, json({ result: { resource: { workspaceId: WS, id: 'room-7' } } }, 201))
    const memory = createWorkspaceMemory(memoryStore())
    const handoff = await openAssistantConversation(
      guideHandoffRequest({ kind: 'suggestion', prompt: firstPrompt() }, { workspaceId: null, forceNewWorkspace: false }),
      { api: createWorkspaceApi(host.fetch), memory, now: () => new Date(2026, 9, 13, 0, 10), fetch: host.fetch },
    )
    expect(host.calls.at(-1)!.body).toEqual({
      input: {
        prompt: 'What can I try in Leitbild in my first ten minutes? Point me to the demos and wiki pages that fit.\n\nAsked from: Getting started guide · suggested question',
        conversation: 'new',
        title: 'Getting started: What can I try in my first ten minutes?',
      },
      actor: { kind: 'human' },
    })
    expect(guideConversationUrl(handoff.destination)).toBe(`/workspaces/${WS}?agents=room-7&from=guide`)
    expect(memory.remembered()).toBe(WS)
  })
})

describe('destination line', () => {
  const workspace = workspaceFixture(WS, { name: 'Grid study' }) as never

  test('names the remembered Workspace, offers a new one, and can switch back', () => {
    expect(askDestination(undefined, false)).toEqual({ kind: 'checking' })
    expect(askDestination(workspace, false)).toEqual({ kind: 'remembered', workspace })
    expect(askDestination(workspace, true)).toEqual({ kind: 'new', instead: workspace })
    expect(askDestination(null, false)).toEqual({ kind: 'new', instead: null })
  })

  test('the conversation link keeps the room and marks the guide as its origin', () => {
    expect(guideConversationUrl(`/workspaces/${WS}?agents=r1`)).toBe(`/workspaces/${WS}?agents=r1&from=guide`)
  })
})

describe('progress', () => {
  test('one status sentence per step; the Workspace step names the Workspace', () => {
    const workspace = workspaceFixture(WS, { name: null }) as never
    let progress = askProgress(INITIAL_ASK_PROGRESS, { kind: 'creating-workspace' })
    expect(progress.status).toBe('Creating a Workspace…')
    expect(progress.steps.map(step => step.state)).toEqual(['active', 'pending', 'pending'])
    expect(progress.steps[0]!.label).toBe('Create a Workspace')
    progress = askProgress(progress, { kind: 'created-workspace', workspace })
    expect(progress.steps[0]!.label).toBe('Use Untitled · 0b4b9a')
    progress = askProgress(progress, { kind: 'opening-conversation', workspace })
    expect(progress.status).toBe('Opening a new conversation…')
    expect(progress.steps.map(step => step.state)).toEqual(['done', 'active', 'pending'])
    expect(progress.steps[0]!.label).toBe('Use Untitled · 0b4b9a')
    progress = askProgress(progress, { kind: 'sending-question', workspace })
    expect(progress.status).toBe('Sending your question…')
    expect(progress.steps.map(step => step.state)).toEqual(['done', 'done', 'active'])
  })
})
