import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { accessContextSchema, moduleResourceCollectionSchema, newRequestId, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { handleWorldModuleApi } from '../src/core/api/workspace-module-api.ts'
import {
  actorIdSchema,
  compiledScenarioSchema,
  scenarioExecutionStateSchema,
  seesForRoleSet,
  sidedObjectAudienceIssue,
  viewerForRoleSet,
  type ObjectAudience,
  type ObjectId,
  type OperationalObject,
  type RunRoles,
  type SimulationRunEvent,
  type SimulationRunId,
} from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { eventReach, eventVisibleTo } from '../src/core/simulation-runs/event-audience.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { compiledScenarioSideViewRules, executionStateSideViewRules, snapshotSideViewRules } from '../src/core/simulation-runs/side-view.ts'
import { simulationRunStateSnapshotSchema } from '../src/core/simulation-runs/state-store.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import {
  compileWithRolePacks,
  createRoleRunRegistry,
  createRoleRunWorkspaces,
  sidedNames,
  sidedRoles,
  sidedRunDefinition,
  sides,
} from './fixtures/role-runs.ts'

const nonce = crypto.randomUUID().slice(0, 8)
const names = sidedNames(nonce)
const sided = sidedRunDefinition(nonce)
const unsided = sidedRunDefinition(nonce, { sided: false })
const declaration: RunRoles = { roles: [...sidedRoles], presets: [], sides: [...sides] }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const registryWithSidedRuns = async (): Promise<SimulationRunRegistry> => {
  const registry = await createRoleRunRegistry([sided, unsided])
  cleanups.push(async () => { await registry.shutdown() })
  return registry
}

interface ErrorBody { readonly error: { readonly code: string; readonly message: string } }

const callRoute = async <T>(registry: SimulationRunRegistry, path: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: T }> => {
  const request = new Request(`http://leitbild.test/api/workspaces/${encodeURIComponent(registry.workspaceId)}/world${path}`, init)
  const response = await handleSimulationRunApi(request, new URL(request.url), {
    registry,
    accessContext: accessContextSchema.parse({ workspaceId: registry.workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } }),
    roleHolders: () => ({}),
  })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: await response.json() as T }
}

const runPath = (id: SimulationRunId, suffix = '', roles?: string): string =>
  `/simulation-runs/${encodeURIComponent(id)}${suffix}${roles === undefined ? '' : `${suffix.includes('?') ? '&' : '?'}roles=${encodeURIComponent(roles)}`}`
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const invokePath = (id: SimulationRunId, capabilityId: string, roles?: string): string =>
  runPath(id, `/capabilities/${encodeURIComponent(capabilityId)}/invoke`, roles)

const issues = (error: unknown): ReadonlyArray<{ readonly path: string; readonly code?: string; readonly message: string }> => {
  const list = (error as { readonly issues?: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string; readonly params?: { readonly code?: string } }> }).issues
  if (!list) throw new Error(`expected a validation error, got ${String(error)}`)
  return list.map(issue => ({ path: issue.path.map(String).join('.'), ...(issue.params?.code === undefined ? {} : { code: issue.params.code }), message: issue.message }))
}

const refusedDefinition = (definition: unknown) => {
  const result = scenarioDefinitionSchema.safeParse(definition)
  if (result.success) throw new Error('expected a refused Definition')
  return issues(result.error)
}

const compileError = async (definition: unknown): Promise<unknown> => {
  try { await compileWithRolePacks(definition) } catch (error) { return error }
  throw new Error('expected compilation to be refused')
}

