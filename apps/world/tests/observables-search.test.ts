import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { objectIdSchema, type ActorId } from '../src/core/model/index.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { resolveName, searchObservables } from '../src/features/displays/observation/search.ts'
import type { ObservationDeclaration } from '../src/core/observation/capabilities.ts'
import type { WorldPack } from '../src/core/packs/protocol.ts'
import type { ObservationPort } from '../src/features/displays/observation/port.ts'
import { createFixtureObject } from './fixtures/fixture-pack.ts'
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
    expect((await top('unit:kjolberg#SPD')).matches[0]).toMatchObject({ ref: 'unit:kjolberg#speed', score: 3.5 })
    expect((await top('Kjølberg#speed')).matches[0]).toMatchObject({ ref: 'unit:kjolberg#speed', score: 3.5 })
    // A qualified label: 3, up to 3.4 where its words are whole and name all of the entry (here they do).
    expect((await top('Åsgård#Åsgård status')).matches[0]).toMatchObject({ ref: 'unit:asgard#status', score: 3.4 })
    const speeds = (await top('speed')).matches.filter((entry: { kind: string }) => entry.kind === 'observable').map((entry: { ref: string }) => entry.ref)
    expect(speeds).toEqual(['unit:kjolberg#speed', 'unit:asgard#speed', 'unit:aeroy#speed'])
    // A word nothing in the Run knows is left out; one some entry knows but this one lacks makes a partial match.
    expect((await top('Kjølberg speed odometer')).matches[0]).toMatchObject({ ref: 'unit:kjolberg#speed' })
    expect((await top('Kjølberg speed odometer')).matches[0].score).toBeGreaterThan(2)
    const partial = (await top('Kjølberg pickup')).matches
    expect(partial[0].score).toBeLessThan(1)
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

