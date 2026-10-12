import type { SimulationRunId } from '../core/model/index.ts'
import type {
  CapabilityInvocationResponse,
  SimulationRunResponse,
  ScenarioResponse,
  RunExecutionState,
} from './types.ts'
import { recordCapabilityQueryDiagnostics } from './internal-diagnostics.ts'
import { activeWorkspaceId, workspaceApiPath } from './workspace-context.ts'
import { withActiveRoleSet } from './roles/role-session.ts'
import type { RunRoles } from '../core/model/index.ts'

/** A World API refusal with its structured code, e.g. role_required. */
export type WorldApiError = Error & { readonly code?: string }

export const worldApiErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined

export interface SimulationRunCapabilityRequest {
  readonly capabilityId: string
  readonly input: unknown
  readonly expectedRevision?: number
  readonly idempotencyKey?: string
}

export interface SimulationRunRequestOptions {
  readonly signal?: AbortSignal
}

const readJsonResponse = async <T>(
  response: Response,
  failureMessage: string,
): Promise<T> => {
  const text = await response.text()
  if (!response.ok) {
    let detail: string | undefined
    let code: string | undefined
    try {
      const parsed = JSON.parse(text) as { readonly error?: { readonly message?: unknown; readonly code?: unknown } }
      if (typeof parsed.error?.message === 'string') detail = parsed.error.message
      if (typeof parsed.error?.code === 'string') code = parsed.error.code
    } catch { /* Non-JSON errors retain the stable client message. */ }
    const error: WorldApiError = new Error(detail ?? `${failureMessage}: ${response.status}`)
    throw code === undefined ? error : Object.assign(error, { code })
  }
  return JSON.parse(text) as T
}

export const fetchScenario = async (scenarioId: string): Promise<ScenarioResponse> => {
  const response = await fetch(workspaceApiPath(`/scenarios/${encodeURIComponent(scenarioId)}`), { cache: 'no-store' })
  return await readJsonResponse<ScenarioResponse>(response, 'scenario fetch failed')
}

export const joinSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}`)), {
    cache: 'no-store',
  })
  return await readJsonResponse<SimulationRunResponse>(response, 'simulation run join failed')
}

export const syncSimulationRunSnapshot = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/snapshot`)), { cache: 'no-store' })
  return await readJsonResponse<SimulationRunResponse>(response, 'snapshot sync failed')
}

export const resetSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<SimulationRunResponse> => {
  const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/reset`)), {
    method: 'POST',
  })
  return await readJsonResponse<SimulationRunResponse>(response, 'simulation run reset failed')
}

export const deleteSimulationRun = async (
  simulationRunId: SimulationRunId,
): Promise<{ readonly id: SimulationRunId; readonly deleted: true }> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}`), {
    method: 'DELETE',
  })
  return await readJsonResponse<{ readonly id: SimulationRunId; readonly deleted: true }>(response, 'simulation run delete failed')
}

export const invokeSimulationRunCapability = async (
  simulationRunId: SimulationRunId,
  invocation: SimulationRunCapabilityRequest,
): Promise<CapabilityInvocationResponse> => {
  const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/capabilities/${encodeURIComponent(invocation.capabilityId)}/invoke`)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: invocation.input,
      ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    }),
  })
  return await readJsonResponse<CapabilityInvocationResponse>(response, 'capability invocation failed')
}

/** The public presence of a Run; a role Run adds its roles and how many screens hold each. */
export interface RunPresence {
  readonly simulationRunId: SimulationRunId
  readonly title: string
  readonly roles?: RunRoles & { readonly holders: Readonly<Record<string, number>> }
}

export const fetchRunPresence = async (simulationRunId: SimulationRunId): Promise<RunPresence> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/presence`), { cache: 'no-store' })
  return await readJsonResponse<RunPresence>(response, 'presence fetch failed')
}

export const fetchRunExecution = async (simulationRunId: SimulationRunId): Promise<RunExecutionState> => {
  const workspaceId = activeWorkspaceId()
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/world.simulation-run.execution.read/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: simulationRunId },
      input: {},
      actor: { kind: 'human' },
    }),
  })
  return (await readJsonResponse<{ readonly result: RunExecutionState }>(response, 'execution status failed')).result
}

const capabilityQueryFailureMessage = (status: number, text: string): string => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `Capability query failed: ${status}`
    const error = (parsed as { readonly error?: unknown }).error
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return `Capability query failed: ${status}`
    const message = (error as { readonly message?: unknown }).message
    return typeof message === 'string' && message.length > 0 ? message : `Capability query failed: ${status}`
  } catch {
    return `Capability query failed: ${status}`
  }
}

const diagnosticPackId = (capabilityId: string): string => capabilityId.split('.')[1] ?? 'world'

export const querySimulationRunCapability = async <T = unknown>(
  simulationRunId: SimulationRunId,
  capabilityId: string,
  input: unknown,
  options: SimulationRunRequestOptions = {},
): Promise<T> => {
  const body = JSON.stringify({ input })
  const startedAtMs = performance.now()
  let responseStatus: number | undefined
  let recorded = false
  try {
    const response = await fetch(withActiveRoleSet(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    responseStatus = response.status
    const text = await response.text()
    recordCapabilityQueryDiagnostics({
      ownerId: diagnosticPackId(capabilityId),
      capabilityId,
      startedAtMs,
      durationMs: performance.now() - startedAtMs,
      requestBytes: body.length,
      responseBytes: text.length,
      status: response.status,
      ok: response.ok,
    })
    recorded = true
    if (!response.ok) throw new Error(capabilityQueryFailureMessage(response.status, text))
    const invocation = JSON.parse(text) as CapabilityInvocationResponse
    if (invocation.kind !== 'query') throw new Error(`Simulation Capability is not a query: ${capabilityId}`)
    return invocation.result as T
  } catch (err) {
    if (!recorded) {
      recordCapabilityQueryDiagnostics({
        ownerId: diagnosticPackId(capabilityId),
        capabilityId,
        startedAtMs,
        durationMs: performance.now() - startedAtMs,
        requestBytes: body.length,
        responseBytes: 0,
        ...(responseStatus === undefined ? {} : { status: responseStatus }),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }
}
