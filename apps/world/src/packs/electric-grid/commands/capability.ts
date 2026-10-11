import { z } from 'zod'
import { commandResultSchema, objectIdSchema } from '../../../core/model/index.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../../simulation/protocol.ts'

export const assetPayload = z.object({ assetId: z.string().min(1) }).strict()

/**
 * A Grid-targeted command Capability: the payload plus the target `gridId`. Every Grid command sets
 * an absolute state and rejects a request that would change nothing, so a repeated command is
 * idempotent. `destructive` marks commands that disconnect supply or generation at once.
 */
export const gridCommandCapability = <Shape extends z.ZodRawShape>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly payloadSchema: z.ZodObject<Shape>
  readonly risk: 'write' | 'destructive'
  readonly searchTerms: ReadonlyArray<string>
}): SimulationCapability => {
  const input = config.payloadSchema.extend({ gridId: objectIdSchema })
  return defineSimulationCommandCapability({
    id: config.id,
    title: config.title,
    description: config.description,
    searchTerms: config.searchTerms,
    input,
    output: commandResultSchema,
    risk: config.risk,
    idempotent: true,
    schedulable: true,
    buildCommand: raw => {
      const { gridId, ...payload } = input.parse(raw) as Record<string, unknown> & {
        readonly gridId: ReturnType<typeof objectIdSchema.parse>
      }
      return { targetObjectIds: [gridId], payload }
    },
  })
}
