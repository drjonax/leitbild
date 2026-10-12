import { z } from 'zod'
import { actorIdSchema, clientIdSchema, commandIdSchema, idSchema, objectIdSchema, simulationRunIdSchema, type ActorId, type ClientId, type CommandId, type ObjectId, type SimulationRunId } from './ids.ts'
import { isoTimestampSchema, type IsoTimestamp } from './time.ts'

export const deleteObjectCommandKind = 'world.object.delete'

export const deleteObjectPayloadSchema = z.object({
  objectId: objectIdSchema,
})

export type DeleteObjectPayload = z.infer<typeof deleteObjectPayloadSchema>

export interface CommandEnvelope {
  readonly id: CommandId
  readonly simulationRunId: SimulationRunId
  readonly actorId: ActorId
  readonly clientId?: ClientId
  readonly idempotencyKey?: string
  readonly kind: string
  readonly targetObjectIds: ReadonlyArray<ObjectId>
  readonly payload: unknown
  readonly issuedAt: IsoTimestamp
  readonly expectedRevision?: number
  /** The role set the issuing screen held; present only in a Run that declares roles. */
  readonly roleIds?: ReadonlyArray<string>
}

export type CommandResult =
  | {
      readonly ok: true
      readonly commandId: CommandId
      readonly acceptedAt: IsoTimestamp
    }
  | {
      readonly ok: false
      readonly commandId: CommandId
      readonly rejectedAt: IsoTimestamp
      readonly reason: string
    }

export const commandEnvelopeSchema = z.object({
  id: commandIdSchema,
  simulationRunId: simulationRunIdSchema,
  actorId: actorIdSchema,
  clientId: clientIdSchema.optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  kind: z.string().min(1),
  targetObjectIds: z.array(objectIdSchema),
  payload: z.custom<unknown>(value => value !== undefined, 'payload is required'),
  issuedAt: isoTimestampSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
  roleIds: z.array(idSchema).min(1).optional(),
})

export const commandResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    commandId: commandIdSchema,
    acceptedAt: isoTimestampSchema,
  }),
  z.object({
    ok: z.literal(false),
    commandId: commandIdSchema,
    rejectedAt: isoTimestampSchema,
    reason: z.string().min(1),
  }),
])
