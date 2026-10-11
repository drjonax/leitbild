import { sourceDocumentPathSchema,sourceRevisionSchema,type AccessContext } from '@leitbild/contracts'
import { z } from 'zod'
import { actorIdSchema,clientIdSchema,interactionEndpointSchema,interactionSignalSchema,nowIso,objectIdSchema,procedureIdSchema,procedureSourceIdSchema,simulationRunIdSchema,type CompiledScenario,type InteractionSignal,type SimulationRunId } from '../model/index.ts'
import type { Actor } from '../simulation-runs/actors.ts'
import { CommandIdempotencyConflictError } from '../simulation-runs/command-idempotency.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../simulation-runs/runtime.ts'
import { apiError,json,readJson } from './responses.ts'
import { runCopyInputSchema } from '../simulation-runs/execution.ts'
import { recordingSeriesQuerySchema } from '../model/recording.ts'

const defaultOperatorActorId = actorIdSchema.parse('actor:operator')

export interface SimulationRunRouteConfig {
  readonly registry: SimulationRunRegistry
  readonly accessContext: AccessContext
}

export const capabilityInvocationRequestSchema = z.object({
  input: z.custom<unknown>(value => value !== undefined, 'input is required'),
  idempotencyKey: z.string().min(1).max(256).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict()

const signalRequestSchema = z.object({
  actorId: actorIdSchema.optional(),
  clientId: clientIdSchema.optional(),
  source: interactionEndpointSchema.optional(),
  type: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema).optional(),
  targets: z.array(interactionEndpointSchema).optional(),
  payload: z.unknown(),
  severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  ttlMs: z.number().finite().positive().optional(),
})

export const buildSimulationRunActor = (actorId: Actor['id'], role: Actor['role'] = 'operator'): Actor => ({
  id: actorId,
  label: actorId,
  role,
})

export const actorIdForAccessContext = (accessContext: AccessContext): Actor['id'] =>
  accessContext.actor.id === undefined
    ? defaultOperatorActorId
    : actorIdSchema.parse(`actor:${accessContext.actor.kind}:${accessContext.actor.id}`)

export const buildSimulationRunActorForAccess = (accessContext: AccessContext): Actor =>
  buildSimulationRunActor(
    actorIdForAccessContext(accessContext),
    accessContext.actor.kind === 'ai'
      ? 'ai_agent'
      : accessContext.actor.kind === 'system'
        ? 'system'
        : 'operator',
  )

const buildSignal = (simulationRunId: SimulationRunId, raw: unknown, defaultActorId: Actor['id']): {
  readonly signal: InteractionSignal
  readonly actor: Actor
} => {
  const parsed = signalRequestSchema.parse(raw)
  const actorId = parsed.actorId ?? defaultActorId
  const targets = parsed.targets ?? parsed.targetObjectIds?.map(objectId => ({ kind: 'object' as const, id: objectId })) ?? []
  const signal = interactionSignalSchema.parse({
    id: `signal:${crypto.randomUUID()}`,
    simulationRunId,
    at: nowIso(),
    source: parsed.source ?? (parsed.clientId
      ? { kind: 'client', id: parsed.clientId }
      : { kind: 'actor', id: actorId }),
    targets,
    type: parsed.type,
    payload: parsed.payload,
    ...(parsed.severity === undefined ? {} : { severity: parsed.severity }),
    ...(parsed.correlationId === undefined ? {} : { correlationId: parsed.correlationId }),
    ...(parsed.causationId === undefined ? {} : { causationId: parsed.causationId }),
    ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
  }) as InteractionSignal
  return { signal, actor: buildSimulationRunActor(actorId) }
}

const simulationRunResponse = async (
  registry: SimulationRunRegistry,
  runtime: SimulationRunRuntime,
): Promise<{
  readonly id: typeof runtime.id
  readonly snapshot: ReturnType<SimulationRunRuntime['snapshot']>
  readonly scenarioRevisionId?: string
  readonly scenario?: CompiledScenario
}> => {
  const snapshot = runtime.snapshot()
  const [scenario, summary] = await Promise.all([registry.compiledScenarioForRun(runtime.id), registry.summary(runtime.id)])
  return {
    id: runtime.id,
    snapshot,
    ...(summary.scenarioRevisionId === null ? {} : { scenarioRevisionId: summary.scenarioRevisionId }),
    scenario,
  }
}

const handleSimulationRunApiInner = async (
  req: Request,
  url: URL,
  config: SimulationRunRouteConfig,
): Promise<Response | null> => {
  if (config.accessContext.workspaceId !== config.registry.workspaceId) {
    throw new Error(`Workspace context mismatch: expected ${config.registry.workspaceId}, got ${config.accessContext.workspaceId}`)
  }
  const apiPrefix = `/api/workspaces/${encodeURIComponent(config.registry.workspaceId)}/world`
  if (!url.pathname.startsWith(`${apiPrefix}/`)) return null
  const pathname = url.pathname.slice(apiPrefix.length)

  const scenarioMatch = pathname.match(/^\/scenarios\/([^/]+)$/)
  if (scenarioMatch && req.method === 'GET') {
    const scenarioId = decodeURIComponent(scenarioMatch[1] ?? '')
    const revision = await config.registry.currentScenario(scenarioId)
    if (!revision) return apiError(404, 'scenario_not_found', 'scenario not found')
    return json({
      source: revision.document,
      scenario: await config.registry.compileScenarioRevision(revision),
      revisionId: revision.id,
      digest: revision.digest,
    })
  }

  // Presence never loads a Run or extends its lease. Embedded views poll it to
  // decide whether a Run is live without keeping an unattended Run alive.
  const presenceMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/presence$/)
  if (presenceMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(presenceMatch[1] ?? ''))
    const summary = await config.registry.summary(simulationRunId)
    if (summary.scenarioId === null) {
      return apiError(404, 'simulation_run_not_found', summary.loadError ?? 'simulation run not found')
    }
    const execution = await config.registry.executionOverview(simulationRunId)
    return json({ simulationRunId, title: summary.title, loaded: config.registry.get(simulationRunId) !== undefined, execution })
  }

  const simulationRunMatch = pathname.match(/^\/simulation-runs\/([^/]+)$/)
  if (simulationRunMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(simulationRunMatch[1] ?? ''))
    let runtime: SimulationRunRuntime
    try {
      runtime = await config.registry.load(simulationRunId)
    } catch (err) {
      if ((err as Error).message.startsWith('Simulation Run not found:')) {
        return apiError(404, 'simulation_run_not_found', 'simulation run not found')
      }
      throw err
    }
    return json(await simulationRunResponse(config.registry, runtime))
  }

  if (simulationRunMatch && req.method === 'DELETE') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(simulationRunMatch[1] ?? ''))
    const deleted = await config.registry.delete(simulationRunId)
    if (!deleted) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json({ id: simulationRunId, deleted: true })
  }

  const snapshotMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/snapshot$/)
  if (snapshotMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(snapshotMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json(await simulationRunResponse(config.registry, runtime))
  }

  const capabilitiesMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/capabilities$/)
  if (capabilitiesMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json(runtime.capabilities())
  }

  const resetMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/reset$/)
  if (resetMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(resetMatch[1] ?? ''))
    const runtime = await config.registry.reset(simulationRunId)
    return json(await simulationRunResponse(config.registry, runtime))
  }

  const copiesMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/copies$/)
  if (copiesMatch && req.method === 'POST') {
    const sourceId = simulationRunIdSchema.parse(decodeURIComponent(copiesMatch[1] ?? ''))
    const input = runCopyInputSchema.parse(await readJson(req))
    const result = await config.registry.copy(sourceId, input.name === undefined ? {} : { name: input.name })
    return json({
      id: result.id,
      uiPath: `/workspaces/${encodeURIComponent(config.registry.workspaceId)}/world/runs/${encodeURIComponent(result.id)}`,
    }, { status: 201 })
  }

  const objectsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/objects$/)
  if (objectsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(objectsMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    return json({ objects: runtime.snapshot().objects })
  }

  const objectMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/objects\/([^/]+)$/)
  if (objectMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(objectMatch[1] ?? ''))
    const objectId = objectIdSchema.parse(decodeURIComponent(objectMatch[2] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const object = runtime.snapshot().objects.find(candidate => candidate.id === objectId)
    if (!object) return apiError(404, 'object_not_found', 'object not found')
    return json({ object })
  }

  const eventsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/events$/)
  if (eventsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(eventsMatch[1] ?? ''))
    const afterSeqParam = url.searchParams.get('afterSeq')
    const afterSeq = afterSeqParam === null ? undefined : z.coerce.number().int().nonnegative().parse(afterSeqParam)
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const events = runtime.events(afterSeq === undefined ? {} : { afterSeq })
    return json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq ?? 0 })
  }

  const historySamplesMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/history\/samples$/)
  if (historySamplesMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(historySamplesMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const optional = (name: string): string | undefined => url.searchParams.get(name) ?? undefined
    const limitParam = optional('limit')
    const historyTimestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
    const query = {
      ...(optional('runtimeId') === undefined ? {} : { runtimeId: z.string().min(1).max(128).parse(optional('runtimeId')) }),
      ...(optional('seriesId') === undefined ? {} : { seriesId: z.string().min(1).max(128).parse(optional('seriesId')) }),
      ...(optional('subjectId') === undefined ? {} : { subjectId: z.string().min(1).max(128).parse(optional('subjectId')) }),
      ...(optional('signalId') === undefined ? {} : { signalId: z.string().min(1).max(512).parse(optional('signalId')) }),
      ...(optional('from') === undefined ? {} : { from: historyTimestamp.parse(optional('from')) }),
      ...(optional('to') === undefined ? {} : { to: historyTimestamp.parse(optional('to')) }),
      ...(limitParam === undefined ? {} : { limit: z.coerce.number().int().positive().max(10_000).parse(limitParam) }),
    }
    return json(runtime.recordedSamples(recordingSeriesQuerySchema.parse({ ...query,
      mode: optional('mode'),
      ...(optional('timeAxis') === undefined ? {} : { timeAxis: z.enum(['observed', 'simulation']).parse(optional('timeAxis')) }),
      ...(optional('beforeSequence') === undefined ? {} : { beforeSequence: z.coerce.number().int().positive().parse(optional('beforeSequence')) }),
    })))
  }

  const historyMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/history$/)
  if (historyMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(historyMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const status = runtime.recordingStatus()
    return json({ status, series: status?.captureState === 'unavailable' ? null : runtime.recordingSeries() })
  }

  const invocationMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
  if (invocationMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(invocationMatch[1] ?? ''))
    const capabilityId = decodeURIComponent(invocationMatch[2] ?? '')
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const invocation = capabilityInvocationRequestSchema.parse(await readJson(req))
    try {
      const actor = buildSimulationRunActorForAccess(config.accessContext)
      const outcome = await runtime.invokeCapability(actor, {
        capabilityId,
        input: invocation.input,
        ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
        ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
      })
      return json(outcome)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof CommandIdempotencyConflictError) {
        return apiError(error.status, error.code, reason)
      }
      return apiError(400, 'capability_invocation_failed', reason)
    }
  }

  const procedureCatalogMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedures$/)
  if (procedureCatalogMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureCatalogMatch[1] ?? ''))
    const runtime = await config.registry.load(simulationRunId)
    const sourceIdParam = url.searchParams.get('sourceId')
    const refresh = url.searchParams.get('refresh') === 'true'
    const catalog = await runtime.procedureCatalog({
      ...(sourceIdParam === null ? {} : { sourceId: procedureSourceIdSchema.parse(sourceIdParam) }),
      refresh,
    })
    return json({ catalog })
  }

  const procedureDocumentMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedures\/([^/]+)$/)
  if (procedureDocumentMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureDocumentMatch[1] ?? ''))
    const procedureId = procedureIdSchema.parse(decodeURIComponent(procedureDocumentMatch[2] ?? ''))
    const runtime = await config.registry.load(simulationRunId)
    const sourceIdParam = url.searchParams.get('sourceId')
    const sourceRevisionParam = url.searchParams.get('sourceRevision')
    const sourcePathParam = url.searchParams.get('sourcePath')
    if (sourcePathParam !== null && sourceRevisionParam === null) {
      return apiError(400, 'invalid_procedure_source_reference', 'sourcePath requires sourceRevision')
    }
    const procedure = await runtime.procedureDocument({
      procedureId,
      ...(sourceIdParam === null ? {} : { sourceId: procedureSourceIdSchema.parse(sourceIdParam) }),
      ...(sourceRevisionParam === null ? {} : { sourceRevision: sourceRevisionSchema.parse(sourceRevisionParam) }),
      ...(sourcePathParam === null ? {} : { sourcePath: sourceDocumentPathSchema.parse(sourcePathParam) }),
    })
    return json({ procedure })
  }

  const procedureRunsMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/procedure-runs$/)
  if (procedureRunsMatch && req.method === 'GET') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(procedureRunsMatch[1] ?? ''))
    const runtime = await config.registry.load(simulationRunId)
    return json({ procedures: runtime.snapshot().procedures ?? { runs: [] } })
  }

  const signalMatch = pathname.match(/^\/simulation-runs\/([^/]+)\/signals$/)
  if (signalMatch && req.method === 'POST') {
    const simulationRunId = simulationRunIdSchema.parse(decodeURIComponent(signalMatch[1] ?? ''))
    const runtime = config.registry.get(simulationRunId)
    if (!runtime) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    const raw = await readJson(req)
    const { signal, actor } = buildSignal(simulationRunId, raw, actorIdForAccessContext(config.accessContext))
    await runtime.publishInteractionSignal(signal, { source: actor.id.startsWith('actor:ai') ? 'ai' : 'operator' })
    return json({ signal }, { status: 202 })
  }

  return null
}

