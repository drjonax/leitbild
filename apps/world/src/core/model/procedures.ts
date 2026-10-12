import { z } from 'zod'
import { parseProcedureAssessment, type ProcedureAssessment as AuthoredProcedureAssessment } from '@leitbild/procmd'
import { sourceDocumentPathSchema, sourceRevisionSchema } from '@leitbild/contracts'
import { actorIdSchema, commandIdSchema, idSchema, objectIdSchema } from './ids.ts'
import { isoTimestampSchema } from './time.ts'

export const procedureSourceIdSchema = idSchema
export const procedureIdSchema = z.string().min(1).max(80).regex(/^[A-Z0-9][A-Z0-9._-]*$/)
export const procedureStepIdSchema = idSchema
export const procedureTagIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
export const procedureRunIdSchema = z.string().min(1).max(128).regex(/^procedure-run:[a-zA-Z0-9._:-]+$/)

// Citations may target the Host's wiki reader without assuming a deployment origin.
// This is not a redirect or fetch-target schema.
export const procedureSourceUrlSchema = z.string().refine(value => {
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return false
  if (value.startsWith('/')) return !value.startsWith('//')
  return z.url({ protocol: /^https?$/ }).safeParse(value).success
}, 'Expected an HTTP(S) URL or a safe root-relative source reference')

export type ProcedureSourceId = z.infer<typeof procedureSourceIdSchema>
export type ProcedureId = z.infer<typeof procedureIdSchema>
export type ProcedureStepId = z.infer<typeof procedureStepIdSchema>
export type ProcedureTagId = z.infer<typeof procedureTagIdSchema>
export type ProcedureRunId = z.infer<typeof procedureRunIdSchema>

export const procedureRunScopeSchema = z.object({
  plantId: idSchema.describe('Canonical id of the live operational object this procedure concerns.'),
  targetObjectId: objectIdSchema.optional(),
  label: z.string().min(1).max(160).optional(),
})
export type ProcedureRunScope = z.infer<typeof procedureRunScopeSchema>

// Optional display/reference metadata must not create a second operational scope.
export const sameProcedureScope = (left: ProcedureRunScope, right: ProcedureRunScope): boolean =>
  left.plantId === right.plantId

export const procedureAssessmentSchema = z.enum(['blank', 'complete', 'failed', 'unknown'])
export type ProcedureAssessment = z.infer<typeof procedureAssessmentSchema>


export const procedureSourceSchema = z.object({
  sourceId: procedureSourceIdSchema,
  label: z.string().min(1),
  repository: z.string().min(1),
  ref: z.string().min(1),
  path: z.string().min(1),
  revision: sourceRevisionSchema,
  fetchedAt: isoTimestampSchema,
  sourceUrl: procedureSourceUrlSchema,
})
export type ProcedureSource = z.infer<typeof procedureSourceSchema>

export const procedureTagSchema = z.object({
  id: procedureTagIdSchema,
  description: z.string().min(1).optional(),
  simPath: z.string().min(1).optional(),
  units: z.string().min(1).optional(),
  equipment: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  range: z.array(z.number().finite()).length(2).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
})
export type ProcedureTag = z.infer<typeof procedureTagSchema>

export const procedureTextBlockSchema = z.object({
  kind: z.enum(['check', 'action', 'expected', 'rno', 'unknown', 'basis', 'decision', 'when', 'until', 'abort-if', 'abort-to', 'within', 'concurrent', 'caution', 'note', 'because', 'against', 'text']),
  text: z.string().min(1),
  paths: z.array(z.string()).optional(),
  sourceLine: z.number().int().positive(),
  tagIds: z.array(procedureTagIdSchema).default([]),
})
export type ProcedureTextBlock = z.infer<typeof procedureTextBlockSchema>

export const procedureBranchSchema = z.object({
  label: z.string().min(1),
  target: z.string().min(1),
  targetKind: z.enum(['step', 'procedure', 'end', 'retry', 'abort', 'unknown']),
  targetStepId: procedureStepIdSchema.optional(),
  outcome: z.enum(['normal', 'rno', 'unknown']).optional(),
  execution: z.enum(['transfer', 'parallel']).optional(),
  because: z.string().min(1).optional(),
  against: z.string().min(1).optional(),
  sourceLine: z.number().int().positive(),
  tagIds: z.array(procedureTagIdSchema).default([]),
})
export type ProcedureBranch = z.infer<typeof procedureBranchSchema>

