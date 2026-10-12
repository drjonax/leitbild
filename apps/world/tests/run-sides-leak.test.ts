// The wire oracle: Red, Blue and Controller screens, each driven by the real
// World client modules, play one scripted sided fixture Run over a real
// server. Every id and label carries a per-run nonce. After each step the
// oracle deep-scans every HTTP body and WebSocket message a side screen
// received, and every store it built, for any id or label of an object
// outside that side's audience and for any command id another side issued.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createServer } from '../src/core/api/server.ts'
import {
  audienceVisibleTo,
  seesForRoleSet,
  type ObjectAudience,
  type OperationalObject,
  type RunRoles,
  type SimulationRunId,
} from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import type { SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createRealtimeConnectionController, type RealtimeConnectionController } from '../src/ui/app/realtime-connection.ts'
import { startupScenarioSource } from '../src/ui/app/startup-scenario.ts'
import { emptyCommandFeedback } from '../src/ui/command-feedback.ts'
import { storesForPerspective, type RunScopedStores } from '../src/ui/roles/perspective.ts'
import { configureActiveRoleSet } from '../src/ui/roles/role-session.ts'
import {
  invokeSimulationRunCapability,
  joinSimulationRun,
  querySimulationRunCapability,
  resetSimulationRun,
} from '../src/ui/simulation-run-client.ts'
import { applySimulationRunEventBatchMessage } from '../src/ui/simulation-run-events.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { fixtureAnnouncementType, fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import { createRoleRunWorkspaces, sidedNames, sidedRoles, sidedRunDefinition, sides } from './fixtures/role-runs.ts'
import { waitForCondition } from './helpers.ts'

const nonce = crypto.randomUUID().slice(0, 8)
const names = sidedNames(nonce)
const definition = sidedRunDefinition(nonce)
const declaration: RunRoles = { roles: [...sidedRoles], presets: [], sides: [...sides] }

/** Event types a side socket may receive at all. */
const sideVisibleEventTypes = new Set(['object.upserted', 'object.deleted', 'telemetry.sampled', 'clock.updated', 'simulationRun.reset', 'scenario.guidance.shown', 'scenario.guidance.hidden'])

interface Screen {
  readonly name: string
  roleIds: ReadonlyArray<string>
  readonly connection: RealtimeConnectionController
  stores: RunScopedStores | null
  epoch: number
  socket: WebSocket | null
  readonly http: Array<{ readonly method: string; readonly url: string; readonly status: number; readonly body: string }>
  readonly ws: Array<{ readonly text: string; readonly type: string; readonly epoch?: number }>
  /** Each ready and event batch the screen applied to its stores, with the epoch it carried. */
  readonly applied: Array<{ readonly kind: 'ready' | 'events'; readonly epoch: number | undefined }>
  readonly realtime: Array<string>
  /** Channel errors, invalid messages and refusals; a screen in this script has none. */
  readonly errors: Array<string>
}

let workspaces: WorldWorkspaceRuntimeRegistry
let dataDir: string
let workspaceId: WorkspaceId
let server: ReturnType<typeof createServer>
let base: string
let runId: SimulationRunId
const screens: Screen[] = []
const originalFetch = globalThis.fetch
const savedGlobals: Record<string, unknown> = {}
let activeScreen: Screen | null = null
let constructing: Screen | null = null

const registry = async (): Promise<SimulationRunRegistry> => await workspaces.withRuntime(workspaceId, async runtime => runtime.simulationRuns)
const liveRun = async () => {
  const run = (await registry()).get(runId)
  if (!run) throw new Error('the sided Run is not loaded')
  return run
}

/** The client modules' fetch: relative paths reach the test server; each answer is recorded for the screen that asked. */
const screenFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const screen = activeScreen
  if (screen === null) throw new Error(`A client module fetched outside a screen: ${String(input)}`)
  const path = String(input)
  const response = await originalFetch(path.startsWith('/') ? `${base}${path}` : path, init)
  const body = await response.text()
  screen.http.push({ method: init?.method ?? 'GET', url: path, status: response.status, body })
  return new Response(body, { status: response.status, headers: response.headers })
}) as typeof fetch