export const handleSimulationRunApi = async (
  req: Request,
  url: URL,
  config: SimulationRunRouteConfig,
): Promise<Response | null> => {
  let release: (() => void) | undefined
  try {
    const match = url.pathname.match(/\/world\/simulation-runs\/([^/]+)(?:\/|$)/)
    if (match && req.method !== 'DELETE' && !url.pathname.endsWith('/reset') && !url.pathname.endsWith('/presence')) release = config.registry.acquireLease(simulationRunIdSchema.parse(decodeURIComponent(match[1]!)), 'api')
    return await handleSimulationRunApiInner(req, url, config)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Simulation Run not found:')) return apiError(404, 'simulation_run_not_found', 'simulation run not found')
    if (err instanceof Error && 'code' in err && err.code === 'storage_budget_exceeded') return apiError(507, 'storage_budget_exceeded', err.message)
    if (err instanceof Error && 'code' in err && err.code === 'history_unavailable') return apiError(503, 'history_unavailable', err.message)
    if (err instanceof Error && 'code' in err && err.code === 'simulation_run_busy') return apiError(409, 'simulation_run_busy', err.message)
    if (err instanceof Error && 'code' in err && err.code === 'simulation_run_failed') return apiError(409, 'simulation_run_failed', err.message)
    if (err instanceof Error && 'code' in err && typeof err.code === 'string'
      && ['simulation_run_commit_uncertain', 'simulation_run_observer_failed', 'simulation_run_recovery_required'].includes(err.code)) return apiError(409, err.code, err.message)
    if (err instanceof Error && 'code' in err && err.code === 'fast_forward_unsupported') return apiError(422, 'fast_forward_unsupported', err.message)
    if (err instanceof SyntaxError) return apiError(400, 'invalid_json', err.message)
    if (err instanceof z.ZodError) return apiError(400, 'invalid_request', err.message)
    throw err
  } finally { release?.() }
}
