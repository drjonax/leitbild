import { z } from 'zod'
import { objectIdSchema } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { defineSimulationQueryCapability } from '../../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'

export type GridRuntimes = ReadonlyMap<string, GridRuntimeInstance>

/** One read-only Electric Grid query Capability and the handler answering it. */
export interface ElectricGridQuery {
  readonly capability: SimulationCapability
  readonly answer: (rawInput: unknown, grids: GridRuntimes) => unknown
}

export const assetKindSchema = z.enum(['bus', 'branch', 'generator', 'load', 'storage'])
export const gridPayloadSchema = z.object({ gridId: z.string().min(1) }).strict()
export const genericObjectSchema = z.record(z.string(), z.unknown())

export const defineGridQuery = <Input extends z.ZodType>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly input: Input
  readonly output: z.ZodType
  readonly answer: (payload: z.output<Input>, grids: GridRuntimes) => unknown
}): ElectricGridQuery => ({
  capability: defineSimulationQueryCapability({
    id: config.id,
    title: config.title,
    description: config.description,
    input: config.input,
    output: config.output,
    inspectObjectIds: rawInput => {
      const gridId = (rawInput as { gridId?: unknown }).gridId
      return typeof gridId === 'string' ? [objectIdSchema.parse(gridId)] : []
    },
  }),
  answer: (rawInput, grids) => config.answer(config.input.parse(rawInput), grids),
})

export const gridFor = (grids: GridRuntimes, gridId: string): GridRuntimeInstance => {
  const grid = grids.get(gridId)
  if (!grid) return rejectCapabilityTarget(
    `Electric Grid not found: ${gridId}. Discover exact running Grid ids with world.electric-grid.catalog.list.`,
  )
  return grid
}