const NativeWebSocket = globalThis.WebSocket
class ScreenSocket extends NativeWebSocket {
  constructor(url: string | URL) {
    super(url)
    const screen = constructing
    if (screen === null) throw new Error(`A WebSocket opened outside a screen: ${String(url)}`)
    screen.socket = this
    this.addEventListener('message', event => {
      const text = String(event.data)
      const parsed = JSON.parse(text) as { readonly type: string; readonly epoch?: number }
      screen.ws.push({ text, type: parsed.type, ...(parsed.epoch === undefined ? {} : { epoch: parsed.epoch }) })
    })
  }
}

/** Runs client-module calls as one screen: its role set on every request, its record for every answer. */
const asScreen = async <T>(screen: Screen, work: () => Promise<T>): Promise<T> => {
  activeScreen = screen
  configureActiveRoleSet(screen.roleIds)
  try { return await work() }
  finally {
    activeScreen = null
    configureActiveRoleSet(null)
  }
}

const createScreen = (name: string, roleIds: ReadonlyArray<string>): Screen => {
  const screen: Screen = { name, roleIds, connection: createRealtimeConnectionController(), stores: null, epoch: 0, socket: null, http: [], ws: [], applied: [], realtime: [], errors: [] }
  screens.push(screen)
  return screen
}

/** The Run read a joining World screen makes, and the Compiled Scenario it then works from. */
const readRun = async (screen: Screen) => await asScreen(screen, async () => {
  const response = await joinSimulationRun(runId)
  expect(startupScenarioSource(response, null, true).kind).toBe('run-read')
  return response
})

/** Joins as a World screen does: the Run read, then the realtime channel and its first ready. */
const join = async (screen: Screen): Promise<void> => {
  await readRun(screen)
  constructing = screen
  try {
    screen.connection.connect(runId, {
        onOpen: () => {},
        onClose: () => {},
        onError: message => { screen.errors.push(`error: ${message}`) },
        onInvalidMessage: message => { screen.errors.push(`invalid: ${message}`) },
        onReady: message => {
          if (!message.perspective) {
            screen.errors.push('a role Run\'s ready without its perspective')
            return
          }
          screen.stores = storesForPerspective(message.perspective, { epoch: screen.epoch, roleIds: screen.roleIds, feedback: screen.stores?.commandFeedback ?? emptyCommandFeedback }, () => false)
          screen.epoch = message.perspective.epoch
          screen.roleIds = message.perspective.roleIds
          screen.applied.push({ kind: 'ready', epoch: message.perspective.epoch })
        },
        onEvent: message => {
          const stores = screen.stores
          if (stores === null) {
            screen.errors.push('events before the first ready')
            return
          }
          const applied = applySimulationRunEventBatchMessage({
            objects: stores.objects,
            selectedControllerId: stores.selectedControllerId,
            ...(stores.scenarioState === undefined ? {} : { scenarioState: stores.scenarioState }),
          }, message)
          screen.stores = {
            ...stores,
            ...(applied.objectUpdate === undefined ? {} : { objects: applied.objectUpdate.objects, selectedControllerId: applied.objectUpdate.selectedControllerId }),
            ...(applied.scenarioUpdate === undefined ? {} : { scenarioState: applied.scenarioUpdate }),
            ...(applied.clockUpdate === undefined ? {} : { clock: applied.clockUpdate }),
          }
          screen.applied.push({ kind: 'events', epoch: message.epoch })
        },
        onRuntimeRealtime: message => { for (const item of message.messages) screen.realtime.push(item.type) },
        onRoleRefused: message => { screen.errors.push(`role refused: ${message.message}`) },
      }, screen.roleIds)
  } finally { constructing = null }
  await waitForCondition(`${screen.name} ready`, () => screen.applied.some(entry => entry.kind === 'ready'))
}

