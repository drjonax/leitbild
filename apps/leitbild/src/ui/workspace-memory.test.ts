import { describe, expect, test } from 'bun:test'
import { createWorkspaceMemory, isWorkspaceId, LAST_WORKSPACE_KEY, RECENT_WORKSPACES_KEY, type WorkspaceMemoryStorage } from './workspace-memory.ts'

const ids = Array.from({ length: 7 }, (_, index) => `0b4b9a52-2f7e-4c1a-9d3e-00000000000${index}`)
const fakeStorage = (initial: Record<string, string> = {}): WorkspaceMemoryStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  }
}
const throwingStorage: WorkspaceMemoryStorage = {
  getItem: () => { throw new DOMException('blocked', 'SecurityError') },
  setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
  removeItem: () => { throw new DOMException('blocked', 'SecurityError') },
}

describe('remembered Workspace (rule 6)', () => {
  test('visiting a shared Workspace link adds it to Recent but never makes it the default', () => {
    const memory = createWorkspaceMemory(fakeStorage())
    memory.visited(ids[0]!)
    expect(memory.remembered()).toBeNull()
    expect(memory.recent()).toEqual([ids[0]!])
  })

  test('visiting does not replace a chosen default', () => {
    const memory = createWorkspaceMemory(fakeStorage())
    memory.remember(ids[0]!, 'picked')
    memory.visited(ids[1]!)
    expect(memory.remembered()).toBe(ids[0]!)
    expect(memory.recent()).toEqual([ids[1]!, ids[0]!])
  })

  test('create, pick, launch and ask each set the default and Recent', () => {
    for (const reason of ['created', 'picked', 'launched', 'asked'] as const) {
      const memory = createWorkspaceMemory(fakeStorage())
      memory.remember(ids[2]!, reason)
      expect(memory.remembered()).toBe(ids[2]!)
      expect(memory.recent()).toEqual([ids[2]!])
    }
  })

  test('keeps at most five recent Workspaces, newest first, without duplicates', () => {
    const memory = createWorkspaceMemory(fakeStorage())
    for (const id of ids) memory.visited(id)
    memory.visited(ids[4]!)
    expect(memory.recent()).toEqual([ids[4]!, ids[6]!, ids[5]!, ids[3]!, ids[2]!])
  })

  test('forgets a Workspace that no longer exists', () => {
    const memory = createWorkspaceMemory(fakeStorage())
    memory.remember(ids[0]!, 'launched')
    memory.visited(ids[1]!)
    memory.forget(ids[0]!)
    expect(memory.remembered()).toBeNull()
    expect(memory.recent()).toEqual([ids[1]!])
  })

  test('drops values that are not Workspace ids', () => {
    const storage = fakeStorage({ [LAST_WORKSPACE_KEY]: 'not-a-uuid', [RECENT_WORKSPACES_KEY]: JSON.stringify([ids[0], 'x', 42, ids[0]]) })
    const memory = createWorkspaceMemory(storage)
    expect(memory.remembered()).toBeNull()
    expect(storage.data.has(LAST_WORKSPACE_KEY)).toBe(false)
    expect(memory.recent()).toEqual([ids[0]!])
    expect(storage.data.get(RECENT_WORKSPACES_KEY)).toBe(JSON.stringify([ids[0]]))
    expect(createWorkspaceMemory(fakeStorage({ [RECENT_WORKSPACES_KEY]: '{broken' })).recent()).toEqual([])
    expect(() => memory.remember('../evil', 'picked')).toThrow()
    expect(() => memory.visited('')).toThrow()
  })

  test('storage that is missing or throws means nothing is remembered, and the page keeps working', () => {
    for (const storage of [null, throwingStorage]) {
      const memory = createWorkspaceMemory(storage)
      expect(() => memory.remember(ids[0]!, 'created')).not.toThrow()
      expect(() => memory.visited(ids[1]!)).not.toThrow()
      expect(() => memory.forget(ids[0]!)).not.toThrow()
      expect(memory.remembered()).toBeNull()
      expect(memory.recent()).toEqual([])
    }
  })

  test('recognises Workspace ids like the contract does', () => {
    expect(isWorkspaceId(ids[0])).toBe(true)
    expect(isWorkspaceId(crypto.randomUUID())).toBe(true)
    expect(isWorkspaceId('b56b1d')).toBe(false)
    expect(isWorkspaceId(undefined)).toBe(false)
  })
})
