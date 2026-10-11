import { z } from 'zod'
import { objectIdSchema } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { defineSimulationQueryCapability } from '../../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { solvedGridIslands } from '../runtime/island-lifecycle.ts'

export type GridRuntimes = ReadonlyMap<string, GridRuntimeInstance>

/** One read-only Electric Grid query Capability and the handler answering it. */
export interface ElectricGridQuery {
  readonly capability: SimulationCapability
  /** The answer, or a Promise of it from a query that finishes on worker threads. */
  readonly answer: (rawInput: unknown, grids: GridRuntimes) => unknown
}

export const assetKindSchema = z.enum(['bus', 'branch', 'generator', 'load', 'storage'])
export const gridPayloadSchema = z.object({ gridId: z.string().min(1) }).strict()

export const defineGridQuery = <Input extends z.ZodType>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly searchTerms: ReadonlyArray<string>
  readonly input: Input
  readonly output: z.ZodType
  readonly answer: (payload: z.output<Input>, grids: GridRuntimes) => unknown
}): ElectricGridQuery => ({
  capability: defineSimulationQueryCapability({
    id: config.id,
    title: config.title,
    description: config.description,
    searchTerms: config.searchTerms,
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

/** A stable island id of the Grid's solved islands, or a capability rejection naming where ids come from. */
export const requireGridIsland = (grid: GridRuntimeInstance, islandId: string): string => {
  if (!solvedGridIslands(grid).islands.some(island => island.id === islandId)) return rejectCapabilityTarget(
    `Grid island not found: ${islandId}. Discover current island ids with world.electric-grid.islands.list.`,
  )
  return islandId
}

/** The stable island id holding a bus at the last solve. */
export const gridBusIslandId = (grid: GridRuntimeInstance, busId: string): string => grid.busStates.get(busId)!.islandId
