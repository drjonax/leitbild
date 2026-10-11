// Verifies the pack-aware tool surface filter — the structural fix for
// tool-context bloat. Built-in and authored tools remain independent of Pack
// activation; activating a Pack adds only that Pack's tools.

import { describe, expect, test } from 'bun:test'
import { buildToolSupport, effectiveAgentToolSelection } from './spawn.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool, ToolResult } from '../core/types/tool.ts'
import type { LLMProvider } from '../core/types/llm.ts'

const okTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  execute: async (): Promise<ToolResult> => ({ success: true, data: name }),
})

// Provider isn't actually exercised — buildToolSupport just threads it into
// the lazy ToolContext for sub-LLM calls inside tool execute().
const stubProvider = {} as unknown as LLMProvider

const makeRoom = (activePacks: string[]) => ({ getActivePacks: () => activePacks })

describe('pack-aware tool surface filter', () => {
  test('every AI Agent gets the small generic Workspace broker surface', () => {
    expect(effectiveAgentToolSelection({
      name: 'Operator',
      model: 'test',
      persona: 'Observe the World.',
      tools: ['product_read'],
    })).toEqual([
      'product_read',
      'workspace_explore',
      'workspace_call',
      'conversation_read',
    ])
  })

  test('with no Packs active, agent sees built-in and authored tools only', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })
    registry.registerWithSource(okTool('local_tool'), { kind: 'external', path: '/x.ts' })
    registry.registerWithSource(okTool('site-survey_atc'), {
      kind: 'pack-owned', pack: 'site-survey', path: '/p/atc.ts', displayName: 'atc',
    })
    registry.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-owned', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      (roomId: string) => roomId === 'r1' ? makeRoom([]) : undefined,
    )

    expect(support.resolveToolDefinitions).toBeDefined()
    const defs = support.resolveToolDefinitions!('r1')
    expect(defs).not.toBeNull()
    const names = (defs ?? []).map(d => d.function.name).sort()
    // 'pass' is auto-injected as another built-in tool.
    expect(names).toContain('core_tool')
    expect(names).toContain('local_tool')
    expect(names).not.toContain('site-survey_atc')
    expect(names).not.toContain('cafes_menu')
  })

  test('activating a pack exposes only that pack', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })
    registry.registerWithSource(okTool('site-survey_atc'), {
      kind: 'pack-owned', pack: 'site-survey', path: '/p/atc.ts', displayName: 'atc',
    })
    registry.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-owned', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      (roomId: string) => roomId === 'tower' ? makeRoom(['site-survey']) : undefined,
    )

    const defs = support.resolveToolDefinitions!('tower')
    const names = (defs ?? []).map(d => d.function.name)
    expect(names).toContain('core_tool')
    expect(names).toContain('site-survey_atc')
    expect(names).not.toContain('cafes_menu')
  })

  test('unknown room exposes no tools instead of falling back to the static selection', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      () => undefined,
    )

    expect(support.resolveToolDefinitions!('does-not-exist')).toEqual([])
  })

  test('without a Room resolver, support keeps its static selected-tool surface', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })

    const support = await buildToolSupport(
      ['core_tool'],
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
    )
    expect(support.resolveToolDefinitions).toBeUndefined()
    // toolDefinitions still set — the maximal set the agent was spawned with.
    expect(support.toolDefinitions?.length).toBeGreaterThan(0)
  })
})