const objectIds = (screen: Screen): ReadonlyArray<string> => (screen.stores?.objects ?? []).map(object => object.id).sort()

/** Everything a store holds, Maps included, as text to search. */
const storeText = (stores: RunScopedStores | null): string =>
  JSON.stringify(stores, (_key, value: unknown) => value instanceof Map ? [...value.entries()] : value)

/**
 * Every object the Run has held, with its audience: initial ones, every
 * upsert journaled or projected since, and every object the script asked for,
 * so an id the Run refused is still watched for.
 */
const inventory = new Map<string, { readonly label: string; readonly audience: ObjectAudience | undefined }>()
const attempt = <T extends { readonly id: string; readonly label: string; readonly audience?: ObjectAudience }>(item: T): T => {
  inventory.set(item.id, { label: item.label, audience: item.audience })
  return item
}
/** Every command a side role issued, by the sides it sees. */
const sideCommands = new Map<string, ReadonlyArray<string>>()
const takeInventory = async (): Promise<void> => {
  const run = await liveRun()
  const record = (object: OperationalObject) => { inventory.set(object.id, { label: object.label, audience: object.audience }) }
  for (const object of (await (await registry()).compiledScenarioForRun(runId)).initialObjects) record(object)
  for (const event of run.events()) {
    if (event.type === 'object.upserted') record(event.object)
    if (event.type === 'command.issued' && event.command.roleIds !== undefined) {
      const sees = seesForRoleSet(declaration, event.command.roleIds)
      if (sees !== 'all') sideCommands.set(event.command.id, sees)
    }
  }
  for (const object of run.snapshot().objects) record(object)
}

const forbiddenFor = (side: string): ReadonlyArray<string> => [
  ...[...inventory.entries()].flatMap(([id, { label, audience }]) => audienceVisibleTo(audience, [side]) ? [] : [id, label]),
  ...[...sideCommands.entries()].flatMap(([commandId, sees]) => sees.includes(side) ? [] : [commandId]),
]

/** The oracle: no forbidden token in what the screen received since the marks, or in its stores. */
const expectNoLeak = async (screen: Screen, side: string, since: { readonly http?: number; readonly ws?: number } = {}): Promise<void> => {
  await takeInventory()
  const texts = [
    ...screen.http.slice(since.http ?? 0).map(entry => entry.body),
    ...screen.ws.slice(since.ws ?? 0).map(entry => entry.text),
    storeText(screen.stores),
  ]
  const leaks = forbiddenFor(side).filter(token => texts.some(text => text.includes(token)))
  expect({ screen: screen.name, side, leaks }).toEqual({ screen: screen.name, side, leaks: [] })
}

/**
 * A public event every screen receives, after everything committed before it:
 * once a screen has it, nothing earlier is still on the way.
 */
const barrier = async (...waiting: ReadonlyArray<Screen>): Promise<void> => {
  const run = await liveRun()
  await run.setClock({ paused: true })
  const seq = run.snapshot().seq
  for (const screen of waiting) {
    await waitForCondition(`${screen.name} barrier ${seq}`, () => screen.ws.some(entry => entry.type === 'events'
      && (JSON.parse(entry.text) as { events: Array<{ seq: number }> }).events.some(event => event.seq === seq)))
  }
}

const eventsReceived = (screen: Screen, since = 0): ReadonlyArray<{ readonly type: string; readonly objectId?: string; readonly object?: { readonly id: string }; readonly audience?: unknown }> =>
  screen.ws.slice(since).filter(entry => entry.type === 'events').flatMap(entry => (JSON.parse(entry.text) as { events: Array<{ type: string }> }).events)

const command = async (screen: Screen, capabilityId: string, input: unknown) =>
  await asScreen(screen, async () => await invokeSimulationRunCapability(runId, { capabilityId, input }))

