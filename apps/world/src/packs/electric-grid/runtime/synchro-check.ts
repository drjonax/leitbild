import type { GridBranchDefinition } from '../grid-model.ts'
import { gridAcState, gridIslandFlowModel } from './ac-load-flow.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { gridIslandAtBus, gridIslandFrequencyHz, solvedGridIslands } from './island-lifecycle.ts'

const degreesPerRadian = 180 / Math.PI

/**
 * Where a loop-closing angle comes from: `ac`, the island's converged AC load flow; `dc`, the DC
 * solution, because the island's AC load flow did not converge; `dc-after-actions`, the DC solution
 * of a remedial case after earlier actions, which has no AC solution of its own.
 */
export type GridLoopAngleBasis = 'ac' | 'dc' | 'dc-after-actions'

const basisText: Readonly<Record<GridLoopAngleBasis, string>> = {
  ac: 'AC load flow',
  dc: 'DC solution: the island\'s AC load flow did not converge',
  'dc-after-actions': 'DC solution of the case after the earlier actions',
}

/** A loop-closing angle as rejection reasons state it: `Δθ 24.6° (AC load flow)`. */
export const loopAngleText = (angleDegrees: number, basis: GridLoopAngleBasis): string => `Δθ ${angleDegrees.toFixed(1)}° (${basisText[basis]})`

/**
 * Synchronism check for closing an open branch, with the Automation's limits.
 * - Ends in two energised islands: their frequencies may differ by at most maximumFrequencyDifferenceHz.
 * - Ends already in one AC component of an energised island (closing a loop): their voltage angles
 *   may differ by at most maximumAngleDifferenceDegrees, read from the island's AC load flow when it
 *   converged and from the DC solution when it did not; the reason names which.
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
    const fromBus = network.busIndexById.get(branch.fromBusId)!
    const toBus = network.busIndexById.get(branch.toBusId)!
    if (islands.plan.componentIndexOfBus[fromBus] !== islands.plan.componentIndexOfBus[toBus]) return null
    const basis = gridIslandFlowModel(grid, from) === 'ac' ? 'ac' : 'dc'
    const angles = basis === 'ac' ? gridAcState(grid)!.angleRad : islands.plan.anglesRad
    const angleDegrees = Math.abs(angles[fromBus]! - angles[toBus]!) * degreesPerRadian
    if (angleDegrees <= limits.maximumAngleDifferenceDegrees) return null
    return `synchro-check blocks closing ${branch.id}: both ends are in ${from.id} and their voltage angles differ by ${loopAngleText(angleDegrees, basis)}, `
      + `above the ${limits.maximumAngleDifferenceDegrees}° loop-closing limit; reduce the angle by re-dispatch first`
  }
  const fromHz = gridIslandFrequencyHz(from)!
  const toHz = gridIslandFrequencyHz(to)!
  const slipHz = Math.abs(fromHz - toHz)
  if (slipHz <= limits.maximumFrequencyDifferenceHz) return null
  return `synchro-check blocks closing ${branch.id}: ${from.id} at ${fromHz.toFixed(3)} Hz and ${to.id} at ${toHz.toFixed(3)} Hz `
    + `differ by ${slipHz.toFixed(3)} Hz, above the ${limits.maximumFrequencyDifferenceHz} Hz limit; bring the islands within ${limits.maximumFrequencyDifferenceHz} Hz first`
}
