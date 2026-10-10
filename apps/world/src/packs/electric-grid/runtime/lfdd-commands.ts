import { gridLfddStagePayloadSchema, gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from '../commands/frequency.ts'
import { rearmIslandLfddStage, restoreIslandLfddStage } from './frequency/island-state.ts'
import type { GridIsland, GridRuntimeInstance } from './instance.ts'

const energisedIsland = (grid: GridRuntimeInstance, islandId: string): GridIsland => {
  const island = grid.islandPlan?.islands.find(candidate => candidate.id === islandId)
  if (!island) throw new Error(`Grid island not found: ${islandId}`)
  if (!island.energized || island.frequency === null) throw new Error(`Grid island ${islandId} is de-energised; its LFDD stages were reset when it lost supply`)
  return island
}

/** LFDD lifecycle commands: latched stages change only through these, never by frequency recovery. */
export const gridFrequencyCommandHandlers = {
  [gridRestoreLfddStageCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridLfddStagePayloadSchema.parse(rawPayload)
    const island = energisedIsland(grid, payload.islandId)
    island.frequency = restoreIslandLfddStage(island.frequency!, payload.stageId).state
  },
  [gridRearmLfddStageCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridLfddStagePayloadSchema.parse(rawPayload)
    const island = energisedIsland(grid, payload.islandId)
    island.frequency = rearmIslandLfddStage(island.frequency!, payload.stageId)
  },
} as const
