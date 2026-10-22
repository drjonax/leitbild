import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceIdSchema } from '@leitbild/contracts'
import { objectIdSchema, runRolesOf, type CompiledScenario, type OperationalObject, type RunRoles, type SimulationRunId } from '../src/core/model/index.ts'
import {
  createRealtimeConnectionController,
  staleRefusalMessage,
  staleResultMessage,
  switchUnderWayMessage,
  type RealtimeConnectionCallbacks,
} from '../src/ui/app/realtime-connection.ts'
import { beginAction, commandFeedbackText, emptyCommandFeedback } from '../src/ui/command-feedback.ts'
import { createPerspectiveGate, perspectiveKey, storesForPerspective, type RealtimePerspective, type RunScopedStores } from '../src/ui/roles/perspective.ts'
import {
  dropRole,
  idleRoleKeys,
  roleBarModel,
  roleEntries,
  roleKeyArmWindowMs,
  roleKeyStep,
  roleSetText,
  switchToEntry,
  type RoleKeyInput,
} from '../src/ui/roles/role-controller.ts'
import { openRoleDialog, roleDialogModel, togglePreset } from '../src/ui/roles/role-dialog.ts'
import {
  configureActiveRoleSet,
  initialRoleSet,
  readStoredRoleSet,
  roleSetFromSearch,
  roleSetStorageKey,
  searchWithRoleSet,
  withActiveRoleSet,
  writeStoredRoleSet,
  type RoleSetStorage,
} from '../src/ui/roles/role-session.ts'
import { fetchRunPresence, joinSimulationRun, worldApiErrorCode } from '../src/ui/simulation-run-client.ts'
import { parseSimulationRunWebSocketMessage } from '../src/ui/simulation-run-events.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { compileWithRolePacks, declaredPresets, declaredRoles, openRunDefinition, roleRunDefinition, sidedRoles, sides } from './fixtures/role-runs.ts'

const declaration: RunRoles = { roles: [...declaredRoles], presets: [...declaredPresets] }
const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const runId = 'run-roles' as SimulationRunId
configureActiveWorkspace(workspaceId)

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  configureActiveRoleSet(null)
})

const memoryStorage = (): RoleSetStorage & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}

const key = (value: string, now: number, extra: Partial<RoleKeyInput> = {}): RoleKeyInput =>
  ({ key: value, repeat: false, modified: false, inert: false, now, ...extra })

