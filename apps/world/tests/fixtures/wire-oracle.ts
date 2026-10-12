// The wire oracle's harness: side and Controller screens, each driven by
// the real World client modules against a real World server, with every HTTP
// body and WebSocket message they receive recorded, and the oracle that scans
// those and every store a screen built for any id or label of an object
// outside a side's audience and any command id another side issued. A test
// file opens one harness on its own Workspace and Run and closes it after.
// Test-only: production code never imports this file.
import { expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createServer } from '../../src/core/api/server.ts'
import {
  audienceVisibleTo,
  roleClassForRoleSet,
  seesForRoleSet,
  type ObjectAudience,
  type OperationalObject,
  type RunRoles,
  type SimulationRunId,
} from '../../src/core/model/index.ts'
import type { WorldPack } from '../../src/core/packs/protocol.ts'
import type { SimulationRunRegistry } from '../../src/core/simulation-runs/registry.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../../src/core/workspaces/runtime-registry.ts'
import type { PackRuntimeAdapter } from '../../src/simulation/protocol.ts'
import { createRealtimeConnectionController, type RealtimeConnectionController } from '../../src/ui/app/realtime-connection.ts'
import { startupScenarioSource } from '../../src/ui/app/startup-scenario.ts'
import { emptyCommandFeedback } from '../../src/ui/command-feedback.ts'
import { storesForPerspective, type RunScopedStores } from '../../src/ui/roles/perspective.ts'
import { configureActiveRoleSet } from '../../src/ui/roles/role-session.ts'
import {
  invokeSimulationRunCapability,
  joinSimulationRun,
  querySimulationRunCapability,
} from '../../src/ui/simulation-run-client.ts'
import { applySimulationRunEventBatchMessage } from '../../src/ui/simulation-run-events.ts'
import { configureActiveWorkspace } from '../../src/ui/workspace-context.ts'
import { createBoardController } from '../../src/packs/einsatz/board/controller.ts'
import { einsatzQueryIds } from '../../src/packs/einsatz/capabilities.ts'
import { configurationOutputSchema } from '../../src/packs/einsatz/config-schema.ts'
import type { Recommendation } from '../../src/packs/einsatz/recommendation-schema.ts'
import { createRoleRunWorkspaces } from './role-runs.ts'
import { waitForCondition } from '../helpers.ts'

/** Event types a side socket may receive at all. */
export const sideVisibleEventTypes = new Set(['object.upserted', 'object.deleted', 'telemetry.sampled', 'clock.updated', 'simulationRun.reset', 'scenario.guidance.shown', 'scenario.guidance.hidden'])

