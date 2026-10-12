import { z } from 'zod'
import { processSignalTagIdSchema, processVariableValueSchema, variablePathSchema } from './graph/index.ts'
import {
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantIcLifecycleCommandKind,
  processPlantActionInvokeCommandKind,
  processPlantControlProposeCommandKind,
  processPlantControlDecideCommandKind,
  processPlantActuationResetCommandKind,
} from './command-kinds.ts'
import { PROPOSAL_EVIDENCE_MAX, PROPOSAL_PROCEDURE_STEP_MAX_LENGTH, PROPOSAL_REASON_MAX_LENGTH } from './operations/proposals.ts'

export {
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantIcLifecycleCommandKind,
  processPlantActionInvokeCommandKind,
  processPlantControlProposeCommandKind,
  processPlantControlDecideCommandKind,
  processPlantActuationResetCommandKind,
}

export const processPlantActionInvokePayloadSchema = z.object({
  plantId: z.string().min(1).describe('Exact live Plant id returned by world.process-plant.plants.list.'),
  actionId: z.string().min(1).describe('Exact action id returned by world.process-plant.actions.search.'),
  parameters: z.record(z.string(), z.unknown()).default({}).describe('Action parameters matching the returned action inputSchema.'),
}).strict()
export type ProcessPlantActionInvokePayload = z.infer<typeof processPlantActionInvokePayloadSchema>

export const processPlantControlWritePayloadSchema = z.object({
  plantId: z.string().min(1),
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
  value: processVariableValueSchema,
}).strict().superRefine((payload, ctx) => {
  const referenceCount = Number(payload.path !== undefined) + Number(payload.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process plant control write must define exactly one of path or tagId',
    })
  }
})

export type ProcessPlantControlWritePayload = z.infer<typeof processPlantControlWritePayloadSchema>

export const processPlantControlRampPayloadSchema = z.object({
  plantId: z.string().min(1),
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
  targetValue: z.number().finite(),
  durationSeconds: z.number().finite().positive(),
}).strict().superRefine((payload, ctx) => {
  const referenceCount = Number(payload.path !== undefined) + Number(payload.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process plant control ramp must define exactly one of path or tagId',
    })
  }
})

export type ProcessPlantControlRampPayload = z.infer<typeof processPlantControlRampPayloadSchema>

const processPlantIcCommandLifecycleActionSchema = z.enum([
  'acknowledge',
  'reset',
  'suppress',
  'unsuppress',
  'shelve',
  'unshelve',
])

export const processPlantIcLifecyclePayloadSchema = z.object({
  plantId: z.string().min(1),
  lifecycleId: z.string().min(1),
  action: processPlantIcCommandLifecycleActionSchema,
  reason: z.string().min(1).optional(),
  shelveDurationMs: z.number().finite().positive().optional(),
}).strict()

export type ProcessPlantIcLifecyclePayload = z.infer<typeof processPlantIcLifecyclePayloadSchema>

export const processPlantControlProposePayloadSchema = z.object({
  plantId: z.string().min(1),
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
  value: processVariableValueSchema.optional().describe('The value of one option the control offers (controls.list): true/false, 1/0 for a valve\'s OPEN/SHUT, or a demand control\'s setting in its span and step (0.4 for 40 %). Absent for a reset.'),
  reset: z.string().min(1).optional().describe('Instead of a write: the latched actuation to reset, by its ruleId as controls.list lists it under resets.'),
  reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX_LENGTH).describe('Why, in plain words: what the evidence shows and what the operation does about it.'),
  procedureStep: z.string().trim().min(1).max(PROPOSAL_PROCEDURE_STEP_MAX_LENGTH).optional().describe('The procedure step it carries out, as the procedure names it.'),
  evidence: z.array(processSignalTagIdSchema).min(1).max(PROPOSAL_EVIDENCE_MAX).describe('Published tags it rests on; the person sees how each moved since.'),
}).strict().superRefine((payload, ctx) => {
  if (payload.reset !== undefined) {
    if (payload.path !== undefined || payload.tagId !== undefined || payload.value !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a proposed reset names its actuation only: no path, tagId or value' })
    }
    return
  }
  const referenceCount = Number(payload.path !== undefined) + Number(payload.tagId !== undefined)
  if (referenceCount !== 1 || payload.value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process plant control proposal must define exactly one of path or tagId, and a value, or a reset',
    })
  }
})

export type ProcessPlantControlProposePayload = z.infer<typeof processPlantControlProposePayloadSchema>

export const processPlantControlDecidePayloadSchema = z.object({
  plantId: z.string().min(1),
  proposalId: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'extend', 'withdraw']),
  reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX_LENGTH).optional(),
}).strict()

export type ProcessPlantControlDecidePayload = z.infer<typeof processPlantControlDecidePayloadSchema>

export const processPlantActuationResetPayloadSchema = z.object({
  plantId: z.string().min(1),
  ruleId: z.string().min(1).describe('The latched actuation to reset, by its ruleId as controls.list lists it under resets.'),
  reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX_LENGTH).optional(),
}).strict()

export type ProcessPlantActuationResetPayload = z.infer<typeof processPlantActuationResetPayloadSchema>
