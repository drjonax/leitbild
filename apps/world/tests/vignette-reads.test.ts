import { accessContextSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import { refObjectId } from '../src/core/model/alerts.ts'
import { objectIdSchema, type ActorId, type SimulationRunId } from '../src/core/model/index.ts'
import { displaySpecSchema } from '../src/core/observation/spec.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { composeVignette } from '../src/features/displays/compose/compose.ts'
import { vignetteStateSchema, type VignetteState } from '../src/features/displays/compose/model.ts'
import { compileVignette, readsOf, refsRead, sampleVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import type { ObservationPort } from '../src/features/displays/observation/port.ts'
import { fixtureComposeRun } from './fixtures/compose-runs.ts'
import { createRoleRunWorkspaces, openRunDefinition } from './fixtures/role-runs.ts'

// T06 for vignettes (architecture A5): the view and sample read only what the state names (readsOf, plus what its
// drawings bind), as the caller; a forged state shows nothing the caller may not see. The routes are for people; the
// Assistant composes through its one Capability.

const recorded = { ...openRunDefinition, id: 'recorded-run', packs: [{ ...openRunDefinition.packs[0]!, recording: { profileId: 'operations' } }] }
let fixture: Awaited<ReturnType<typeof fixtureComposeRun>>
beforeAll(async () => { fixture = await fixtureComposeRun(recorded, 5) })
afterAll(async () => { await fixture.close() })

/** A port that records every object and ref it is asked about. */
const recording = (port: ObservationPort) => {
  const asked = { objects: new Set<string>(), refs: new Set<string>() }
  const wrapped: ObservationPort = {
    declarations: async (objectIds, elementIds) => { objectIds.forEach(id => asked.objects.add(id)); return port.declarations(objectIds, elementIds) },
    read: async request => {
      if ('refs' in request) request.refs.forEach(ref => { asked.refs.add(ref); asked.objects.add(refObjectId(ref)) })
      else asked.objects.add(request.lead.objectId)
      return port.read(request)
    },
    topology: async objectId => { asked.objects.add(objectId); return port.topology(objectId) },
  }
  return { asked, wrapped }
}
const spec = (subjects: ReadonlyArray<unknown>, views: ReadonlyArray<unknown> = []) => displaySpecSchema.parse({ title: 'Reads', question: 'What is read?', subjects, views })
const composed = async (run: ViewRun, subjects: ReadonlyArray<unknown>, views: ReadonlyArray<unknown> = []): Promise<VignetteState> => {
  const outcome = await composeVignette(run, spec(subjects, views))
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues))
  return outcome.state
}

describe('T06: the view and the sample read only what the state names', () => {
  test('a composed default reads its refs, its drawing\'s bindings and its objects, nothing else', async () => {
    const run = await fixture.runOf()
    const state = await composed(run, ['unit:one', 'unit:one#engine'])
    const { asked, wrapped } = recording(run.port)
    const watched = { ...run, port: wrapped }
    const view = await compileVignette(watched, state)
    const sample = await sampleVignette(watched, state, { fromMs: 0 })
    const allowedRefs = new Set(await refsRead(run, state))
    const allowedObjects = new Set([...readsOf(state).objectIds, ...[...allowedRefs].map(refObjectId)])
    expect([...asked.refs].filter(ref => !allowedRefs.has(ref))).toEqual([])
    expect([...asked.objects].filter(id => !allowedObjects.has(id))).toEqual([])
    expect(view.sections.map(section => section.kind)).toContain('topology')
    expect(sample.observations.map(observation => observation.ref).every(ref => allowedRefs.has(ref))).toBe(true)
    expect(Object.keys(sample.series ?? {})).toHaveLength(1)
  })

  test('a forged state naming what the caller may not inspect shows none of it and never asks for it', async () => {
    const run = await fixture.runOf({ denied: new Set(['unit:two']) })
    const forged = vignetteStateSchema.parse({ title: 'Forged', at: { at: '2026-01-01T08:00:00.000Z', clock: 'simulation' }, views: [
      { kind: 'values', refs: ['unit:two#speed', 'unit:one#speed'], rows: 2 },
      { kind: 'slots', objectId: 'unit:two', rows: 3 },
      { kind: 'alerts', objectIds: ['unit:two'], rows: 2 },
      { kind: 'topology', objectId: 'unit:two', request: { around: ['engine'] }, rows: 5 },
    ] })
    const { asked, wrapped } = recording(run.port)
    const view = await compileVignette({ ...run, port: wrapped }, forged)
    const sample = await sampleVignette({ ...run, port: wrapped }, forged)
    expect(asked.objects.has('unit:two')).toBe(false)
    expect(JSON.stringify(view)).not.toContain('unit:two')
    expect(sample.observations.map(observation => observation.ref)).toEqual(['unit:one#speed'])
    expect(sample.slots).toEqual({})
    expect(view.sections.map(section => section.kind)).toEqual(['values'])
  })
})