describe('role dialog rows and role bar', () => {
  test('numbers roles and presets for P then a digit, and offers each as a one-tap row with ticks and holders', () => {
    expect(roleEntries(declaration).map(entry => [entry.kind, entry.id, entry.key])).toEqual([
      ['role', 'dispatch', '1'], ['role', 'field', '2'], ['role', 'control', '3'], ['preset', 'solo', '4'],
    ])
    const rows = roleDialogModel(declaration, openRoleDialog(declaration, ['dispatch', 'field'], []), { mode: 'join', held: [], holders: { control: 2 } }).presets
    // A Run without sides shows no side colours.
    expect(rows.map(row => ({ id: row.id, ticked: row.ticked, holders: row.holders, sides: row.sides }))).toEqual([
      { id: 'solo', ticked: true, holders: null, sides: [] },
      { id: 'dispatch', ticked: true, holders: 0, sides: [] },
      { id: 'field', ticked: true, holders: 0, sides: [] },
      { id: 'control', ticked: false, holders: 2, sides: [] },
    ])
  })

  test('ticks roles and presets as a union in declaration order', () => {
    const ticking = (held: ReadonlyArray<string>, entryId: string) => togglePreset(declaration, openRoleDialog(declaration, held, []), entryId).control
    expect(ticking([], 'control')).toEqual(['control'])
    expect(ticking(['control'], 'solo')).toEqual(['dispatch', 'field', 'control'])
    expect(ticking(['dispatch', 'field', 'control'], 'solo')).toEqual(['control'])
    expect(ticking(['dispatch'], 'solo')).toEqual(['dispatch', 'field'])
    expect(() => ticking([], 'ghost')).toThrow('Unknown role: ghost')
  })

  test('drops and switches whole role sets', () => {
    expect(dropRole(declaration, ['dispatch', 'control'], 'dispatch')).toEqual({ kind: 'set', roleIds: ['control'] })
    expect(dropRole(declaration, ['control'], 'control').kind).toBe('refused')
    expect(switchToEntry(declaration, ['dispatch', 'control'], 'field')).toEqual({ kind: 'set', roleIds: ['field'] })
    expect(switchToEntry(declaration, ['field'], 'field')).toEqual({ kind: 'unchanged' })
    expect(switchToEntry(declaration, ['control'], 'solo')).toEqual({ kind: 'set', roleIds: ['dispatch', 'field'] })
    const bar = roleBarModel(declaration, ['field', 'dispatch'])
    expect(bar.chips.map(chip => [chip.id, chip.droppable])).toEqual([['dispatch', true], ['field', true]])
    expect(roleBarModel(declaration, ['control']).chips).toEqual([{ id: 'control', label: 'Controller', roleClass: 'controller', droppable: false, sides: [] }])
    expect(roleBarModel(declaration, ['dispatch', 'field', 'control']).sidesWarning).toBeNull()
    expect(roleSetText(declaration, ['control', 'dispatch'])).toBe('Dispatcher + Controller')
  })

  test('switches with P then a digit, and only then', () => {
    let state = idleRoleKeys
    const step = (input: RoleKeyInput) => {
      const result = roleKeyStep(state, input, declaration, ['dispatch'])
      state = result.state
      return result
    }
    expect(step(key('3', 0))).toMatchObject({ handled: false, change: null })
    expect(step(key('p', 100))).toMatchObject({ handled: true, change: null })
    expect(step(key('3', 200))).toEqual({ state: idleRoleKeys, handled: true, change: { kind: 'set', roleIds: ['control'] } })
    expect(step(key('4', 300))).toMatchObject({ handled: false, change: null })
    step(key('P', 1_000))
    expect(step(key('4', 1_000 + roleKeyArmWindowMs + 1))).toMatchObject({ handled: false, change: null })
    step(key('p', 5_000))
    expect(step(key('Escape', 5_100))).toMatchObject({ handled: true, change: null })
    expect(step(key('2', 5_200))).toMatchObject({ handled: false })
    step(key('p', 6_000))
    expect(step(key('9', 6_100))).toMatchObject({ handled: false, change: null })
    for (const blocked of [{ inert: true }, { modified: true }, { repeat: true }]) {
      expect(step(key('p', 7_000, blocked))).toMatchObject({ handled: false })
      expect(step(key('2', 7_100))).toMatchObject({ handled: false })
    }
    step(key('p', 8_000))
    expect(step(key('1', 8_100))).toMatchObject({ handled: true, change: { kind: 'unchanged' } })
  })
})

describe('side colours and the several-sides warning', () => {
  const sided: RunRoles = { roles: [...sidedRoles], presets: [], sides: [...sides] }

  test('the dialog and the role bar show each role\'s side colour and warn when one screen sees two sides', () => {
    // The dialog lists the roles of one side at a time, and truth roles on every side.
    const rowsOn = (side: string) => roleDialogModel(sided, { side, control: [], hidden: [] }, { mode: 'join', held: [], holders: {} }).presets
      .map(row => [row.id, row.sides.map(entry => entry.colour)])
    expect(rowsOn('red')).toEqual([['red-lead', [sides[0]!.colour]], ['umpire', []], ['control', []]])
    expect(rowsOn('blue')).toEqual([['blue-lead', [sides[1]!.colour]], ['umpire', []], ['control', []]])
    expect(roleBarModel(sided, ['red-lead']).sidesWarning).toBeNull()
    expect(roleBarModel(sided, ['red-lead', 'control']).sidesWarning).toBeNull()
    expect(roleBarModel(sided, ['red-lead', 'blue-lead']).sidesWarning).toBe('This screen sees Red and Blue together: play fair')
    expect(roleBarModel(sided, ['blue-lead', 'red-lead']).chips.map(chip => chip.sides.map(side => side.id))).toEqual([['red'], ['blue']])
  })
})

