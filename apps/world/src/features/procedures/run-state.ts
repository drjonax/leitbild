import type {
  CommandEnvelope, SimulationRunEvent, SimulationRunId, EventId, IsoTimestamp,
  ProcedureControlState, ProcedureDocument, ProcedureRunScope, ProcedureRunState,
  Provenance, OperationalObject,
} from '../../core/model/index.ts'
import {
  sameProcedureScope, createProcedureRunId, procedureCommandKindSchema, procedureRunClosePayloadSchema,
  procedureRunResetPayloadSchema, procedureRunStartPayloadSchema, procedureStepUpdatePayloadSchema,
  procedureRunTransitionPayloadSchema,
} from '../../core/model/index.ts'

export interface ProcedureCommitContext {
  readonly simulationRunId: SimulationRunId
  readonly at: IsoTimestamp
  readonly simulationTime?: IsoTimestamp
  readonly commandSource?: Provenance['source']
  readonly procedures: ProcedureControlState | undefined
  readonly objectIds: ReadonlySet<string>
  readonly objects?: ReadonlyMap<string, OperationalObject>
  readonly factory: { readonly eventId: () => EventId; readonly nextSeq: () => number }
}

const activeRunFor = (procedures: ProcedureControlState | undefined, runId: string): ProcedureRunState => {
  const run = procedures?.runs.find(candidate => candidate.runId === runId)
  if (!run) throw new Error(`procedure run not found: ${runId}`)
  if (run.status !== 'active') throw new Error(`procedure run is not active: ${runId}`)
  return run
}

const currentRunFor = (state: ProcedureControlState | undefined, sourceId: string, procedureId: string, scope: ProcedureRunScope) =>
  state?.runs.find(run => run.sourceId === sourceId && run.procedureId === procedureId
    && sameProcedureScope(run.scope, scope) && run.status !== 'abandoned')

const assertLiveScope = (context: ProcedureCommitContext, scope: ProcedureRunScope): void => {
  if (scope.targetObjectId !== undefined && scope.targetObjectId !== scope.plantId) {
    throw new Error('procedure targetObjectId must match the canonical plantId')
  }
  if (!context.objectIds.has(scope.plantId)) throw new Error(`procedure target no longer exists: ${scope.plantId}`)
}

const assertInstalledProcedure = (document: ProcedureDocument): void => {
  if (document.annotations?.['runtime-bindings'] === 'uninstalled') {
    throw new Error(`Procedure ${document.procedureId} is design guidance with uninstalled runtime bindings; read its specification instead of starting or transferring a live procedure.`)
  }
}