const ids = (objects: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> => objects.map(object => object.id).sort()

/** A snapshot as the wire carries it, without the clock, whose reading time moves between two reads. */
const sansClock = (snapshot: unknown): unknown => {
  const { clock: _clock, ...rest } = snapshot as Record<string, unknown>
  return JSON.parse(JSON.stringify(rest))
}

const unit = (id: string, label: string, audience?: ObjectAudience) =>
  ({ item: { type: 'unit', id, label, position: [10.74, 59.92], speedMps: 10, ...(audience === undefined ? {} : { audience }) } })

describe('Scenario sides and what each role sees', () => {
  test('a Definition declares sides and each role\'s sees, and refuses what cannot be played', () => {
    expect(scenarioDefinitionSchema.parse(sided).sides).toEqual([...sides])
    const roles = sidedRoles.map(role => ({ ...role }))
    const withRoles = (next: ReadonlyArray<Record<string, unknown>>) => ({ ...sided, roles: next })
    const { sees: _sees, ...redWithout } = roles[0]!
    expect(refusedDefinition(withRoles([redWithout, ...roles.slice(1)]))).toContainEqual(expect.objectContaining({ path: 'roles.0.sees', code: 'role_sees_required' }))
    expect(refusedDefinition(withRoles([...roles.slice(0, 3), { ...roles[3]!, sees: ['red'] }]))).toContainEqual(expect.objectContaining({ path: 'roles.3.sees', code: 'role_sees_required' }))
    expect(refusedDefinition(withRoles([{ ...roles[0]!, sees: ['green'] }, ...roles.slice(1)]))[0]!.message).toContain('undeclared side: green')
    expect(refusedDefinition({ ...sided, sides: [...sides, sides[0]] })[0]!.message).toContain('duplicate side: red')
    expect(refusedDefinition({ ...sided, sides: [{ id: 'red', label: 'Red', colour: 'red' }] })[0]!.path).toBe('sides.0.colour')
    const { roles: _roles, ...withoutRoles } = sided
    expect(refusedDefinition(withoutRoles).map(issue => issue.message)).toContain('Sides need declared roles: a side is what a role sees')
    // Without sides every role sees everything, so sees has nothing to say.
    expect(refusedDefinition({ ...unsided, roles: sidedRoles })[0]!.message).toContain('declares no sides')
    // AI restrictions stay refused in a sided Run, as in every role Run.
    expect(refusedDefinition({ ...sided, agentRestrictions: { operationIds: ['world.fixture.assign'] } })).toContainEqual(expect.objectContaining({ code: 'agent_restrictions_in_role_run' }))
  })

  test('a screen\'s view is the union of its roles\' sees, and any truth role makes it a truth view', () => {
    expect(seesForRoleSet(declaration, ['red-lead'])).toEqual(['red'])
    expect(seesForRoleSet(declaration, ['blue-lead', 'red-lead'])).toEqual(['red', 'blue'])
    expect(seesForRoleSet(declaration, ['red-lead', 'umpire'])).toBe('all')
    expect(seesForRoleSet(declaration, ['control'])).toBe('all')
    expect(seesForRoleSet({ roles: sidedRoles.map(({ sees: _sees, ...role }) => role), presets: [] }, ['red-lead'])).toBe('all')
    expect(viewerForRoleSet(declaration, ['control', 'red-lead'])).toEqual({ roleIds: ['red-lead', 'control'], class: 'controller', sees: 'all' })
    expect(viewerForRoleSet(declaration, ['red-lead'])).toEqual({ roleIds: ['red-lead'], class: 'operator', sees: ['red'] })
  })

  test('compiling a sided Run refuses objects without a valid audience, guidance naming sided objects, and Pack configuration its roles cannot honour', async () => {
    const compiled = await compileWithRolePacks(sided)
    expect(compiled.sides).toEqual([...sides])
    const audiences: ReadonlyArray<unknown> = compiled.initialObjects.map(object => [object.id, object.audience])
    expect(audiences).toEqual([
      [names.depot.id, 'public'], [names.redUnit.id, ['red']], [names.redTask.id, ['red']],
      [names.blueUnit.id, ['blue']], [names.blueTask.id, ['blue']], [names.hidden.id, []],
    ])
    const withItems = (mapItem: (item: Record<string, unknown>, index: number) => Record<string, unknown>) =>
      ({ ...sided, packs: sided.packs.map(selection => ({ ...selection, items: selection.items.map((item, index) => mapItem(item, index)) })) })
    const missing = await compileError(withItems((item, index) => {
      if (index !== 1) return item
      const { audience: _audience, ...rest } = item
      return rest
    }))
    expect(issues(missing)).toContainEqual(expect.objectContaining({ path: 'initialObjects.1.audience', code: 'audience_required' }))
    const undeclared = await compileError(withItems((item, index) => index === 3 ? { ...item, audience: ['green'] } : item))
    expect(issues(undeclared)).toContainEqual(expect.objectContaining({ path: 'initialObjects.3.audience', code: 'audience_undeclared_side' }))
    const guidance = await compileError({
      ...sided,
      timeline: { cues: [{ id: 'leak', at: { kind: 'after_scenario_start', seconds: 0 }, actions: [{ type: 'show_guidance', guidance: { id: 'g', title: 'G', message: 'M', objectIds: [names.depot.id, names.redUnit.id] } }] }] },
    })
    expect(issues(guidance)).toEqual([expect.objectContaining({ path: 'timeline.cues.0.actions.0.guidance.objectIds.1', code: 'guidance_references_sided_object' })])
    expect(issues(guidance)[0]!.message).not.toContain(names.redUnit.id)
    // The Pack checks its own configuration against the roles, at its path.
    const withAuthority = (authority: unknown) => ({ ...sided, packs: sided.packs.map(selection => ({ ...selection, config: { authority } })) })
    const authority = await compileError(withAuthority([{ roleId: 'ghost', crews: ['alpha'] }, { roleId: 'control', crews: ['alpha'] }]))
    expect(issues(authority)).toEqual([
      expect.objectContaining({ path: 'packs.0.config.authority.0.roleId', code: 'unknown_authority_role' }),
      expect.objectContaining({ path: 'packs.0.config.authority.1.roleId', code: 'controller_authority' }),
    ])
    const { roles: _roles, sides: _sides, ...open } = unsided
    expect(issues(await compileError({ ...open, id: 'open-authority' }))).toEqual([expect.objectContaining({ path: 'packs.0.config.authority', code: 'authority_without_roles' })])
  })

  test('sides are Run state that snapshots, restores and copies keep', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    expect(run.roles()).toEqual(declaration)
    expect(run.snapshot().scenario?.roles?.sides).toEqual([...sides])
    const copy = await registry.copy(run.id, {})
    expect(copy.roles()).toEqual(declaration)
    await registry.close(copy.id)
    expect(await registry.runRoles(copy.id)).toEqual(declaration)
    expect((await registry.summary(copy.id)).roles?.sides).toEqual([...sides])
    expect((await registry.load(copy.id)).snapshot().scenario?.roles).toEqual(declaration)
    const presence = await callRoute<{ roles: { sides: unknown } }>(registry, runPath(run.id, '/presence'))
    expect(presence.body.roles.sides).toEqual([...sides])
  })
})

