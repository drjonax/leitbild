import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { objectIdSchema, type ActorId } from '../src/core/model/index.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { resolveName } from '../src/features/displays/observation/search.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createRoleRunWorkspaces, openRunDefinition } from './fixtures/role-runs.ts'

// world.simulation-run.observables.search (architecture A4, R23): every Pack's observables, elements and objects,
// folded for æ, ø and å both ways, ranked exact → qualified → all words → some words, read as the caller.

const definition = {
  ...openRunDefinition, id: 'search-run', title: 'Search Run',
  packs: [{ id: 'fixture', config: {}, items: [
    { id: 'site:base', label: 'Base', type: 'site', position: [10.7387, 59.9365] },
    { id: 'unit:kjolberg', label: 'Kjølberg', type: 'unit', atObject: 'site:base', speedMps: 15 },
    { id: 'unit:asgard', label: 'Åsgård', type: 'unit', position: [10.7707, 59.9146], speedMps: 12 },
    { id: 'unit:aeroy', label: 'Ærøy', type: 'unit', position: [10.75, 59.92], speedMps: 9 },
    { id: 'task:north', label: 'North pickup', type: 'task', position: [10.7874, 59.946], priority: 'high' },
  ] }],
}

let workspaces: WorldWorkspaceRuntimeRegistry
let dataDir: string
let run: SimulationRunRuntime
const workspaceId = newWorkspaceId() as WorkspaceId
const call = async (path: string, init?: RequestInit) => {
  const request = new Request(`http://world.test${path}`, init)
  const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces))!
  return { status: response.status, body: await response.json() as any }
}
const search = async (queries: ReadonlyArray<Record<string, string>>, kind: 'ai' | 'human' = 'ai') => (await call(`/internal/workspaces/${workspaceId}/capabilities/world.simulation-run.observables.search/invoke`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId, capabilityId: 'world.simulation-run.observables.search', resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.id },
    input: { queries }, access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: `${kind}-searcher` } }) }),
})).body
const top = async (text: string, extra: Record<string, string> = {}) => (await search([{ text, ...extra }])).result.results[0]

