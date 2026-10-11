import { gridLfddStagePayloadSchema, gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from '../commands/frequency.ts'
import { rearmLfddStage, restoreLfddStage } from './frequency/lfdd.ts'
import { setWorkspaceLfdd, type IslandFrequencyWorkspace } from './frequency/workspace.ts'
import type { GridRuntimeInstance } from './instance.ts'

const energisedIslandWorkspace = (grid: GridRuntimeInstance, islandId: string): IslandFrequencyWorkspace => {
  const island = grid.islandPlan?.islands.find(candidate => candidate.id === islandId)
  if (!island) throw new Error(`Grid island not found: ${islandId}`)
  if (!island.energized || island.workspace === null) throw new Error(`Grid island ${islandId} is de-energised; its LFDD stages were reset when it lost supply`)
  return island.workspace
}

/** LFDD lifecycle commands: latched stages change only through these, never by frequency recovery. */
export const gridFrequencyCommandHandlers = {
  [gridRestoreLfddStageCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridLfddStagePayloadSchema.parse(rawPayload)
    const workspace = energisedIslandWorkspace(grid, payload.islandId)
    setWorkspaceLfdd(workspace, restoreLfddStage(workspace.lfdd, payload.stageId).state)
  },
  [gridRearmLfddStageCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridLfddStagePayloadSchema.parse(rawPayload)
    const workspace = energisedIslandWorkspace(grid, payload.islandId)
    setWorkspaceLfdd(workspace, rearmLfddStage(workspace.lfdd, payload.stageId))
  },
} as const