let red: Screen
let blue: Screen
let controller: Screen

beforeAll(async () => {
  const created = await createRoleRunWorkspaces(undefined, [definition, sidedRunDefinition(nonce, { sided: false })])
  workspaces = created.workspaces
  dataDir = created.dataDir
  workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  server = createServer({ workspaces, port: 0, bindHost: '127.0.0.1' })
  base = `http://127.0.0.1:${server.port}`
  runId = await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'sided-run' })).id)
  // Nothing moves or fires unless a step asks: the oracle runs on a deterministic script.
  await (await registry()).setExecution(runId, { playback: 'paused' })
  configureActiveWorkspace(workspaceId)
  const globals = globalThis as unknown as Record<string, unknown>
  for (const key of ['fetch', 'WebSocket', 'location', 'window']) savedGlobals[key] = globals[key]
  Object.assign(globals, { fetch: screenFetch, WebSocket: ScreenSocket, location: { protocol: 'http:', host: `127.0.0.1:${server.port}` }, window: globalThis })
})

afterAll(async () => {
  for (const screen of screens) screen.connection.disconnect()
  Object.assign(globalThis as unknown as Record<string, unknown>, savedGlobals)
  await server.stop()
  await rm(dataDir, { recursive: true, force: true })
})

describe('the wire oracle on a sided fixture Run', () => {
  test('Red, Blue and Controller screens join, each with its own picture', async () => {
    red = createScreen('red', ['red-lead'])
    blue = createScreen('blue', ['blue-lead'])
    controller = createScreen('controller', ['control'])
    for (const screen of [red, blue, controller]) await join(screen)
    expect(objectIds(red)).toEqual([names.depot.id, names.redTask.id, names.redUnit.id].sort())
    expect(objectIds(blue)).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    expect(objectIds(controller)).toHaveLength(6)
    // The opening highlights the Red unit for truth views only; its guidance names the public depot for all.
    expect(controller.stores?.scenarioState?.highlightedObjectIds as ReadonlyArray<string> | undefined).toEqual([names.redUnit.id])
    for (const side of [red, blue]) {
      expect(side.stores?.scenarioState?.highlightedObjectIds).toEqual([])
      expect(side.stores?.scenarioState?.guidance?.objectIds as ReadonlyArray<string> | undefined).toEqual([names.depot.id])
      expect(side.stores?.compiledScenario.initialObjects).toEqual([])
    }
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 7: a Pack write without an audience is refused whole and reaches no one, Blue\'s later commands are answered without it, and a public site reaches both sides', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length, blueHttp: blue.http.length }
    const loose = attempt({ type: 'unit', id: `unit:loose-${nonce}`, label: `loose ${nonce}`, position: [10.74, 59.92], speedMps: 10 } as const)
    const job = attempt({ type: 'task', id: `task:loosejob-${nonce}`, label: `loosejob ${nonce}`, position: [10.74, 59.92], priority: 'low', audience: [] } as const)
    const run = await liveRun()
    const faults = () => run.health().find(entry => entry.runtimeId === fixtureRuntimeId)?.failureCount ?? 0
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // The fixture Pack accepts the unit without an audience and keeps it;
      // the Run refuses each emission that writes it, as the Pack's fault.
      expect(await command(controller, fixtureCommandIds.createItem, { item: loose })).toMatchObject({ result: { ok: true } })
      expect(await command(controller, fixtureCommandIds.createItem, { item: job })).toMatchObject({ result: { ok: true } })
      expect(await command(controller, fixtureCommandIds.assign, { unitId: loose.id, taskId: job.id })).toMatchObject({ result: { ok: true } })
      // On the Run's clock the Pack moves the unit it kept: a refused write no
      // caller made, which a later caller's command must not be handed.
      const before = faults()
      await (await registry()).setExecution(runId, { playback: 'playing' })
      await waitForCondition('the Pack writes the refused unit on its own', () => faults() > before)
      await (await registry()).setExecution(runId, { playback: 'paused' })
      // Blue commands over HTTP and over its realtime connection.
      expect(await command(blue, fixtureCommandIds.setPriority, { taskId: names.blueTask.id, priority: 'high' })).toMatchObject({ result: { ok: true } })
      expect(await blue.connection.invokeCapability(runId, { capabilityId: fixtureCommandIds.setPriority, input: { taskId: names.blueTask.id, priority: 'low' } })).toMatchObject({ result: { ok: true } })
      let deleteRefusal: unknown
      try { await blue.connection.invokeCapability(runId, { capabilityId: 'world.object.delete', input: { objectId: names.redUnit.id } }) }
      catch (error) { deleteRefusal = error }
      expect(deleteRefusal).toBeInstanceOf(Error)
      const refusal = blue.ws.slice(marks.blue).find(entry => entry.type === 'capability.error')
      expect(refusal === undefined ? null : (JSON.parse(refusal.text) as { readonly code?: string }).code).toBe('role_controller_only')
      // Blue asks the Pack for a Red object by id: the Pack answers as if it did not exist.
      expect(await asScreen(blue, async () => await querySimulationRunCapability<{ readonly object: unknown }>(runId, fixtureQueryIds.object, { objectId: names.redUnit.id }))).toEqual({ object: null })
    } finally { logged.mockRestore() }
    await barrier(red, blue, controller)
    for (const screen of [red, blue, controller]) expect(objectIds(screen)).not.toContain(loose.id)
    expect(objectIds(controller)).toContain(job.id)
    expect(eventsReceived(red, marks.red).filter(event => event.type === 'object.upserted')).toEqual([])
    expect(eventsReceived(blue, marks.blue).filter(event => event.type === 'object.upserted').map(event => event.object?.id)).toEqual([names.blueTask.id, names.blueTask.id])
    // The fault is the Pack's: on its runtime's health, naming no object, and the Run itself has not failed.
    expect(run.health().find(entry => entry.runtimeId === fixtureRuntimeId)).toMatchObject({ state: 'degraded', lastFailure: { operation: 'emission', message: expect.stringMatching(/^audience_required: /) } })
    expect(JSON.stringify(run.health())).not.toContain(nonce)
    expect(run.health().some(entry => entry.runtimeId === 'world.core')).toBe(false)
    expect(objectIds(red)).toContain(names.depot.id)
    expect(objectIds(blue)).toContain(names.depot.id)
    await expectNoLeak(blue, 'blue', { http: marks.blueHttp, ws: marks.blue })
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
  })

  test('case 1: the Controller creates a Red unit and Blue receives nothing about it', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length }
    const created = await command(controller, fixtureCommandIds.createItem, { item: { type: 'unit', id: `unit:rednew-${nonce}`, label: `rednew ${nonce}`, position: [10.82, 59.95], speedMps: 10, crew: 'alpha', audience: ['red'] } })
    expect(created).toMatchObject({ kind: 'command', result: { ok: true } })
    await barrier(red, blue, controller)
    expect(objectIds(red)).toContain(`unit:rednew-${nonce}`)
    expect(objectIds(controller)).toContain(`unit:rednew-${nonce}`)
    // Blue's only message since is the barrier itself.
    expect(blue.ws.slice(marks.blue).map(entry => entry.type)).toEqual(['events'])
    expect(eventsReceived(blue, marks.blue).map(event => event.type)).toEqual(['clock.updated'])
    expect(eventsReceived(red, marks.red).map(event => event.type)).toEqual(['object.upserted', 'clock.updated'])
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
  })

  test('a side commands within its picture and is answered without naming what it cannot see', async () => {
    const assigned = await command(red, fixtureCommandIds.assign, { unitId: names.redUnit.id, taskId: names.redTask.id })
    expect(assigned).toMatchObject({ kind: 'command', result: { ok: true } })
    const refused = await command(red, fixtureCommandIds.assign, { unitId: names.blueUnit.id, taskId: names.redTask.id })
    expect(refused.kind === 'command' && !refused.result.ok ? refused.result.reason : null).toMatch(/^not_in_picture: /)
    // An id taken by another side's object, or a place on one, is refused as not in the picture, never as taken.
    for (const item of [
      { type: 'unit', id: names.redUnit.id, label: `copy ${nonce}`, position: [10.70, 59.91], speedMps: 10, audience: ['blue'] },
      attempt({ type: 'unit', id: `unit:bluenear-${nonce}`, label: `bluenear ${nonce}`, atObject: names.redTask.id, speedMps: 10, audience: ['blue'] }),
    ]) {
      const taken = await command(blue, fixtureCommandIds.createItem, { item })
      expect(taken.kind === 'command' && !taken.result.ok ? taken.result.reason : null).toMatch(/^not_in_picture: /)
    }
    const state = await asScreen(blue, async () => await querySimulationRunCapability<{ units: Array<{ id: string }>; tasks: Array<{ id: string }>; sites: Array<{ id: string }> }>(runId, fixtureQueryIds.state, {}))
    expect([...state.units, ...state.tasks, ...state.sites].map(object => object.id).sort()).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    await barrier(red, blue)
    expect(red.stores?.objects.find(object => object.id === names.redUnit.id)?.operational.status).toBe('en_route')
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 2: the Scenario timeline creates one unit per side and each reaches only its own side', async () => {
    const reg = await registry()
    await reg.advanceExecution(runId, { minutes: 1 })
    await waitForCondition('both cued units', () => objectIds(controller).includes(names.redCued.id) && objectIds(controller).includes(names.blueCued.id))
    await waitForCondition('maximum pace finished', () => reg.leaseSummary(runId).leasesByKind['maximum-pace'] === 0)
    await barrier(red, blue, controller)
    expect(objectIds(red)).toContain(names.redCued.id)
    expect(objectIds(red)).not.toContain(names.blueCued.id)
    expect(objectIds(blue)).toContain(names.blueCued.id)
    expect(objectIds(blue)).not.toContain(names.redCued.id)
    // The Red unit moved during the advance; only Red and the Controller saw it.
    expect(red.stores?.objects.find(object => object.id === names.redUnit.id)?.spatial.position?.point.coordinates).not.toEqual([10.80, 59.95])
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 8: side sockets get only side-visible event types, deletions by their audience, and no runtime messages', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length }
    for (const objectId of [names.hidden.id, names.redCued.id]) {
      expect(await command(controller, 'world.object.delete', { objectId })).toMatchObject({ result: { ok: true } })
    }
    expect(await command(controller, fixtureCommandIds.announce, { text: `announcement ${nonce}` })).toMatchObject({ result: { ok: true } })
    await waitForCondition('the Controller hears the announcement', () => controller.realtime.includes(fixtureAnnouncementType))
    await barrier(red, blue, controller)
    expect(objectIds(red)).not.toContain(names.redCued.id)
    expect(eventsReceived(red, marks.red).filter(event => event.type === 'object.deleted')).toEqual([expect.objectContaining({ objectId: names.redCued.id, audience: ['red'] })])
    expect(eventsReceived(blue, marks.blue).filter(event => event.type === 'object.deleted')).toEqual([])
    for (const side of [red, blue]) {
      expect(side.realtime).toEqual([])
      expect(side.ws.some(entry => entry.type === 'runtime.realtime')).toBe(false)
      const types = new Set(eventsReceived(side).map(event => event.type))
      expect([...types].filter(type => !sideVisibleEventTypes.has(type))).toEqual([])
    }
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 3: the Controller switches to Blue in place, no store keeps a Red truth id, and nothing of the old epoch applies', async () => {
    expect(storeText(controller.stores)).toContain(names.redUnit.id)
    // An earlier truth batch naming a Red object, to replay late.
    const late = controller.ws.find(entry => entry.type === 'events' && entry.epoch === 1 && entry.text.includes(`unit:rednew-${nonce}`))
    if (!late) throw new Error('expected a truth batch naming the new Red unit')
    const marks = { http: controller.http.length, applied: controller.applied.length }
    controller.connection.setRoles(runId, ['blue-lead'])
    await waitForCondition('the Controller screen adopts epoch 2', () => controller.epoch === 2)
    const readyIndex = controller.ws.findIndex(entry => entry.type === 'realtime.ready' && entry.epoch === 2)
    expect(controller.roleIds).toEqual(['blue-lead'])
    expect(objectIds(controller)).toEqual(objectIds(blue))
    expect(controller.stores?.scenarioState?.highlightedObjectIds).toEqual([])
    expect(controller.stores?.compiledScenario.initialObjects).toEqual([])
    // A late message of the old epoch is dropped at the gate.
    const socket = controller.socket!
    const appliedBefore = controller.applied.length
    socket.onmessage?.call(socket, new MessageEvent('message', { data: late.text }))
    expect(controller.applied).toHaveLength(appliedBefore)
    await barrier(controller)
    const sinceReady = controller.applied.slice(controller.applied.findIndex((entry, index) => index >= marks.applied && entry.kind === 'ready' && entry.epoch === 2))
    expect(sinceReady.length).toBeGreaterThan(1)
    expect(sinceReady.map(entry => entry.epoch)).toEqual(sinceReady.map(() => 2))
    await expectNoLeak(controller, 'blue', { http: marks.http, ws: readyIndex })
    // A Definition with roles may not restrict AI.
    const restricted = scenarioDefinitionSchema.safeParse({ ...definition, agentRestrictions: { operationIds: [fixtureCommandIds.assign] } })
    expect(restricted.success ? null : restricted.error.issues.map(issue => (issue as { readonly params?: { readonly code?: string } }).params?.code)).toContain('agent_restrictions_in_role_run')
  })

  test('case 9: every request this script\'s side screens made reached an allow-listed route with their role set, other routes refuse a side view, and after a reset a side screen re-joins through the Run read', async () => {
    const director = createScreen('director', ['control'])
    await join(director)
    const readies = blue.applied.filter(entry => entry.kind === 'ready').length
    await asScreen(director, async () => { await resetSimulationRun(runId) })
    await (await liveRun()).setClock({ paused: true })
    await waitForCondition('Blue adopts the reset Run', () => blue.applied.filter(entry => entry.kind === 'ready').length > readies)
    expect(objectIds(blue)).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    // A screen re-joining reads the Run, never the Scenario fetch.
    const reread = await readRun(blue)
    expect(reread.snapshot.objects.map(object => String(object.id)).sort()).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    // This proves the requests the client modules made for the steps scripted
    // here, not every request a full World screen could make.
    const runPath = `/api/workspaces/${workspaceId}/world/simulation-runs/${runId}`
    const allowed = (screen: Screen) => new RegExp(`^${runPath.replaceAll('.', '\\.')}(/snapshot|/presence|/capabilities/world\\.fixture\\.[a-z.-]+/invoke)?\\?roles=${encodeURIComponent(screen.roleIds.join(','))}$`)
    for (const screen of [red, blue]) {
      expect(screen.http.map(entry => entry.url).filter(url => !allowed(screen).test(url))).toEqual([])
      expect(screen.http.some(entry => entry.url.includes('/scenarios/'))).toBe(false)
    }
    // The routes a side view never reaches, asked directly.
    const probe = async (suffix: string, init?: RequestInit) => {
      const separator = suffix.includes('?') ? '&' : '?'
      const response = await originalFetch(`${base}${suffix.startsWith('/scenarios') ? `/api/workspaces/${workspaceId}/world` : runPath}${suffix}${separator}roles=blue-lead`, init)
      return { suffix, status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code }
    }
    for (const [suffix, init] of [
      ['/events', undefined], ['/objects', undefined], ['/history', undefined], ['/procedures', undefined], ['/procedure-runs', undefined],
      ['/signals', { method: 'POST', body: JSON.stringify({ type: 'note', payload: {} }) }], ['/reset', { method: 'POST' }],
      ['/copies', { method: 'POST', body: '{}' }], ['/scenarios/sided-run', undefined],
    ] as const) expect(await probe(suffix, init)).toEqual({ suffix, status: 403, code: 'role_view_not_supported' })
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
    for (const screen of screens) expect({ screen: screen.name, errors: screen.errors }).toEqual({ screen: screen.name, errors: [] })
  })
})

