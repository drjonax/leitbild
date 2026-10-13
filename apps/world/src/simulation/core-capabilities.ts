import { z } from 'zod'
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
import { procedureStepViewSchema } from '../features/procedures/step-view.ts'
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
  /** A result that says more than accepted or refused; the core result where absent. */
  readonly output?: z.ZodType
}): SimulationCapability => defineSimulationCapability({
  id: config.id,
  kind: 'command',
  title: config.title,
  description: config.description,
  risk: config.risk ?? 'write',
  idempotent: false,
  ...(config.schedulable === undefined ? {} : { schedulable: config.schedulable }),
  input: config.input,
  output: config.output ?? commandResultSchema,
  buildCommand: raw => {
    const input = config.input.parse(raw)
    return { targetObjectIds: config.targets(input), payload: input }
  },
})

/** Accepted for an AI agent, it carries the step the transition leads to (as step.read returns it), or why that read failed. */
/** A start's pin, for every caller; for an AI agent also the first step, as step.read returns it. */
const procedureStartResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({
    pinned: z.object({ runId: z.string(), sourceId: z.string(), sourceRevision: z.string(), sourcePath: z.string() }).strict().optional(),
    next: procedureStepViewSchema.optional(),
    nextUnavailable: z.string().optional(),
  }),
  commandResultSchema.options[1],
])

const procedureTransitionResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({ next: procedureStepViewSchema.optional(), nextUnavailable: z.string().optional() }),
  commandResultSchema.options[1],
])

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
    description: 'Input {procedureId, scope: {plantId, label?}, sourceId?, sourceRevision?}. Starts a procedure for an explicit operational scope, pinned to a source revision, or resumes a transferred procedure at its preserved step. Without sourceId and sourceRevision it starts from the Run\'s procedure source at its current publication (name sourceId where the Run has several); the result names the pinned run, source, revision and path. Completed or abandoned procedures require an explicit reset. An AI agent that starts or resumes a procedure drives it (see world.procedure.run.drive), and the result carries next: its current step, as world.procedure.run.step.read returns it; it cannot resume one someone else drives.',
    input: procedureRunStartPayloadSchema,
    output: procedureStartResultSchema,
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
    description: 'Input {runId, stepId, branchIndex, basis?, evidenceTagIds?}. Atomically follows a declared local-step, procedure, retry, END, or ABORT branch from the pinned document. Records the chosen branch, who chose it, an optional basis (at most 300 characters) and up to six of the step\'s own tags as evidenceTagIds, which World reads now on the run\'s plant and records with the decision. A procedure transfer preserves source placekeeping and hands the run\'s driver on; an explicitly parallel branch keeps it active. Only authored outcome labels change step assessment. Read the step (world.procedure.run.step.read) to select stepId and branchIndex. An AI agent selects only on a run it drives, only the current step\'s branches that step.read marks aiMaySelect (an authored normal branch to another step of the same procedure), always with a basis and evidenceTagIds that World can read; a person selects every other branch in the procedure window. A person selecting a branch off the current step of a run an AI agent drives takes it over. Accepted for an AI agent, the result carries next: the step the run is now at, as step.read returns it (the run alone after a transfer or END).',
    input: procedureRunTransitionPayloadSchema,
    output: procedureTransitionResultSchema,
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
    description: 'Input {runId, action: "claim" | "release"}. Claims or releases driving an active procedure run, so the procedure window shows who works it. An AI agent claims a run nobody drives (or one it drives already) and must drive a run to change it; a person\'s claim takes over at once, and a person also takes over by ticking a step, jumping, closing it or selecting a branch off its current step. While a person drives, AI agents only read it. Release makes the run shared again: the driver or a person releases; only then may an AI agent claim it.',
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
