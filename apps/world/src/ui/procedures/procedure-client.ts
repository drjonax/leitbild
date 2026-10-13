import {
  procedureRunCloseCommandKind,
  procedureRunDriveCommandKind,
  procedureRunResetCommandKind,
  procedureRunStartCommandKind,
  procedureStepUpdateCommandKind,
  procedureRunTransitionCommandKind,
  procedureCatalogSchema,
  procedureDocumentSchema,
  procedureControlStateSchema,
} from '../../core/model/index.ts'
import type {
  SimulationRunId,
  ProcedureAssessment,
  ProcedureCatalog,
  ProcedureDocument,
  ProcedureRunScope,
  ProcedureRunState,
  ProcedureStepId,
  ProcedureTag,
} from '../../core/model/index.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'
import { activeWorkspaceId, workspaceApiPath } from '../workspace-context.ts'
import type { PackProcedureContribution } from '../../core/packs/protocol.ts'
import {
  createProcedureObservationPort,
  type ProcedureCsfEvaluation,
  type ProcedureObservationPort,
  type ProcedureTagValidation,
  type ProcedureTagValue,
} from '../../features/procedures/pack-observations.ts'

// The observation wire types live with their parsers, shared with World's own procedure reads.
export type { ProcedureCsfEvaluation, ProcedureCsfSignalRead, ProcedureCsfStatus, ProcedureTagValidation, ProcedureTagValue } from '../../features/procedures/pack-observations.ts'

export interface ProcedureRunsResponse {
  readonly runs: ReadonlyArray<ProcedureRunState>
}

export interface ProcedureSourceEvidenceRequest {
  readonly sourceId: string
  readonly sourceRevision: string
  readonly sourcePath: string
  readonly section?: string
  readonly startLine?: number
  readonly lineCount?: number
}

export interface ProcedureSourceEvidence {
  readonly revision: string
  readonly path: string
  readonly title: string
  readonly content: string
  readonly startLine: number
  readonly endLine: number
  readonly totalLines: number
  readonly nextLine?: number
}

const assertRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

const assertLineNumber = (value: unknown, message: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

export const readProcedureSourceEvidence = async (
  simulationRunId: SimulationRunId,
  request: ProcedureSourceEvidenceRequest,
): Promise<ProcedureSourceEvidence> => {
  const workspaceId = activeWorkspaceId()
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/world.procedure.source.read/invoke`, {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: simulationRunId }, input: request, actor: { kind: 'human' } }),
  })
  const body = await readJson<{ readonly result: unknown }>(response, 'retained procedure source read failed')
  const row = assertRecord(body.result, 'procedure source evidence is malformed')
  if (row.revision !== request.sourceRevision || row.path !== request.sourcePath) throw new Error('procedure source evidence identity does not match requested revision and path')
  if (typeof row.content !== 'string') throw new Error('procedure source evidence requires content')
  const startLine = assertLineNumber(row.startLine, 'procedure source evidence requires startLine')
  const endLine = assertLineNumber(row.endLine, 'procedure source evidence requires endLine')
  const totalLines = assertLineNumber(row.totalLines, 'procedure source evidence requires totalLines')
  if (endLine < startLine || endLine > totalLines) throw new Error('procedure source evidence line range is invalid')
  const nextLine = row.nextLine === undefined ? undefined : assertLineNumber(row.nextLine, 'procedure source evidence requires a valid nextLine')
  if (nextLine !== undefined && (nextLine <= endLine || nextLine > totalLines)) throw new Error('procedure source evidence nextLine is invalid')
  return {
    revision: request.sourceRevision, path: request.sourcePath,
    title: assertString(row.title, 'procedure source evidence requires title'), content: row.content,
    startLine, endLine, totalLines, ...(nextLine === undefined ? {} : { nextLine }),
  }
}

const readJson = async <T>(response: Response, message: string): Promise<T> => {
  if (!response.ok) throw new Error(`${message}: ${response.status}`)
  return await response.json() as T
}

export const readProcedureCatalog = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId?: string; readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ProcedureCatalog> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.refresh) params.set('refresh', 'true')
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedures${suffix}`), { cache: 'no-store', signal: config.signal ?? null })
  const body = await readJson<{ readonly catalog: ProcedureCatalog }>(response, 'procedure catalog fetch failed')
  return procedureCatalogSchema.parse(body.catalog) as ProcedureCatalog
}

