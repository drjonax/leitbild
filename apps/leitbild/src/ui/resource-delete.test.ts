import { describe, expect, test } from 'bun:test'
import { moduleCapabilityDescriptorSchema, moduleResourceDescriptorSchema, type ModuleResourceDescriptor } from '@leitbild/contracts'
import { CONVERSATION_NOUN, deleteEach, ITEM_NOUN, SIMULATION_NOUN } from './bulk-delete.ts'
import { CAPACITY_TEXT } from './error-text.ts'
import { fakeFetch, hostError, json } from './host-fetch-fake.test-support.ts'
import { createResourceRemover, resourceDeleteBody, resourceDeleteItem, resourceNoun } from './resource-delete.ts'
import { room, run, WS } from './workspace-page.test-support.ts'

const capability = (id: string, resourceType: string, risk: 'destructive' | 'write' = 'destructive') => moduleCapabilityDescriptorSchema.parse({
  id, moduleId: id.split('.')[0], kind: 'command', scope: { kind: 'resource', resourceType },
  title: 'Delete', description: 'Deletes it', risk, idempotent: false,
  inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
})
// The ids are the ones the fixtures' Modules publish; the Host code under test reads them from the descriptors.
const runDelete = capability('world.simulation-run.delete', 'world.simulation-run')
const roomDelete = capability('agents.room.delete', 'agents.room')
const deletable = (resource: ModuleResourceDescriptor, capabilityId: string): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
  ...resource, capabilityIds: [capabilityId], deleteCapabilityId: capabilityId,
})
const running = deletable(run('a', 'Running', '2026-10-12T21:00:00.000Z'), runDelete.id)
const paused = deletable(run('b', 'Paused', '2026-10-12T20:00:00.000Z'), runDelete.id)
const chat = deletable(room('c', '2026-10-12T21:30:00.000Z'), roomDelete.id)
const capabilities = [runDelete, roomDelete]
const invokePath = (capabilityId: string): string => `/api/workspaces/${WS}/capabilities/${encodeURIComponent(capabilityId)}/invoke`

describe('what can be deleted', () => {
  test('a Resource is deletable through the delete Capability its descriptor names; a Run shows its status and age', () => {
    expect(resourceDeleteItem(running, capabilities, new Date('2026-10-12T21:05:00.000Z'))).toMatchObject({
      key: 'world.simulation-run:a', label: 'Run a', note: 'Running · started 5 min ago', capability: { id: 'world.simulation-run.delete' },
    })
    expect(resourceDeleteItem(chat, capabilities)).toMatchObject({ key: 'agents.room:c', label: 'Room c', capability: { id: 'agents.room.delete' } })
    expect(resourceDeleteItem(chat, capabilities)?.note).toBeUndefined()
  })

  test('no delete Capability, or one the catalogue does not list, offers no delete', () => {
    expect(resourceDeleteItem(run('d', 'Running', '2026-10-12T21:00:00.000Z'), capabilities)).toBeNull()
    expect(resourceDeleteItem(running, [roomDelete])).toBeNull()
  })

  test('a delete Capability that is not destructive is refused, never guessed', () => {
    expect(() => resourceDeleteItem(running, [capability('world.simulation-run.delete', 'world.simulation-run', 'write')])).toThrow('Invalid delete')
  })

  test('the words follow what is deleted', () => {
    const [a, b, c] = [running, paused, chat].map(resource => resourceDeleteItem(resource, capabilities)!)
    expect(resourceNoun([a!, b!])).toBe(SIMULATION_NOUN)
    expect(resourceNoun([c!])).toBe(CONVERSATION_NOUN)
    expect(resourceNoun([a!, c!])).toBe(ITEM_NOUN)
    expect(resourceDeleteBody([a!])).toBe('Deleting stops it and removes it for everyone. This cannot be undone.')
    expect(resourceDeleteBody([a!, b!])).toBe('Deleting stops them and removes them for everyone. This cannot be undone.')
    expect(resourceDeleteBody([c!])).toBe('Its messages are deleted for everyone. This cannot be undone.')
    expect(resourceDeleteBody([a!, c!])).toBe('They are deleted for everyone. This cannot be undone.')
  })
})

describe('deleting', () => {
  test('invokes each Resource\'s own delete Capability with its reference, as a person', async () => {
    const host = fakeFetch()
      .on('POST', invokePath(runDelete.id), json({ result: { deleted: true } }))
      .on('POST', invokePath(roomDelete.id), json({ result: { deleted: true } }))
    const remove = createResourceRemover(WS, host.fetch)
    const items = [running, chat].map(resource => resourceDeleteItem(resource, capabilities)!)
    expect(await deleteEach(items, remove)).toEqual({ removed: items, failed: [] })
    expect(host.calls.map(call => [call.path, call.body])).toEqual([
      [invokePath(runDelete.id), { resource: running.ref, input: {}, actor: { kind: 'human' } }],
      [invokePath(roomDelete.id), { resource: chat.ref, input: {}, actor: { kind: 'human' } }],
    ])
  })

  test('already gone counts as deleted; a refusal is that item\'s failure in plain words', async () => {
    const host = fakeFetch().on('POST', invokePath(runDelete.id),
      hostError(404, 'simulation_run_not_found', 'Simulation Run not found'),
      hostError(503, 'workspace_capacity_exceeded', 'capacity'))
    const remove = createResourceRemover(WS, host.fetch)
    const [a, b] = [running, paused].map(resource => resourceDeleteItem(resource, capabilities)!)
    const error = console.error
    console.error = () => {}
    try {
      const result = await deleteEach([a!, b!], remove, { concurrency: 1 })
      expect(result.removed).toEqual([a!])
      expect(result.failed).toEqual([{ item: b!, text: CAPACITY_TEXT }])
    } finally { console.error = error }
  })
})