describe('object and event audience in a sided Run', () => {
  test('an upsert without a valid audience is refused before anything commits, and an audience never changes', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    const seqBefore = run.snapshot().seq
    const refused = await callRoute<ErrorBody>(registry, invokePath(run.id, fixtureCommandIds.createItem, 'control'), post({ input: unit(`unit:loose-${nonce}`, 'Loose') }))
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'audience_required' } } })
    const undeclared = await callRoute<ErrorBody>(registry, invokePath(run.id, fixtureCommandIds.createItem, 'control'), post({ input: unit(`unit:green-${nonce}`, 'Green', ['green']) }))
    expect(undeclared).toMatchObject({ status: 400, body: { error: { code: 'audience_undeclared_side' } } })
    expect(run.snapshot().objects.some(object => object.id.startsWith('unit:loose') || object.id.startsWith('unit:green'))).toBe(false)
    expect(run.events({ afterSeq: seqBefore }).some(event => event.type === 'object.upserted')).toBe(false)
    const changed = sidedObjectAudienceIssue({ id: 'a', audience: ['blue'] }, { audience: ['red'] }, sides)
    expect(changed?.code).toBe('audience_changed')
    expect(sidedObjectAudienceIssue({ id: 'a', audience: ['blue', 'red'] }, { audience: ['red', 'blue'] }, sides)).toBeNull()
  })

  test('a deletion carries its object\'s audience from the commit on', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    for (const objectId of [names.hidden.id, names.depot.id]) {
      const deleted = await callRoute<{ result: { ok: boolean } }>(registry, invokePath(run.id, 'world.object.delete', 'control'), post({ input: { objectId } }))
      expect(deleted.body.result.ok).toBe(true)
    }
    const deletions: ReadonlyArray<unknown> = run.events().flatMap(event => event.type === 'object.deleted' ? [[event.objectId, event.audience]] : [])
    expect(deletions).toEqual([[names.hidden.id, []], [names.depot.id, 'public']])
  })

  test('every event type is classified: object events by audience, clock, reset and guidance public, the rest truth-only', () => {
    const base = { id: 'event:x', simulationRunId: 'run-x', seq: 1, at: '2026-01-01T08:00:00.000Z', provenance: { source: 'system' } }
    const object = { id: names.redUnit.id, audience: ['red'] } as unknown as OperationalObject
    const audiences = new Map<string, ObjectAudience>([[names.redUnit.id, ['red']]])
    const audienceOf = (objectId: ObjectId) => audiences.get(objectId)
    const event = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as unknown as SimulationRunEvent
    const visible = (fields: Record<string, unknown>, sees: ReadonlyArray<string>) => eventVisibleTo(event(fields), sees, audienceOf)
    expect(visible({ type: 'object.upserted', object }, ['red'])).toBe(true)
    expect(visible({ type: 'object.upserted', object }, ['blue'])).toBe(false)
    expect(visible({ type: 'telemetry.sampled', objectId: names.redUnit.id, telemetry: {} }, ['blue'])).toBe(false)
    expect(visible({ type: 'telemetry.sampled', objectId: 'unit:unresolved', telemetry: {} }, ['red', 'blue'])).toBe(false)
    expect(visible({ type: 'object.deleted', objectId: names.redUnit.id, audience: ['red'] }, ['red'])).toBe(true)
    // A deletion without an audience reaches no side, whatever the object was.
    expect(visible({ type: 'object.deleted', objectId: names.redUnit.id }, ['red', 'blue'])).toBe(false)
    for (const type of ['clock.updated', 'simulationRun.reset', 'scenario.guidance.shown', 'scenario.guidance.hidden']) {
      expect({ type, reach: eventReach(event({ type }), audienceOf).kind }).toEqual({ type, reach: 'public' })
    }
    for (const type of ['command.issued', 'command.result', 'interaction.signal.received', 'notification.emitted', 'scenario.cue.started', 'scenario.objects.highlighted', 'scenario.highlights.cleared', 'scenario.agent-restrictions.set', 'procedure.run.started', 'procedure.observation.updated']) {
      expect({ type, visible: visible({ type }, ['red', 'blue']) }).toEqual({ type, visible: false })
      expect(eventVisibleTo(event({ type }), 'all', audienceOf)).toBe(true)
    }
  })
})

