import { z } from 'zod'
import { defineGridQuery, genericObjectSchema, gridFor } from './common.ts'

const powerFlowPayloadSchema = z.object({
  gridId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
const powerFlowResultSchema = z.object({
  gridId: z.string(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  branches: z.array(genericObjectSchema),
}).strict()

export const gridPowerFlowQuery = defineGridQuery({
  id: 'world.electric-grid.power-flow.snapshot',
  title: 'Get power-flow snapshot',
  description: 'Returns a bounded page of current branch flow state.',
  input: powerFlowPayloadSchema,
  output: powerFlowResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const branches = grid.definition.model.branches.map(definition => ({ definition, state: grid.branches.get(definition.id)! }))
    return {
      gridId: payload.gridId,
      total: branches.length,
      offset: payload.offset,
      limit: payload.limit,
      branches: branches.slice(payload.offset, payload.offset + payload.limit),
    }
  },
})