export const procedureStepSchema = z.object({
  id: procedureStepIdSchema,
  label: z.string().min(1),
  title: z.string().min(1),
  level: z.number().int().min(2).max(6),
  blocks: z.array(procedureTextBlockSchema).default([]),
  branches: z.array(procedureBranchSchema).default([]),
  tagIds: z.array(procedureTagIdSchema).default([]),
  sourceLine: z.number().int().positive(),
  sourceEndLine: z.number().int().positive(),
  assessment: z.unknown().transform((value, context): AuthoredProcedureAssessment | typeof z.NEVER => {
    try { return parseProcedureAssessment(value) }
    catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
  }).optional().describe('Authored engineering criterion tree, not a live observation or execution. Comparison operands identify exact declared tag, native unit, interval bound, evidence class, source and maximum age; all/any/not/vote combine them, held requires continuous simulation-time duration, manual names physical judgment. Uninstalled criteria cannot imply automatic success.'),
  observation: z.object({
    capabilityId: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    continuous: z.boolean(),
  }).strict().optional(),
})
export type ProcedureStep = z.infer<typeof procedureStepSchema>

export const procedureDocumentSchema = z.object({
  source: procedureSourceSchema,
  procedureId: procedureIdSchema,
  title: z.string().min(1),
  profile: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  appliesTo: z.string().min(1).optional(),
  referencePlant: z.string().min(1).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  diagnostics: z.array(z.string()).optional(),
  csfsMonitored: z.array(idSchema).default([]),
  entryTriggers: z.array(idSchema).default([]),
  description: z.string().default(''),
  sourcePath: sourceDocumentPathSchema,
  sourceUrl: procedureSourceUrlSchema,
  rawMarkdown: z.string(),
  steps: z.array(procedureStepSchema).default([]),
  tags: z.array(procedureTagSchema).default([]),
})
export type ProcedureDocument = z.infer<typeof procedureDocumentSchema>

export const procedureCatalogItemSchema = z.object({
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  title: z.string().min(1),
  profile: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  appliesTo: z.string().min(1).optional(),
  referencePlant: z.string().min(1).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  csfsMonitored: z.array(idSchema).default([]),
  entryTriggers: z.array(idSchema).default([]),
  stepCount: z.number().int().nonnegative(),
  tagCount: z.number().int().nonnegative(),
  sourcePath: sourceDocumentPathSchema,
  sourceUrl: procedureSourceUrlSchema,
})
export type ProcedureCatalogItem = z.infer<typeof procedureCatalogItemSchema>

export const procedureCatalogSchema = z.object({
  source: procedureSourceSchema,
  procedures: z.array(procedureCatalogItemSchema),
})
export type ProcedureCatalog = z.infer<typeof procedureCatalogSchema>

/** Who works a procedure Run. Absent: shared, anyone may. A person driving holds AI agents to reading it. */
export const procedureRunDriverSchema = z.object({
  kind: z.enum(['ai', 'person']),
  actorId: actorIdSchema,
  /** The actor's display name when the request named one. */
  label: z.string().min(1).max(80).optional(),
  since: isoTimestampSchema,
})
export type ProcedureRunDriver = z.infer<typeof procedureRunDriverSchema>

/** A reading World took of a cited tag when it accepted a branch: the value as formatted, or why none. */
export const procedureDecisionEvidenceSchema = z.object({
  tagId: procedureTagIdSchema,
  reading: z.string().min(1).max(160),
})

/** A branch selection's basis: up to 300 characters and up to six of the step's own tags, which World reads at commit. */
export const procedureDecisionBasisSchema = z.object({
  basis: z.string().trim().min(1).max(300).optional(),
  evidenceTagIds: z.array(procedureTagIdSchema).min(1).max(6).optional(),
})

