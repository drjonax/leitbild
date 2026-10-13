import { describe, expect, test } from 'bun:test'
import {
  moduleCapabilityDescriptorSchema, moduleDefinitionDescriptorSchema, moduleResourceDescriptorSchema, type ModuleResourceDescriptor,
} from '@leitbild/contracts'
import { CONVERSATION_NOUN, deleteEach, ITEM_NOUN, SCENARIO_NOUN, SIMULATION_NOUN } from './bulk-delete.ts'
import { catalogDeleteBody, catalogDeleteItem, catalogNoun, createCatalogRemover } from './catalog-delete.ts'
import { CAPACITY_TEXT } from './error-text.ts'
import { fakeFetch, hostError, json } from './host-fetch-fake.test-support.ts'
import { room, run, scenario, WS } from './workspace-page.test-support.ts'

const capability = (id: string, scope: { kind: 'resource'; resourceType: string } | { kind: 'definition'; definitionType: string }, risk: 'destructive' | 'write' = 'destructive') =>
  moduleCapabilityDescriptorSchema.parse({
    id, moduleId: id.split('.')[0], kind: 'command', scope,
    title: 'Delete', description: 'Deletes it', risk, idempotent: false,
    inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
  })
// The ids the fixtures' Modules publish; the Host code under test reads them from the descriptors.
const runDelete = capability('world.simulation-run.delete', { kind: 'resource', resourceType: 'world.simulation-run' })
const roomDelete = capability('agents.room.delete', { kind: 'resource', resourceType: 'agents.room' })
const scenarioDelete = capability('world.scenario.delete', { kind: 'definition', definitionType: 'world.scenario' })
const deletable = (resource: ModuleResourceDescriptor, capabilityId: string): ModuleResourceDescriptor => moduleResourceDescriptorSchema.parse({
  ...resource, capabilityIds: [capabilityId], deleteCapabilityId: capabilityId,
})
const running = deletable(run('a', 'Running', '2026-10-12T21:00:00.000Z'), runDelete.id)
const paused = deletable(run('b', 'Paused', '2026-10-12T20:00:00.000Z'), runDelete.id)
const chat = deletable(room('c', '2026-10-12T21:30:00.000Z'), roomDelete.id)
const exercise = moduleDefinitionDescriptorSchema.parse({ ...scenario('exercise', { primary: false }), capabilityIds: [scenarioDelete.id], deleteCapabilityId: scenarioDelete.id })
const capabilities = [runDelete, roomDelete, scenarioDelete]
const invokePath = (capabilityId: string): string => `/api/workspaces/${WS}/capabilities/${encodeURIComponent(capabilityId)}/invoke`
const quietly = async <T>(action: () => Promise<T>): Promise<T> => {
  const error = console.error
  console.error = () => {}
  try { return await action() } finally { console.error = error }
}