describe('the person routes and the Assistant\'s Capability', () => {
  let workspaces: WorldWorkspaceRuntimeRegistry
  let dataDir: string
  let runtime: SimulationRunRuntime
  const workspaceId = newWorkspaceId() as WorkspaceId
  const access = (kind: 'human' | 'ai') => accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind, id: `${kind}-viewer` } })
  const route = async (path: string, body: unknown, kind: 'human' | 'ai' = 'human') => {
    const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
    const request = new Request(`http://world.test/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(runtime.id)}/displays/${path}`, { method: 'POST', body: JSON.stringify(body) })
    const response = (await handleSimulationRunApi(request, new URL(request.url), { registry, accessContext: access(kind), roleHolders: () => ({}) }))!
    return { status: response.status, body: await response.json() as any }
  }
  const call = async (path: string, init?: RequestInit) => {
    const request = new Request(`http://world.test${path}`, init)
    const response = (await handleWorldModuleApi(request, new URL(request.url), workspaces))!
    return { status: response.status, body: await response.json() as any }
  }
  const compose = async (input: unknown) => (await call(`/internal/workspaces/${workspaceId}/capabilities/world.simulation-run.display.compose/invoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, capabilityId: 'world.simulation-run.display.compose', resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runtime.id }, input, access: access('ai') }),
  }))
  beforeAll(async () => {
    ({ workspaces, dataDir } = await createRoleRunWorkspaces())
    await call(`/internal/workspaces/${workspaceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }) })
    runtime = await workspaces.getLoaded(workspaceId)!.simulationRuns.create({ scenarioId: 'open-run' })
  })
  afterAll(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

  test('a person opens an object\'s World default, then its view and samples, from the state alone', async () => {
    const opened = await route('default', { subject: 'unit:one' })
    expect(opened.status).toBe(200)
    expect(opened.body.result.view).toMatchObject({ viewType: 'display.vignette', title: 'Unit One' })
    // The unit's own state (declared on it, not on its engine) leads its values.
    expect(opened.body.result.card.items[0]).toMatchObject({ key: 'k1', label: 'Unit One · Unit One status', subject: { ref: 'unit:one#status' } })
    const state = opened.body.result.view.state as string
    const view = await route('view', { state })
    expect(view.body.view.sections.map((section: { kind: string }) => section.kind)).toEqual(['values', 'topology'])
    const sample = await route('sample', { state })
    expect(sample.body.sample.observations.map((observation: { ref: string }) => observation.ref)).toEqual(['unit:one#status', 'unit:one#speed'])
    expect(sample.body.sample.at).toMatchObject({ clock: 'simulation', paused: expect.any(Boolean) })
  })

  test('the routes take a vignette state only, and serve people, never the Assistant', async () => {
    expect((await route('view', { state: '{"refs":["unit:one#speed"]}' })).status).toBe(400)
    expect((await route('sample', { refs: ['unit:one#speed'] })).status).toBe(400)
    expect((await route('default', { subject: 'unit:one' }, 'ai')).body.error.code).toBe('display_route_for_people')
    expect((await route('default', { subject: 'fixture' })).body.error.code).toBe('pack_is_not_an_object')
  })

  test('a display reads the Scenario its Run was loaded with, never the stored file again, and not a reloaded Run\'s', async () => {
    const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
    const rereads = { ...registry, compiledScenarioForRun: async () => { throw new Error('read from disk again') } }
    expect((await displayRunOf(rereads, runtime, { id: 'actor:human:x' as ActorId, label: 'x', role: 'operator' }, new Set())).connections).toEqual([])
    const copy = await registry.create({ scenarioId: 'open-run' })
    await registry.close(copy.id)
    const reloaded = await registry.load(copy.id)
    await expect(displayRunOf(registry, copy, { id: 'actor:human:x' as ActorId, label: 'x', role: 'operator' }, new Set())).rejects.toThrow('was reloaded')
    expect((await displayRunOf(registry, reloaded, { id: 'actor:human:x' as ActorId, label: 'x', role: 'operator' }, new Set())).objects.length).toBeGreaterThan(0)
  })

  test('a display of a Run that is not loaded waits: the route reports it and never loads the Run', async () => {
    const registry = workspaces.getLoaded(workspaceId)!.simulationRuns
    const idle = await registry.create({ scenarioId: 'open-run' })
    const state = (await route('default', { subject: 'unit:one' })).body.result.view.state as string
    await registry.close(idle.id)
    const request = new Request(`http://world.test/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(idle.id)}/displays/sample`, { method: 'POST', body: JSON.stringify({ state }) })
    const response = (await handleSimulationRunApi(request, new URL(request.url), { registry, accessContext: access('human'), roleHolders: () => ({}) }))!
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([409, 'simulation_run_not_loaded'])
    expect(registry.get(idle.id)).toBeUndefined()
  })

  test('the Assistant composes through one embedded-view Capability, refused on what it may not inspect', async () => {
    const catalog = (await call(`/internal/workspaces/${workspaceId}/capabilities`)).body.capabilities
    expect(catalog.find((entry: { id: string }) => entry.id === 'world.simulation-run.display.compose')).toMatchObject({ kind: 'query', risk: 'read', publishes: ['embedded-view'] })
    const composedVignette = await compose({ title: 'Unit One speed', question: 'How fast is Unit One?', subjects: ['unit:one#speed'], views: [] })
    expect(composedVignette.status).toBe(200)
    expect(composedVignette.body.result.view).toMatchObject({ viewType: 'display.vignette', height: expect.any(Number) })
    expect(JSON.parse(composedVignette.body.result.view.state)).toMatchObject({ by: 'assistant' })
    expect(await compose({ title: 'x', question: 'y', subjects: ['unit:one'], views: [{ kind: 'values', signals: ['unit:one#speed'], limits: { high: 3 } }] })).toMatchObject({ status: 400 })
    const person = { id: 'actor:human:restrict' as ActorId, label: 'Restrict', role: 'operator' as const }
    const revision = runtime.snapshot().scenario!.agentRestrictions.revision
    await runtime.setAgentRestrictions(person, { operationIds: [], objects: [{ objectId: objectIdSchema.parse('unit:two'), deny: ['inspect'] }] }, revision)
    try {
      const refused = await compose({ title: 'Unit Two', question: 'And Unit Two?', subjects: ['unit:two'], views: [] })
      expect(refused).toMatchObject({ status: 422, body: { error: { code: 'agent_access_restricted' } } })
    } finally {
      await runtime.setAgentRestrictions(person, { operationIds: [], objects: [] }, revision + 1)
    }
  })
})

export type { SimulationRunId }