// Ranking defects found by the T11 run (lead, p1-network): a short label word stood in for a long query word as its
// abbreviation ("Søa" for "Skogssäter", "SG" for "Skagerrak"), and an entry's object label inflated its share.
describe('ranking against a grid and a plant', () => {
  const at = '2026-01-01T08:00:00.000Z' as never
  const object = (id: string, label: string, packId: string) => ({ ...createFixtureObject({ type: 'site', id: id as never, label, position: [10, 59] }, { at, objectById: () => undefined }), packId: packId as never })
  const pack = (id: string) => ({ descriptor: { id, name: id }, presentation: {
    categories: [{ id: `${id}-objects`, label: `${id} objects`, emptyLabel: 'none', matches: () => true }],
    presentObject: () => ({ categoryId: `${id}-objects`, icon: 'i', color: '#000', summary: '', fields: [] }),
  } }) as unknown as WorldPack
  const observable = (ref: string, label: string, quantity: string, unit: string, element?: string, tag?: string) =>
    ({ ref, label, quantity, unit, valueType: 'number', thresholds: [], series: null, ...(element ? { element } : {}), ...(tag ? { tag } : {}) })
  const declarations: Record<string, ObservationDeclaration> = {
    'grid:test': { objectId: 'grid:test', revision: 'r1', observables: [observable('grid:test#grid.frequency', 'Frequency', 'frequency', 'Hz')], elements: [
      { id: 'branch:skog', class: 'branch', label: 'Halden - Skogssäter' }, { id: 'gen:soa', class: 'generator', label: 'Søa' }, { id: 'hvdc:sk4', class: 'hvdc', label: 'Skagerrak 4' },
    ] } as never,
    'plant:unit-4': { objectId: 'plant:unit-4', revision: 'r1', elements: [
      { id: 'sgA', class: 'steam-generator', label: 'Steam Generator A', shortLabel: 'SG A' }, { id: 'afwHeader', class: 'processHeader', label: 'Auxiliary Feedwater Header', shortLabel: 'AFW header' },
      { id: 'afwValveA', class: 'process-valve', label: 'Auxiliary Feedwater Valve A', shortLabel: 'AFW valve A' },
      { id: 'core', class: 'reactor-core', label: 'Reactor Core' }, { id: 'pzr', class: 'pressurizer', label: 'Pressurizer', shortLabel: 'PZR' },
    ], observables: [
      observable('plant:unit-4#core.powerRangePercent', 'Power range neutron flux', 'fraction', '%', 'core', 'NI-41-PR'),
      observable('plant:unit-4#pzr.reliefValve.state', 'State · PORV', 'state', '', 'pzr'),
      observable('plant:unit-4#sgA.heatTransferMw', 'Heat transfer · SG A', 'thermal-power', 'MW', 'sgA'),
      observable('plant:unit-4#sgA.steamFlowKgPerS', 'Steam production · SG A', 'flow', 'kg/s', 'sgA'),
      observable('plant:unit-4#sgA.pressureMPa', 'Steam generator pressure · SG A', 'pressure', 'MPa', 'sgA', 'SG-A-PRESS'),
      observable('plant:unit-4#afwValveA.positionFraction', 'Process valve position demand · AFW valve A', 'fraction', '1', 'afwValveA', 'AFW-A-CV'),
      observable('plant:unit-4#afwHeader.outletFlowKgPerS', 'Process header outlet flow · AFW header', 'flow', 'kg/s', 'afwHeader', 'AFW-FLOW'),
    ] } as never,
  }
  const port: ObservationPort = {
    declarations: async objectIds => objectIds.map(objectId => declarations[objectId] ?? { objectId, refused: { code: 'not_observed', message: 'none' } }),
    read: async () => ({ observations: [], unknown: [], refused: [], leads: [] }),
    topology: async objectId => ({ objectId, refused: { code: 'not_observed', message: 'none' } }),
  }
  const searchRun = { objects: [object('plant:unit-4', 'Halden Unit 4', 'plant'), object('grid:test', 'Grid', 'grid')], denied: new Set<string>(), packs: [pack('plant'), pack('grid')], port }
  const first = async (text: string) => (await searchObservables(searchRun, [{ text }]))[0]!.matches[0]
  // What matched every query word: the false matches the T11 run found were full matches.
  const full = async (text: string) => (await searchObservables(searchRun, [{ text }]))[0]!.matches.filter(match => match.score >= 2).map(match => match.ref ?? match.element?.id ?? match.objectId)

  test('a short label word is no abbreviation of a long query word', async () => {
    for (const text of ['Skogssäter', 'Skogssater', 'Halden - Skogssäter']) expect((await first(text))?.element?.id).toBe('branch:skog')
    expect(await full('Skogssäter')).toEqual(['branch:skog'])
    expect((await first('Skagerrak 4'))?.element?.id).toBe('hvdc:sk4')
    expect(await full('Skagerrak 4')).toEqual(['hvdc:sk4'])
  })

  test('labels, element names and quantity words outrank unit fragments of a signal id', async () => {
    expect((await first('SG pressure'))?.ref).toBe('plant:unit-4#sgA.pressureMPa')
    expect(await full('SG pressure')).toEqual(['plant:unit-4#sgA.pressureMPa'])
    expect((await first('AFW flow'))?.ref).toBe('plant:unit-4#afwHeader.outletFlowKgPerS')
    expect(await full('AFW flow')).toEqual(['plant:unit-4#afwHeader.outletFlowKgPerS'])
    // A tag's word abbreviates a query word ("press" for "pressure"), a label's never does.
    expect((await first('SG A press'))?.ref).toBe('plant:unit-4#sgA.pressureMPa')
  })

  test('a qualified name ranks the entries its words name whole before one a tag word abbreviates (gallery review: "#PORV")', async () => {
    const [result] = await searchObservables(searchRun, [{ text: 'plant:unit-4#PORV' }])
    expect(result!.matches.map(match => match.ref).slice(0, 2)).toEqual(['plant:unit-4#pzr.reliefValve.state', 'plant:unit-4#core.powerRangePercent'])
    expect(result!.matches[0]!.score).toBeGreaterThan(result!.matches[1]!.score)
    expect(await resolveName(searchRun, 'plant:unit-4#PORV')).toEqual(['plant:unit-4#pzr.reliefValve.state'])
  })
})

