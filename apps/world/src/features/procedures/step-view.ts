import { z } from 'zod'
import {
  isoTimestampSchema, procedureAssessmentSchema, procedureBranchSchema, procedureRunDriverSchema,
  procedureRunIdSchema, procedureRunStatusSchema, procedureStepDecisionSchema, procedureTextBlockSchema,
  type IsoTimestamp, type ProcedureDocument, type ProcedureRunState, type ProcedureStep,
} from '../../core/model/index.ts'
import { readProcedureTags, type ProcedureObservationPort, type ProcedureTagRead } from './pack-observations.ts'

// One step of a live procedure Run, compact enough to work through step by
// step: what it says, its branches, the step's tags as World reads them on
// the run's plant now, and the safety function colours the document
// monitors. Empty fields are left out.

const stepCommentLength = 500

const runSummarySchema = z.object({
  runId: procedureRunIdSchema,
  procedureId: z.string(),
  title: z.string(),
  status: procedureRunStatusSchema,
  plantId: z.string(),
  unit: z.string().optional(),
  driver: procedureRunDriverSchema.optional(),
  currentStepId: z.string().optional(),
  /** The position of the step read, of the document's steps. */
  stepNumber: z.number().int().positive().optional(),
  totalSteps: z.number().int().nonnegative(),
}).strict()

/** A value World read for the view, just before its simulationTime. */
const tagReadingSchema = z.object({
  formatted: z.string(),
  /** The model variable read, where its value means nothing without it: an on/off state, or a unit the tag asks for that the model does not give. */
  signal: z.string().optional(),
  quality: z.string().optional(),
  /** The Pack's caveat on this value (such as a requested unit it could not convert to), unless a binding warning says it. */
  note: z.string().optional(),
}).strict()

const stepTagSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  binding: z.enum(['resolved', 'resolved-with-warnings', 'missing', 'unchecked']),
  warnings: z.array(z.string()).optional(),
  notes: z.record(z.string(), z.string()).optional(),
  reading: tagReadingSchema.optional(),
  unavailable: z.string().optional(),
}).strict()

const stepBranchSchema = z.object({
  index: z.number().int().nonnegative(),
  label: z.string(),
  outcome: procedureBranchSchema.shape.outcome,
  targetKind: procedureBranchSchema.shape.targetKind,
  target: z.string(),
  /** The label of the step it leads to, where that is a step of this procedure ("11" for step 11). */
  targetLabel: z.string().optional(),
  targetStepId: z.string().optional(),
  execution: procedureBranchSchema.shape.execution,
  because: z.string().optional(),
}).strict()

const stepSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Where it says more than "Step <label>". */
  title: z.string().optional(),
  blocks: z.array(z.object({ kind: procedureTextBlockSchema.shape.kind, text: z.string() }).strict()),
  branches: z.array(stepBranchSchema),
  observation: z.object({ status: z.enum(['satisfied', 'challenged', 'unknown']), reason: z.string().optional(), simulationTime: isoTimestampSchema }).strict().optional(),
  state: z.object({
    assessment: procedureAssessmentSchema,
    comment: z.string().optional(),
    decision: procedureStepDecisionSchema.optional(),
  }).strict().optional(),
}).strict()

const csfSchema = z.object({
  id: z.string(),
  status: z.enum(['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored']),
  procedure: z.string().optional(),
  reason: z.string().optional(),
}).strict()

export const procedureStepViewSchema = z.object({
  /** The journal sequence the view was read at: pass it to world.simulation-run.wait. */
  sequence: z.number().int().nonnegative(),
  simulationTime: isoTimestampSchema,
  paused: z.literal(true).optional(),
  run: runSummarySchema,
  step: stepSchema.optional(),
  tags: z.array(stepTagSchema).optional(),
  csfs: z.array(csfSchema).optional(),
}).strict()
export type ProcedureStepView = z.infer<typeof procedureStepViewSchema>

export interface ProcedureStepViewPorts {
  readonly sequence: () => number
  readonly clock: () => { readonly currentTime: IsoTimestamp; readonly paused: boolean }
  /** The run scope's observations, read as the caller. */
  readonly observations: () => ProcedureObservationPort
}

export const procedureStepNotFoundCode = 'procedure_step_not_found'

// Link targets carry nothing a step is decided by; their words stay.
const withoutLinkTargets = (text: string): string => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

// Technical basis text and its links explain a step; they do not decide it.
const omittedBlockKinds = new Set(['basis'])

const runSummary = (run: ProcedureRunState, document: ProcedureDocument, step?: ProcedureStep) => {
  const stepIndex = step === undefined ? -1 : document.steps.findIndex(candidate => candidate.id === step.id)
  return {
    runId: run.runId,
    procedureId: run.procedureId,
    title: run.title,
    status: run.status,
    plantId: run.scope.plantId,
    ...(run.scope.label === undefined ? {} : { unit: run.scope.label }),
    ...(run.driver === undefined ? {} : { driver: run.driver }),
    ...(run.currentStepId === undefined ? {} : { currentStepId: run.currentStepId }),
    ...(stepIndex < 0 ? {} : { stepNumber: stepIndex + 1 }),
    totalSteps: document.steps.length,
  }
}