export interface Screen {
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

/** What a screen held at one moment: its objects and the Run time. */
export interface Shown {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly currentTime: NonNullable<RunScopedStores['clock']>['currentTime']
}

/** The Workspace, server and Run a harness opened. */
interface Opened {
  readonly workspaces: WorldWorkspaceRuntimeRegistry
  readonly dataDir: string
  readonly workspaceId: WorkspaceId
  readonly server: ReturnType<typeof createServer>
  readonly base: string
  readonly runId: SimulationRunId
}

/** What a harness opens: the Packs and Definitions its Workspace compiles, the runtimes they run on, and the Scenario its Run starts from. */
export interface WireOracleSetup {
  readonly packs: ReadonlyArray<WorldPack>
  readonly definitions: ReadonlyArray<unknown>
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioId: string
}

/** A wire oracle for one Run declaring these roles and sides. */
export const createWireOracle = (declaration: RunRoles) => {
  let current: Opened | null = null
  const opened = (): Opened => {
    if (current === null) throw new Error('The wire oracle has no Run open')
    return current
  }
  const originalFetch = globalThis.fetch
  const nativeWebSocket = globalThis.WebSocket
  const screens: Screen[] = []
  const savedGlobals: Record<string, unknown> = {}
  let activeScreen: Screen | null = null
  let constructing: Screen | null = null

  const registry = async (): Promise<SimulationRunRegistry> => await opened().workspaces.withRuntime(opened().workspaceId, async runtime => runtime.simulationRuns)
  const liveRun = async () => {
    const run = (await registry()).get(opened().runId)
    if (!run) throw new Error('the oracle\'s Run is not loaded')
    return run
  }

  /** The client modules' fetch: relative paths reach the test server; each answer is recorded for the screen that asked. */
  const screenFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const screen = activeScreen
    if (screen === null) throw new Error(`A client module fetched outside a screen: ${String(input)}`)
    const path = String(input)
    const response = await originalFetch(path.startsWith('/') ? `${opened().base}${path}` : path, init)
    const body = await response.text()
    screen.http.push({ method: init?.method ?? 'GET', url: path, status: response.status, body })
    return new Response(body, { status: response.status, headers: response.headers })
  }) as typeof fetch

  class ScreenSocket extends nativeWebSocket {
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
    const response = await joinSimulationRun(opened().runId)
    expect(startupScenarioSource(response, null, true).kind).toBe('run-read')
    return response
  })

  /** Joins as a World screen does: the Run read, then the realtime channel and its first ready. */
  const join = async (screen: Screen): Promise<void> => {
    await readRun(screen)
    constructing = screen
    try {
      screen.connection.connect(opened().runId, {
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
    for (const object of (await (await registry()).compiledScenarioForRun(opened().runId)).initialObjects) record(object)
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

  /**
   * Whether a text holds a token as a whole: not as the start of a longer id,
   * so a forbidden "task:1" is found in "task:1" but not in the engine's next
   * id "task:12".
   */
  const holds = (text: string, token: string): boolean => {
    for (let index = text.indexOf(token); index !== -1; index = text.indexOf(token, index + 1)) {
      if (!/[\w:-]/.test(text.charAt(index + token.length))) return true
    }
    return false
  }

  /** The oracle: no forbidden token in what the screen received since the marks, in its stores, or in what else it built from them. */
  const expectNoLeak = async (screen: Screen, side: string, since: { readonly http?: number; readonly ws?: number } = {}, built: ReadonlyArray<string> = []): Promise<void> => {
    await takeInventory()
    const texts = [
      ...screen.http.slice(since.http ?? 0).map(entry => entry.body),
      ...screen.ws.slice(since.ws ?? 0).map(entry => entry.text),
      storeText(screen.stores),
      ...built,
    ]
    const leaks = forbiddenFor(side).filter(token => texts.some(text => holds(text, token)))
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
    await asScreen(screen, async () => await invokeSimulationRunCapability(opened().runId, { capabilityId, input }))
  const refusalOf = (outcome: Awaited<ReturnType<typeof command>>): string | null => outcome.kind === 'command' && !outcome.result.ok ? outcome.result.reason : null

  const recommendAs = async (screen: Screen, taskId: string): Promise<Recommendation> =>
    await asScreen(screen, async () => await querySimulationRunCapability<Recommendation>(opened().runId, einsatzQueryIds.recommend, { taskId }))

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
    const configuration = configurationOutputSchema.parse(await asScreen(screen, async () => await querySimulationRunCapability<unknown>(opened().runId, einsatzQueryIds.configuration, {}))).config
    const board = createBoardController({
      config: configuration,
      viewer: { class: roleClassForRoleSet(declaration, screen.roleIds), sees: seesForRoleSet(declaration, screen.roleIds), roles: declaration.roles.filter(role => screen.roleIds.includes(role.id)) },
      declaredRoles: declaration.roles,
      sides: declaration.sides ?? [],
    })
    const show = async (shown: Shown): Promise<void> => {
      const asked = board.dispatch({ kind: 'snapshot', objects: shown.objects, currentTime: shown.currentTime, wallMs: 0 })
      for (const effect of asked) {
        if (effect.kind !== 'recommend') continue
        // An earlier snapshot's task may have closed since; the panel reports a failed query as such.
        let answer: unknown
        try {
          answer = await asScreen(screen, async () => await querySimulationRunCapability<unknown>(opened().runId, einsatzQueryIds.recommend, { taskId: effect.taskId }))
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

  /**
   * Opens the Workspace, the server and a paused Run, and lets the client
   * modules reach that server only as one of the harness's screens.
   */
  const open = async (setup: WireOracleSetup): Promise<void> => {
    const created = await createRoleRunWorkspaces(setup.packs, setup.definitions, setup.runtimeAdapters)
    const workspaceId = newWorkspaceId()
    await created.workspaces.provision(workspaceId)
    const server = createServer({ workspaces: created.workspaces, port: 0, bindHost: '127.0.0.1' })
    const runId = await created.workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: setup.scenarioId })).id)
    current = { workspaces: created.workspaces, dataDir: created.dataDir, workspaceId, server, base: `http://127.0.0.1:${server.port}`, runId }
    // Nothing moves or fires unless a step asks: the oracle runs on a deterministic script.
    await (await registry()).setExecution(runId, { playback: 'paused' })
    configureActiveWorkspace(workspaceId)
    const globals = globalThis as unknown as Record<string, unknown>
    for (const key of ['fetch', 'WebSocket', 'location', 'window']) savedGlobals[key] = globals[key]
    Object.assign(globals, { fetch: screenFetch, WebSocket: ScreenSocket, location: { protocol: 'http:', host: `127.0.0.1:${server.port}` }, window: globalThis })
  }

  const close = async (): Promise<void> => {
    const { server, dataDir } = opened()
    for (const screen of screens) screen.connection.disconnect()
    Object.assign(globalThis as unknown as Record<string, unknown>, savedGlobals)
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  }

  return {
    open,
    close,
    /** The fetch and WebSocket the client modules had before the harness took them over. */
    originalFetch,
    nativeWebSocket,
    runId: (): SimulationRunId => opened().runId,
    workspaceId: (): WorkspaceId => opened().workspaceId,
    workspaces: (): WorldWorkspaceRuntimeRegistry => opened().workspaces,
    base: (): string => opened().base,
    port: (): number => opened().server.port,
    screens,
    registry,
    liveRun,
    asScreen,
    createScreen,
    readRun,
    join,
    objectIds,
    einsatzIds,
    attributions,
    storeText,
    einsatzType,
    attempt,
    sideCommands,
    takeInventory,
    forbiddenFor,
    holds,
    expectNoLeak,
    barrier,
    eventsReceived,
    command,
    refusalOf,
    recommendAs,
    shownOn,
    boardText,
    recommended,
  }
}

export type WireOracle = ReturnType<typeof createWireOracle>