describe('side views on World-direct routes', () => {
  test('every key of the snapshot, execution state and Compiled Scenario is classified for side views', async () => {
    const classified = (rules: object) => Object.keys(rules).sort()
    expect(classified(snapshotSideViewRules)).toEqual(Object.keys(simulationRunStateSnapshotSchema.shape).sort())
    expect(classified(executionStateSideViewRules)).toEqual(Object.keys(scenarioExecutionStateSchema.shape).sort())
    expect(classified(compiledScenarioSideViewRules)).toEqual(Object.keys(compiledScenarioSchema.shape).sort())
    // A live sided Run uses no key its schemas do not declare.
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    for (const key of Object.keys(run.snapshot())) expect(Object.keys(snapshotSideViewRules)).toContain(key)
    for (const key of Object.keys(run.snapshot().scenario ?? {})) expect(Object.keys(executionStateSideViewRules)).toContain(key)
    for (const key of Object.keys(await registry.compiledScenarioForRun(run.id))) expect(Object.keys(compiledScenarioSideViewRules)).toContain(key)
  })

  test('the Run read and snapshot of a side view are built from the allow-list; truth views read everything', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    type Read = { snapshot: { objects: OperationalObject[]; seq: number; scenario: Record<string, unknown>; clock?: unknown }; scenario: Record<string, unknown> & { initialObjects: unknown[] } }
    for (const suffix of ['', '/snapshot']) {
      const red = await callRoute<Read>(registry, runPath(run.id, suffix, 'red-lead'))
      expect(red.status).toBe(200)
      expect(ids(red.body.snapshot.objects)).toEqual([names.depot.id, names.redTask.id, names.redUnit.id].sort())
      expect(Object.keys(red.body.snapshot).sort()).toEqual(['clock', 'objects', 'scenario', 'seq'])
      expect(red.body.snapshot.scenario).toEqual({
        scenarioId: 'sided-run',
        agentRestrictions: { operationIds: [], objects: [], revision: 0 },
        guidance: expect.objectContaining({ id: 'brief', objectIds: [names.depot.id] }),
        highlightedObjectIds: [],
      })
      expect(red.body.scenario).toMatchObject({ id: 'sided-run', roles: [...sidedRoles], sides: [...sides], initialObjects: [], connections: [], agentRestrictions: { operationIds: [], objects: [] } })
      expect('timeline' in red.body.scenario).toBe(false)
      expect(JSON.stringify(red.body)).not.toContain(names.blueUnit.id)
      expect(JSON.stringify(red.body)).not.toContain(names.hidden.id)
      // The union of two sides' roles reads both pictures, still without truth-only objects.
      const both = await callRoute<Read>(registry, runPath(run.id, suffix, 'red-lead,blue-lead'))
      expect(ids(both.body.snapshot.objects)).toEqual([names.depot.id, names.redTask.id, names.redUnit.id, names.blueTask.id, names.blueUnit.id].sort())
      for (const roles of ['control', 'umpire,red-lead']) {
        const truth = await callRoute<Read>(registry, runPath(run.id, suffix, roles))
        expect(sansClock(truth.body.snapshot)).toEqual(sansClock(run.snapshot()))
        expect(truth.body.scenario).toEqual(JSON.parse(JSON.stringify(await registry.compiledScenarioForRun(run.id))))
      }
    }
  })

  test('a side view reaches no other World-direct route and no World operation', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    for (const [suffix, init] of [
      ['/capabilities', undefined],
      ['/objects', undefined],
      [`/objects/${encodeURIComponent(names.depot.id)}`, undefined],
      ['/events', undefined],
      ['/history', undefined],
      ['/history/samples', undefined],
      ['/procedures', undefined],
      ['/procedure-runs', undefined],
      ['/signals', post({ type: 'note', payload: {} })],
      ['/reset', { method: 'POST' }],
      ['/copies', post({})],
      ['', { method: 'DELETE' }],
    ] as const) {
      const refused = await callRoute<ErrorBody>(registry, runPath(run.id, suffix, 'blue-lead'), init)
      expect({ suffix, status: refused.status, code: refused.body.error?.code }).toEqual({ suffix, status: 403, code: 'role_view_not_supported' })
    }
    const scenarioFetch = await callRoute<ErrorBody>(registry, '/scenarios/sided-run?roles=blue-lead')
    expect(scenarioFetch).toMatchObject({ status: 403, body: { error: { code: 'role_view_not_supported' } } })
    // Scenario Definitions stay open authoring material, and truth views keep every route.
    expect((await callRoute(registry, '/scenarios/sided-run')).status).toBe(200)
    expect((await callRoute(registry, '/scenarios/sided-run?roles=control')).status).toBe(200)
    expect((await callRoute(registry, runPath(run.id, '/events', 'control'))).status).toBe(200)
    expect((await callRoute(registry, runPath(run.id, '/presence', 'blue-lead'))).status).toBe(200)
    const procedure = await callRoute<ErrorBody>(registry, invokePath(run.id, 'world.procedure.run.start', 'blue-lead'), post({ input: {} }))
    expect(procedure).toMatchObject({ status: 403, body: { error: { code: 'role_view_not_supported' } } })
    const deleteRefused = await callRoute<ErrorBody>(registry, invokePath(run.id, 'world.object.delete', 'blue-lead'), post({ input: { objectId: names.blueTask.id } }))
    expect(deleteRefused.body.error.code).toBe('role_controller_only')
  })

  test('core stamps each query and command with the caller\'s viewer, from its connection and never from input', async () => {
    const registry = await registryWithSidedRuns()
    const run = await registry.create({ scenarioId: 'sided-run' })
    const viewerAs = async (roles: string) => (await callRoute<{ result: { viewer: unknown } }>(registry, invokePath(run.id, fixtureQueryIds.viewer, roles), post({ input: {} }))).body.result.viewer
    expect(await viewerAs('red-lead')).toEqual({ roleIds: ['red-lead'], class: 'operator', sees: ['red'] })
    expect(await viewerAs('blue-lead,red-lead')).toEqual({ roleIds: ['red-lead', 'blue-lead'], class: 'operator', sees: ['red', 'blue'] })
    expect(await viewerAs('control')).toEqual({ roleIds: ['control'], class: 'controller', sees: 'all' })
    const forged = await callRoute<ErrorBody>(registry, invokePath(run.id, fixtureQueryIds.viewer, 'red-lead'), post({ input: { viewer: { roleIds: ['control'], class: 'controller', sees: 'all' } } }))
    expect(forged.status).toBe(400)
    // The Scenario timeline acts as the Run itself: no viewer.
    const timeline: Actor = { id: actorIdSchema.parse('actor:scenario-timeline'), label: 'Scenario timeline', role: 'system' }
    expect(await run.invokeCapability(timeline, { capabilityId: fixtureQueryIds.viewer, input: {} })).toEqual({ kind: 'query', result: { viewer: null } })

    // A role-aware Pack answers within the stamped picture.
    const state = await callRoute<{ result: { units: Array<{ id: string }>; tasks: Array<{ id: string }>; sites: Array<{ id: string }> } }>(registry, invokePath(run.id, fixtureQueryIds.state, 'blue-lead'), post({ input: {} }))
    expect(ids([...state.body.result.units, ...state.body.result.tasks, ...state.body.result.sites])).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    const assign = (roles: string, unitId: string, taskId: string) =>
      callRoute<{ result: { ok: boolean; reason?: string } }>(registry, invokePath(run.id, fixtureCommandIds.assign, roles), post({ input: { unitId, taskId } }))
    const crossSide = await assign('blue-lead', names.redUnit.id, names.blueTask.id)
    expect(crossSide.body.result.ok).toBe(false)
    expect(crossSide.body.result.reason).toMatch(/^not_in_picture: /)
    expect(crossSide.body.result.reason).not.toContain(names.redUnit.id)
    // The umpire sees both sides but its role is given no crew.
    expect((await assign('umpire', names.blueUnit.id, names.blueTask.id)).body.result.reason).toMatch(/^unit_not_authorized: /)
    expect((await assign('blue-lead', names.blueUnit.id, names.blueTask.id)).body.result.ok).toBe(true)
  })
})

