import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunEventNotification } from '../simulation-runs/runtime.ts'
import type { SimulationRunStateSnapshot } from '../simulation-runs/state-store.ts'
import { eventVisibleTo } from '../simulation-runs/event-audience.ts'
import { sideViewOfCompiledScenario, sideViewOfSnapshot } from '../simulation-runs/side-view.ts'
import { isSideView, seesForRoleSet, type CompiledScenario, type ObjectAudience, type ObjectId, type RoleSees, type RunRoles, type SimulationRunId, type SimulationClockState } from '../model/index.ts'
import type { PackRuntimeRealtimeMessage } from '../../simulation/protocol.ts'
import type { WorkspaceId } from '@leitbild/contracts'

type RealtimeMessageContext = Omit<RealtimeReadyMessage, 'type' | 'clock' | 'epoch' | 'roleIds' | 'snapshot' | 'compiledScenario'>

/**
 * A role-Run connection's perspective: the role set it holds and the epoch
 * that set began. Every message it receives carries that epoch, so a screen
 * can tell messages of its current role set from late ones of an older set.
 * A connection to a Run without roles has none, and its messages are unchanged.
 */
export interface ClientPerspective {
  readonly roleIds: ReadonlyArray<string>
  readonly epoch: number
}

interface RealtimeSubscription {
  readonly runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>
  readonly unsubscribe: () => void
  context: RealtimeMessageContext
}

interface SubscriptionReconciliation {
  readonly runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>> | null
  readonly changed: boolean
}

export interface RealtimeStatus {
  readonly websocketClientCount: number
  readonly subscribedSimulationRunCount: number
  readonly simulationRuns: ReadonlyArray<{
    readonly id: SimulationRunId
    readonly websocketClientCount: number
  }>
}

export interface RealtimeReadyMessage {
  readonly type: 'realtime.ready'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly clock?: SimulationClockState
  /**
   * Role Runs only: the perspective epoch, its role set, and a fresh snapshot
   * and Compiled Scenario that replace every Run store the screen keeps.
   */
  readonly epoch?: number
  readonly roleIds?: ReadonlyArray<string>
  readonly snapshot?: SimulationRunStateSnapshot
  readonly compiledScenario?: CompiledScenario
}

export interface RealtimeEventBatchMessage {
  readonly type: 'events'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly events: SimulationRunEventNotification['events']
  readonly epoch?: number
}

export interface RealtimeRuntimeMessageBatch {
  readonly type: 'runtime.realtime'
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly snapshotSeq: number
  readonly messages: ReadonlyArray<PackRuntimeRealtimeMessage>
  readonly epoch?: number
}

export type RealtimeOutboundMessage = RealtimeEventBatchMessage | RealtimeRuntimeMessageBatch

export interface SimulationRunRealtimeManager<Client> {
  readonly addClient: (simulationRunId: SimulationRunId, client: Client) => void
  readonly removeClient: (simulationRunId: SimulationRunId, client: Client) => void
  /** Answers a connection whose perspective just changed with a fresh ready snapshot in its new epoch. */
  readonly sendReady: (simulationRunId: SimulationRunId, client: Client) => void
  /** How many connections hold each role, for the public presence route. */
  readonly roleHolders: (simulationRunId: SimulationRunId) => Readonly<Record<string, number>>
  readonly reconcile: () => void
  readonly status: () => RealtimeStatus
  readonly stop: () => void
}

export const emptyRealtimeStatus = (): RealtimeStatus => ({
  websocketClientCount: 0,
  subscribedSimulationRunCount: 0,
  simulationRuns: [],
})