describe('per-tab role set', () => {
  test('lives in the frame URL query and sessionStorage, the URL first', () => {
    expect(roleSetFromSearch('?debugStartup=1&roles=dispatch,control')).toEqual(['dispatch', 'control'])
    expect(roleSetFromSearch('?roles=')).toBeNull()
    expect(roleSetFromSearch('')).toBeNull()
    expect(searchWithRoleSet('?debugStartup=1', ['dispatch', 'field'])).toBe('?debugStartup=1&roles=dispatch%2Cfield')
    expect(searchWithRoleSet('?roles=dispatch&debugStartup=1', null)).toBe('?debugStartup=1')
    expect(searchWithRoleSet('?roles=dispatch', null)).toBe('')
    const storage = memoryStorage()
    const storageKey = roleSetStorageKey(workspaceId, runId)
    writeStoredRoleSet(storage, storageKey, ['field'])
    expect(readStoredRoleSet(storage, storageKey)).toEqual(['field'])
    expect(initialRoleSet({ search: '?roles=control', storage, key: storageKey })).toEqual(['control'])
    expect(initialRoleSet({ search: '', storage, key: storageKey })).toEqual(['field'])
    writeStoredRoleSet(storage, storageKey, null)
    expect(storage.values.size).toBe(0)
    storage.setItem(storageKey, '{"not":"a list"}')
    expect(() => readStoredRoleSet(storage, storageKey)).toThrow('Stored role set is not a list')
  })

  test('every Run-scoped request carries the active role set, and none in open mode', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ error: { code: 'role_required', message: 'This Run declares roles; pick a role to use it' } }), { status: 403 })
    }) as typeof fetch
    expect(withActiveRoleSet('/x')).toBe('/x')
    configureActiveRoleSet(['dispatch', 'control'])
    expect(withActiveRoleSet('/x?afterSeq=2')).toBe('/x?afterSeq=2&roles=dispatch%2Ccontrol')
    let error: unknown
    try { await joinSimulationRun(runId) } catch (caught) { error = caught }
    expect(worldApiErrorCode(error)).toBe('role_required')
    expect(urls.at(-1)).toBe(`/api/workspaces/${workspaceId}/world/simulation-runs/${runId}?roles=dispatch%2Ccontrol`)
    configureActiveRoleSet(null)
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ simulationRunId: runId, title: 'Role Run', roles: { ...declaration, holders: { control: 1 } } }), { status: 200 })
    }) as typeof fetch
    expect((await fetchRunPresence(runId)).roles?.holders).toEqual({ control: 1 })
    expect(urls.at(-1)).toBe(`/api/workspaces/${workspaceId}/world/simulation-runs/${runId}/presence`)
  })
})

const object = (id: string, revision = 0): OperationalObject => ({ id, revision } as unknown as OperationalObject)

const roleRunScenario = async (): Promise<CompiledScenario> => await compileWithRolePacks(roleRunDefinition)

/** Everything a store holds, Maps included, as text to search for ids. */
const storeText = (stores: RunScopedStores): string =>
  JSON.stringify(stores, (_key, value: unknown) => value instanceof Map ? [...value.entries()] : value)