describe('what can be deleted', () => {
  test('through the delete Capability the descriptor names; a Run shows its status and age', () => {
    expect(catalogDeleteItem(running, capabilities, new Date('2026-10-12T21:05:00.000Z'))).toMatchObject({
      key: 'world.simulation-run:a', label: 'Run a', note: 'Running · started 5 min ago', capability: { id: 'world.simulation-run.delete' },
    })
    expect(catalogDeleteItem(chat, capabilities)).toMatchObject({ key: 'agents.room:c', label: 'Room c', capability: { id: 'agents.room.delete' } })
    expect(catalogDeleteItem(chat, capabilities)?.note).toBeUndefined()
    expect(catalogDeleteItem(exercise, capabilities)).toMatchObject({ key: 'world.scenario:exercise', capability: { id: 'world.scenario.delete' } })
  })

  test('no delete Capability, or one the catalogue does not list, offers no delete', () => {
    expect(catalogDeleteItem(run('d', 'Running', '2026-10-12T21:00:00.000Z'), capabilities)).toBeNull()
    expect(catalogDeleteItem(running, [roomDelete])).toBeNull()
  })

  test('a delete Capability that is not destructive is refused, never guessed', () => {
    expect(() => catalogDeleteItem(running, [capability('world.simulation-run.delete', { kind: 'resource', resourceType: 'world.simulation-run' }, 'write')]))
      .toThrow('Invalid delete')
  })

  test('the words follow what is deleted', () => {
    const [a, b, c, s] = [running, paused, chat, exercise].map(subject => catalogDeleteItem(subject, capabilities)!)
    expect(catalogNoun([a!, b!])).toBe(SIMULATION_NOUN)
    expect(catalogNoun([c!])).toBe(CONVERSATION_NOUN)
    expect(catalogNoun([s!])).toBe(SCENARIO_NOUN)
    expect(catalogNoun([a!, c!])).toBe(ITEM_NOUN)
    expect(catalogDeleteBody([a!])).toBe('Deleting stops it and removes it for everyone. This cannot be undone.')
    expect(catalogDeleteBody([a!, b!])).toBe('Deleting stops them and removes them for everyone. This cannot be undone.')
    expect(catalogDeleteBody([c!])).toBe('Its messages are deleted for everyone. This cannot be undone.')
    expect(catalogDeleteBody([s!])).toBe('It is removed from this Workspace for everyone; what was already started from it keeps running. This cannot be undone.')
    expect(catalogDeleteBody([a!, c!])).toBe('They are deleted for everyone. This cannot be undone.')
  })
})

describe('deleting', () => {
  test('invokes each one\'s own delete Capability: a Resource by reference, a Definition by its current revision', async () => {
    const host = fakeFetch()
      .on('POST', invokePath(runDelete.id), json({ result: { deleted: true } }))
      .on('POST', invokePath(roomDelete.id), json({ result: { deleted: true } }))
      .on('POST', invokePath(scenarioDelete.id), json({ result: { deleted: true } }))
    const items = [running, chat, exercise].map(subject => catalogDeleteItem(subject, capabilities)!)
    expect(await deleteEach(items, createCatalogRemover(WS, host.fetch), { concurrency: 1 })).toEqual({ removed: items, failed: [] })
    expect(host.calls.map(call => [call.path, call.body])).toEqual([
      [invokePath(runDelete.id), { resource: running.ref, input: {}, actor: { kind: 'human' } }],
      [invokePath(roomDelete.id), { resource: chat.ref, input: {}, actor: { kind: 'human' } }],
      [invokePath(scenarioDelete.id), { definition: { ...exercise.ref, revisionId: exercise.currentRevisionId }, input: {}, actor: { kind: 'human' } }],
    ])
  })

  test('the Module\'s own "does not exist" answer is already gone; a refusal is that item\'s failure in plain words', async () => {
    const host = fakeFetch()
      .on('POST', invokePath(runDelete.id), hostError(404, 'simulation_run_not_found', 'Simulation Run not found'), hostError(503, 'workspace_capacity_exceeded', 'capacity'))
      .on('POST', invokePath(roomDelete.id), hostError(404, 'room_not_found', 'Room not found'))
    const [a, b, c] = [running, paused, chat].map(subject => catalogDeleteItem(subject, capabilities)!)
    const result = await quietly(() => deleteEach([a!, b!, c!], createCatalogRemover(WS, host.fetch), { concurrency: 1 }))
    expect(result.removed).toEqual([a!, c!])
    expect(result.failed).toEqual([{ item: b!, text: CAPACITY_TEXT }])
  })

  test('a 404 for a Capability, route, Module or Workspace is a failure, never "deleted"', async () => {
    for (const [code, message] of [
      ['capability_not_found', 'Capability not found'], ['route_not_found', 'Route not found'],
      ['module_not_installed', 'Module is not installed: world'], ['room_not_found', 'Room not found'],
    ] as const) {
      const host = fakeFetch().on('POST', invokePath(runDelete.id), hostError(404, code, message))
      const item = catalogDeleteItem(running, capabilities)!
      const result = await quietly(() => deleteEach([item], createCatalogRemover(WS, host.fetch)))
      expect(result).toEqual({ removed: [], failed: [{ item, text: message }] })
    }
  })
})
