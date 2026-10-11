import type { GridBranchDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { gridIslandAtBus, gridIslandFrequencyHz, solvedGridIslands } from './island-lifecycle.ts'

const degreesPerRadian = 180 / Math.PI

/**
 * Synchronism check for closing an open branch, with the Automation's limits.
 * - Ends in two energised islands: their frequencies may differ by at most maximumFrequencyDifferenceHz.
 * - Ends already in one AC component of an energised island (closing a loop): their voltage angles
 *   may differ by at most maximumAngleDifferenceDegrees.
 * - Ends in two AC components of one island, joined only through the synchronous external
 *   equivalent: they run at one frequency, and the angle between them depends on the external
 *   network, which the equivalent does not model; closing is allowed.
 * - Either end de-energised: dead-bus closing is allowed.
 * Returns the reason closing is blocked, with the measured difference, or null when it may close.
 */
export const synchroCheckBlockReason = (grid: GridRuntimeInstance, branch: GridBranchDefinition): string | null => {
  const islands = solvedGridIslands(grid)
  const from = gridIslandAtBus(islands, branch.fromBusId)
  const to = gridIslandAtBus(islands, branch.toBusId)
  if (!from.energized || !to.energized) return null
  const limits = grid.definition.automation.synchroCheck
  if (from.id === to.id) {
    const network = islands.plan.network
    const componentOf = (busId: string): number => islands.plan.componentIndexOfBus[network.busIndexById.get(busId)!]!
    if (componentOf(branch.fromBusId) !== componentOf(branch.toBusId)) return null
    const fromAngle = grid.busStates.get(branch.fromBusId)!.angleRad
    const toAngle = grid.busStates.get(branch.toBusId)!.angleRad
    const angleDegrees = Math.abs(fromAngle - toAngle) * degreesPerRadian
    if (angleDegrees <= limits.maximumAngleDifferenceDegrees) return null
    return `synchro-check blocks closing ${branch.id}: both ends are in ${from.id} and their voltage angles differ by ${angleDegrees.toFixed(1)}°, `
      + `above the ${limits.maximumAngleDifferenceDegrees}° loop-closing limit; reduce the angle by re-dispatch first`
  }
  const fromHz = gridIslandFrequencyHz(from)!
  const toHz = gridIslandFrequencyHz(to)!
  const slipHz = Math.abs(fromHz - toHz)
  if (slipHz <= limits.maximumFrequencyDifferenceHz) return null
  return `synchro-check blocks closing ${branch.id}: ${from.id} at ${fromHz.toFixed(3)} Hz and ${to.id} at ${toHz.toFixed(3)} Hz `
    + `differ by ${slipHz.toFixed(3)} Hz, above the ${limits.maximumFrequencyDifferenceHz} Hz limit; bring the islands within ${limits.maximumFrequencyDifferenceHz} Hz first`
}