describe('perspective epochs', () => {
  test('a newer epoch replaces every Run store, the Compiled Scenario and the feedback line included', async () => {
    const compiled = await roleRunScenario()
    const gate = createPerspectiveGate()
    expect(gate.admits(undefined)).toBe(true)
    expect(gate.adopt(1)).toBe(true)
    // The Controller's perspective: its snapshot and Compiled Scenario name a Red unit.
    const controller: RealtimePerspective = {
      epoch: 1,
      roleIds: ['control'],
      snapshot: { objects: [object('red-1', 3), object('blue-1')], seq: 9 },
      compiledScenario: { ...compiled, initialObjects: [object('red-1'), object('blue-1')] },
    }
    let stores = storesForPerspective(controller, { epoch: 0, roleIds: ['control'], feedback: emptyCommandFeedback }, candidate => candidate.id === 'red-1')
    expect(commandFeedbackText(stores.commandFeedback.line)).toBe('Playing Controller')
    // The screen then works in that perspective and names the Red unit.
    stores = {
      ...stores,
      selectedControllerId: objectIdSchema.parse('red-1'),
      packDataRevisions: { fixture: 4 },
      packPanelSelections: { 'fixture.board': 'red-1' },
      commandFeedback: beginAction(stores.commandFeedback, 'Deleting red-1').feedback,
    }
    expect(storeText(stores)).toContain('red-1')
    expect(gate.admits(1)).toBe(true)
    // The switch: the Run answers with epoch 2 and the new role set's snapshot and Compiled Scenario.
    expect(gate.adopt(2)).toBe(true)
    const dispatcher: RealtimePerspective = {
      epoch: 2,
      roleIds: ['dispatch'],
      snapshot: { objects: [object('blue-1', 1)], seq: 12, clock: { currentTime: '2026-01-01T08:00:00.000Z' } as never },
      compiledScenario: { ...compiled, initialObjects: [object('blue-1')] },
    }
    const switched = storesForPerspective(dispatcher, { epoch: 1, roleIds: ['control'], feedback: stores.commandFeedback }, () => false)
    expect(switched).toEqual({
      compiledScenario: dispatcher.compiledScenario,
      objects: [object('blue-1', 1)],
      scenarioState: undefined,
      clock: { currentTime: '2026-01-01T08:00:00.000Z' } as never,
      selectedControllerId: null,
      seenRevisions: new Map([['blue-1', 1]]),
      packDataRevisions: {},
      packPanelSelections: {},
      commandFeedback: { nextActionId: 4, line: { actionId: 3, tone: 'notice', subject: 'Switched to Dispatcher' } },
    })
    // No store of the new perspective holds an id only the old one could see.
    expect(storeText(switched)).not.toContain('red-1')
    expect(gate.admits(1)).toBe(false)
    expect(gate.adopt(1)).toBe(false)
    expect(gate.admits(2)).toBe(true)
    expect(gate.epoch()).toBe(2)
    // A reset re-sends the same epoch with a fresh snapshot: the stores are replaced, this screen's line stays.
    expect(gate.adopt(2)).toBe(true)
    const pending = beginAction(switched.commandFeedback, 'Resetting scenario').feedback
    expect(storesForPerspective(dispatcher, { epoch: 2, roleIds: ['dispatch'], feedback: pending }, () => false).commandFeedback).toBe(pending)
    expect(() => storesForPerspective({ ...dispatcher, compiledScenario: { ...compiled, roles: undefined } as never }, { epoch: 1, roleIds: null, feedback: emptyCommandFeedback }, () => false)).toThrow('declares no roles')
    expect(perspectiveKey(['control', 'dispatch'])).toBe(perspectiveKey(['dispatch', 'control']))
    expect(perspectiveKey(null)).toBe('')
  })

  test('parses epochs, ready snapshots and role refusals, and leaves open-mode messages as they were', async () => {
    const compiled = await roleRunScenario()
    const scope = { workspaceId, simulationRunId: runId }
    const ready = parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'realtime.ready', ...scope, snapshotSeq: 4, epoch: 2, roleIds: ['control'], snapshot: { objects: [object('a')], seq: 4 }, compiledScenario: compiled }))
    expect(ready).toMatchObject({ type: 'realtime.ready', perspective: { epoch: 2, roleIds: ['control'], snapshot: { objects: [object('a')], seq: 4 }, compiledScenario: { id: 'role-run', roles: [...declaredRoles] } } })
    expect(parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'realtime.ready', ...scope, snapshotSeq: 4 }))).toEqual({ type: 'realtime.ready', ...scope, snapshotSeq: 4 })
    expect(parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'events', ...scope, snapshotSeq: 4, events: [], epoch: 3 }))).toMatchObject({ epoch: 3 })
    expect(parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'events', ...scope, snapshotSeq: 4, events: [] }))).toEqual({ type: 'events', ...scope, snapshotSeq: 4, events: [] })
    expect(parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'role.refused', ...scope, code: 'unknown_role', message: 'nope', epoch: 1 }))).toEqual({ type: 'role.refused', ...scope, code: 'unknown_role', message: 'nope', epoch: 1 })
    expect(() => parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'events', ...scope, snapshotSeq: 4, events: [], epoch: 0 }))).toThrow('invalid perspective epoch')
    expect(() => parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'realtime.ready', ...scope, snapshotSeq: 4, epoch: 2, roleIds: ['control'], compiledScenario: compiled }))).toThrow('without a snapshot')
    expect(() => parseSimulationRunWebSocketMessage(JSON.stringify({ type: 'realtime.ready', ...scope, snapshotSeq: 4, epoch: 2, roleIds: ['control'], snapshot: { objects: [], seq: 4 } }))).toThrow('without a Compiled Scenario')
  })
})

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static last: FakeSocket | null = null
  readonly sent: unknown[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  constructor(readonly url: string) { FakeSocket.last = this }
  send(data: string): void { this.sent.push(JSON.parse(data)) }
  close(): void { this.readyState = FakeSocket.CLOSED }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  receive(message: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify({ workspaceId, simulationRunId: runId, ...message }) }) }
}