const realtimeStatusFromClients = <Client>(
  clientsBySimulationRun: ReadonlyMap<SimulationRunId, ReadonlySet<Client>>,
  subscribedSimulationRunCount: number,
): RealtimeStatus => {
  const simulationRuns = [...clientsBySimulationRun.entries()]
    .map(([id, clients]) => ({ id, websocketClientCount: clients.size }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    websocketClientCount: simulationRuns.reduce((count, item) => count + item.websocketClientCount, 0),
    subscribedSimulationRunCount,
    simulationRuns,
  }
}

export const createSimulationRunRealtimeManager = <Client>(config: {
  readonly registry: SimulationRunRegistry
  readonly send: (client: Client, message: RealtimeOutboundMessage) => void
  readonly sendReady: (client: Client, message: RealtimeReadyMessage) => void
  readonly perspectiveOf: (client: Client) => ClientPerspective | null
}): SimulationRunRealtimeManager<Client> => {
  const clientsBySimulationRun = new Map<SimulationRunId, Set<Client>>()
  const subscriptionsBySimulationRun = new Map<SimulationRunId, RealtimeSubscription>()
  const releasesByClient = new Map<Client, { readonly simulationRunId: SimulationRunId; readonly release: () => void }>()

  const releaseClientLease = (client: Client): void => {
    const lease = releasesByClient.get(client)
    if (!lease) return
    lease.release()
    releasesByClient.delete(client)
  }

  const ensureClientLease = (simulationRunId: SimulationRunId, client: Client): void => {
    const lease = releasesByClient.get(client)
    if (lease?.simulationRunId === simulationRunId) return
    lease?.release()
    releasesByClient.set(client, {
      simulationRunId,
      release: config.registry.acquireLease(simulationRunId, 'realtime'),
    })
  }

  const messageContextForRuntime = (
    simulationRunId: SimulationRunId,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
  ): RealtimeMessageContext => {
    const snapshot = runtime.snapshot()
    return {
      workspaceId: config.registry.workspaceId,
      simulationRunId,
      ...(snapshot.scenario?.scenarioId === undefined ? {} : { scenarioId: snapshot.scenario.scenarioId }),
      snapshotSeq: snapshot.seq,
    }
  }

  const inEpochOf = <Message extends RealtimeOutboundMessage>(client: Client, message: Message): Message => {
    const perspective = config.perspectiveOf(client)
    return perspective === null ? message : { ...message, epoch: perspective.epoch }
  }

  /**
   * What a connection to a sided Run sees: its role set's union. A sided Run
   * admits connections only with a role set; one without would see nothing.
   */
  const seesOf = (declaration: RunRoles, client: Client): RoleSees => {
    const perspective = config.perspectiveOf(client)
    return perspective === null ? [] : seesForRoleSet(declaration, perspective.roleIds)
  }

  /** The audience of an object an event names: from this batch first, then the committed projection. */
  const audienceResolver = (
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
    events: SimulationRunEventNotification['events'],
  ): ((objectId: ObjectId) => ObjectAudience | undefined) => {
    let committed: ReadonlyMap<ObjectId, ObjectAudience | undefined> | null = null
    const inBatch = new Map<ObjectId, ObjectAudience | undefined>()
    for (const event of events) if (event.type === 'object.upserted') inBatch.set(event.object.id, event.object.audience)
    return objectId => {
      if (inBatch.has(objectId)) return inBatch.get(objectId)
      committed ??= new Map(runtime.snapshot().objects.map(object => [object.id, object.audience]))
      return committed.get(objectId)
    }
  }

  /**
   * A sided Run sends each distinct view its own batch, filtered once per
   * view: truth views everything, side views the events their sides see and
   * no runtime realtime messages. An empty batch is not sent.
   */
  const broadcastBySide = (
    declaration: RunRoles,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
    clients: ReadonlySet<Client>,
    messageContext: RealtimeMessageContext,
    notification: SimulationRunEventNotification,
  ): void => {
    const groups = new Map<string, { readonly sees: RoleSees; readonly clients: Client[] }>()
    for (const client of clients) {
      const sees = seesOf(declaration, client)
      const key = sees === 'all' ? '*' : sees.join(',')
      const group = groups.get(key) ?? { sees, clients: [] }
      group.clients.push(client)
      groups.set(key, group)
    }
    const audienceOf = audienceResolver(runtime, notification.events)
    for (const { sees, clients: members } of groups.values()) {
      const events = sees === 'all' ? notification.events : notification.events.filter(event => eventVisibleTo(event, sees, audienceOf))
      if (events.length > 0) {
        const message: RealtimeEventBatchMessage = { type: 'events', ...messageContext, events }
        for (const client of members) config.send(client, inEpochOf(client, message))
      }
      if (isSideView(sees) || !notification.realtimeMessages || notification.realtimeMessages.length === 0) continue
      const message: RealtimeRuntimeMessageBatch = { type: 'runtime.realtime', ...messageContext, messages: notification.realtimeMessages }
      for (const client of members) config.send(client, inEpochOf(client, message))
    }
  }

  const broadcastToSimulationRun = (
    simulationRunId: SimulationRunId,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
    notification: SimulationRunEventNotification,
  ): void => {
    const subscription = subscriptionsBySimulationRun.get(simulationRunId)
    if (subscription?.runtime !== runtime) return
    const clients = clientsBySimulationRun.get(simulationRunId)
    if (!clients) return
    const messageContext = notification.events.length > 0
      ? messageContextForRuntime(simulationRunId, runtime)
      : subscription.context
    subscription.context = messageContext
    const declaration = runtime.roles()
    if (declaration?.sides !== undefined) {
      broadcastBySide(declaration, runtime, clients, messageContext, notification)
      return
    }
    if (notification.events.length > 0) {
      const message: RealtimeEventBatchMessage = {
        type: 'events',
        ...messageContext,
        events: notification.events,
      }
      for (const client of clients) config.send(client, inEpochOf(client, message))
    }
    if (notification.realtimeMessages && notification.realtimeMessages.length > 0) {
      const message: RealtimeRuntimeMessageBatch = {
        type: 'runtime.realtime',
        ...messageContext,
        messages: notification.realtimeMessages,
      }
      for (const client of clients) config.send(client, inEpochOf(client, message))
    }
  }

  const readyMessageForRuntime = (
    simulationRunId: SimulationRunId,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
    client: Client,
  ): RealtimeReadyMessage => {
    const snapshot = runtime.snapshot()
    const perspective = config.perspectiveOf(client)
    const declaration = runtime.roles()
    // A side view's ready carries only its allow-listed picture.
    const sees = declaration === null || perspective === null ? 'all' : seesForRoleSet(declaration, perspective.roleIds)
    const compiledScenario = perspective === null ? null : config.registry.loadedCompiledScenario(simulationRunId)
    return {
      type: 'realtime.ready',
      ...messageContextForRuntime(simulationRunId, runtime),
      ...(snapshot.clock === undefined ? {} : { clock: snapshot.clock }),
      ...(perspective === null || compiledScenario === null ? {} : {
        epoch: perspective.epoch,
        roleIds: perspective.roleIds,
        snapshot: isSideView(sees) ? sideViewOfSnapshot(snapshot, sees) : snapshot,
        compiledScenario: isSideView(sees) ? sideViewOfCompiledScenario(compiledScenario, sees) : compiledScenario,
      }),
    }
  }

  const sendReadyToSimulationRun = (
    simulationRunId: SimulationRunId,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
  ): void => {
    const clients = clientsBySimulationRun.get(simulationRunId)
    if (!clients) return
    for (const client of clients) config.sendReady(client, readyMessageForRuntime(simulationRunId, runtime, client))
  }

  const sendReadyToClient = (
    simulationRunId: SimulationRunId,
    runtime: NonNullable<ReturnType<SimulationRunRegistry['get']>>,
    client: Client,
  ): void => {
    config.sendReady(client, readyMessageForRuntime(simulationRunId, runtime, client))
  }

  /**
   * A screen holding roles is attached: a new Run that waits for its first
   * one starts playing (`registry.screenJoined`). A failure to start it is
   * logged and the Run stays paused, still waiting: the next screen that joins
   * retries, and the Host can play it.
   */
  const noteScreens = (simulationRunId: SimulationRunId, clients: ReadonlySet<Client>): void => {
    if (![...clients].some(client => (config.perspectiveOf(client)?.roleIds.length ?? 0) > 0)) return
    const start = async (): Promise<void> => {
      try {
        await config.registry.screenJoined(simulationRunId)
      } catch (error) {
        console.error(`Simulation Run ${simulationRunId} could not start for its first screen`, error)
      }
    }
    void start()
  }

  const reconcileSimulationRunSubscription = (simulationRunId: SimulationRunId): SubscriptionReconciliation => {
    const clients = clientsBySimulationRun.get(simulationRunId)
    const existing = subscriptionsBySimulationRun.get(simulationRunId)
    if (!clients || clients.size === 0) {
      existing?.unsubscribe()
      subscriptionsBySimulationRun.delete(simulationRunId)
      return { runtime: null, changed: existing !== undefined }
    }
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) {
      existing?.unsubscribe()
      subscriptionsBySimulationRun.delete(simulationRunId)
      return { runtime: null, changed: existing !== undefined }
    }
    for (const client of clients) ensureClientLease(simulationRunId, client)
    noteScreens(simulationRunId, clients)
    if (existing?.runtime === runtime) return { runtime, changed: false }
    existing?.unsubscribe()
    const unsubscribe = runtime.subscribe(event => broadcastToSimulationRun(simulationRunId, runtime, event))
    subscriptionsBySimulationRun.set(simulationRunId, {
      runtime,
      unsubscribe,
      context: messageContextForRuntime(simulationRunId, runtime),
    })
    return { runtime, changed: true }
  }

  return {
    addClient: (simulationRunId, client): void => {
      const clients = clientsBySimulationRun.get(simulationRunId) ?? new Set<Client>()
      clients.add(client)
      clientsBySimulationRun.set(simulationRunId, clients)
      const { runtime } = reconcileSimulationRunSubscription(simulationRunId)
      if (runtime) sendReadyToClient(simulationRunId, runtime, client)
    },
    sendReady: (simulationRunId, client): void => {
      if (!clientsBySimulationRun.get(simulationRunId)?.has(client)) throw new Error(`realtime client is not attached to ${simulationRunId}`)
      const { runtime, changed } = reconcileSimulationRunSubscription(simulationRunId)
      if (!runtime) throw new Error(`Simulation Run is not loaded: ${simulationRunId}`)
      if (changed) sendReadyToSimulationRun(simulationRunId, runtime)
      else sendReadyToClient(simulationRunId, runtime, client)
    },
    roleHolders: (simulationRunId) => {
      const holders: Record<string, number> = {}
      for (const client of clientsBySimulationRun.get(simulationRunId) ?? []) {
        for (const roleId of config.perspectiveOf(client)?.roleIds ?? []) holders[roleId] = (holders[roleId] ?? 0) + 1
      }
      return holders
    },
    removeClient: (simulationRunId, client): void => {
      const clients = clientsBySimulationRun.get(simulationRunId)
      if (!clients) return
      clients.delete(client)
      releaseClientLease(client)
      if (clients.size === 0) clientsBySimulationRun.delete(simulationRunId)
      reconcileSimulationRunSubscription(simulationRunId)
    },
    reconcile: (): void => {
      for (const simulationRunId of clientsBySimulationRun.keys()) {
        const { runtime, changed } = reconcileSimulationRunSubscription(simulationRunId)
        if (runtime && changed) sendReadyToSimulationRun(simulationRunId, runtime)
      }
    },
    status: () => realtimeStatusFromClients(clientsBySimulationRun, subscriptionsBySimulationRun.size),
    stop: (): void => {
      for (const { unsubscribe } of subscriptionsBySimulationRun.values()) unsubscribe()
      for (const client of [...releasesByClient.keys()]) releaseClientLease(client)
      subscriptionsBySimulationRun.clear()
      clientsBySimulationRun.clear()
    },
  }
}