/** The latest branch selected on a step, with who chose it and why. The journal keeps every earlier one. */
export const procedureStepDecisionSchema = z.object({
  branchIndex: z.number().int().nonnegative(),
  label: z.string().min(1).optional(),
  outcome: z.enum(['normal', 'rno', 'unknown']).optional(),
  targetKind: procedureBranchSchema.shape.targetKind,
  target: z.string().min(1),
  basis: z.string().min(1).max(300).optional(),
  evidence: z.array(procedureDecisionEvidenceSchema).max(6).optional(),
  selectedBy: actorIdSchema,
  selectedByLabel: z.string().min(1).max(80).optional(),
  simulationTime: isoTimestampSchema,
})
export type ProcedureStepDecision = z.infer<typeof procedureStepDecisionSchema>

export const procedureStepRunStateSchema = z.object({
  stepId: procedureStepIdSchema,
  assessment: procedureAssessmentSchema.default('blank'),
  comment: z.string().max(10_000).optional(),
  favorite: z.boolean().default(false),
  decision: procedureStepDecisionSchema.optional(),
  updatedAt: isoTimestampSchema,
  updatedBy: actorIdSchema,
})
export type ProcedureStepRunState = z.infer<typeof procedureStepRunStateSchema>

export const procedureRunStatusSchema = z.enum(['active', 'transferred', 'completed', 'abandoned'])
export type ProcedureRunStatus = z.infer<typeof procedureRunStatusSchema>

export const procedureRunStateSchema = z.object({
  runId: procedureRunIdSchema,
  sourceId: procedureSourceIdSchema,
  sourceRevision: sourceRevisionSchema,
  sourcePath: sourceDocumentPathSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
  title: z.string().min(1),
  status: procedureRunStatusSchema,
  startedAt: isoTimestampSchema,
  startedBy: actorIdSchema,
  closedAt: isoTimestampSchema.optional(),
  closedBy: actorIdSchema.optional(),
  currentStepId: procedureStepIdSchema.optional(),
  driver: procedureRunDriverSchema.optional(),
  stepStates: z.array(procedureStepRunStateSchema).default([]),
  observations: z.array(z.object({
    stepId: procedureStepIdSchema,
    simulationTime: isoTimestampSchema,
    result: z.object({ status: z.enum(['satisfied', 'challenged', 'unknown']), reason: z.string().optional() }).passthrough(),
  })).optional(),
})
export type ProcedureRunState = z.infer<typeof procedureRunStateSchema>

export const procedureControlStateSchema = z.object({
  runs: z.array(procedureRunStateSchema).default([]),
})
export type ProcedureControlState = z.infer<typeof procedureControlStateSchema>

export const procedureRunStartPayloadSchema = z.object({
  sourceId: procedureSourceIdSchema,
  sourceRevision: sourceRevisionSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
})
export type ProcedureRunStartPayload = z.infer<typeof procedureRunStartPayloadSchema>

export const procedureStepUpdatePayloadSchema = z.object({
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  assessment: procedureAssessmentSchema.optional(),
  comment: z.string().max(10_000).optional(),
  favorite: z.boolean().optional(),
  currentStepId: procedureStepIdSchema.optional(),
}).superRefine((payload, ctx) => {
  if (
    payload.assessment === undefined
      && payload.comment === undefined
      && payload.favorite === undefined
      && payload.currentStepId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'procedure step update requires assessment, comment, favorite, or currentStepId',
    })
  }
})
export type ProcedureStepUpdatePayload = z.infer<typeof procedureStepUpdatePayloadSchema>

export const procedureRunClosePayloadSchema = z.object({
  runId: procedureRunIdSchema,
  status: z.enum(['completed', 'abandoned']),
})
export type ProcedureRunClosePayload = z.infer<typeof procedureRunClosePayloadSchema>

export const procedureRunTransitionPayloadSchema = z.object({
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  branchIndex: z.number().int().nonnegative(),
}).merge(procedureDecisionBasisSchema)

export const procedureRunResetPayloadSchema = z.object({
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
})
export type ProcedureRunResetPayload = z.infer<typeof procedureRunResetPayloadSchema>