describe('realtime connection in a role Run', () => {
  const withFakeSocket = async (body: (connection: ReturnType<typeof createRealtimeConnectionController>, seen: string[]) => Promise<void>): Promise<void> => {
    const globals = globalThis as unknown as Record<string, unknown>
    const saved = { WebSocket: globals.WebSocket, location: globals.location, window: globals.window }
    Object.assign(globals, { WebSocket: FakeSocket, location: { protocol: 'http:', host: 'world.test' }, window: globalThis })
    const connection = createRealtimeConnectionController()
    try {
      const seen: string[] = []
      const callbacks: RealtimeConnectionCallbacks = {
        onOpen: () => {}, onClose: () => {}, onError: message => { seen.push(`error ${message}`) }, onInvalidMessage: message => { seen.push(`invalid ${message}`) },
        onReady: message => { seen.push(`ready ${message.perspective?.epoch} ${message.perspective?.roleIds.join(',')} ${message.perspective?.snapshot.objects.length}`) },
        onEvent: message => { seen.push(`events ${message.epoch}`) },
        onRuntimeRealtime: message => { seen.push(`realtime ${message.epoch}`) },
        onRoleRefused: message => { seen.push(`refused ${message.code}`) },
      }
      connection.connect(runId, callbacks, ['dispatch'])
      await body(connection, seen)
    } finally {
      connection.disconnect()
      Object.assign(globals, saved)
    }
  }

  const readyMessage = (compiledScenario: CompiledScenario, epoch: number, roleIds: ReadonlyArray<string>, objectIds: ReadonlyArray<string>) =>
    ({ type: 'realtime.ready', snapshotSeq: epoch, epoch, roleIds, snapshot: { objects: objectIds.map(id => object(id)), seq: epoch }, compiledScenario })

  const outcome = { kind: 'query', result: { units: 2 } }
  const sentInvocations = (socket: FakeSocket) => socket.sent.filter(message => (message as { type: string }).type === 'capability.invoke') as Array<{ readonly requestId: string }>

  test('switches in place: the new epoch replaces the stores and late messages of the old one are ignored', async () => {
    const compiled = await roleRunScenario()
    await withFakeSocket(async (connection, seen) => {
      const socket = FakeSocket.last!
      expect(socket.url).toBe(`ws://world.test/api/workspaces/${workspaceId}/world/ws?simulationRun=${runId}&roles=dispatch`)
      socket.open()
      socket.receive(readyMessage(compiled, 1, ['dispatch'], ['a', 'b']))
      socket.receive({ type: 'events', snapshotSeq: 2, events: [], epoch: 1 })
      connection.setRoles(runId, ['control'])
      expect(socket.sent.at(-1)).toEqual({ type: 'role.set', roles: ['control'] })
      expect(() => connection.setRoles(runId, ['field'])).toThrow('A role switch is already under way')
      // Until the new snapshot arrives the old epoch still applies; then it never does.
      socket.receive({ type: 'events', snapshotSeq: 3, events: [], epoch: 1 })
      socket.receive(readyMessage(compiled, 2, ['control'], ['c']))
      socket.receive({ type: 'events', snapshotSeq: 4, events: [], epoch: 1 })
      socket.receive({ type: 'runtime.realtime', snapshotSeq: 4, messages: [], epoch: 1 })
      socket.receive(readyMessage(compiled, 1, ['dispatch'], ['a']))
      socket.receive({ type: 'events', snapshotSeq: 5, events: [], epoch: 2 })
      // The switch is answered, so the next one may be asked; the Run refuses it and the screen keeps epoch 2.
      connection.setRoles(runId, ['ghost'])
      socket.receive({ type: 'role.refused', code: 'unknown_role', message: 'nope', epoch: 2 })
      connection.setRoles(runId, ['field'])
      expect(seen).toEqual(['ready 1 dispatch 2', 'events 1', 'events 1', 'ready 2 control 1', 'events 2', 'refused unknown_role'])
    })
  })

  test('settles each invocation by the epoch of its own answer', async () => {
    const compiled = await roleRunScenario()
    await withFakeSocket(async (connection, seen) => {
      const socket = FakeSocket.last!
      socket.open()
      // Asked before the first ready: the Run answers it in epoch 1, which the screen has adopted by then.
      const beforeReady = connection.invokeCapability(runId, { capabilityId: 'world.fixture.assign', input: {} })
      socket.receive(readyMessage(compiled, 1, ['dispatch'], ['a']))
      socket.receive({ type: 'capability.result', requestId: sentInvocations(socket)[0]!.requestId, outcome, epoch: 1 })
      expect(await beforeReady).toEqual(outcome as never)

      // Asked before a switch and answered after it: settled without its result, saying it may have applied.
      const beforeSwitch = Promise.allSettled([
        connection.invokeCapability(runId, { capabilityId: 'world.fixture.assign', input: {} }),
        connection.invokeCapability(runId, { capabilityId: 'world.fixture.assign', input: {} }),
      ])
      connection.setRoles(runId, ['control'])
      // While the switch is outstanding the Run would act under the new set, so nothing is sent.
      const sentBefore = sentInvocations(socket).length
      await expect(connection.invokeCapability(runId, { capabilityId: 'world.fixture.assign', input: {} })).rejects.toThrow(switchUnderWayMessage)
      expect(sentInvocations(socket)).toHaveLength(sentBefore)
      socket.receive(readyMessage(compiled, 2, ['control'], ['c']))
      const [, oldResult, oldError] = sentInvocations(socket)
      socket.receive({ type: 'capability.result', requestId: oldResult!.requestId, outcome, epoch: 1 })
      socket.receive({ type: 'capability.error', requestId: oldError!.requestId, code: 'unit_not_authorized', message: 'Red Tank 2 is not yours', epoch: 1 })
      expect((await beforeSwitch).map(settled => settled.status === 'rejected' ? (settled.reason as Error).message : settled.status)).toEqual([staleResultMessage, staleRefusalMessage])

      // Asked after the switch is answered: the Run answers it in the new epoch and it resolves.
      const afterSwitch = connection.invokeCapability(runId, { capabilityId: 'world.fixture.assign', input: {} })
      socket.receive({ type: 'capability.result', requestId: sentInvocations(socket).at(-1)!.requestId, outcome, epoch: 2 })
      expect(await afterSwitch).toEqual(outcome as never)
      expect(seen).toEqual(['ready 1 dispatch 1', 'ready 2 control 1'])
    })
  })

  test('sends no switch before the Run has answered the screen, and says it was not sent', async () => {
    await withFakeSocket(async connection => {
      expect(() => connection.setRoles(runId, ['control'])).toThrow('so the switch was not sent; this screen keeps its roles')
      FakeSocket.last!.open()
      expect(() => connection.setRoles(runId, ['control'])).toThrow('The Run has not answered this screen yet, so the switch was not sent')
      expect(FakeSocket.last!.sent).toEqual([])
    })
  })
})