describe('a Run without sides', () => {
  test('behaves exactly as before: whole reads, no audience required, deletions without audience, a truth viewer', async () => {
    const registry = await registryWithSidedRuns()
    for (const scenarioId of ['unsided-run', 'open-run']) {
      const run = await registry.create({ scenarioId })
      const roles = scenarioId === 'open-run' ? undefined : 'red-lead'
      const read = await callRoute<{ snapshot: unknown; scenario: unknown }>(registry, runPath(run.id, '', roles))
      expect(sansClock(read.body.snapshot)).toEqual(sansClock(run.snapshot()))
      expect(read.body.scenario).toEqual(JSON.parse(JSON.stringify(await registry.compiledScenarioForRun(run.id))))
      expect(run.snapshot().objects.every(object => !('audience' in object))).toBe(true)
      const created = await callRoute<{ result: { ok: boolean } }>(registry, invokePath(run.id, fixtureCommandIds.createItem, roles), post({ input: unit(`unit:loose-${nonce}`, 'Loose') }))
      expect(created.body.result.ok).toBe(true)
      const deleted = await callRoute<{ result: { ok: boolean } }>(registry, invokePath(run.id, 'world.object.delete', roles === undefined ? undefined : 'control'), post({ input: { objectId: `unit:loose-${nonce}` } }))
      expect(deleted.body.result.ok).toBe(true)
      expect(run.events().filter(event => event.type === 'object.deleted').map(event => 'audience' in event)).toEqual([false])
      const viewer = await callRoute<{ result: { viewer: unknown } }>(registry, invokePath(run.id, fixtureQueryIds.viewer, roles), post({ input: {} }))
      expect(viewer.body.result.viewer).toEqual(roles === undefined ? null : { roleIds: ['red-lead'], class: 'operator', sees: 'all' })
      expect((await callRoute(registry, runPath(run.id, '/events', roles))).status).toBe(200)
      // Open routes ignore a role set outside a sided Run, as before.
      expect((await callRoute(registry, runPath(run.id, '/presence', 'ghost'))).status).toBe(200)
    }
  })
})

