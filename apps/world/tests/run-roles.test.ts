import { describe, expect, test } from 'bun:test'
import { accessContextSchema, newRequestId } from '@leitbild/contracts'
import { actorIdSchema, deleteObjectCommandKind, type SimulationRunEvent, type SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRealtimeManager } from '../src/core/api/realtime.ts'
import { handleSimulationRunApi } from '../src/core/api/simulation-run-routes.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { deepCopy } from '../src/ui/scenario-builder-model.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { fixturePack } from './fixtures/fixture-pack.ts'
import { fixtureCommandIds } from './fixtures/fixture-runtime.ts'
import { waitForCondition } from './helpers.ts'
import {
  compileWithRolePacks,
  createRoleRunRegistry,
  declaredPresets,
  declaredRoles,
  openRunDefinition,
  roleAwareFixturePack,
  roleRunDefinition,
} from './fixtures/role-runs.ts'

interface ApiResponse<T> {
  readonly status: number
  readonly body: T
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> }
}

const callRoute = async <T>(
  registry: SimulationRunRegistry,
  path: string,
  init?: RequestInit,
  roleHolders: Readonly<Record<string, number>> = {},
): Promise<ApiResponse<T>> => {
  const request = new Request(`http://leitbild.test/api/workspaces/${encodeURIComponent(registry.workspaceId)}/world${path}`, init)
  const response = await handleSimulationRunApi(request, new URL(request.url), {
    registry,
    accessContext: accessContextSchema.parse({ workspaceId: registry.workspaceId, requestId: newRequestId(), actor: { kind: 'anonymous' } }),
    roleHolders: () => roleHolders,
  })
  if (!response) throw new Error(`route did not handle ${init?.method ?? 'GET'} ${path}`)
  return { status: response.status, body: await response.json() as T }
}

const runPath = (id: SimulationRunId, suffix = '', roles?: string): string =>
  `/simulation-runs/${encodeURIComponent(id)}${suffix}${roles === undefined ? '' : `?roles=${encodeURIComponent(roles)}`}`

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const invokePath = (id: SimulationRunId, capabilityId: string, roles?: string): string =>
  runPath(id, `/capabilities/${encodeURIComponent(capabilityId)}/invoke`, roles)

const issuedCommands = (registry: SimulationRunRegistry, id: SimulationRunId) =>
  registry.get(id)!.events().flatMap(event => event.type === 'command.issued' ? [event.command] : [])

const issueOf = (error: unknown): { readonly message: string; readonly params?: { readonly code?: string } } => {
  const issues = (error as { readonly issues?: ReadonlyArray<{ readonly message: string; readonly params?: { readonly code?: string } }> }).issues
  if (!issues?.[0]) throw new Error(`expected a validation error, got ${String(error)}`)
  return issues[0]
}

