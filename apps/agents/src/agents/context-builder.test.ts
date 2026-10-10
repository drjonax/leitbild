import { test, expect, describe } from 'bun:test'
import { buildContext, buildSystemSections, flushIncoming, __strategyTestSeam, type BuildContextDeps } from './context-builder.ts'
import type { AgentHistory, Message, RoomProfile } from '../core/types/messaging.ts'

const mkProfile = (id: string, name: string, roomPrompt?: string): RoomProfile => ({
  id, name, roomPrompt, createdAt: Date.now(), createdBy: 'test', scope: { kind: 'workspace' }, scopeRevision: 0,
})

const mkHistory = (roomId: string, name: string, prompt?: string, messages: Message[] = []): AgentHistory => ({
  rooms: new Map([[roomId, {
    profile: mkProfile(roomId, name, prompt),
    history: messages,
    lastActiveAt: Date.now(),
  }]]),
  incoming: [],
  agentProfiles: new Map(),
})

const mkDeps = (overrides: Partial<BuildContextDeps> = {}): BuildContextDeps => ({
  agentId: 'agent-1',
  persona: 'You are Alpha.',
  workspacePrompt: 'Be concise.',
  responseFormat: 'Reply in plain text.',
  history: mkHistory('room-1', 'General', 'Topic: weather.'),
  historyLimit: 10,
  resolveName: (id) => id,
  ...overrides,
})

const systemText = (result: ReturnType<typeof buildContext>): string =>
  (result.systemBlocks ?? []).map(block => block.text).join('\n\n')

test('budget removal of older context is reported', () => {
  const history=mkHistory('room-1','General',undefined,Array.from({length:4},(_,i)=>({
    id:'old'+i,senderId:'human',type:'chat',roomId:'room-1',content:'x'.repeat(400),timestamp:i,
  })))
  history.incoming.push({id:'new',senderId:'human',type:'chat',roomId:'room-1',content:'hello',timestamp:5})
  const result=buildContext(mkDeps({history,contextTokenBudget:220,includeContext:{participants:false,activity:false,knownAgents:false},includePrompts:{workspace:false,room:false,persona:false,responseFormat:false,skills:false}}),'room-1')
  expect(result.messages.length).toBeLessThan(5)
  expect(result.warnings.some(warning=>warning.includes('dropped')||warning.includes('dropped'.toUpperCase()))).toBe(true)
})

test('a joined Agent uses the current compression summary without replaying cached originals', () => {
  const original: Message = { id: 'folded', roomId: 'room-1', senderId: 'human', content: 'exact original', timestamp: 1, type: 'chat' }
  const recent: Message = { ...original, id: 'recent', content: 'recent detail', timestamp: 2 }
  const summary: Message = { ...original, id: 'summary', senderId: 'system', content: 'current summary', timestamp: 3, type: 'room_summary' }
  const history = mkHistory('room-1', 'General', undefined, [original, recent])
  history.incoming.push(original)
  const result = buildContext(mkDeps({
    history, historyLimit: 1,
    getCompressedIds: () => new Set(['folded']),
    getCompressionSummary: () => summary,
  }), 'room-1')
  expect(result.messages.map(message => message.content)).toEqual([
    '[Room Summary]: current summary', '[human]: recent detail',
  ])
  expect(result.flushInfo.ids.has(original.id)).toBe(true)
  flushIncoming(result.flushInfo, history, 1)
  expect(history.incoming).toEqual([])
})

