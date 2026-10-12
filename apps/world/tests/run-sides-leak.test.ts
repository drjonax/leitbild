// The wire oracle: Red, Blue and Controller screens, each driven by the real
// World client modules, play one scripted sided Run over a real server: the
// fixture Pack's objects and Einsatz units, tasks and a public site side by
// side. Every id and label carries a per-run nonce. After each step the
// oracle deep-scans every HTTP body and WebSocket message a side screen
// received, and every store it built, for any id or label of an object
// outside that side's audience and for any command id another side issued.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createServer } from '../src/core/api/server.ts'
import {
  audienceVisibleTo,
  roleClassForRoleSet,
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
import { createBoardController } from '../src/packs/einsatz/board/controller.ts'
import { einsatzCommandIds, einsatzQueryIds } from '../src/packs/einsatz/capabilities.ts'
import { configurationOutputSchema } from '../src/packs/einsatz/config-schema.ts'
import type { Recommendation } from '../src/packs/einsatz/recommendation-schema.ts'
import { roeWords } from '../src/packs/einsatz/lexicon.ts'
import { createEinsatzSidedRuntimeAdapter, einsatzCrossSideCue, einsatzSidedCombat, einsatzSidedNames, einsatzSidedSelection } from '../src/packs/einsatz/fixtures/sided-run.ts'
import { einsatzPack } from '../src/packs/einsatz/pack.ts'
import { fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { fixtureAnnouncementType, fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import { createRoleRunWorkspaces, roleAwareFixturePack, sidedNames, sidedRoles, sidedRunDefinition, sides } from './fixtures/role-runs.ts'
import { waitForCondition } from './helpers.ts'

const nonce = crypto.randomUUID().slice(0, 8)
const names = sidedNames(nonce)
/** Einsatz plays Blue as its first side: Red's carrier, tagged like Blue's, lies nearer Blue's task. */
const einsatz = (() => {
  const named = einsatzSidedNames(nonce)
  return { blueCarrier: named.firstCarrier, redCarrier: named.secondCarrier, blueTask: named.firstTask, redTask: named.secondTask, site: named.site }
})()
const fixtureDefinition = sidedRunDefinition(nonce)
const definition = {
  ...fixtureDefinition,
  packs: [...fixtureDefinition.packs, einsatzSidedSelection(nonce, { side: 'blue', role: 'blue-lead' }, { side: 'red', role: 'red-lead' })],
  timeline: { cues: [...fixtureDefinition.timeline.cues, einsatzCrossSideCue(nonce)] },
}
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

/** The ids of one Pack's objects a screen holds: the fixture Pack's unless named. */
const objectIds = (screen: Screen, packId = 'fixture'): ReadonlyArray<string> =>
  (screen.stores?.objects ?? []).filter(object => object.packId === packId).map(object => object.id).sort()
const einsatzIds = (screen: Screen): ReadonlyArray<string> => objectIds(screen, 'einsatz')

/** Whom the Einsatz objects a screen holds name as giving their last order. */
const attributions = (screen: Screen): ReadonlyArray<string> => [...new Set((screen.stores?.objects ?? [])
  .filter(object => object.packId === 'einsatz')
  .flatMap(object => {
    const by = (object.packData as { readonly lastAction?: { readonly by?: unknown } } | undefined)?.lastAction?.by
    return typeof by === 'string' ? [by] : []
  }))].sort()

/** Everything a store holds, Maps included, as text to search. */
const storeText = (stores: RunScopedStores | null): string =>
  JSON.stringify(stores, (_key, value: unknown) => value instanceof Map ? [...value.entries()] : value)

/** An Einsatz object's record type, or undefined for any other object. */
const einsatzType = (object: { readonly packId: string; readonly packData?: unknown }): unknown =>
  object.packId === 'einsatz' ? (object.packData as { readonly type?: unknown } | undefined)?.type : undefined

/**
 * Every object the Run has held, with its audience: initial ones, every
 * upsert journaled or projected since, and every object the script asked for,
 * so an id the Run refused is still watched for. A track's label is its own
 * side's serial, which every side numbers alike ("T-1"), so only its id names
 * it; every other label is watched like its id.
 */
const inventory = new Map<string, { readonly label: string | null; readonly audience: ObjectAudience | undefined }>()
const attempt = <T extends { readonly id: string; readonly label: string; readonly audience?: ObjectAudience }>(item: T): T => {
  inventory.set(item.id, { label: item.label, audience: item.audience })
  return item
}
/** Every command a side role issued, by the sides it sees. */
const sideCommands = new Map<string, ReadonlyArray<string>>()
const takeInventory = async (): Promise<void> => {
  const run = await liveRun()
  const record = (object: OperationalObject) => { inventory.set(object.id, { label: einsatzType(object) === 'track' ? null : object.label, audience: object.audience }) }
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
  ...[...inventory.entries()].flatMap(([id, { label, audience }]) => audienceVisibleTo(audience, [side]) ? [] : label === null ? [id] : [id, label]),
  ...[...sideCommands.entries()].flatMap(([commandId, sees]) => sees.includes(side) ? [] : [commandId]),
]

/** The oracle: no forbidden token in what the screen received since the marks, in its stores, or in what else it built from them. */
const expectNoLeak = async (screen: Screen, side: string, since: { readonly http?: number; readonly ws?: number } = {}, built: ReadonlyArray<string> = []): Promise<void> => {
  await takeInventory()
  const texts = [
    ...screen.http.slice(since.http ?? 0).map(entry => entry.body),
    ...screen.ws.slice(since.ws ?? 0).map(entry => entry.text),
    storeText(screen.stores),
    ...built,
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
const refusalOf = (outcome: Awaited<ReturnType<typeof command>>): string | null => outcome.kind === 'command' && !outcome.result.ok ? outcome.result.reason : null

const recommendAs = async (screen: Screen, taskId: string): Promise<Recommendation> =>
  await asScreen(screen, async () => await querySimulationRunCapability<Recommendation>(runId, einsatzQueryIds.recommend, { taskId }))
/** What a screen held at one moment: its objects and the Run time. */
interface Shown {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly currentTime: NonNullable<RunScopedStores['clock']>['currentTime']
}

const shownOn = (screen: Screen): Shown => {
  const stores = screen.stores
  const currentTime = stores?.clock?.currentTime
  if (stores === null || currentTime === undefined) throw new Error(`${screen.name} holds no Run to show on a Board`)
  return { objects: stores.objects, currentTime }
}

/**
 * What the Einsatz Board would hold on a screen: a controller for its role
 * set, fed what the screen held earlier, when given, then what it holds now,
 * with the recommendations each snapshot asks for, answered as that screen.
 * Two snapshots make the event log compare two record sets. Its whole
 * state, as text to search.
 */
const boardText = async (screen: Screen, earlier?: Shown): Promise<string> => {
  const now = shownOn(screen)
  const configuration = configurationOutputSchema.parse(await asScreen(screen, async () => await querySimulationRunCapability<unknown>(runId, einsatzQueryIds.configuration, {}))).config
  const board = createBoardController({
    config: configuration,
    viewer: { class: roleClassForRoleSet(declaration, screen.roleIds), sees: seesForRoleSet(declaration, screen.roleIds), roles: declaration.roles.filter(role => screen.roleIds.includes(role.id)) },
    sides: declaration.sides ?? [],
  })
  const show = async (shown: Shown): Promise<void> => {
    const asked = board.dispatch({ kind: 'snapshot', objects: shown.objects, currentTime: shown.currentTime, wallMs: 0 })
    for (const effect of asked) {
      if (effect.kind !== 'recommend') continue
      // An earlier snapshot's task may have closed since; the panel reports a failed query as such.
      let answer: unknown
      try {
        answer = await asScreen(screen, async () => await querySimulationRunCapability<unknown>(runId, einsatzQueryIds.recommend, { taskId: effect.taskId }))
      } catch (error) {
        if (shown === now) throw error
        board.dispatch({ kind: 'recommendation-failed', taskId: effect.taskId, key: effect.key, reason: error instanceof Error ? error.message : String(error), wallMs: 0 })
        continue
      }
      board.dispatch({ kind: 'recommendation', taskId: effect.taskId, key: effect.key, answer, wallMs: 0 })
    }
  }
  if (earlier !== undefined) await show(earlier)
  await show(now)
  return JSON.stringify(board.view())
}

/** Every unit a recommendation names: proposed, alternatives, ineligible and busy. */
const recommended = (recommendation: Recommendation): ReadonlyArray<string> => [
  ...recommendation.proposal.units, ...recommendation.alternatives, ...recommendation.ineligible, ...recommendation.committed,
].map(entry => entry.unitId).sort()

let red: Screen
let blue: Screen
let controller: Screen

beforeAll(async () => {
  const created = await createRoleRunWorkspaces([roleAwareFixturePack, einsatzPack], [definition, sidedRunDefinition(nonce, { sided: false })], [createEinsatzSidedRuntimeAdapter()])
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
    expect(einsatzIds(red)).toEqual([einsatz.redCarrier.id, einsatz.redTask.id, einsatz.site.id].sort())
    expect(einsatzIds(blue)).toEqual([einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    expect(einsatzIds(controller)).toHaveLength(5)
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

  test('case 5: a Red unit tagged like Blue\'s is absent from Blue\'s recommendation, a Blue send naming it is refused as not in the picture, and only a truth view sets the public site, which both sides then see', async () => {
    const marks = { http: blue.http.length, ws: blue.ws.length }
    const asBlue = await recommendAs(blue, einsatz.blueTask.id)
    expect(asBlue.proposal.units.map(entry => entry.unitId)).toEqual([einsatz.blueCarrier.id])
    expect(recommended(asBlue)).toEqual([einsatz.blueCarrier.id])
    expect(recommended(await recommendAs(red, einsatz.redTask.id))).toEqual([einsatz.redCarrier.id])
    const send = { units: [einsatz.redCarrier.id], to: { taskId: einsatz.blueTask.id } }
    expect(refusalOf(await command(blue, einsatzCommandIds.send, send))).toBe('not_in_picture: Not in your picture')
    expect(await blue.connection.invokeCapability(runId, { capabilityId: einsatzCommandIds.send, input: send })).toMatchObject({ result: { ok: false, reason: 'not_in_picture: Not in your picture' } })
    // A side role commands no public unit: Blue's command on the public site is refused within Blue's picture.
    const refused = await command(blue, einsatzCommandIds.siteSet, { siteId: einsatz.site.id, accepting: false })
    if (refused.kind !== 'command' || refused.result.ok) throw new Error(`Expected Blue's command on the public site to be refused: ${JSON.stringify(refused)}`)
    expect(refused.result.reason).toBe(`unit_not_authorized: Blue lead does not command ${einsatz.site.label}, and no operator role does`)
    // The Controller closes and reopens it, and each side sees each change.
    for (const accepting of [false, true]) {
      const outcome = await command(controller, einsatzCommandIds.siteSet, { siteId: einsatz.site.id, accepting })
      if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`The Controller could not set the public site: ${JSON.stringify(outcome)}`)
      await barrier(red, blue, controller)
      for (const side of [red, blue]) {
        expect(side.stores?.objects.find(object => object.id === einsatz.site.id)?.packData).toMatchObject({ accepting, lastAction: { verb: 'set', by: 'Controller' } })
      }
    }
    // No Einsatz object a side holds names the other side's role as the one that gave its last order.
    for (const side of [red, blue]) expect(attributions(side)).toContain('Controller')
    expect(attributions(red).filter(by => by.includes('Blue lead'))).toEqual([])
    expect(attributions(blue).filter(by => by.includes('Red lead'))).toEqual([])
    await expectNoLeak(blue, 'blue', marks)
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
    // The oracle watched Red's screen for Blue's refused command.
    expect(sideCommands.get(refused.result.commandId)).toEqual(['blue'])
  })

  test('case 6: the Controller\'s recommendation for a Blue task lists no Red unit, and cross-side sends by the Controller or a cue are refused', async () => {
    expect(recommended(await recommendAs(controller, einsatz.blueTask.id))).toEqual([einsatz.blueCarrier.id])
    const send = { units: [einsatz.redCarrier.id], to: { taskId: einsatz.blueTask.id } }
    expect(refusalOf(await command(controller, einsatzCommandIds.send, send))).toBe(`cross_side_reference: ${einsatz.redCarrier.label} cannot serve another side's ${einsatz.blueTask.label}`)
    // The cue a minute in, fired by case 2's advance, was refused alike, and only truth views heard of it.
    const events = (await liveRun()).events()
    const cued = events.find(event => event.type === 'command.issued' && event.command.kind === einsatzCommandIds.send && event.command.roleIds === undefined)
    if (cued?.type !== 'command.issued') throw new Error('expected the cross-side cue to issue its send')
    expect(cued.command.payload).toEqual(send)
    const result = events.find(event => event.type === 'command.result' && event.result.commandId === cued.command.id)
    expect(result?.type === 'command.result' && !result.result.ok ? result.result.reason : null).toMatch(/^cross_side_reference: /)
    await barrier(red, blue, controller)
    expect(red.stores?.objects.find(object => object.id === einsatz.redCarrier.id)?.packData).toMatchObject({ phase: 'available' })
    expect(controller.stores?.objects.find(object => object.id === einsatz.blueTask.id)?.packData).toMatchObject({ coverage: { loads: [expect.objectContaining({ covered: 0 })] } })
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('cases 2 and 4 on Einsatz: in a fight, a Blue step-loss task and Red\'s orders reach only their own side, and every track a side receives is whitelisted', async () => {
    const combat = einsatzSidedCombat(nonce, { side: 'blue', role: 'blue-lead' }, { side: 'red', role: 'red-lead' })
    const named = einsatzSidedNames(nonce)
    const marks = { red: red.ws.length, blue: blue.ws.length }
    for (const input of [combat.scout, combat.nearGun, combat.farGun]) {
      const outcome = await command(controller, einsatzCommandIds.unitCreate, input)
      if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`The Controller could not create ${input.label}: ${JSON.stringify(outcome)}`)
    }
    await barrier(red, blue, controller)
    const idOf = (label: string): string => {
      const found = controller.stores?.objects.find(object => object.label === label)
      if (found === undefined) throw new Error(`The Controller holds no ${label}`)
      return found.id
    }
    const scout = idOf(named.scout.label)
    const farGun = idOf(named.farGun.label)
    // Each side gives its carrier a job chain: a long move, then its own task queued behind it, so steps naming each side's ids ride through the fight.
    const away = { type: 'Point', coordinates: [10.40, 59.91] }
    for (const [screen, carrier, task] of [[red, einsatz.redCarrier.id, einsatz.redTask.id], [blue, einsatz.blueCarrier.id, einsatz.blueTask.id]] as const) {
      for (const [capabilityId, input] of [[einsatzCommandIds.send, { units: [carrier], to: { point: away } }], [einsatzCommandIds.queue, { unitId: carrier, to: { taskId: task } }]] as const) {
        const outcome = await command(screen, capabilityId, input)
        if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`${screen.name} could not chain ${carrier}: ${JSON.stringify(outcome)}`)
      }
    }
    const before = { red: shownOn(red), blue: shownOn(blue) }
    // Red orders its far shooter to hold fire: a side's order, which only Red and truth views hear of.
    const held = await command(red, einsatzCommandIds.setRoe, { unitId: farGun, roe: 'hold' })
    if (held.kind !== 'command' || !held.result.ok) throw new Error(`Red could not order its shooter: ${JSON.stringify(held)}`)
    const reg = await registry()
    await reg.advanceExecution(runId, { minutes: 2 })
    await waitForCondition('maximum pace finished', () => reg.leaseSummary(runId).leasesByKind['maximum-pace'] === 0)
    await barrier(red, blue, controller)

    // Case 2: the scout's step-loss tasks are Blue's alone; Red's order shows on Red's shooter only.
    const lossTasks = (screen: Screen) => einsatzIds(screen).filter(id => id.startsWith(`${scout}:loss-`))
    expect(lossTasks(blue).length).toBeGreaterThan(0)
    expect(lossTasks(controller)).toEqual(lossTasks(blue))
    expect(lossTasks(red)).toEqual([])
    expect(red.stores?.objects.find(object => object.id === farGun)?.packData).toMatchObject({ roe: 'hold', lastAction: { by: 'Red lead' } })
    expect(einsatzIds(blue)).not.toContain(farGun)
    // Each side's Board, fed what its screen held before Red's order and what it holds now, shows the step-loss work to Blue alone and Red's order in Red's log alone.
    const boards = { red: await boardText(red, before.red), blue: await boardText(blue, before.blue) }
    expect(lossTasks(blue).every(id => boards.blue.includes(id))).toBe(true)
    const logOf = (board: string): ReadonlyArray<string> => (JSON.parse(board) as { readonly log: ReadonlyArray<{ readonly recordId: string; readonly text: string }> }).log.filter(entry => entry.recordId === farGun).map(entry => entry.text)
    expect(logOf(boards.red)).toContain(`${named.farGun.label}: set · ${roeWords.hold}`)
    expect(logOf(boards.blue)).toEqual([])
    // Each side's carrier holds its queued step on its side's screen alone.
    const queuedTask = (screen: Screen, carrier: string) => (screen.stores?.objects.find(object => object.id === carrier)?.packData as { readonly orders?: ReadonlyArray<{ readonly target: unknown; readonly state: string }> } | undefined)?.orders?.find(step => step.state === 'queued')?.target
    expect(queuedTask(red, einsatz.redCarrier.id)).toEqual({ taskId: einsatz.redTask.id })
    expect(queuedTask(blue, einsatz.blueCarrier.id)).toEqual({ taskId: einsatz.blueTask.id })
    await expectNoLeak(red, 'red', {}, [boards.red])
    await expectNoLeak(blue, 'blue', {}, [boards.blue])
    expect(sideCommands.get(held.result.commandId)).toEqual(['red'])

    // Case 4: every track a side screen received, and every one it holds, carries its observation and nothing more.
    const tracksOf = (screen: Screen, since: number): ReadonlyArray<OperationalObject> => [
      ...eventsReceived(screen, since).flatMap(event => event.type === 'object.upserted' && event.object !== undefined ? [event.object as OperationalObject] : []),
      ...(screen.stores?.objects ?? []),
    ].filter(object => einsatzType(object) === 'track')
    const tiers = new Set<string>()
    for (const [screen, side, since] of [[blue, 'blue', marks.blue], [red, 'red', marks.red]] as const) {
      const received = tracksOf(screen, since)
      expect(received.length).toBeGreaterThan(0)
      for (const track of received) {
        const data = track.packData as { readonly tier: string; readonly identity?: unknown }
        tiers.add(`${side}:${data.tier}`)
        expect({ id: track.id, audience: track.audience, provenance: track.provenance, alerts: track.alerts }).toEqual({ id: track.id, audience: [side], provenance: { source: 'simulator' }, alerts: [] })
        expect([track.id, Object.keys(track.spatial).sort(), Object.keys(track.spatial.position ?? {}).sort()]).toEqual([track.id, ['frame', 'position'], ['observedAt', 'point']])
        expect([track.id, ['tasking', 'telemetry', 'context'].filter(key => key in track)]).toEqual([track.id, []])
        expect([track.id, Object.keys(track.packData as object).filter(key => !['type', 'tier', 'fix', 'identity'].includes(key))]).toEqual([track.id, []])
        // A contact names no type, side or colour of what it follows.
        if (data.tier === 'contact') expect([track.id, data.identity, JSON.stringify(track).includes(side === 'blue' ? '"red"' : '"blue"')]).toEqual([track.id, undefined, false])
      }
      // The per-side index of which unit each track follows reaches no side screen.
      expect((screen.stores?.objects ?? []).filter(object => einsatzType(object) === 'track-index')).toEqual([])
    }
    // Blue's scout held the far shooter as a contact and the near one identified; Red watched its kill of the scout.
    expect([...tiers].sort()).toEqual(expect.arrayContaining(['blue:contact', 'blue:identified', 'red:destroyed']))
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
    expect(einsatzIds(controller)).toEqual(einsatzIds(blue))
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
    expect(einsatzIds(blue)).toEqual([einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    // A screen re-joining reads the Run, never the Scenario fetch.
    const reread = await readRun(blue)
    expect(reread.snapshot.objects.map(object => String(object.id)).sort()).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id, einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    // This proves the requests the client modules made for the steps scripted
    // here, not every request a full World screen could make.
    const runPath = `/api/workspaces/${workspaceId}/world/simulation-runs/${runId}`
    const allowed = (screen: Screen) => new RegExp(`^${runPath.replaceAll('.', '\\.')}(/snapshot|/presence|/capabilities/world\\.(fixture|einsatz)\\.[a-z.-]+/invoke)?\\?roles=${encodeURIComponent(screen.roleIds.join(','))}$`)
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