describe('Scenario roles', () => {
  test('a Definition declares roles and presets strictly and the Builder keeps them', () => {
    const parsed = scenarioDefinitionSchema.parse(roleRunDefinition)
    expect(parsed.roles).toEqual([...declaredRoles])
    expect(parsed.rolePresets).toEqual([...declaredPresets])
    // The Builder edits a JSON copy of the parsed Definition and saves it whole.
    expect(scenarioDefinitionSchema.parse(deepCopy(parsed))).toEqual(parsed)

    const refused = (definition: unknown): string => {
      const result = scenarioDefinitionSchema.safeParse(definition)
      if (result.success) throw new Error('expected a refused Definition')
      return result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    }
    expect(refused({ ...roleRunDefinition, roles: [{ ...declaredRoles[0], sees: 'all' }] })).toContain('roles.0')
    expect(refused({ ...roleRunDefinition, roles: [declaredRoles[0], declaredRoles[0]] })).toContain('duplicate role: dispatch')
    expect(refused({ ...roleRunDefinition, roles: [] })).toContain('roles')
    expect(refused({ ...roleRunDefinition, roles: [{ id: 'x', label: 'X', class: 'observer' }] })).toContain('roles.0.class')
    // A preset may bundle a role a Pack derives, so compile checks its members against the merged roles (derived-roles.test.ts).
    expect(scenarioDefinitionSchema.safeParse({ ...roleRunDefinition, rolePresets: [{ id: 'p', label: 'P', roles: ['ghost'] }] }).success).toBe(true)
    expect(refused({ ...roleRunDefinition, rolePresets: [{ id: 'p', label: 'P', roles: ['dispatch', 'dispatch'] }] })).toContain('rolePresets.0.roles.1: role preset names a role twice: dispatch')
    expect(refused({ ...roleRunDefinition, rolePresets: [{ id: 'control', label: 'P', roles: ['dispatch'] }] })).toContain('already a role id')
    expect(refused({ ...openRunDefinition, rolePresets: declaredPresets })).toContain('Role presets need declared roles')
  })

  test('a role Definition refuses AI restrictions', () => {
    const result = scenarioDefinitionSchema.safeParse({ ...roleRunDefinition, agentRestrictions: { operationIds: ['world.fixture.assign'] } })
    expect(result.success).toBe(false)
    const issue = issueOf(result.error)
    expect(issue.params?.code).toBe('agent_restrictions_in_role_run')
    expect(issue.message.startsWith('agent_restrictions_in_role_run:')).toBe(true)
    // Empty restrictions are what every Definition carries by default.
    expect(scenarioDefinitionSchema.safeParse({ ...roleRunDefinition, agentRestrictions: { operationIds: [], objects: [] } }).success).toBe(true)
  })

  test('compiling a role Run refuses every Pack that is not role-aware', async () => {
    for (const packs of [[fixturePack], [roleAwareFixturePack, weatherPack]]) {
      const source = packs.length === 1 ? roleRunDefinition : { ...roleRunDefinition, packs: [...roleRunDefinition.packs, { id: 'weather', config: {}, items: [] }] }
      let error: unknown
      try { await compileWithRolePacks(source, packs) } catch (caught) { error = caught }
      const issue = issueOf(error)
      expect(issue.params?.code).toBe('role_run_pack_not_role_aware')
      expect(issue.message).toStartWith('role_run_pack_not_role_aware: Pack ')
    }
    // The same Scenario without roles is open mode and needs no opt-in.
    await expect(compileWithRolePacks(openRunDefinition, [fixturePack])).resolves.toMatchObject({ id: 'open-run' })
  })

  test('roles compile into durable Run state that Run copies keep', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const compiled = await compileWithRolePacks(roleRunDefinition)
      expect(compiled.roles).toEqual([...declaredRoles])
      expect(compiled.rolePresets).toEqual([...declaredPresets])
      const declaration = { roles: [...declaredRoles], presets: [...declaredPresets] }

      const run = await registry.create({ scenarioId: 'role-run' })
      expect(run.roles()).toEqual(declaration)
      expect(run.snapshot().scenario?.roles).toEqual(declaration)
      expect((await registry.compiledScenarioForRun(run.id)).roles).toEqual([...declaredRoles])

      const copy = await registry.copy(run.id, {})
      expect(copy.snapshot().scenario?.roles).toEqual(declaration)
      expect(copy.roles()).toEqual(declaration)
      await registry.close(copy.id)
      expect(await registry.runRoles(copy.id)).toEqual(declaration)
      expect((await registry.summary(copy.id)).roles).toEqual(declaration)
      const reloaded = await registry.load(copy.id)
      expect(reloaded.snapshot().scenario?.roles).toEqual(declaration)

      const open = await registry.create({ scenarioId: 'open-run' })
      expect(open.roles()).toBeNull()
      expect(open.snapshot().scenario && 'roles' in open.snapshot().scenario!).toBe(false)
      expect((await registry.summary(open.id)).roles).toBeNull()
    } finally { await registry.shutdown() }
  })
})