describe('inert in a Run without roles', () => {
  test('the role dialog and the role bar mount only for a Run that declares roles', async () => {
    expect(runRolesOf(await compileWithRolePacks(openRunDefinition))).toBeNull()
    expect(runRolesOf(await compileWithRolePacks(roleRunDefinition))).toEqual(declaration)
    const route = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'routes', 'ControlSurfaceRoute.svelte'), 'utf8')
    const markup = route.slice(route.indexOf('</script>'))
    expect(markup.match(/<RoleBar\b/g)).toHaveLength(1)
    expect(markup.match(/<RoleDialog\b/g)).toHaveLength(2)
    // Each mounts only under its role guard, however the markup is laid out.
    expect(markup).toMatch(/\{#if\s+runRoles\s*&&\s*heldRoleIds\s*\}\s*<RoleBar\b/)
    expect(markup).toMatch(/\{#if\s+rolePicker\s*\}\s*<RoleDialog\b/)
    expect(markup).toMatch(/\{#if\s+roleDialogOpen\s*&&\s*runRoles\s*&&\s*heldRoleIds\s*\}\s*<RoleDialog\b/)
    // The picker opens only on the Run's own refusal of a screen without (valid) roles.
    expect(route.match(/rolePicker\s*=\s*\{/g)).toHaveLength(1)
    expect(route).toMatch(/if\s*\(\s*code\s*!==\s*'role_required'\s*&&\s*code\s*!==\s*'unknown_role'\s*\)\s*throw\s+err\b/)
    // Delete and reset are offered to everyone in open mode, where no role set exists.
    expect(markup).toMatch(/deleteObject=\{\s*controllerControls\s*\?\s*deleteObject\s*:\s*undefined\s*\}/)
    // Without a delete handler the rail row shows no delete control and no confirmation.
    const row = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ObjectRow.svelte'), 'utf8')
    expect(row).toMatch(/\{#if\s+deleteObject\s*\}\s*<span\s+class="row-delete-toggle"/)
    expect(row).toMatch(/\{#if\s+deleteRequested\s*&&\s*deleteObject\s*\}/)
    expect(markup).toMatch(/resetScenario=\{\s*controllerControls\s*\?\s*resetScenario\s*:\s*null\s*\}/)
    expect(route).toMatch(/const\s+controllerControls\s*=\s*\$derived\(\s*runRoles\s*===\s*null\s*\|\|/)
  })
})
