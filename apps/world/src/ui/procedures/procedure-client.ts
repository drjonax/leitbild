import {
  procedureRunCloseCommandKind,
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
  ProcedureTagId,
} from '../../core/model/index.ts'
import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'
import { activeWorkspaceId, workspaceApiPath } from '../workspace-context.ts'
import type { PackProcedureContribution } from '../../core/packs/protocol.ts'

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

export interface ProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: Record<string, unknown>
  /** The Pack's id for the equipment the tag is measured on, where it names one. */
  readonly measuredOn?: string
  readonly warnings: ReadonlyArray<string>
}

export interface ProcedureTagValue {
  readonly tagId: ProcedureTagId
  readonly label: string
  readonly value: unknown
  readonly formatted: string
  readonly unit?: string
  readonly quality?: string
  readonly path?: string
  readonly conversionStatus?: 'native' | 'converted' | 'unavailable'
  readonly warning?: string
}

export interface ProcedureCsfSignalRead {
  readonly id: string
  readonly label: string
  readonly path?: string
  readonly formatted: string
  readonly operator?: string
  readonly expected?: unknown
  readonly matches?: boolean
}

/** A status tree's colour, unknown where a reading it needs is not available, or not judged in the Plant's state. */
export type ProcedureCsfStatus = 'green' | 'yellow' | 'orange' | 'red' | 'unknown' | 'not-monitored'
const procedureCsfStatuses: ReadonlyArray<ProcedureCsfStatus> = ['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored']

// The criteria a provider may judge a colour by: its own reference-model
// status trees, or a qualified plant criterion. A row naming neither is shown
// unknown, whatever colour it reports.
const judgedCriteria = new Set(['reference-model-criteria', 'qualified-criterion'])

export interface ProcedureCsfEvaluation {
  readonly id: string
  readonly label: string
  readonly status: ProcedureCsfStatus
  /** The function restoration procedure the colour sends operators to. */
  readonly procedure?: string
  readonly reason?: string
  readonly signalCount: number
  readonly signals: ReadonlyArray<ProcedureCsfSignalRead>
  readonly qualification: string
  readonly simTimeMs?: number
  readonly modelRef?: string
  readonly modelDigest?: string
}

const assertRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertArray = (value: unknown, message: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
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

const optionalRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const formatSignalValue = (
  value: unknown,
  unit: string | undefined,
): string =>
  `${String(value)}${unit === undefined ? '' : ` ${unit}`}`

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
const procedureRunDriveCapabilityId = 'world.procedure.run.drive'

export const driveProcedureRun = async (
  simulationRunId: SimulationRunId,
  config: { readonly runId: string; readonly action: 'claim' | 'release' },
): Promise<void> => {
  const response = await invokeSimulationRunCapability(simulationRunId, {
    capabilityId: procedureRunDriveCapabilityId,
    input: config,
  })
  if (response.kind !== 'command') throw new Error(`${procedureRunDriveCapabilityId} is not a command`)
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

const formattedNumber = (value: number, digits: number): string => {
  if (Number.isInteger(value)) return value.toFixed(0)
  if (Math.abs(value) > 0 && Math.abs(value) < 0.001) return value.toExponential(3)
  return value.toFixed(digits)
}

const queryProcedureSignal = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  tag: ProcedureTag,
  provider: PackProcedureContribution,
): Promise<Record<string, unknown> | null> => {
  const query = provider.signalReadQuery(scopeId, tag)
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    query.capabilityId,
    query.input,
  ), 'procedure signal query returned no result')
  const first = assertArray(result.signals, 'procedure signal query returned no signals')[0]
  return first === undefined ? null : assertRecord(first, 'procedure signal query returned malformed signal')
}

export const validateProcedureTags = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  tags: ReadonlyArray<ProcedureTag>,
  provider: PackProcedureContribution,
): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
  if (tags.length === 0) return new Map()
  const query = provider.tagValidationQuery(scopeId, tags)
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    query.capabilityId,
    query.input,
  ), 'procedure tag validation returned a malformed result')
  const rows = assertArray(result.tags, 'procedure tag validation returned no tags').map((value): readonly [string, ProcedureTagValidation] => {
    const row = assertRecord(value, 'procedure tag validation row is malformed')
    const id = assertString(row.id, 'procedure tag validation row requires id')
    const status = assertString(row.status, 'procedure tag validation row requires status')
    if (status !== 'resolved' && status !== 'resolved-with-warnings' && status !== 'missing') {
      throw new Error(`procedure tag validation returned unsupported status: ${status}`)
    }
    const warnings = assertArray(row.warnings, 'procedure tag validation row requires warnings').map(warning =>
      assertString(warning, 'procedure tag validation warning must be a string'),
    )
    const signal = optionalRecord(row.signal)
    const measuredOn = row.measuredOn === undefined ? undefined : assertString(row.measuredOn, 'procedure tag validation measuredOn must be a non-empty string')
    if (measuredOn !== undefined && status === 'missing') throw new Error(`procedure tag validation row ${id} is missing but names equipment`)
    return [id, {
      id,
      status,
      ...(signal === null ? {} : { signal }),
      ...(measuredOn === undefined ? {} : { measuredOn }),
      warnings,
    }]
  })
  return new Map(rows)
}