describe('Role Run gates on World-direct REST', () => {
  test('a screen without a role reaches only presence, copy, delete and Scenario Definitions', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      for (const [suffix, init] of [
        ['', undefined],
        ['/snapshot', undefined],
        ['/capabilities', undefined],
        ['/objects', undefined],
        ['/objects/unit%3Aone', undefined],
        ['/events', undefined],
        ['/history', undefined],
        ['/procedure-runs', undefined],
        ['/capabilities/world.fixture.assign/invoke', post({ input: { unitId: 'unit:one', taskId: 'task:one' } })],
        ['/reset', { method: 'POST' }],
        ['/signals', post({ type: 'note', payload: {} })],
      ] as const) {
        const response = await callRoute<ErrorBody>(registry, runPath(run.id, suffix), init)
        expect({ suffix, status: response.status, code: response.body.error?.code }).toEqual({ suffix, status: 403, code: 'role_required' })
      }
      expect(issuedCommands(registry, run.id)).toEqual([])

      const presence = await callRoute<{ roles: { roles: unknown; presets: unknown; holders: Record<string, number> } }>(registry, runPath(run.id, '/presence'), undefined, { control: 2 })
      expect(presence.status).toBe(200)
      expect(presence.body.roles).toEqual({ roles: [...declaredRoles], presets: [...declaredPresets], holders: { control: 2 } })
      expect((await callRoute(registry, '/scenarios/role-run')).status).toBe(200)
      const copied = await callRoute<{ id: SimulationRunId }>(registry, runPath(run.id, '/copies'), post({}))
      expect(copied.status).toBe(201)
      expect((await callRoute(registry, runPath(copied.body.id), { method: 'DELETE' })).status).toBe(200)
    } finally { await registry.shutdown() }
  })

  test('unknown role ids are refused with a structured reason', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      const unknown = await callRoute<ErrorBody>(registry, runPath(run.id, '', 'dispatch,ghost'))
      expect(unknown.status).toBe(400)
      expect(unknown.body.error).toMatchObject({ code: 'unknown_role', details: { unknownRoleIds: ['ghost'], declaredRoleIds: ['dispatch', 'field', 'control'] } })
      // A Run without roles declares none, so any role id is unknown there.
      const open = await registry.create({ scenarioId: 'open-run' })
      const openUnknown = await callRoute<ErrorBody>(registry, runPath(open.id, '', 'dispatch'))
      expect(openUnknown.status).toBe(400)
      expect(openUnknown.body.error).toMatchObject({ code: 'unknown_role', details: { unknownRoleIds: ['dispatch'], declaredRoleIds: [] } })
    } finally { await registry.shutdown() }
  })

  test('a role set reads the Run and journals its roles on every command it issues', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      const joined = await callRoute<{ snapshot: { objects: unknown[] }; scenario: { roles: unknown } }>(registry, runPath(run.id, '', 'dispatch'))
      expect(joined.status).toBe(200)
      expect(joined.body.snapshot.objects).toHaveLength(4)
      expect(joined.body.scenario.roles).toEqual([...declaredRoles])
      const assigned = await callRoute<{ kind: string; result: { ok: boolean } }>(registry, invokePath(run.id, fixtureCommandIds.assign, 'field,dispatch'), post({ input: { unitId: 'unit:one', taskId: 'task:one' } }))
      expect(assigned.body).toMatchObject({ kind: 'command', result: { ok: true } })
      expect(issuedCommands(registry, run.id).map(command => command.roleIds)).toEqual([['dispatch', 'field']])
      const journaled = (await registry.get(run.id)!.events()).find((event): event is Extract<SimulationRunEvent, { type: 'command.issued' }> => event.type === 'command.issued')
      expect(journaled?.command.roleIds).toEqual(['dispatch', 'field'])
      // The journal keeps them: a closed and reloaded Run reads the same roles back.
      expect(await registry.close(run.id)).toBe(true)
      expect(registry.get(run.id)).toBeUndefined()
      await registry.load(run.id)
      expect(issuedCommands(registry, run.id).map(command => command.roleIds)).toEqual([['dispatch', 'field']])
    } finally { await registry.shutdown() }
  })

  test('delete, signal and reset need a controller-class role in the set', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      const deleteUnit = (roles: string) => callRoute<ErrorBody & { result?: { ok: boolean } }>(registry, invokePath(run.id, deleteObjectCommandKind, roles), post({ input: { objectId: 'unit:two' } }))
      for (const roles of ['dispatch', 'dispatch,field']) {
        const deleted = await deleteUnit(roles)
        expect({ roles, status: deleted.status, code: deleted.body.error?.code }).toEqual({ roles, status: 403, code: 'role_controller_only' })
        const reset = await callRoute<ErrorBody>(registry, runPath(run.id, '/reset', roles), { method: 'POST' })
        expect(reset.body.error.code).toBe('role_controller_only')
        const signal = await callRoute<ErrorBody>(registry, runPath(run.id, '/signals', roles), post({ type: 'note', payload: {} }))
        expect(signal.body.error.code).toBe('role_controller_only')
      }
      expect(registry.get(run.id)!.snapshot().objects.some(object => object.id === 'unit:two')).toBe(true)
      // The union counts: one controller-class role makes the screen a controller.
      const deleted = await deleteUnit('dispatch,control')
      expect(deleted.body.result?.ok).toBe(true)
      expect(issuedCommands(registry, run.id).at(-1)?.roleIds).toEqual(['dispatch', 'control'])
      expect((await callRoute(registry, runPath(run.id, '/signals', 'control'), post({ type: 'note', payload: {} }))).status).toBe(202)
      expect((await callRoute(registry, runPath(run.id, '/reset', 'control'), { method: 'POST' })).status).toBe(200)
    } finally { await registry.shutdown() }
  })

  test('the Run itself refuses AI and restrictions, and lets the Scenario timeline act', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      const actor = (role: Actor['role'], roleIds?: ReadonlyArray<string>): Actor => ({ id: actorIdSchema.parse(`actor:${role}`), label: role, role, ...(roleIds === undefined ? {} : { roleIds }) })
      const assign = { capabilityId: fixtureCommandIds.assign, input: { unitId: 'unit:one', taskId: 'task:one' } }
      await expect(run.invokeCapability(actor('ai_agent'), assign)).rejects.toMatchObject({ code: 'ai_role_run_unsupported' })
      await expect(run.invokeCapability(actor('ai_agent', ['control']), assign)).rejects.toMatchObject({ code: 'ai_role_run_unsupported' })
      await expect(run.invokeCapability(actor('operator'), assign)).rejects.toMatchObject({ code: 'role_required' })
      await expect(run.invokeCapability(actor('operator', ['ghost']), assign)).rejects.toMatchObject({ code: 'unknown_role' })
      await expect(run.setAgentRestrictions(actor('controller', ['control']), { operationIds: [], objects: [] }, 0)).rejects.toMatchObject({ code: 'agent_restrictions_in_role_run' })
      // The timeline acts as the system actor: no role, and no roles journaled.
      const timeline = await run.invokeCapability(actor('system'), assign)
      expect(timeline).toMatchObject({ kind: 'command', result: { ok: true } })
      expect(issuedCommands(registry, run.id).map(command => 'roleIds' in command)).toEqual([false])
    } finally { await registry.shutdown() }
  })

  test('a new role Run waits, paused, for its first screen to join with roles; a choice made before that, a later join or an open Run is untouched', async () => {
    const registry = await createRoleRunRegistry()
    interface Screen { readonly roleIds: ReadonlyArray<string> }
    const realtime = createSimulationRunRealtimeManager<Screen>({
      registry,
      send: () => undefined,
      sendReady: () => undefined,
      perspectiveOf: screen => screen.roleIds.length === 0 ? null : { roleIds: screen.roleIds, epoch: 1 },
    })
    const playback = async (id: SimulationRunId) => (await registry.executionStatus(id)).playback
    try {
      const run = await registry.create({ scenarioId: 'role-run' })
      expect(await playback(run.id)).toBe('paused')
      // A screen without roles, choosing them, starts nothing.
      realtime.addClient(run.id, { roleIds: [] })
      await Bun.sleep(20)
      expect(await playback(run.id)).toBe('paused')
      realtime.addClient(run.id, { roleIds: ['control'] })
      await waitForCondition('the first screen with roles starts the Run', () => registry.get(run.id)!.snapshot().clock?.paused === false)
      expect(await playback(run.id)).toBe('playing')
      // Paused afterwards, it stays paused when another screen joins.
      await registry.setExecution(run.id, { playback: 'paused' })
      realtime.addClient(run.id, { roleIds: ['control'] })
      await Bun.sleep(20)
      expect(await playback(run.id)).toBe('paused')

      // The Host's choice before anyone joined wins.
      const chosen = await registry.create({ scenarioId: 'role-run' })
      await registry.setExecution(chosen.id, { playback: 'paused' })
      realtime.addClient(chosen.id, { roleIds: ['control'] })
      await Bun.sleep(20)
      expect(await playback(chosen.id)).toBe('paused')

      const open = await registry.create({ scenarioId: 'open-run' })
      expect(await playback(open.id)).toBe('playing')
    } finally {
      realtime.stop()
      await registry.shutdown()
    }
  })

  test('a Run without roles behaves exactly as before', async () => {
    const registry = await createRoleRunRegistry()
    try {
      const run = await registry.create({ scenarioId: 'open-run' })
      const joined = await callRoute<{ snapshot: { objects: unknown[]; scenario: Record<string, unknown> }; scenario: Record<string, unknown> }>(registry, runPath(run.id))
      expect(joined.status).toBe(200)
      expect(Object.keys(joined.body.snapshot.scenario).sort()).toEqual(['agentRestrictions', 'highlightedObjectIds', 'scenarioId'])
      expect('roles' in joined.body.scenario || 'rolePresets' in joined.body.scenario).toBe(false)
      const presence = await callRoute<Record<string, unknown>>(registry, runPath(run.id, '/presence'))
      expect(Object.keys(presence.body).sort()).toEqual(['execution', 'loaded', 'simulationRunId', 'title'])
      const assigned = await callRoute<{ result: { ok: boolean } }>(registry, invokePath(run.id, fixtureCommandIds.assign), post({ input: { unitId: 'unit:one', taskId: 'task:one' } }))
      expect(assigned.body.result.ok).toBe(true)
      const deleted = await callRoute<{ result: { ok: boolean } }>(registry, invokePath(run.id, deleteObjectCommandKind), post({ input: { objectId: 'unit:two' } }))
      expect(deleted.body.result.ok).toBe(true)
      expect(issuedCommands(registry, run.id).every(command => !('roleIds' in command))).toBe(true)
      expect((await callRoute(registry, runPath(run.id, '/signals'), post({ type: 'note', payload: {} }))).status).toBe(202)
      expect((await callRoute(registry, runPath(run.id, '/reset'), { method: 'POST' })).status).toBe(200)
    } finally { await registry.shutdown() }
  })
})