describe('a Run without sides on the WebSocket', () => {
  test('sends every role set the whole ready, every event and every runtime message, as before', async () => {
    const unsidedId = await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'unsided-run' })).id)
    const socket = new NativeWebSocket(`ws://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/world/ws?simulationRun=${unsidedId}&roles=red-lead`)
    const received: Array<{ readonly type: string; readonly [key: string]: unknown }> = []
    socket.onmessage = event => { received.push(JSON.parse(String(event.data)) as { readonly type: string }) }
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('WebSocket failed')) })
      await waitForCondition('unsided ready', () => received.some(message => message.type === 'realtime.ready'))
      const ready = received.find(message => message.type === 'realtime.ready') as unknown as { snapshot: { objects: unknown[]; scenario: Record<string, unknown> }; compiledScenario: { initialObjects: unknown[]; timeline?: unknown } }
      expect(ready.snapshot.objects).toHaveLength(6)
      expect(ready.snapshot.scenario.highlightedObjectIds).toEqual([`unit:redunit-${nonce}`])
      expect(ready.compiledScenario.initialObjects).toHaveLength(6)
      expect(ready.compiledScenario.timeline).toBeDefined()
      socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'loose', capabilityId: fixtureCommandIds.createItem, invocation: { input: { item: { type: 'unit', id: `unit:unsided-${nonce}`, label: `unsided ${nonce}`, position: [10.74, 59.92], speedMps: 10 } } } }))
      socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'announce', capabilityId: fixtureCommandIds.announce, invocation: { input: { text: 'all hear this' } } }))
      await waitForCondition('unsided runtime message', () => received.some(message => message.type === 'runtime.realtime'))
      expect(received.find(message => message.requestId === 'loose')).toMatchObject({ type: 'capability.result', outcome: { result: { ok: true } } })
      const types = received.filter(message => message.type === 'events').flatMap(message => (message.events as Array<{ type: string }>).map(event => event.type))
      expect(types).toEqual(expect.arrayContaining(['command.issued', 'object.upserted', 'command.result']))
    } finally { socket.close() }
  })
})

describe('the wire oracle itself', () => {
  test('flags an id or label outside a side\'s audience wherever it appears', async () => {
    await takeInventory()
    expect(forbiddenFor('blue')).toEqual(expect.arrayContaining([names.redUnit.id, names.redUnit.label, names.hidden.id]))
    expect(forbiddenFor('blue')).not.toContain(names.depot.id)
    expect(forbiddenFor('red')).toEqual(expect.arrayContaining([names.blueCued.id, names.blueCued.label]))
    const planted: Screen = { ...createScreen('planted', ['blue-lead']), ws: [{ text: JSON.stringify({ type: 'events', events: [{ type: 'object.deleted', objectId: names.redTask.id }] }), type: 'events' }] }
    const leaks = forbiddenFor('blue').filter(token => [...planted.ws.map(entry => entry.text), storeText(planted.stores)].some(text => text.includes(token)))
    expect(leaks).toEqual([names.redTask.id])
  })
})
