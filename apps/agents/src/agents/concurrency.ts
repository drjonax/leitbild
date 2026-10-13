// ============================================================================
// ConcurrencyManager — Per-agent concurrency and state tracking.
//
// One evaluation at a time per agent. If a message arrives in room B while
// the agent is generating for room A, room B is queued. When room A finishes,
// the agent picks up pending rooms in order.
//
// State model: exactly one of { idle } or { generating, context: roomId }.
// No ambiguity, no multi-room parallelism. The LLM processes one request
// at a time anyway (gateway semaphore), so parallel evals would just queue
// at the LLM layer and complicate the state model for no benefit.
//
// generationEpoch: incremented on cancelAll(). In-flight async results from
// a cancelled epoch are silently discarded.
//
// A turn delayed by scheduleNext (the reply cooldown) is queued work: the state
// reads 'idle' meanwhile, but whenIdle waits for it and hasQueuedWork reports
// it. close() is for a closing runtime: queued work is dropped and no turn can
// start again; a running one ends on its own or by cancelAll().
// ============================================================================

import type { AgentState, StateSubscriber, StateValue } from '../core/types/agent.ts'

const AGENT_TIMEOUT_MS = 30_000

export interface ConcurrencyManager {
  readonly state: AgentState
  readonly isBusy: () => boolean
  readonly getActiveRoom: () => string | undefined
  readonly startGeneration: (roomId: string) => void
  readonly endGeneration: (roomId: string) => void
  readonly addPending: (roomId: string) => void
  readonly consumePending: (roomId: string) => boolean
  readonly hasPending: () => boolean
  readonly nextPending: () => string | undefined
  // Starts `roomId` after `delayMs` unless cancelled or closed first.
  readonly scheduleNext: (roomId: string, delayMs: number, start: (roomId: string) => void) => void
  // A pending room or a scheduled turn waits to start.
  readonly hasQueuedWork: () => boolean
  readonly close: () => void
  readonly isClosed: () => boolean
  readonly epochAtStart: () => number
  readonly isEpochCurrent: (epoch: number) => boolean
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly cancelAll: () => void
  // Fires the AgentState subscribers. The third arg (startedAt) is read
  // from internal `startedAt` — callers only supply value + context.
  readonly notifyState: (value: StateValue, context?: string) => void
  // Wall-clock timestamp the current generation started at, or undefined
  // when idle. Mirrored on AgentState.getStartedAt so the UI snapshot path
  // can convey it on reconnect mid-generation.
  readonly getStartedAt: () => number | undefined
}

export const createConcurrencyManager = (agentId: string): ConcurrencyManager => {
  let activeRoom: string | undefined      // the ONE room currently generating
  let startedAt: number | undefined        // Date.now() when activeRoom was set
  const pendingRooms = new Set<string>()   // rooms waiting for their turn
  const scheduled = new Set<ReturnType<typeof setTimeout>>()  // delayed turns
  let idleResolvers: Array<() => void> = []
  const stateSubscribers = new Set<StateSubscriber>()
  let generationEpoch = 0
  let closed = false

  const notifyState = (value: StateValue, context?: string): void => {
    // startedAt is read from closure — callers don't thread it through.
    for (const fn of stateSubscribers) fn(value, agentId, context, startedAt)
  }

  const isQuiet = (): boolean => !activeRoom && pendingRooms.size === 0 && scheduled.size === 0

  const checkIdle = (): void => {
    if (isQuiet()) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const state: AgentState = {
    get: () => activeRoom ? 'generating' : 'idle',
    getContext: () => activeRoom,
    getStartedAt: () => startedAt,
    subscribe: (fn: StateSubscriber) => {
      stateSubscribers.add(fn)
      return () => { stateSubscribers.delete(fn) }
    },
  }

  const whenIdle = (timeoutMs = AGENT_TIMEOUT_MS): Promise<void> => {
    if (isQuiet()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`whenIdle timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      idleResolvers.push(() => { clearTimeout(timer); resolve() })
    })
  }

  const assertOpen = (action: string): void => {
    if (closed) throw new Error(`Agent ${agentId} is closed and cannot ${action}`)
  }

  const clearScheduled = (): void => {
    for (const timer of scheduled) clearTimeout(timer)
    scheduled.clear()
  }

  return {
    state,
    isBusy: () => activeRoom !== undefined,
    getActiveRoom: () => activeRoom,
    startGeneration: (roomId: string) => { assertOpen('start a turn'); activeRoom = roomId; startedAt = Date.now() },
    endGeneration: (_roomId: string) => {
      activeRoom = undefined
      startedAt = undefined
      notifyState('idle')
      checkIdle()
    },
    addPending: (roomId: string) => { assertOpen('queue a turn'); pendingRooms.add(roomId) },
    consumePending: (roomId: string) => {
      if (!pendingRooms.has(roomId)) return false
      pendingRooms.delete(roomId)
      return true
    },
    hasPending: () => pendingRooms.size > 0,
    nextPending: () => {
      const first = pendingRooms.values().next()
      return first.done ? undefined : first.value
    },
    scheduleNext: (roomId, delayMs, start) => {
      assertOpen('queue a turn')
      const timer = setTimeout(() => {
        scheduled.delete(timer)
        try { start(roomId) } finally { checkIdle() }
      }, delayMs)
      scheduled.add(timer)
    },
    hasQueuedWork: () => pendingRooms.size > 0 || scheduled.size > 0,
    close: () => {
      closed = true
      pendingRooms.clear()
      clearScheduled()
      checkIdle()
    },
    isClosed: () => closed,
    epochAtStart: () => generationEpoch,
    isEpochCurrent: (epoch: number) => generationEpoch === epoch,
    whenIdle,
    cancelAll: () => {
      generationEpoch++
      activeRoom = undefined
      startedAt = undefined
      pendingRooms.clear()
      clearScheduled()
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
      notifyState('idle')
    },
    notifyState,
    getStartedAt: () => startedAt,
  }
}
