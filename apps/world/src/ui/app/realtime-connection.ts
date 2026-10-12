import type { SimulationRunId, SimulationClockState } from '../../core/model/index.ts'
import {
  parseSimulationRunWebSocketMessage,
  type RoleRefusedMessage,
  type SimulationRunEventBatchMessage,
  type RuntimeRealtimeMessageBatch,
} from '../simulation-run-events.ts'
import { createPerspectiveGate, type PerspectiveGate, type RealtimePerspective } from '../roles/perspective.ts'
import { roleSetQueryParameter } from '../roles/role-session.ts'
import type { SimulationRunCapabilityRequest } from '../simulation-run-client.ts'
import type { CapabilityInvocationResponse } from '../types.ts'
import { workspaceApiPath } from '../workspace-context.ts'
import { activeWorkspaceId } from '../workspace-context.ts'

export interface RealtimeReadyMessage {
  readonly simulationRunId: SimulationRunId
  readonly scenarioId?: string
  readonly clock?: SimulationClockState
  /** Role Runs: the adopted epoch's role set and the snapshot that replaces every Run store. */
  readonly perspective?: RealtimePerspective
}

export interface RealtimeConnectionCallbacks {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onError: (message: string) => void
  readonly onInvalidMessage: (message: string) => void
  readonly onReady: (message: RealtimeReadyMessage) => void
  readonly onEvent: (message: SimulationRunEventBatchMessage) => void
  readonly onRuntimeRealtime: (message: RuntimeRealtimeMessageBatch) => void
  readonly onRoleRefused: (message: RoleRefusedMessage) => void
}

export interface RealtimeConnectionController {
  /** Opens the Run's channel; a role Run's connection carries the screen's role set. */
  readonly connect: (id: SimulationRunId, callbacks: RealtimeConnectionCallbacks, roleIds: ReadonlyArray<string> | null) => void
  /**
   * Asks the Run to swap this connection's role set in place; a ready message
   * of a new epoch or a role refusal answers. One switch at a time: until it is
   * answered, a second switch and every capability invocation are refused.
   */
  readonly setRoles: (id: SimulationRunId, roleIds: ReadonlyArray<string>) => void
  readonly disconnect: () => void
  readonly canCarry: (id: SimulationRunId) => boolean
  readonly statusFor: (id: SimulationRunId) => 'open' | 'connecting' | 'other'
  readonly invokeCapability: (id: SimulationRunId, invocation: SimulationRunCapabilityRequest) => Promise<CapabilityInvocationResponse>
  readonly sendRuntimeInput: (id: SimulationRunId, input: RuntimeInputRequest) => void
}

export interface RuntimeInputRequest {
  readonly type: string
  readonly actorId?: string
  readonly clientId?: string
  readonly payload: unknown
}

/**
 * The Run answers each invocation in the epoch the invocation arrived in. An
 * answer from an epoch this screen has since left is never applied; the
 * invocation settles with these words instead, which say what is known.
 */
export const staleResultMessage = 'Answered under the previous role set, so its result is not shown; it may have been applied'
export const staleRefusalMessage = 'Refused under the previous role set'
export const switchUnderWayMessage = 'Switching roles; issue this again once the switch completes'