const tagRow = (document: ProcedureDocument, read: ProcedureTagRead) => {
  const tag = document.tags.find(candidate => candidate.id === read.tagId)
  const notes = tag?.annotations ?? {}
  return {
    id: read.tagId,
    ...(tag?.description === undefined ? {} : { description: tag.description }),
    binding: read.binding,
    ...(read.warnings.length === 0 ? {} : { warnings: read.warnings }),
    ...(Object.keys(notes).length === 0 ? {} : { notes }),
    ...(read.value === undefined ? {} : { reading: {
      formatted: read.value.formatted,
      ...(read.value.path !== undefined && (typeof read.value.value === 'boolean' || read.value.conversionStatus === 'unavailable') ? { signal: read.value.path } : {}),
      ...(read.value.quality === undefined ? {} : { quality: read.value.quality }),
      ...(read.value.warning === undefined || read.warnings.includes(read.value.warning) ? {} : { note: read.value.warning }),
    } }),
    ...(read.value === undefined ? { unavailable: read.unavailable ?? 'no value' } : {}),
  }
}

const csfRows = async (document: ProcedureDocument, ports: ProcedureStepViewPorts) => {
  if (document.csfsMonitored.length === 0) return undefined
  try {
    const evaluations = await ports.observations().evaluateCsfs(document.csfsMonitored)
    return document.csfsMonitored.map(id => {
      const evaluation = evaluations.get(id)
      if (evaluation === undefined) return { id, status: 'unknown' as const, reason: 'not evaluated by the plant' }
      return {
        id,
        status: evaluation.status,
        ...(evaluation.procedure === undefined ? {} : { procedure: evaluation.procedure }),
        ...(evaluation.status === 'green' || evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
      }
    })
  } catch (error) {
    const reason = `unavailable: ${error instanceof Error ? error.message : String(error)}`
    return document.csfsMonitored.map(id => ({ id, status: 'unknown' as const, reason }))
  }
}

/** The run alone, as a transfer or END leaves it: no step to work. */
export const composeProcedureRunView = (config: {
  readonly run: ProcedureRunState
  readonly document: ProcedureDocument
  readonly ports: Pick<ProcedureStepViewPorts, 'sequence' | 'clock'>
}): ProcedureStepView => {
  const clock = config.ports.clock()
  return procedureStepViewSchema.parse({
    sequence: config.ports.sequence(),
    simulationTime: clock.currentTime,
    ...(clock.paused ? { paused: true } : {}),
    run: runSummary(config.run, config.document),
  })
}

/** One step of a run (its current step unless stepId), as step.read returns it and an AI agent's transition answers with. */
export const composeProcedureStepView = async (config: {
  readonly run: ProcedureRunState
  readonly document: ProcedureDocument
  readonly stepId?: string
  readonly ports: ProcedureStepViewPorts
}): Promise<ProcedureStepView> => {
  const { run, document, ports } = config
  const stepId = config.stepId ?? run.currentStepId
  if (stepId === undefined) return composeProcedureRunView(config)
  const step = document.steps.find(candidate => candidate.id === stepId)
  if (step === undefined) {
    throw Object.assign(new Error(`Procedure ${document.procedureId} has no step ${stepId}; its steps are ${document.steps.map(candidate => candidate.id).join(', ')}.`), { code: procedureStepNotFoundCode })
  }
  const [reads, csfs] = await Promise.all([
    readProcedureTags({ observations: ports.observations, declared: document.tags, tagIds: step.tagIds }),
    csfRows(document, ports),
  ])
  const observation = run.observations?.find(item => item.stepId === step.id)
  const labels = new Map(document.steps.map(candidate => [candidate.id, candidate.label]))
  const state = run.stepStates.find(item => item.stepId === step.id)
  // Read the clock after the reads, so the view's plant time is not older than its readings.
  const clock = ports.clock()
  return procedureStepViewSchema.parse({
    sequence: ports.sequence(),
    simulationTime: clock.currentTime,
    ...(clock.paused ? { paused: true } : {}),
    run: runSummary(run, document, step),
    step: {
      id: step.id,
      label: step.label,
      ...(step.title === `Step ${step.label}` ? {} : { title: step.title }),
      blocks: step.blocks.filter(block => !omittedBlockKinds.has(block.kind)).map(block => ({ kind: block.kind, text: withoutLinkTargets(block.text) })),
      branches: step.branches.map((branch, index) => ({
        index,
        label: branch.label,
        ...(branch.outcome === undefined ? {} : { outcome: branch.outcome }),
        targetKind: branch.targetKind,
        target: branch.target,
        ...(branch.targetKind === 'step' && labels.has(branch.target) ? { targetLabel: labels.get(branch.target)! } : {}),
        ...(branch.targetStepId === undefined ? {} : { targetStepId: branch.targetStepId }),
        ...(branch.execution === undefined ? {} : { execution: branch.execution }),
        ...(branch.because === undefined ? {} : { because: withoutLinkTargets(branch.because) }),
      })),
      ...(observation === undefined ? {} : { observation: {
        status: observation.result.status,
        ...(observation.result.reason === undefined ? {} : { reason: observation.result.reason }),
        simulationTime: observation.simulationTime,
      } }),
      ...(state === undefined ? {} : { state: {
        assessment: state.assessment,
        ...(state.comment === undefined ? {} : {
          comment: state.comment.length <= stepCommentLength ? state.comment : `${state.comment.slice(0, stepCommentLength - 1)}…`,
        }),
        ...(state.decision === undefined ? {} : { decision: state.decision }),
      } }),
    },
    ...(reads.length === 0 ? {} : { tags: reads.map(read => tagRow(document, read)) }),
    ...(csfs === undefined ? {} : { csfs }),
  })
}