export const readProcedureTagValue = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  tag: ProcedureTag,
  provider: PackProcedureContribution,
): Promise<ProcedureTagValue> => {
  const first = await queryProcedureSignal(simulationRunId, scopeId, tag, provider)
  if (first === null) throw new Error('not resolved to a Leitbild signal')
  const signal = assertRecord(first.signal, 'procedure tag read row requires signal')
  const variable = assertRecord(first.variable, 'procedure tag read row requires variable')
  let unit = assertString(signal.unit, 'procedure signal requires unit')
  let value = variable.value
  let conversionStatus: ProcedureTagValue['conversionStatus']
  let warning: string | undefined
  if (tag.units !== undefined) {
    // Unit semantics belong to the runtime. A missing projection is a malformed
    // response, not permission for the browser to infer or relabel a value.
    const view = assertRecord(first.valueView, 'requested-unit signal read requires valueView')
    const status = view.status
    if (status !== 'native' && status !== 'converted' && status !== 'unavailable') throw new Error('signal valueView has unsupported status')
    if (view.requestedUnit !== tag.units.trim()) throw new Error('signal valueView does not match requested unit')
    const viewUnit = assertString(view.unit, 'signal valueView requires unit')
    if (status !== 'converted' && (viewUnit !== unit || view.value !== value)) throw new Error('native or unavailable signal valueView must preserve raw value and unit')
    if (status === 'converted' && viewUnit !== view.requestedUnit) throw new Error('converted signal valueView has unexpected unit')
    if (status === 'unavailable') warning = assertString(view.reason, 'unavailable signal valueView requires reason')
    unit = viewUnit
    value = view.value
    conversionStatus = status
  }
  if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('procedure signal requires a finite number or boolean value')
  const quality = optionalRecord(first.quality)
  return {
    tagId: tag.id,
    label: typeof signal.label === 'string' ? signal.label : tag.id,
    value,
    formatted: formatSignalValue(typeof value === 'number' ? formattedNumber(value, 3) : value, unit),
    unit,
    ...(conversionStatus === undefined ? {} : { conversionStatus }),
    ...(warning === undefined ? {} : { warning }),
    ...(typeof quality?.status === 'string' ? { quality: quality.status } : {}),
    ...(typeof signal.path === 'string' ? { path: signal.path } : {}),
  }
}

// One comparison a status tree made: the reading (or the total or difference
// of several) against its threshold, and whether it held.
const parseProcedureCsfComparison = (value: unknown): ProcedureCsfSignalRead => {
  const row = assertRecord(value, 'procedure CSF comparison is malformed')
  const reads = assertArray(row.reads, 'procedure CSF comparison requires reads').map(read => assertRecord(read, 'procedure CSF reading is malformed'))
  const names = reads.map(read => assertString(read.signal, 'procedure CSF reading requires signal'))
  const combines = row.combines === 'total' || row.combines === 'difference' ? row.combines : undefined
  const unit = stringOrUndefined(row.unit)
  const measured = combines === undefined ? reads[0]?.value : row.measured
  const label = combines === 'total' ? `Total of ${names.join(', ')}` : combines === 'difference' ? names.join(' − ') : stringOrUndefined(reads[0]?.label) ?? names[0] ?? 'signal'
  const operator = assertString(row.operator, 'procedure CSF comparison requires operator')
  const path = combines === undefined ? stringOrUndefined(reads[0]?.path) : undefined
  return {
    id: `${names.join('|')} ${operator} ${String(row.threshold)}`,
    label,
    ...(path === undefined ? {} : { path }),
    formatted: measured === undefined ? 'unavailable' : formatSignalValue(typeof measured === 'number' ? formattedNumber(measured, 3) : measured, unit),
    operator,
    expected: row.threshold,
    ...(row.answer === 'yes' ? { matches: true } : row.answer === 'no' ? { matches: false } : {}),
  }
}

export const evaluateProcedureCsfs = async (
  simulationRunId: SimulationRunId,
  scopeId: string,
  csfs: ReadonlyArray<string>,
  provider: PackProcedureContribution,
): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> => {
  if (csfs.length === 0) return new Map()
  const query = provider.assessmentsQuery(scopeId, csfs)
  const result = assertRecord(await querySimulationRunCapability(
    simulationRunId,
    query.capabilityId,
    query.input,
  ), 'procedure CSF evaluation returned a malformed result')
  return new Map(assertArray(result.assessments, 'procedure CSF evaluation returned no statuses').map(item => {
    const row = assertRecord(item, 'procedure CSF row is malformed')
    const id = assertString(row.id, 'procedure CSF row requires id')
    const label = assertString(row.title, 'procedure CSF row requires title')
    const status = assertString(row.status, 'procedure CSF row requires status') as ProcedureCsfStatus
    if (!procedureCsfStatuses.includes(status)) throw new Error(`procedure CSF row has unsupported status: ${status}`)
    const steps = assertArray(row.path, 'procedure CSF row requires its path').map(step => assertRecord(step, 'procedure CSF path step is malformed'))
    const compared = steps.flatMap(step => assertArray(step.comparisons, 'procedure CSF path step requires comparisons').map(parseProcedureCsfComparison))
    const signals = [...new Map(compared.map(signal => [signal.id, signal])).values()]
    const qualification = stringOrUndefined(row.qualification) ?? 'not-established'
    const judged = judgedCriteria.has(qualification)
    const coloured = status !== 'unknown' && status !== 'not-monitored'
    const procedure = judged && coloured ? stringOrUndefined(row.procedure) : undefined
    return [id, {
      id,
      label,
      status: judged || !coloured ? status : 'unknown',
      ...(procedure === undefined ? {} : { procedure }),
      ...(!judged && coloured ? { reason: 'Assessment criterion qualification is not established.' } : typeof row.meaning === 'string' ? { reason: row.meaning } : {}),
      signalCount: signals.length,
      signals,
      qualification,
      ...(typeof row.simTimeMs === 'number' && Number.isFinite(row.simTimeMs) ? { simTimeMs: row.simTimeMs } : {}),
      ...(typeof row.modelRef === 'string' ? { modelRef: row.modelRef } : {}),
      ...(typeof row.modelDigest === 'string' ? { modelDigest: row.modelDigest } : {}),
    }]
  }))
}
