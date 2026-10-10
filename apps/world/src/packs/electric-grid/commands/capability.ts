import { z } from 'zod'
import { commandResultSchema, objectIdSchema } from '../../../core/model/index.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../../simulation/protocol.ts'

export const assetPayload = z.object({ assetId: z.string().min(1) }).strict()

/** A Grid-targeted command Capability: the payload plus the target `gridId`. */
export const gridCommandCapability = <Shape extends z.ZodRawShape>(
  id: string,
  title: string,
  description: string,
  payloadSchema: z.ZodObject<Shape>,
): SimulationCapability => {
  const input = payloadSchema.extend({ gridId: objectIdSchema })
  return defineSimulationCommandCapability({
    id,
    title,
    description,
    input,
    output: commandResultSchema,
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