describe('the Host broker on a sided Run', () => {
  const call = async <T>(workspaces: WorldWorkspaceRuntimeRegistry, path: string, init?: RequestInit) => {
    const request = new Request(`http://world.test${path}`, init)
    const response = await handleWorldModuleApi(request, new URL(request.url), workspaces)
    if (!response) throw new Error(`Module route did not handle ${path}`)
    return { status: response.status, body: await response.json() as T }
  }
  const invoke = <T = { error?: { code: string } }>(workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, capabilityId: string, config: { readonly actor: 'human' | 'ai'; readonly input?: unknown; readonly run?: SimulationRunId; readonly definition?: { readonly id: string; readonly revisionId: string } }) =>
    call<T>(workspaces, `/internal/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/invoke`, post({
      workspaceId,
      capabilityId,
      input: config.input ?? {},
      ...(config.run === undefined ? {} : { resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.run } }),
      ...(config.definition === undefined ? {} : { definition: { workspaceId, moduleId: 'world', type: 'world.scenario', ...config.definition } }),
      access: accessContextSchema.parse({ workspaceId, requestId: newRequestId(), actor: { kind: config.actor, id: config.actor === 'ai' ? 'sides-agent' : 'sides-person' } }),
    }))

  test('AI is refused on every Run-scoped Capability and can still read and update a sided Definition; the Run lists no object count', async () => {
    const { workspaces, dataDir } = await createRoleRunWorkspaces(undefined, [sided, unsided])
    cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
    const workspaceId = newWorkspaceId()
    await workspaces.provision(workspaceId)
    const run = await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'sided-run' })).id)
    const unsidedRun = await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'unsided-run' })).id)
    for (const capabilityId of ['world.simulation-run.read', 'world.simulation-run.execution.read', 'world.simulation-run.objects.search', fixtureQueryIds.state, fixtureCommandIds.createItem, 'world.object.delete']) {
      const refused = await invoke(workspaces, workspaceId, capabilityId, { actor: 'ai', run })
      expect({ capabilityId, code: refused.body.error?.code }).toEqual({ capabilityId, code: 'ai_role_run_unsupported' })
    }
    const definitions = await call<{ definitions: Array<{ ref: { id: string }; currentRevisionId: string }> }>(workspaces, `/internal/workspaces/${workspaceId}/definitions`)
    const definition = definitions.body.definitions.find(candidate => candidate.ref.id === 'sided-run')!
    const read = await invoke<{ result: { source: { sides: unknown } } }>(workspaces, workspaceId, 'world.scenario.read', { actor: 'ai', definition: { id: 'sided-run', revisionId: definition.currentRevisionId } })
    expect(read.body.result.source.sides).toEqual([...sides])
    const updated = await invoke(workspaces, workspaceId, 'world.scenario.update', { actor: 'ai', definition: { id: 'sided-run', revisionId: definition.currentRevisionId }, input: { source: { ...sided, title: 'Sided Run, revised' } } })
    expect(updated.status).toBe(200)
    const { resources } = moduleResourceCollectionSchema.parse((await call(workspaces, `/internal/workspaces/${workspaceId}/resources`)).body)
    const summaryKeys = (id: SimulationRunId) => resources.find(resource => resource.ref.type === 'world.simulation-run' && String(resource.ref.id) === id)!.summary.map(item => item.key)
    expect(summaryKeys(run)).not.toContain('object-count')
    expect(summaryKeys(unsidedRun)).toContain('object-count')
  })
})