// Network work happens outside the Simulation Run commit queue. The returned
// function is synchronous and rechecks mutable state inside that queue.
export const prepareProcedureCommand = async (config: {
  readonly command: CommandEnvelope
  readonly procedures: ProcedureControlState | undefined
  readonly assertTargetApplicable?: (document: ProcedureDocument, object: OperationalObject) => void
  readonly readDocument: (config: {
    readonly sourceId: string; readonly procedureId: string
    readonly sourceRevision: string; readonly sourcePath?: string
  }) => Promise<ProcedureDocument>
}): Promise<((context: ProcedureCommitContext) => ReadonlyArray<SimulationRunEvent>) | null> => {
  const { command } = config
  const assertDocumentScope = (context: ProcedureCommitContext, document: ProcedureDocument, scope: ProcedureRunScope): void => {
    assertLiveScope(context, scope)
    if (config.assertTargetApplicable) {
      const object = context.objects?.get(scope.plantId)
      if (!object) throw new Error(`Canonical procedure target unavailable at commit: ${scope.plantId}`)
      config.assertTargetApplicable(document, object)
    }
  }
  const kind = procedureCommandKindSchema.safeParse(command.kind)
  if (!kind.success) return null
  const base = (context: ProcedureCommitContext) => ({
    id: context.factory.eventId(), simulationRunId: context.simulationRunId,
    seq: context.factory.nextSeq(), at: context.at,
    provenance: { source: context.commandSource ?? 'operator', causedByCommandId: command.id },
  })
  const started = (context: ProcedureCommitContext, document: ProcedureDocument, scope: ProcedureRunScope, entryStepId?: string): SimulationRunEvent => ({
    ...base(context), type: 'procedure.run.started',
    run: {
      runId: createProcedureRunId(), sourceId: document.source.sourceId,
      sourceRevision: document.source.revision, sourcePath: document.sourcePath,
      procedureId: document.procedureId, scope, title: document.title, status: 'active',
      startedAt: context.at, startedBy: command.actorId,
      ...(entryStepId ?? document.steps[0]?.id ? { currentStepId: entryStepId ?? document.steps[0]!.id } : {}), stepStates: [],
    },
  })

  if (kind.data === 'world.procedure.run.start') {
    const payload = procedureRunStartPayloadSchema.parse(command.payload)
    const document = await config.readDocument(payload)
    assertInstalledProcedure(document)
    return context => {
      assertDocumentScope(context, document, payload.scope)
      const existing = currentRunFor(context.procedures, payload.sourceId, payload.procedureId, payload.scope)
      if (existing?.status === 'transferred' && existing.sourceRevision === document.source.revision && existing.sourcePath === document.sourcePath) {
        return [{ ...base(context), type: 'procedure.run.resumed', runId: existing.runId,
          resumedAt: context.at, resumedBy: command.actorId }]
      }
      if (existing) {
        throw new Error(`procedure ${payload.procedureId} already has current run state for ${payload.scope.plantId}; reset it before starting another run`)
      }
      return [started(context, document, payload.scope)]
    }
  }
  if (kind.data === 'world.procedure.run.reset') {
    const payload = procedureRunResetPayloadSchema.parse(command.payload)
    return context => {
      assertLiveScope(context, payload.scope)
      return [{ ...base(context), type: 'procedure.run.reset', ...payload, resetAt: context.at, resetBy: command.actorId }]
    }
  }
  if (kind.data === 'world.procedure.run.close') {
    const payload = procedureRunClosePayloadSchema.parse(command.payload)
    return context => {
      assertLiveScope(context, activeRunFor(context.procedures, payload.runId).scope)
      return [{ ...base(context), type: 'procedure.run.closed', ...payload, closedAt: context.at, closedBy: command.actorId }]
    }
  }

  const payload = kind.data === 'world.procedure.run.transition'
    ? procedureRunTransitionPayloadSchema.parse(command.payload)
    : procedureStepUpdatePayloadSchema.parse(command.payload)
  const preparedRun = activeRunFor(config.procedures, payload.runId)
  const document = await config.readDocument(preparedRun)
  assertInstalledProcedure(document)
  const step = document.steps.find(step => step.id === payload.stepId)
  if (!step) throw new Error(`procedure step ${payload.stepId} is not part of ${document.procedureId}`)

  if ('branchIndex' in payload) {
    const branch = step.branches[payload.branchIndex]
    if (!branch || branch.targetKind === 'unknown') throw new Error('transition requires an actionable declared branch')
    if (branch.targetKind === 'procedure' && branch.target === document.procedureId) throw new Error('use a local step target for same-procedure navigation')
    if (branch.targetKind === 'step' && !document.steps.some(candidate => candidate.id === branch.target)) throw new Error('branch step target does not exist')
    const targetDocument = branch.targetKind === 'procedure' ? await config.readDocument({
      sourceId: preparedRun.sourceId, sourceRevision: preparedRun.sourceRevision, procedureId: branch.target,
    }) : undefined
    if (targetDocument) assertInstalledProcedure(targetDocument)
    if (targetDocument && !targetDocument.steps.length) throw new Error(`procedure ${targetDocument.procedureId} has no entry step`)
    if (targetDocument && branch.targetStepId !== undefined && !targetDocument.steps.some(step => step.id === branch.targetStepId)) {
      throw new Error(`procedure ${targetDocument.procedureId} does not contain destination step ${branch.targetStepId}`)
    }
    const preparedTarget = targetDocument ? currentRunFor(config.procedures, preparedRun.sourceId, targetDocument.procedureId, preparedRun.scope) : undefined
    return context => {
      const run = activeRunFor(context.procedures, payload.runId)
      assertDocumentScope(context, document, run.scope)
      if (targetDocument) assertDocumentScope(context, targetDocument, run.scope)
      // Deliberate off-path decisions remain possible, but asynchronously prepared
      // requests must not race another operator's newly accepted navigation.
      if (run.currentStepId !== preparedRun.currentStepId) throw new Error('procedure current step changed; refresh before selecting this branch')
      const target = targetDocument ? currentRunFor(context.procedures, run.sourceId, targetDocument.procedureId, run.scope) : undefined
      if (branch.targetStepId !== undefined && (target?.runId !== preparedTarget?.runId || target?.currentStepId !== preparedTarget?.currentStepId || target?.status !== preparedTarget?.status)) {
        throw new Error('destination procedure state changed; refresh before selecting this branch')
      }
      if (target && (target.status === 'completed' || target.sourceRevision !== run.sourceRevision || target.sourcePath !== targetDocument?.sourcePath)) {
        throw new Error('destination procedure must be unstarted, active or transferred at the same source revision; reset a completed destination explicitly')
      }
      const result: SimulationRunEvent[] = []
      if (targetDocument && !target) result.push(started(context, targetDocument, run.scope, branch.targetStepId))
      if (target?.status === 'transferred') result.push({ ...base(context), type: 'procedure.run.resumed',
        runId: target.runId, resumedAt: context.at, resumedBy: command.actorId })
      if (target && branch.targetStepId !== undefined) result.push({ ...base(context), type: 'procedure.step.updated', runId: target.runId,
        stepId: branch.targetStepId, currentStepId: branch.targetStepId, update: {}, updatedAt: context.at, updatedBy: command.actorId })
      result.push({ ...base(context), type: 'procedure.branch.selected', runId: run.runId, stepId: step.id,
        branchIndex: payload.branchIndex, label: branch.label, target: branch.target, targetKind: branch.targetKind,
        ...(branch.targetStepId === undefined ? {} : { targetStepId: branch.targetStepId }),
        ...(branch.outcome === undefined ? {} : { outcome: branch.outcome }),
        ...(branch.execution === undefined ? {} : { execution: branch.execution }),
        simulationTime: context.simulationTime ?? context.at, selectedBy: command.actorId,
        ...(run.observations?.find(item => item.stepId === step.id) === undefined ? {} : {
          observation: run.observations!.find(item => item.stepId === step.id)!,
        }) })
      const assessment = branch.outcome === 'normal' ? 'complete' as const : branch.outcome === 'rno' ? 'failed' as const : branch.outcome === 'unknown' ? 'unknown' as const : undefined
      const currentStepId = branch.targetKind === 'step' ? branch.target : step.id
      result.push(
        { ...base(context), type: 'procedure.step.updated', runId: run.runId, stepId: step.id,
          update: assessment === undefined ? {} : { assessment }, currentStepId, updatedAt: context.at, updatedBy: command.actorId })
      if (branch.targetKind === 'end' || branch.targetKind === 'abort' || (branch.targetKind === 'procedure' && branch.execution !== 'parallel')) {
        result.push({ ...base(context), type: 'procedure.run.closed', runId: run.runId,
          status: branch.targetKind === 'end' ? 'completed' : branch.targetKind === 'abort' ? 'abandoned' : 'transferred',
          closedAt: context.at, closedBy: command.actorId })
      }
      return result
    }
  }
  if (payload.currentStepId !== undefined && !document.steps.some(step => step.id === payload.currentStepId)) {
    throw new Error(`procedure current step ${payload.currentStepId} is not part of ${document.procedureId}`)
  }
  return context => {
    assertDocumentScope(context, document, activeRunFor(context.procedures, payload.runId).scope)
    return [{
      ...base(context), type: 'procedure.step.updated', runId: payload.runId, stepId: payload.stepId,
      update: {
        ...(payload.assessment === undefined ? {} : { assessment: payload.assessment }),
        ...(payload.comment === undefined ? {} : { comment: payload.comment }),
        ...(payload.favorite === undefined ? {} : { favorite: payload.favorite }),
      },
      ...(payload.currentStepId === undefined ? {} : { currentStepId: payload.currentStepId }),
      updatedAt: context.at, updatedBy: command.actorId,
    }]
  }
}
