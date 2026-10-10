import type { GridBranchDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { gridIslandIsEnergized } from './island-energization.ts'
import { topologyPlanForGrid } from './topology.ts'

/**
 * Synchronism check for closing an open branch. Closing inside one island, or onto a dead island
 * (dead-bus closing), is allowed. Closing between two energised islands requires the measured
 * frequency difference of the two end buses to be within the Automation's synchroCheckHz.
 * Returns the reason closing is blocked, or null when it may close.
 */
export const synchroCheckBlockReason = (grid: GridRuntimeInstance, branch: GridBranchDefinition): string | null => {
  const plan = topologyPlanForGrid(grid)
  const fromIslandId = plan.islandIdByBus.get(branch.fromBusId)!
  const toIslandId = plan.islandIdByBus.get(branch.toBusId)!
  if (fromIslandId === toIslandId) return null
  const fromIsland = plan.islands.find(island => island.id === fromIslandId)!
  const toIsland = plan.islands.find(island => island.id === toIslandId)!
  if (!gridIslandIsEnergized(grid, fromIsland) || !gridIslandIsEnergized(grid, toIsland)) return null
  const fromHz = grid.busStates.get(branch.fromBusId)?.frequencyHz
  const toHz = grid.busStates.get(branch.toBusId)?.frequencyHz
  if (fromHz === undefined || toHz === undefined) {
    throw new Error(`synchro-check has no frequency measurement for ${branch.fromBusId} or ${branch.toBusId}; advance the Grid first`)
  }
  const slipHz = Math.abs(fromHz - toHz)
  const limitHz = grid.definition.automation.synchroCheckHz
  if (slipHz <= limitHz) return null
  return `synchro-check blocks closing ${branch.id}: ${fromIslandId} at ${fromHz.toFixed(3)} Hz and ${toIslandId} at ${toHz.toFixed(3)} Hz `
    + `differ by ${slipHz.toFixed(3)} Hz, above the ${limitHz} Hz limit; bring the islands within ${limitHz} Hz first`
}