export const readProcedureDocument = async (
  simulationRunId: SimulationRunId,
  procedureId: string,
  config: {
    readonly sourceId?: string
    readonly sourceRevision?: string
    readonly sourcePath?: string
    readonly signal?: AbortSignal
  } = {},
): Promise<ProcedureDocument> => {
  const params = new URLSearchParams()
  if (config.sourceId) params.set('sourceId', config.sourceId)
  if (config.sourceRevision) params.set('sourceRevision', config.sourceRevision)
  if (config.sourcePath) params.set('sourcePath', config.sourcePath)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedures/${encodeURIComponent(procedureId)}${suffix}`), { cache: 'no-store', signal: config.signal ?? null })
  const body = await readJson<{ readonly procedure: ProcedureDocument }>(response, 'procedure fetch failed')
  return procedureDocumentSchema.parse(body.procedure) as ProcedureDocument
}

export const readProcedureRuns = async (
  simulationRunId: SimulationRunId,
  signal?: AbortSignal,
): Promise<ProcedureRunsResponse> => {
  const response = await fetch(workspaceApiPath(`/simulation-runs/${encodeURIComponent(simulationRunId)}/procedure-runs`), { cache: 'no-store', signal: signal ?? null })
  const body = await readJson<{ readonly procedures: ProcedureRunsResponse }>(response, 'procedure runs fetch failed')
  return procedureControlStateSchema.parse(body.procedures) as ProcedureRunsResponse
}

export const transitionProcedureRun = async (
  simulationRunId: SimulationRunId,
  input: { readonly runId: string; readonly stepId: string; readonly branchIndex: number },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, { capabilityId: procedureRunTransitionCommandKind, input })
  if (response.kind !== 'command') throw new Error('procedure transition is not a command')
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure transition rejected')
}

export const startProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: {
    readonly sourceId: string
    readonly sourceRevision: string
    readonly procedureId: string
    readonly scope: ProcedureRunScope
  },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunStartCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunStartCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run start rejected')
}

export const updateProcedureStep = async (
  simulationRunId: SimulationRunId,
  config: {
    readonly runId: string
    readonly stepId: ProcedureStepId
    readonly assessment?: ProcedureAssessment
    readonly comment?: string
    readonly favorite?: boolean
    readonly currentStepId?: ProcedureStepId
  },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureStepUpdateCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureStepUpdateCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure step update rejected')
}

/** World's command that hands a procedure Run to its driver: claim takes it (a person always may), release shares it again. */

export const driveProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly runId: string; readonly action: 'claim' | 'release' },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunDriveCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunDriveCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run drive rejected')
}

export const closeProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly runId: string; readonly status: 'completed' | 'abandoned' },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunCloseCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunCloseCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run close rejected')
}

export const resetProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly sourceId: string; readonly procedureId: string; readonly scope: ProcedureRunScope },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunResetCommandKind,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunResetCommandKind} is not a command`)
  if (!response.result.ok) throw new Error(response.result.reason ?? 'procedure run reset rejected')
}

const observationPort = (
  simulationRunId: SimulationRunId,
  scopeId: string,
  provider: PackProcedureContribution,
): ProcedureObservationPort => createProcedureObservationPort({
  scopeId,
  provider,
  query: async query => await querySimulationRunCapability(simulationRunId, query.capabilityId, query.input),
})

export const validateProcedureTags = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  tags: ReadonlyArray<ProcedureTag>,
  provider: PackProcedureContribution,
): Promise<ReadonlyMap<string, ProcedureTagValidation>> =>
  await observationPort(simulationRunId, scopeId, provider).validateTags(tags)

export const readProcedureTagValue = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  tag: ProcedureTag,
  provider: PackProcedureContribution,
): Promise<ProcedureTagValue> =>
  await observationPort(simulationRunId, scopeId, provider).readTag(tag)

export const evaluateProcedureCsfs = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  csfs: ReadonlyArray<string>,
  provider: PackProcedureContribution,
): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> =>
  await observationPort(simulationRunId, scopeId, provider).evaluateCsfs(csfs)
