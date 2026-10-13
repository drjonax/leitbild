import { z } from 'zod'
import { commandEnvelopeSchema, commandResultSchema, type CommandEnvelope, type CommandResult } from './commands.ts'
import { actorIdSchema, eventIdSchema, objectIdSchema, simulationRunIdSchema, type ActorId, type EventId, type ObjectId, type SimulationRunId } from './ids.ts'
import { operationalObjectSchema, type OperationalObject } from './object.ts'
import { objectAudienceSchema, type ObjectAudience } from './audience.ts'
import { provenanceSchema, type Provenance } from './provenance.ts'
import { isoTimestampSchema, simulationClockStateSchema, type IsoTimestamp, type SimulationClockState } from './time.ts'
import { telemetryStateSchema, type TelemetryState } from './telemetry.ts'
import { interactionSignalSchema, operationalNotificationSchema, type InteractionSignal, type OperationalNotification } from './interactions.ts'
import { agentRestrictionsSchema, scenarioGuidanceSchema, type AgentRestrictions, type ScenarioGuidance } from './scenario.ts'
import { procedureObservationUpdatedEventSchema, procedureBranchSelectedEventSchema, procedureRunDriverChangedEventSchema, procedureRunResumedEventSchema, procedureRunClosedEventSchema, procedureRunResetEventSchema, procedureRunStartedEventSchema, procedureStepUpdatedEventSchema, type ProcedureRunState, type ProcedureRunId, type ProcedureRunScope, type ProcedureRunStatus, type ProcedureStepId, type ProcedureAssessment, type ProcedureId, type ProcedureSourceId } from './procedures.ts'

export interface EventEnvelopeBase {
  readonly id: EventId
  readonly simulationRunId: SimulationRunId
  readonly seq: number
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}

export type SimulationRunEvent =
  | (EventEnvelopeBase & z.infer<typeof procedureObservationUpdatedEventSchema>)
  | (EventEnvelopeBase & z.infer<typeof procedureRunResumedEventSchema>)
  | (EventEnvelopeBase & z.infer<typeof procedureBranchSelectedEventSchema>)
  | (EventEnvelopeBase & z.infer<typeof procedureRunDriverChangedEventSchema>)
  | (EventEnvelopeBase & {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
    })
  | (EventEnvelopeBase & {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
      /**
       * The deleted object's audience, written at commit in a Run that
       * declares sides. Without it the event reaches truth roles only.
       */
      readonly audience?: ObjectAudience
    })
  | (EventEnvelopeBase & {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
    })
  | (EventEnvelopeBase & {
      readonly type: 'command.issued'
      readonly command: CommandEnvelope
    })
  | (EventEnvelopeBase & {
      readonly type: 'command.result'
      readonly result: CommandResult
    })
  | (EventEnvelopeBase & {
      readonly type: 'interaction.signal.received'
      readonly signal: InteractionSignal
    })
  | (EventEnvelopeBase & {
      readonly type: 'notification.emitted'
      readonly notification: OperationalNotification
    })
  | (EventEnvelopeBase & {
      readonly type: 'clock.updated'
      readonly clock: SimulationClockState
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.cue.started'
      readonly cueId: string
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.guidance.shown'
      readonly guidance: ScenarioGuidance
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.guidance.hidden'
      readonly guidanceId?: string
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.objects.highlighted'
      readonly objectIds: ReadonlyArray<ObjectId>
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.highlights.cleared'
      readonly objectIds?: ReadonlyArray<ObjectId>
    })
  | (EventEnvelopeBase & {
      readonly type: 'scenario.agent-restrictions.set'
      readonly restrictions: AgentRestrictions
      readonly revision: number
      readonly updatedBy: ActorId
    })
  | (EventEnvelopeBase & {
      readonly type: 'simulationRun.reset'
      readonly previousSeq: number
      readonly previousScenarioId?: string
      readonly scenarioId?: string
    })
  | (EventEnvelopeBase & {
      readonly type: 'procedure.run.started'
      readonly run: ProcedureRunState
    })
  | (EventEnvelopeBase & {
      readonly type: 'procedure.step.updated'
      readonly runId: ProcedureRunId
      readonly stepId: ProcedureStepId
      readonly update: {
        readonly assessment?: ProcedureAssessment
        readonly comment?: string
        readonly favorite?: boolean
      }
      readonly currentStepId?: ProcedureStepId
      readonly updatedAt: IsoTimestamp
      readonly updatedBy: ActorId
    })
  | (EventEnvelopeBase & {
      readonly type: 'procedure.run.closed'
      readonly runId: ProcedureRunId
      readonly status: Exclude<ProcedureRunStatus, 'active'>
      readonly closedAt: IsoTimestamp
      readonly closedBy: ActorId
    })
  | (EventEnvelopeBase & {
      readonly type: 'procedure.run.reset'
      readonly sourceId: ProcedureSourceId
      readonly procedureId: ProcedureId
      readonly scope: ProcedureRunScope
      readonly resetAt: IsoTimestamp
      readonly resetBy: ActorId
    })

const eventBaseSchema = z.object({
  id: eventIdSchema,
  simulationRunId: simulationRunIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  provenance: provenanceSchema,
})

export const simulationRunEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({
    type: z.literal('object.upserted'),
    object: operationalObjectSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('object.deleted'),
    objectId: objectIdSchema,
    audience: objectAudienceSchema.optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('telemetry.sampled'),
    objectId: objectIdSchema,
    telemetry: telemetryStateSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('command.issued'),
    command: commandEnvelopeSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('command.result'),
    result: commandResultSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('interaction.signal.received'),
    signal: interactionSignalSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('notification.emitted'),
    notification: operationalNotificationSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('clock.updated'),
    clock: simulationClockStateSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.cue.started'),
    cueId: z.string().min(1),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.guidance.shown'),
    guidance: scenarioGuidanceSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.guidance.hidden'),
    guidanceId: z.string().min(1).optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.objects.highlighted'),
    objectIds: z.array(objectIdSchema),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.highlights.cleared'),
    objectIds: z.array(objectIdSchema).optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal('scenario.agent-restrictions.set'),
    restrictions: agentRestrictionsSchema,
    revision: z.number().int().nonnegative(),
    updatedBy: actorIdSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal('simulationRun.reset'),
    previousSeq: z.number().int().nonnegative(),
    previousScenarioId: z.string().min(1).optional(),
    scenarioId: z.string().min(1).optional(),
  }),
  eventBaseSchema.merge(procedureRunStartedEventSchema),
  eventBaseSchema.merge(procedureStepUpdatedEventSchema),
  eventBaseSchema.merge(procedureRunClosedEventSchema),
  eventBaseSchema.merge(procedureRunResumedEventSchema),
  eventBaseSchema.merge(procedureBranchSelectedEventSchema),
  eventBaseSchema.merge(procedureRunDriverChangedEventSchema),
  eventBaseSchema.merge(procedureObservationUpdatedEventSchema),
  eventBaseSchema.merge(procedureRunResetEventSchema),
])
