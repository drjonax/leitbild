import type { z } from 'zod'
import {
  commandResultSchema,
  deleteObjectCommandKind,
  deleteObjectPayloadSchema,
  objectIdSchema,
  procedureRunCloseCommandKind,
  procedureRunClosePayloadSchema,
  procedureRunDriveCommandKind,
  procedureRunDrivePayloadSchema,
  procedureRunResetCommandKind,
  procedureRunResetPayloadSchema,
  procedureRunStartCommandKind,
  procedureRunStartPayloadSchema,
  procedureRunTransitionCommandKind,
  procedureRunTransitionPayloadSchema,
  procedureStepUpdateCommandKind,
  procedureStepUpdatePayloadSchema,
  type ObjectId,
} from '../core/model/index.ts'
import { defineSimulationCapability } from './capabilities.ts'
import type { SimulationCapability } from './protocol.ts'

const command = <T>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodType<T>
  readonly targets: (input: T) => ReadonlyArray<ObjectId>
  readonly risk?: 'write' | 'destructive'
  readonly schedulable?: boolean
}): SimulationCapability => defineSimulationCapability({
  id: config.id,
  kind: 'command',
  title: config.title,
  description: config.description,
  risk: config.risk ?? 'write',
  idempotent: false,
  ...(config.schedulable === undefined ? {} : { schedulable: config.schedulable }),
  input: config.input,
  output: commandResultSchema,
  buildCommand: raw => {
    const input = config.input.parse(raw)
    return { targetObjectIds: config.targets(input), payload: input }
  },
})

export const worldCoreCapabilities: ReadonlyArray<SimulationCapability> = [
  command({
    id: deleteObjectCommandKind,
    title: 'Delete operational object',
    description: 'Deletes one current operational object from this Simulation Run.',
    input: deleteObjectPayloadSchema,
    targets: input => [input.objectId],
    risk: 'destructive',
    schedulable: true,
  }),
  command({
    id: procedureRunStartCommandKind,
    title: 'Start procedure run',
    description: 'Starts a pinned procedure for an explicit operational scope, or resumes a transferred procedure at its preserved step. Completed or abandoned procedures require an explicit reset. An AI agent that starts or resumes a procedure drives it (see world.procedure.run.drive); it cannot resume one someone else drives.',
    input: procedureRunStartPayloadSchema,
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
  command({
    id: procedureStepUpdateCommandKind,
    title: 'Update procedure step',
    description: 'Records an assessment, note, favorite, or current-step change in an active procedure run. A person ticking a step or moving the current step of a run an AI agent drives takes it over. An AI agent records only a comment (at most 500 characters) on a run it drives; it answers a step with world.procedure.run.transition.',
    input: procedureStepUpdatePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunTransitionCommandKind,
    title: 'Follow procedure branch',
    description: 'Atomically follows a declared local-step, procedure, retry, END, or ABORT branch from the pinned document. Records the chosen branch, who chose it, an optional basis (at most 300 characters) and up to six of the step\'s own tags as evidenceTagIds, which World reads now on the run\'s plant and records with the decision. A procedure transfer preserves source placekeeping and hands the run\'s driver on; an explicitly parallel branch keeps it active. Only authored outcome labels change step assessment. Read the step (world.procedure.run.step.read) to select stepId and branchIndex. An AI agent selects only on a run it drives, only the current step\'s branches that step.read marks aiMaySelect (an authored normal branch to another step of the same procedure), always with a basis and evidenceTagIds that World can read; a person selects every other branch in the procedure window. A person selecting a branch off the current step of a run an AI agent drives takes it over.',
    input: procedureRunTransitionPayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunCloseCommandKind,
    title: 'Close procedure run',
    description: 'Completes or abandons an active procedure run. An AI agent closes only a run it drives; a person closing a run an AI agent drives takes it over.',
    input: procedureRunClosePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunDriveCommandKind,
    title: 'Drive procedure run',
    description: 'Claims or releases driving an active procedure run, so the procedure window shows who works it. An AI agent claims a run nobody drives (or one it drives already) and must drive a run to change it; a person\'s claim takes over at once, and a person also takes over by ticking a step, jumping, closing it or selecting a branch off its current step. While a person drives, AI agents only read it. Release makes the run shared again: the driver or a person releases; only then may an AI agent claim it.',
    input: procedureRunDrivePayloadSchema,
    targets: () => [],
  }),
  command({
    id: procedureRunResetCommandKind,
    title: 'Reset procedure run',
    description: 'Clears current procedure state for an explicit operational scope. Only a person resets a procedure; an AI agent is refused.',
    input: procedureRunResetPayloadSchema,
    targets: input => [objectIdSchema.parse(input.scope.plantId)],
  }),
]