describe('context-builder includePrompts', () => {
  test('all sections included by default (undefined includePrompts)', () => {
    const result = buildContext(mkDeps(), 'room-1')
    const sys = systemText(result)
    expect(sys).toContain('<leitbild:workspace_rules>')
    expect(sys).toContain('<leitbild:room name="General">')
    expect(sys).toContain('<leitbild:identity>')
    expect(sys).toContain('<leitbild:response_format>')
  })

  test('workspace: false suppresses WORKSPACE RULES only', () => {
    const result = buildContext(mkDeps({ includePrompts: { workspace: false } }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:workspace_rules>')
    expect(sys).toContain('<leitbild:room name="General">')
    expect(sys).toContain('<leitbild:identity>')
    expect(sys).toContain('<leitbild:response_format>')
  })

  test('room: false suppresses ROOM only', () => {
    const result = buildContext(mkDeps({ includePrompts: { room: false } }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:room name="General">')
    expect(sys).toContain('<leitbild:workspace_rules>')
    expect(sys).toContain('<leitbild:identity>')
  })

  test('persona: false suppresses YOUR IDENTITY only', () => {
    const result = buildContext(mkDeps({ includePrompts: { persona: false } }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:identity>')
    expect(sys).toContain('<leitbild:workspace_rules>')
  })

  test('responseFormat: false suppresses RESPONSE FORMAT only', () => {
    const result = buildContext(mkDeps({ includePrompts: { responseFormat: false } }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:response_format>')
    expect(sys).toContain('<leitbild:identity>')
  })

  test('all four off: none of the four sections present; CONTEXT still emitted', () => {
    const result = buildContext(mkDeps({
      includePrompts: { persona: false, room: false, workspace: false, responseFormat: false },
    }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:workspace_rules>')
    expect(sys).not.toContain('<leitbild:room name="General">')
    expect(sys).not.toContain('<leitbild:identity>')
    expect(sys).not.toContain('<leitbild:response_format>')
    expect(sys).toContain('<leitbild:context>')
  })

  test('partial includePrompts defaults missing keys to true', () => {
    const result = buildContext(mkDeps({ includePrompts: { workspace: false } }), 'room-1')
    const sys = systemText(result)
    expect(sys).toContain('<leitbild:identity>')
    expect(sys).toContain('<leitbild:room name="General">')
    expect(sys).toContain('<leitbild:response_format>')
  })

  test('promptsEnabled: false excludes every prompt regardless of per-key flags', () => {
    const result = buildContext(mkDeps({
      promptsEnabled: false,
      includePrompts: { persona: true, room: true, workspace: true, responseFormat: true, skills: true },
    }), 'room-1')
    const sys = systemText(result)
    expect(sys).not.toContain('<leitbild:workspace_rules>')
    expect(sys).not.toContain('<leitbild:room name="General">')
    expect(sys).not.toContain('<leitbild:identity>')
    expect(sys).not.toContain('<leitbild:response_format>')
  })

  test('contextEnabled: false suppresses participants/activity/knownAgents', () => {
    const sections = buildSystemSections(mkDeps({ contextEnabled: false }), 'room-1')
    const toggleableKeys = ['ctx_participants', 'ctx_activity', 'ctx_knownAgents']
    for (const key of toggleableKeys) {
      const sec = sections.find(s => s.key === key)
      expect(sec?.enabled).toBe(false)
    }
  })
})

describe('buildSystemSections', () => {
  test('returns labelled sections with enabled flags', () => {
    const sections = buildSystemSections(mkDeps(), 'room-1')
    const byKey = Object.fromEntries(sections.map(s => [s.key, s]))
    expect(byKey.workspace?.enabled).toBe(true)
    expect(byKey.room?.enabled).toBe(true)
    expect(byKey.persona?.enabled).toBe(true)
    expect(byKey.responseFormat?.enabled).toBe(true)
    expect(byKey.skills?.enabled).toBe(false) // getSkills not provided
    expect(byKey.ctx_intro?.optional).toBe(false)
  })

  test('respects includePrompts.workspace=false', () => {
    const sections = buildSystemSections(mkDeps({ includePrompts: { workspace: false } }), 'room-1')
    expect(sections.find(s => s.key === 'workspace')!.enabled).toBe(false)
  })

  test('respects includeContext.knownAgents=false', () => {
    const history = mkHistory('room-1', 'General', undefined, [])
    history.agentProfiles.set('b', { id: 'b', name: 'Bob', kind: 'ai' })
    const sections = buildSystemSections(mkDeps({
      history, includeContext: { knownAgents: false },
    }), 'room-1')
    expect(sections.find(s => s.key === 'ctx_knownAgents')!.enabled).toBe(false)
  })
})

describe('context-builder skills + context-data toggles', () => {
  test('skills section appears by default when getSkills returns text', () => {
    const result = buildContext(mkDeps({
      getSkills: () => 'skill-text',
    }), 'room-1')
    expect(systemText(result)).toContain('<leitbild:skills>')
    expect(systemText(result)).toContain('skill-text')
  })

  test('includePrompts.skills false suppresses SKILLS block', () => {
    const result = buildContext(mkDeps({
      getSkills: () => 'skill-text',
      includePrompts: { skills: false },
    }), 'room-1')
    expect(systemText(result)).not.toContain('<leitbild:skills>')
  })

  test('includeContext.participants false suppresses Other participants', () => {
    // Need to add a participant — simulate by injecting history with another sender
    const history = mkHistory('room-1', 'General', 'Topic: weather.', [{
      id: 'm1', roomId: 'room-1', senderId: 'other-agent', senderName: 'Other',
      content: 'hi', timestamp: Date.now(), type: 'chat',
    }])
    const result = buildContext(mkDeps({
      history,
      includeContext: { participants: false },
    }), 'room-1')
    expect(systemText(result)).not.toContain('Other participants:')
  })

  test('includeContext.knownAgents false suppresses Known agents line', () => {
    const history = mkHistory('room-1', 'General', undefined, [])
    history.agentProfiles.set('b', { id: 'b', name: 'Bob', kind: 'ai' })
    const result = buildContext(mkDeps({
      history,
      includeContext: { knownAgents: false },
    }), 'room-1')
    expect(systemText(result)).not.toContain('Known agents:')
  })
})

// ============================================================================
// Strategy split — see ContextStrategy in context-builder.ts.
// These tests guard the regression class that motivated the split: dialogue
// inside a system prompt makes models autocomplete from it (the "Sam parroted
// Alex" bug). Structural tests alone wouldn't catch a future change that
// re-inlined dialogue into the system block.
// ============================================================================

const SCRIPT_DOC = `# SCRIPT: Test\n\n## Cast\n### Alex\n- persona: lead\n### Sam\n- persona: critic\n\n## Step 1 — Open\nRoles:\n  Alex — propose\n  Sam — challenge`
const dialogueFixture = [
  { speaker: 'Alex', content: 'I think we should ship.' },
  { speaker: 'Sam', content: 'What about the migration risk?' },
]

const mkScriptDeps = (overrides: Partial<BuildContextDeps> = {}): BuildContextDeps => mkDeps({
  agentId: 'agent-alex',
  resolveName: (id) => id === 'agent-alex' ? 'Alex' : id,
  getScriptContext: (_roomId, agentName) =>
    agentName === 'Alex'
      ? { systemDoc: SCRIPT_DOC, dialogue: dialogueFixture }
      : undefined,
  ...overrides,
})

describe('selectStrategy — routing', () => {
  test('returns Script strategy when getScriptContext returns a value', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    // Script: trailing instruction is non-null and contains the speak prompt.
    const trailing = strategy.buildTrailingInstruction()
    expect(trailing).not.toBeNull()
    expect(trailing!.content).toContain('Speak your next line as Alex')
  })

  test('returns Normal strategy when getScriptContext is absent', () => {
    const deps = mkDeps()  // no getScriptContext
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    expect(strategy.buildTrailingInstruction()).toBeNull()
  })

  test('returns Normal strategy when getScriptContext returns undefined for this agent', () => {
    const deps = mkScriptDeps({
      agentId: 'agent-bystander',
      resolveName: (id) => id === 'agent-bystander' ? 'Bystander' : id,
    })
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    expect(strategy.buildTrailingInstruction()).toBeNull()
  })
})

describe('createScriptStrategy — content regression guards', () => {
  // The "Sam parroted Alex" bug: dialogue inside a system block causes
  // autocompletion. These assertions guarantee dialogue lives in user/
  // assistant messages, NOT in the system block.

  test('system block contains script structure but NONE of the dialogue contents', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const sysText = strategy.buildSystemBlocks().map(b => b.text).join('\n')
    expect(sysText).toContain('SCRIPT: Test')
    expect(sysText).toContain('Roles:')
    for (const entry of dialogueFixture) {
      expect(sysText).not.toContain(entry.content)
    }
  })

  test('own-speaker dialogue is rendered as assistant role', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { messages } = strategy.buildHistoryMessages()
    const ownEntries = messages.filter(m => m.role === 'assistant')
    expect(ownEntries).toHaveLength(1)
    expect(ownEntries[0]!.content).toBe('I think we should ship.')
  })

  test('other-speaker dialogue is rendered as user role with "{speaker} said:" prefix', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { messages } = strategy.buildHistoryMessages()
    const others = messages.filter(m => m.role === 'user')
    expect(others).toHaveLength(1)
    expect(others[0]!.content).toBe('Sam said: What about the migration risk?')
  })

  test('all fresh incoming messages are added to flushIds', () => {
    const incoming: Message[] = [
      { id: 'inc-1', roomId: 'room-1', senderId: 'other', senderName: 'Other', content: 'hi', type: 'chat', timestamp: Date.now() },
      { id: 'inc-2', roomId: 'room-1', senderId: 'other', senderName: 'Other', content: 'hi2', type: 'chat', timestamp: Date.now() },
      { id: 'inc-skip', roomId: 'room-other', senderId: 'other', senderName: 'Other', content: 'wrong room', type: 'chat', timestamp: Date.now() },
    ]
    const history: AgentHistory = {
      rooms: new Map([['room-1', { profile: mkProfile('room-1', 'General'), history: [], lastActiveAt: Date.now() }]]),
      incoming,
      agentProfiles: new Map(),
    }
    const deps = mkScriptDeps({ history })
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { flushIds } = strategy.buildHistoryMessages()
    expect(flushIds.has('inc-1')).toBe(true)
    expect(flushIds.has('inc-2')).toBe(true)
    expect(flushIds.has('inc-skip')).toBe(false)  // wrong room — must NOT be flushed
  })
})

describe('buildContext — end-to-end snapshots (wire-format parity guard)', () => {
  test('Normal path: full message array shape', () => {
    const incoming: Message[] = [
      { id: 'in-1', roomId: 'room-1', senderId: 'b', senderName: 'Bob', content: 'morning', type: 'chat', timestamp: 1 },
    ]
    const old: Message[] = [
      { id: 'old-1', roomId: 'room-1', senderId: 'b', senderName: 'Bob', content: 'evening', type: 'chat', timestamp: 0 },
    ]
    const history: AgentHistory = {
      rooms: new Map([['room-1', { profile: mkProfile('room-1', 'General'), history: old, lastActiveAt: Date.now() }]]),
      incoming,
      agentProfiles: new Map([['b', { id: 'b', name: 'Bob', kind: 'ai' }]]),
    }
    const result = buildContext(mkDeps({
      history,
      resolveName: (id) => id === 'b' ? 'Bob' : id,
    }), 'room-1')
    expect(result.messages.map(m => m.role)).toEqual(['user', 'user'])
    // First user message is the OLD one (no [NEW] tag); second is the fresh incoming.
    expect(result.messages[0]!.content).toContain('[Bob]: evening')
    expect(result.messages[0]!.content).not.toContain('[NEW]')
    expect(result.messages[1]!.content).toContain('[NEW]')
    expect(result.messages[1]!.content).toContain('[Bob]: morning')
    expect(result.flushInfo.ids.has('in-1')).toBe(true)
    expect(result.flushInfo.ids.has('old-1')).toBe(false)
  })

  test('Script path: full message array shape with trailing instruction', () => {
    const result = buildContext(mkScriptDeps(), 'room-1')
    // Instructions are separate; messages contain dialogue + trailing turn.
    expect(result.messages.map(m => m.role)).toEqual(['assistant', 'user', 'user'])
    expect(systemText(result)).toContain('SCRIPT: Test')
    expect(result.messages[0]!.content).toBe('I think we should ship.')
    expect(result.messages[1]!.content).toBe('Sam said: What about the migration risk?')
    expect(result.messages[2]!.content).toContain('Speak your next line as Alex')
    // Single non-cacheable system block — see ScriptStrategy.buildSystemBlocks.
    expect(result.systemBlocks).toHaveLength(1)
    expect(result.systemBlocks![0]!.cacheable).toBe(false)
  })
})

describe('requested turn instruction', () => {
  test('ends the normal context as a transient user message counted in the history budget', () => {
    const history = mkHistory('room-1', 'General', undefined, Array.from({ length: 4 }, (_, i) => ({
      id: `m${i}`, roomId: 'room-1', senderId: 'human', content: `message ${i} ${'x'.repeat(200)}`, timestamp: i, type: 'chat' as const,
    })))
    const includes = { includeContext: { participants: false, activity: false, knownAgents: false }, includePrompts: { workspace: false, room: false, persona: false, responseFormat: false, skills: false } }
    const instruction = `[Display request] ${'y'.repeat(400)}`
    const without = buildContext(mkDeps({ history, contextTokenBudget: 260, ...includes }), 'room-1')
    const withInstruction = buildContext(mkDeps({ history, contextTokenBudget: 260, turnInstruction: instruction, ...includes }), 'room-1')
    expect(withInstruction.messages.at(-1)).toEqual({ role: 'user', content: instruction })
    expect(withInstruction.messages.length - 1).toBeLessThan(without.messages.length)
    expect(withInstruction.flushInfo.ids.size).toBe(0)
  })

  test('is refused where a script directs the room', () => {
    expect(() => buildContext(mkScriptDeps({ turnInstruction: 'Show a display.' }), 'room-1'))
      .toThrow('A requested turn cannot run while a script directs this room')
  })
})
