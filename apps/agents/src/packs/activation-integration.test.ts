// End-to-end activation test — exercises the full chain that the bloat
// fix relies on:
//   - tool surface filter (spawn-pack-filter)
//   - skill section filter (workspace-runtime.ts getSkillsForRoom — covered indirectly
//     via context-builder)
//   - script runner activation gate (script-runner.start)
//
// Each layer has its own unit test; this one verifies they compose
// correctly under realistic RoomDirectory + Room + Pack metadata, and that
// flipping room.setActivePacks() takes effect on the very next eval —
// no caching, no stale views (the b660b3e pattern this design avoids).

import { describe, test, expect } from 'bun:test'
import { createRoomDirectory } from '../core/rooms/directory.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { buildToolSupport, createToolExecutor } from '../agents/spawn.ts'
import type { Tool, ToolResult } from '../core/types/tool.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import { effectiveActivePacks } from './activation.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'

const okTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  execute: async (): Promise<ToolResult> => ({ success: true, data: name }),
})

const stubProvider = {} as unknown as LLMProvider

describe('pack activation — end-to-end with RoomDirectory + Room', () => {
  test.each(['deactivate', 'uninstall', 'delete-room'] as const)('%s while queued prevents stale tool dispatch', async change => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'Operations', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['site-survey'])
    const reg = createToolRegistry()
    let calls = 0
    reg.registerWithSource({ ...okTool('survey'), execute: async () => { calls++; return { success: true } } }, { kind: 'pack-owned', pack: 'site-survey' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const executor = createToolExecutor(reg, ['survey'], { callerId: 'test', callerName: 'Test' }, id => house.getRoom(id), undefined, undefined, undefined,
      async operation => { entered.resolve(); await release.promise; return operation() })
    const pending = executor([{ tool: 'survey', arguments: {} }], room.profile.id)
    await entered.promise
    if (change === 'deactivate') room.setActivePacks([])
    if (change === 'uninstall') reg.unregister('survey')
    if (change === 'delete-room') house.removeRoom(room.profile.id)
    release.resolve()
    const result = (await pending)[0]!
    expect(result.success).toBe(false)
    expect(result.error).toContain(change === 'deactivate' ? 'not active' : change === 'uninstall' ? 'not registered' : 'unavailable')
    expect(calls).toBe(0)
  })

  test.each(['deactivate', 'uninstall'] as const)('%s after dispatch does not cancel admitted work but blocks the next call', async change => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'Operations', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['site-survey'])
    const reg = createToolRegistry()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    reg.registerWithSource({ ...okTool('survey'), execute: async () => { calls++; entered.resolve(); await release.promise; return { success: true, data: 'admitted outcome' } } }, { kind: 'pack-owned', pack: 'site-survey' })
    const support = await buildToolSupport(['survey'], reg, { id: 'test', name: 'Test' }, stubProvider, id => house.getRoom(id))
    const pending = support.toolExecutor!([{ tool: 'survey', arguments: {} }, { tool: 'survey', arguments: {} }], room.profile.id)
    await entered.promise
    if (change === 'deactivate') room.setActivePacks([])
    else reg.unregister('survey')
    release.resolve()
    const result = await pending
    expect(result[0]).toEqual({ success: true, data: 'admitted outcome' })
    expect(result[1]!.success).toBe(false)
    expect(calls).toBe(1)
    expect(support.resolveToolDefinitions!(room.profile.id)).toEqual([])
  })

  test('deleted explicit Room cannot widen either projection or execution authority', async () => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'Operations', createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()
    let calls = 0
    reg.register({ ...okTool('builtin'), execute: async () => { calls++; return { success: true } } })
    const support = await buildToolSupport(['builtin'], reg, { id: 'test', name: 'Test' }, stubProvider, id => house.getRoom(id))
    house.removeRoom(room.profile.id)
    expect(support.resolveToolDefinitions!(room.profile.id)).toEqual([])
    expect((await support.toolExecutor!([{ tool: 'builtin', arguments: {} }], room.profile.id))[0]!.success).toBe(false)
    expect(calls).toBe(0)
  })

  test('fresh Room has no active Packs; selected non-Pack tools remain available', async () => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'Cafe', createdBy: SYSTEM_SENDER_ID })
    expect(room.getActivePacks()).toEqual([])
    const reg = createToolRegistry()

    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('local_a'),   { kind: 'external', path: '/x' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-owned', pack: 'site-survey', path: '/p/atc.ts', displayName: 'atc',
    })
    reg.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-owned', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      (id: string) => house.getRoom(id),
    )

    expect(support.resolveToolDefinitions).toBeDefined()
    const empty = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(empty).toContain('builtin_a')
    expect(empty).toContain('local_a')
    expect(empty).not.toContain('av_atc')
    expect(empty).not.toContain('cafes_menu')
  })

  test('flipping setActivePacks takes effect on the next resolve, no cache', async () => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'Tower', createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()
    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-owned', pack: 'site-survey', path: '/p/atc.ts', displayName: 'atc',
    })

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      (id: string) => house.getRoom(id),
    )

    // Empty activePacks → only the selected non-Pack tool matches.
    const before = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(before).toContain('builtin_a')
    expect(before).not.toContain('av_atc')

    room.setActivePacks(['site-survey'])

    // Next resolve sees the change without any explicit invalidation —
    // the resolver is pure over (room state, registry).
    const after = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(after).toContain('builtin_a')
    expect(after).toContain('av_atc')

    // Remove site-survey again.
    room.setActivePacks(room.getActivePacks().filter(p => p !== 'site-survey'))
    const reset = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(reset).not.toContain('av_atc')
  })

  test('two rooms diverge: each sees only its own active packs', async () => {
    const house = createRoomDirectory({})
    const tower = house.createRoom({ name: 'Tower', createdBy: SYSTEM_SENDER_ID })
    const cafe  = house.createRoom({ name: 'Cafe',  createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()
    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-owned', pack: 'site-survey', path: '/p/atc.ts', displayName: 'atc',
    })
    reg.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-owned', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    tower.setActivePacks(['site-survey'])
    cafe.setActivePacks(['cafes'])

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      (id: string) => house.getRoom(id),
    )

    const towerSurf = (support.resolveToolDefinitions!(tower.profile.id) ?? []).map(d => d.function.name)
    const cafeSurf  = (support.resolveToolDefinitions!(cafe.profile.id)  ?? []).map(d => d.function.name)

    expect(towerSurf).toContain('av_atc')
    expect(towerSurf).not.toContain('cafes_menu')
    expect(cafeSurf).toContain('cafes_menu')
    expect(cafeSurf).not.toContain('av_atc')
  })

  test('effectiveActivePacks is a passthrough — what the room says is what you get', () => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    expect(effectiveActivePacks(room)).toEqual([])
    room.setActivePacks(['z', 'a'])
    expect(effectiveActivePacks(room)).toEqual(['z', 'a'])
  })

  test('snapshot-style restore round-trips activePacks', () => {
    const house = createRoomDirectory({})
    const room = house.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['site-survey', 'cafes'])
    const state = room.getRoomState()
    expect(state.activePacks).toEqual(['site-survey', 'cafes'])

    // Fresh room from snapshot data.
    const house2 = createRoomDirectory({})
    const restored = house2.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    restored.restoreState({
      members: [],
      muted: [],
      mode: 'broadcast',
      paused: false,
      activePacks: state.activePacks,
    })
    expect(restored.getActivePacks()).toEqual(['site-survey', 'cafes'])
  })
})
