import { describe, expect, test } from 'bun:test'
import { createExecutionStore } from '../core/executions/store.ts'
import { discoveryMemo } from './discovery-memo.ts'
import { buildSystemSections } from './context-builder.ts'
import type { ToolResult } from '../core/types/tool.ts'
import type { AgentHistory } from '../core/types/messaging.ts'

const ROOM = 'room-1'
const target = { kind: 'resource', ref: { workspaceId: 'ws', moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } }
const plantsSchema = { type: 'object', properties: {} }
const composeSchema = { type: 'object', properties: { plantId: { type: 'string' }, panels: { type: 'array' } }, required: ['plantId', 'panels'] }

// The execution record as a turn leaves it: the explore that found the
// operations with their schemas, then the calls that used them.
const recordTurn = (store: ReturnType<typeof createExecutionStore>, turnId: string, agentId: string, startedAt: number, calls: ReadonlyArray<{ tool: string; result: ToolResult }>, status: 'completed' | 'running' = 'completed') => {
  store.beginTurn({ id: turnId, roomId: ROOM, agentId, startedAt })
  calls.forEach((call, index) => {
    const id = `${turnId}-call-${index}`
    store.recordAttempt(turnId, { id, tool: call.tool, arguments: {}, startedAt: startedAt + index })
    store.recordOutcome(turnId, id, call.result, startedAt + index)
  })
  if (status === 'completed') store.finishTurn(turnId, 'completed')
}
const explored = (operations: ReadonlyArray<{ operationId: string; inputSchema?: unknown }>): { tool: string; result: ToolResult } =>
  ({ tool: 'workspace_explore', result: { success: true, data: { operations } } })
const called = (results: ReadonlyArray<Record<string, unknown>>): { tool: string; result: ToolResult } =>
  ({ tool: 'workspace_call', result: { success: true, data: { results } } })

describe('discovery memo', () => {
  test('names the operations an Agent used in this Room, newest first, with the target and schema they had', () => {
    const store = createExecutionStore(':memory:')
    recordTurn(store, 'turn-1', 'assistant', 1_000, [
      explored([{ operationId: 'world.process-plant.plants.list', inputSchema: plantsSchema }, { operationId: 'world.process-plant.display.compose', inputSchema: composeSchema }]),
      called([{ key: 'plants', operationId: 'world.process-plant.plants.list', target, success: true, data: {} }]),
      called([{ key: 'display', operationId: 'world.process-plant.display.compose', target, success: true, data: {} }]),
    ])
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe([
      'Workspace operations you used earlier in this conversation, with the exact target and input schema they had then. '
        + 'Call them again with workspace_call without exploring them first; a target or schema that changed is refused with the current one.',
      `- world.process-plant.display.compose · target ${JSON.stringify(target)} · input schema ${JSON.stringify(composeSchema)}`,
      `- world.process-plant.plants.list · target ${JSON.stringify(target)} · input schema ${JSON.stringify(plantsSchema)}`,
    ].join('\n'))
  })

  test('remembers only what succeeded, takes a schema from a refusal, and leaves out other Agents and the running turn', () => {
    const store = createExecutionStore(':memory:')
    recordTurn(store, 'turn-1', 'assistant', 1_000, [
      called([
        { key: 'refused', operationId: 'world.process-plant.signals.read', success: false, error: 'invalid_request', inputSchema: plantsSchema },
        { key: 'read', operationId: 'world.process-plant.signals.search', target, success: true, data: {} },
      ]),
    ])
    recordTurn(store, 'turn-2', 'other-agent', 2_000, [called([{ key: 'x', operationId: 'world.weather.map-features', target, success: true, data: {} }])])
    recordTurn(store, 'turn-3', 'assistant', 3_000, [called([{ key: 'y', operationId: 'world.process-plant.controls.list', target, success: true, data: {} }])], 'running')
    recordTurn(store, 'turn-4', 'assistant', 4_000, [called([{ key: 'z', operationId: 'world.process-plant.signals.read', target, success: true, data: {} }])])
    const memo = discoveryMemo(store, ROOM, 'assistant')
    expect(memo.split('\n').slice(1)).toEqual([
      `- world.process-plant.signals.read · target ${JSON.stringify(target)} · input schema ${JSON.stringify(plantsSchema)}`,
      `- world.process-plant.signals.search · target ${JSON.stringify(target)} · input schema: read it with workspace_explore operationIds if you need it`,
    ])
    expect(memo).not.toContain('map-features')
    expect(memo).not.toContain('controls.list')
  })

  test('is empty without Workspace operations, so the context gains no section', () => {
    const store = createExecutionStore(':memory:')
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
    recordTurn(store, 'turn-1', 'assistant', 1_000, [{ tool: 'conversation_read', result: { success: true, data: {} } }])
    expect(discoveryMemo(store, ROOM, 'assistant')).toBe('')
  })

  test('reaches the system prompt as its own context section', () => {
    const history: AgentHistory = { rooms: new Map(), incoming: [], agentProfiles: new Map() } as unknown as AgentHistory
    const sections = buildSystemSections({
      agentId: 'assistant', persona: 'p', history, historyLimit: 10, resolveName: name => name,
      getDiscoveryMemo: roomId => roomId === ROOM ? 'Workspace operations you used earlier in this conversation …' : '',
    }, ROOM)
    expect(sections.find(section => section.key === 'ctx_discovery')).toMatchObject({ enabled: true, text: 'Workspace operations you used earlier in this conversation …' })
  })
})