export const createRealtimeConnectionController = (): RealtimeConnectionController => {
  let socket: WebSocket | null = null
  let socketId: SimulationRunId | null = null
  let gate: PerspectiveGate = createPerspectiveGate()
  // The epoch a sent `role.set` left; null when no switch awaits its answer.
  let switchFromEpoch: number | null = null
  const pendingInvocations = new Map<string, {
    readonly resolve: (response: CapabilityInvocationResponse) => void
    readonly reject: (err: Error) => void
    readonly timeoutId: number
  }>()

  const canCarry = (id: SimulationRunId): boolean =>
    socket !== null
    && socketId === id
    && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)

  const rejectPendingInvocations = (message: string): void => {
    for (const [requestId, pending] of pendingInvocations) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(message))
      pendingInvocations.delete(requestId)
    }
  }

  const resolveInvocation = (requestId: string, response: CapabilityInvocationResponse): void => {
    const pending = pendingInvocations.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingInvocations.delete(requestId)
    pending.resolve(response)
  }

  const rejectInvocation = (requestId: string | undefined, message: string): void => {
    if (requestId === undefined) {
      rejectPendingInvocations(message)
      return
    }
    const pending = pendingInvocations.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutId)
    pendingInvocations.delete(requestId)
    pending.reject(new Error(message))
  }

  return {
    connect: (id, callbacks, roleIds): void => {
      if (canCarry(id)) return
      socket?.close()
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const roleQuery = roleIds === null || roleIds.length === 0 ? '' : `&${roleSetQueryParameter}=${encodeURIComponent(roleIds.join(','))}`
      const nextSocket = new WebSocket(`${protocol}//${location.host}${workspaceApiPath('/ws')}?simulationRun=${encodeURIComponent(id)}${roleQuery}`)
      socket = nextSocket
      socketId = id
      // Epochs count per connection.
      gate = createPerspectiveGate()
      switchFromEpoch = null
      const connectionGate = gate

      nextSocket.onopen = () => {
        if (socket !== nextSocket) return
        callbacks.onOpen()
      }
      nextSocket.onclose = () => {
        if (socket !== nextSocket) return
        socket = null
        socketId = null
        switchFromEpoch = null
        rejectPendingInvocations('Realtime capability channel closed')
        callbacks.onClose()
      }
      nextSocket.onerror = () => {
        if (socket !== nextSocket) return
        callbacks.onError('WebSocket error')
      }
      nextSocket.onmessage = (message) => {
        let parsed
        try {
          parsed = parseSimulationRunWebSocketMessage(message.data as string)
        } catch (err) {
          callbacks.onInvalidMessage(err instanceof Error ? err.message : 'Invalid WebSocket message')
          return
        }
        if (!parsed) return
        if (parsed.workspaceId !== activeWorkspaceId() || parsed.simulationRunId !== id) {
          callbacks.onInvalidMessage('Realtime message scope does not match the active Workspace and Simulation Run')
          return
        }
        if (parsed.type === 'realtime.ready') {
          if (parsed.perspective !== undefined) {
            if (!connectionGate.adopt(parsed.perspective.epoch)) return
            // The first ready of a newer epoch answers the outstanding switch.
            if (switchFromEpoch !== null && parsed.perspective.epoch > switchFromEpoch) switchFromEpoch = null
          }
          callbacks.onReady(parsed)
          return
        }
        // An invocation's fate follows the epoch of its own answer: one asked
        // before a switch but answered after it settles without its result.
        if ((parsed.type === 'capability.result' || parsed.type === 'capability.error')
          && parsed.requestId !== undefined
          && parsed.epoch !== undefined
          && parsed.epoch < connectionGate.epoch()) {
          rejectInvocation(parsed.requestId, parsed.type === 'capability.result' ? staleResultMessage : staleRefusalMessage)
          return
        }
        if (!connectionGate.admits(parsed.epoch)) return
        if (parsed.type === 'capability.result') {
          resolveInvocation(parsed.requestId, parsed.outcome)
          return
        }
        if (parsed.type === 'capability.error') {
          rejectInvocation(parsed.requestId, parsed.message)
          return
        }
        if (parsed.type === 'role.refused') {
          switchFromEpoch = null
          callbacks.onRoleRefused(parsed)
          return
        }
        if (parsed.type === 'runtime.realtime') {
          callbacks.onRuntimeRealtime(parsed)
          return
        }
        if (parsed.type === 'runtime.input.error') {
          callbacks.onError(`${parsed.inputType ?? 'Runtime input'} rejected: ${parsed.message}`)
          return
        }
        callbacks.onEvent(parsed)
      }
    },
    disconnect: (): void => {
      socket?.close()
      socket = null
      socketId = null
      switchFromEpoch = null
      rejectPendingInvocations('Realtime capability channel disconnected')
    },
    setRoles: (id, roleIds): void => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('The realtime channel is not open, so the switch was not sent; this screen keeps its roles')
      }
      if (gate.epoch() === 0) throw new Error('The Run has not answered this screen yet, so the switch was not sent; this screen keeps its roles')
      if (switchFromEpoch !== null) throw new Error('A role switch is already under way')
      socket.send(JSON.stringify({ type: 'role.set', roles: roleIds }))
      switchFromEpoch = gate.epoch()
    },
    canCarry,
    statusFor: (id): 'open' | 'connecting' | 'other' => {
      if (socketId !== id || socket === null) return 'other'
      if (socket.readyState === WebSocket.OPEN) return 'open'
      if (socket.readyState === WebSocket.CONNECTING) return 'connecting'
      return 'other'
    },
    invokeCapability: async (id, invocation): Promise<CapabilityInvocationResponse> => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Realtime capability channel is not open')
      }
      // The Run applies a switch as soon as it arrives, so an invocation sent
      // now would act under a role set this screen does not show yet.
      if (switchFromEpoch !== null) throw new Error(switchUnderWayMessage)
      const activeSocket = socket
      const requestId = `rtcmd:${crypto.randomUUID()}`
      return await new Promise<CapabilityInvocationResponse>((resolve, reject): void => {
        const timeoutId = window.setTimeout(() => {
          pendingInvocations.delete(requestId)
          reject(new Error('Realtime capability invocation timed out'))
        }, 2_500)
        pendingInvocations.set(requestId, { resolve, reject, timeoutId })
        activeSocket.send(JSON.stringify({
          type: 'capability.invoke',
          requestId,
          capabilityId: invocation.capabilityId,
          invocation: {
            input: invocation.input,
            ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
            ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
          },
        }))
      })
    },
    sendRuntimeInput: (id, input): void => {
      if (socketId !== id || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Realtime input channel is not open')
      }
      socket.send(JSON.stringify({
        type: 'runtime.input',
        input,
      }))
    },
  }
}