export const procedureRunStartedEventSchema = z.object({
  type: z.literal('procedure.run.started'),
  run: procedureRunStateSchema,
})

export const procedureStepUpdatedEventSchema = z.object({
  type: z.literal('procedure.step.updated'),
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  update: z.object({
    assessment: procedureAssessmentSchema.optional(),
    comment: z.string().max(10_000).optional(),
    favorite: z.boolean().optional(),
  }),
  currentStepId: procedureStepIdSchema.optional(),
  updatedAt: isoTimestampSchema,
  updatedBy: actorIdSchema,
})

export const procedureRunClosedEventSchema = z.object({
  type: z.literal('procedure.run.closed'),
  runId: procedureRunIdSchema,
  status: z.enum(['transferred', 'completed', 'abandoned']),
  closedAt: isoTimestampSchema,
  closedBy: actorIdSchema,
})

export const procedureRunResumedEventSchema = z.object({
  type: z.literal('procedure.run.resumed'),
  runId: procedureRunIdSchema,
  resumedAt: isoTimestampSchema,
  resumedBy: actorIdSchema,
})

/** Selecting a path records a decision, not proof that equipment responded. */
export const procedureBranchSelectedEventSchema = z.object({
  type: z.literal('procedure.branch.selected'),
  runId: procedureRunIdSchema,
  stepId: procedureStepIdSchema,
  branchIndex: z.number().int().nonnegative(),
  outcome: z.enum(['normal', 'rno', 'unknown']).optional(),
  target: z.string().min(1),
  targetKind: procedureBranchSchema.shape.targetKind,
  targetStepId: procedureBranchSchema.shape.targetStepId,
  execution: procedureBranchSchema.shape.execution,
  simulationTime: isoTimestampSchema,
  selectedBy: actorIdSchema,
  selectedByLabel: z.string().min(1).max(80).optional(),
  label: z.string().min(1).optional(),
  basis: z.string().min(1).max(300).optional(),
  evidence: z.array(procedureDecisionEvidenceSchema).max(6).optional(),
  observation: procedureRunStateSchema.shape.observations.unwrap().element.optional(),
})

export const procedureRunDriverChangedEventSchema = z.object({
  type: z.literal('procedure.run.driver.changed'),
  runId: procedureRunIdSchema,
  /** Absent: nobody drives; the Run is shared again. */
  driver: procedureRunDriverSchema.optional(),
  reason: z.enum(['claimed', 'released', 'person-acted', 'started']),
  changedAt: isoTimestampSchema,
  changedBy: actorIdSchema,
})

export const procedureObservationUpdatedEventSchema = z.object({
  type: z.literal('procedure.observation.updated'),
  runId: procedureRunIdSchema,
  observation: procedureRunStateSchema.shape.observations.unwrap().element,
})

export const procedureRunResetEventSchema = z.object({
  type: z.literal('procedure.run.reset'),
  sourceId: procedureSourceIdSchema,
  procedureId: procedureIdSchema,
  scope: procedureRunScopeSchema,
  resetAt: isoTimestampSchema,
  resetBy: actorIdSchema,
})

export const procedureRunStartCommandKind = 'world.procedure.run.start'
export const procedureStepUpdateCommandKind = 'world.procedure.step.update'
export const procedureRunCloseCommandKind = 'world.procedure.run.close'
export const procedureRunResetCommandKind = 'world.procedure.run.reset'
export const procedureRunTransitionCommandKind = 'world.procedure.run.transition'

export const procedureCommandKindSchema = z.enum([
  procedureRunStartCommandKind,
  procedureStepUpdateCommandKind,
  procedureRunCloseCommandKind,
  procedureRunResetCommandKind,
  procedureRunTransitionCommandKind,
])
export type ProcedureCommandKind = z.infer<typeof procedureCommandKindSchema>

export const createProcedureRunId = (): ProcedureRunId =>
  procedureRunIdSchema.parse(`procedure-run:${crypto.randomUUID()}`)

export const procedureCommandIdempotencyKey = (commandId: z.infer<typeof commandIdSchema>): string =>
  `procedure-command:${commandId}`