beforeAll(async () => {
  ({ workspaces, dataDir } = await createRoleRunWorkspaces(undefined, [definition]))
  await call(`/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
  run = await workspaces.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'search-run' })
})
afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('observables search', () => {
  test('is in the catalog, AI-visible', async () => {
    const catalog = (await call(`/internal/workspaces/${workspaceId}/capabilities`)).body.capabilities
    expect(catalog.find((entry: { id: string }) => entry.id === 'world.simulation-run.observables.search')).toMatchObject({ kind: 'query', risk: 'read' })
  })

  test('folds æ, ø and å both ways', async () => {
    for (const text of ['Kjølberg speed', 'Kjolberg speed', 'Kjoelberg speed', 'KJØLBERG SPEED']) expect((await top(text)).matches[0].ref).toBe('unit:kjolberg#speed')
    for (const text of ['Åsgård status', 'Asgard status', 'Aasgaard status']) expect((await top(text)).matches[0].ref).toBe('unit:asgard#status')
    for (const text of ['Ærøy speed', 'Aeroy speed', 'aeroey speed']) expect((await top(text)).matches[0].ref).toBe('unit:aeroy#speed')
  })

  test('every match names its ref, tag, element and object as declared (R23)', async () => {
    const [match] = (await top('Kjølberg speed')).matches
    expect(match).toMatchObject({ kind: 'observable', ref: 'unit:kjolberg#speed', objectId: 'unit:kjolberg', tag: 'SPD', element: { id: 'engine', class: 'mover' },
      label: 'Kjølberg · Kjølberg speed', pack: 'fixture', category: 'units', quantity: 'speed', unit: 'm/s', recorded: false })
    const engine = (await top('Kjølberg engine')).matches
    expect(engine[0]).toMatchObject({ kind: 'element', objectId: 'unit:kjolberg', element: { id: 'engine', class: 'mover' } })
    expect(engine.some((entry: { ref?: string }) => entry.ref === 'unit:kjolberg#speed')).toBe(true)
  })

  test('ranks an exact ref or tag, then a qualified name, then all words, then some; ties keep Run order', async () => {
    expect((await top('unit:asgard#status')).matches[0]).toMatchObject({ ref: 'unit:asgard#status', score: 4 })
    expect((await top('SPD', { objectId: 'unit:aeroy' })).matches[0]).toMatchObject({ ref: 'unit:aeroy#speed', score: 4 })
    expect((await top('unit:kjolberg#SPD')).matches[0]).toMatchObject({ ref: 'unit:kjolberg#speed', score: 3 })
    expect((await top('Kjølberg#speed')).matches[0]).toMatchObject({ ref: 'unit:kjolberg#speed', score: 3 })
    const speeds = (await top('speed')).matches.filter((entry: { kind: string }) => entry.kind === 'observable').map((entry: { ref: string }) => entry.ref)
    expect(speeds).toEqual(['unit:kjolberg#speed', 'unit:asgard#speed', 'unit:aeroy#speed'])
    const partial = await top('Kjølberg speed odometer')
    expect(partial.matches[0].score).toBeLessThan(1)
  })

  test('a bare object id lists the object, then its values in the Pack\'s lead order', async () => {
    const matches = (await top('unit:asgard')).matches
    expect(matches.slice(0, 3).map((entry: { kind: string; ref?: string }) => entry.ref ?? entry.kind)).toEqual(['object', 'unit:asgard#speed', 'unit:asgard#status'])
  })

  test('objects without declarations are found as objects in their presentation category', async () => {
    expect((await top('North pickup')).matches[0]).toMatchObject({ kind: 'object', objectId: 'task:north', category: 'tasks' })
    expect((await top('pickup', { category: 'units' })).matches).toEqual([])
  })

  test('suggests each Pack\'s nearest names when nothing matches fully', async () => {
    const result = await top('Kjalberg spead')
    expect(result.didYouMean).toEqual([{ pack: 'fixture', suggestions: expect.arrayContaining(['Kjølberg speed']) }])
    expect((await top('Kjølberg speed')).didYouMean).toBeUndefined()
  })

  test('refuses a Pack id as an object with its categories, and an unknown object', async () => {
    expect((await top('speed', { objectId: 'fixture' })).refused).toMatchObject({ code: 'pack_is_not_an_object', categories: ['units', 'tasks', 'sites'] })
    expect((await top('speed', { objectId: 'unit:nowhere' })).refused).toMatchObject({ code: 'unknown_object' })
  })

  test('T06: an object the AI may not inspect is absent, and refused when named', async () => {
    const person = { id: 'actor:human:restrict' as ActorId, label: 'Restrict', role: 'operator' as const }
    const revision = run.snapshot().scenario!.agentRestrictions.revision
    await run.setAgentRestrictions(person, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:kjolberg'), deny: ['inspect'] }] }, revision)
    try {
      const ai = (await search([{ text: 'Kjølberg speed' }, { text: 'speed', objectId: 'unit:kjolberg' }])).result.results
      expect(ai[0].matches.some((entry: { objectId: string }) => entry.objectId === 'unit:kjolberg')).toBe(false)
      expect(JSON.stringify(ai[0])).not.toContain('Kjølberg')
      expect(ai[1].refused).toMatchObject({ code: 'agent_access_restricted' })
      expect((await search([{ text: 'Kjølberg speed' }], 'human')).result.results[0].matches[0].ref).toBe('unit:kjolberg#speed')
    } finally {
      await run.setAgentRestrictions(person, { operationIds: [], objects: [] }, revision + 1)
    }
  })

  test('resolveName gives compose one ref for a qualified name and the lead for a bare object id, within its subjects', async () => {
    const person = { id: 'actor:human:resolve' as ActorId, label: 'Resolve', role: 'operator' as const }
    const searchRun = { objects: run.snapshot().objects, denied: new Set<string>(), packs: run.packs(), port: run.observations(person) }
    expect(await resolveName(searchRun, 'unit:kjolberg#SPD')).toEqual(['unit:kjolberg#speed'])
    expect(await resolveName(searchRun, 'Åsgård#status')).toEqual(['unit:asgard#status'])
    expect(await resolveName(searchRun, 'unit:aeroy')).toEqual(['unit:aeroy#speed', 'unit:aeroy#status'])
    expect(await resolveName(searchRun, 'unit:aeroy', ['unit:asgard'])).toEqual([])
    expect(await resolveName(searchRun, 'unit:kjolberg#odometer')).toEqual([])
  })
})
