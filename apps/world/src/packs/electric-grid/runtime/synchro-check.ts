import type { GridBranchDefinition, GridExternalSystemDefinition } from '../grid-model.ts'
import { gridAcState, gridIslandFlowModel } from './ac-load-flow.ts'
import { externalSystemIsland, separatedBoundarySystem } from './boundary-separation.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance } from './instance.ts'
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

/** An end of an open branch: a bus in a Norwegian island, or a separated boundary bus its external system holds. */
type BranchEnd =
  | { readonly kind: 'island'; readonly island: GridIsland }
  | { readonly kind: 'external'; readonly system: GridExternalSystemDefinition; readonly island: GridIsland | null }

const branchEnd = (grid: GridRuntimeInstance, islands: GridIslandPlan, busId: string): BranchEnd => {
  const system = separatedBoundarySystem(grid, islands.plan, islands.plan.network.busIndexById.get(busId)!)
  if (system < 0) return { kind: 'island', island: gridIslandAtBus(islands, busId) }
  return { kind: 'external', system: grid.definition.index.externalSystems[system]!, island: externalSystemIsland(islands, system) }
}

/**
 * Synchronism check for closing an open branch, with the Automation's limits.
 * - Ends in two energised islands: their frequencies may differ by at most maximumFrequencyDifferenceHz.
 * - Ends already in one AC component of an energised island (closing a loop): their voltage angles
 *   may differ by at most maximumAngleDifferenceDegrees, read from the island's AC load flow when it
 *   converged and from the DC solution when it did not; the reason names which.
 * - Ends in two AC components of one island, joined only through the synchronous external
 *   equivalent: they run at one frequency, and the angle between them depends on the external
 *   network, which the equivalent does not model; closing is allowed.
 * - One end a separated boundary bus (its ties all open; boundary-separation.ts): the external
 *   system is live there. Coupled to a Norwegian island through other ties, that island is the end
 *   (closing onto the island itself rejoins it through the equivalent, as above). Coupled to none,
 *   the other end's frequency may differ from the system's nominal frequency by at most
 *   maximumFrequencyDifferenceHz; the separated system shares no angle reference with Norway, so
 *   the check is on frequency only.
 * - The other end de-energised: dead-bus closing is allowed (from an external system, it energises the island).
 * Returns the reason closing is blocked, with the measured difference, or null when it may close.
 */
export const synchroCheckBlockReason = (grid: GridRuntimeInstance, branch: GridBranchDefinition): string | null => {
  const islands = solvedGridIslands(grid)
  const fromEnd = branchEnd(grid, islands, branch.fromBusId)
  const toEnd = branchEnd(grid, islands, branch.toBusId)
  if (fromEnd.kind === 'external') return toEnd.kind === 'external' ? null : separatedEndReason(grid, branch, fromEnd, toEnd.island)
  if (toEnd.kind === 'external') return separatedEndReason(grid, branch, toEnd, fromEnd.island)
  const limits = grid.definition.automation.synchroCheck
  const from = fromEnd.island
  const to = toEnd.island
  if (!from.energized || !to.energized) return null
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
  return islandSlipReason(grid, branch, from, to)
}

/** The check of closing a branch from island `other` onto a separated boundary bus of `external`'s system: the reason it blocks, or null. */
const separatedEndReason = (grid: GridRuntimeInstance, branch: GridBranchDefinition, external: Extract<BranchEnd, { kind: 'external' }>, other: GridIsland): string | null => {
  if (!other.energized) return null
  if (external.island !== null) return external.island.id === other.id ? null : islandSlipReason(grid, branch, other, external.island)
  const limits = grid.definition.automation.synchroCheck
  const islandHz = gridIslandFrequencyHz(other)!
  const systemHz = grid.definition.automation.swing.nominalFrequencyHz
  const slipHz = Math.abs(islandHz - systemHz)
  if (slipHz <= limits.maximumFrequencyDifferenceHz) return null
  return `synchro-check blocks closing ${branch.id}: ${other.id} at ${islandHz.toFixed(3)} Hz and ${external.system.id}, separated from every Norwegian island and so at its nominal ${systemHz.toFixed(3)} Hz, `
    + `differ by ${slipHz.toFixed(3)} Hz, above the ${limits.maximumFrequencyDifferenceHz} Hz limit; bring ${other.id} within ${limits.maximumFrequencyDifferenceHz} Hz of ${systemHz.toFixed(3)} Hz first`
}

/** The frequency check of closing a branch between two energised islands: the reason it blocks, or null. */
const islandSlipReason = (grid: GridRuntimeInstance, branch: GridBranchDefinition, from: GridIsland, to: GridIsland): string | null => {
  const limits = grid.definition.automation.synchroCheck
  const fromHz = gridIslandFrequencyHz(from)!
  const toHz = gridIslandFrequencyHz(to)!
  const slipHz = Math.abs(fromHz - toHz)
  if (slipHz <= limits.maximumFrequencyDifferenceHz) return null
  return `synchro-check blocks closing ${branch.id}: ${from.id} at ${fromHz.toFixed(3)} Hz and ${to.id} at ${toHz.toFixed(3)} Hz `
    + `differ by ${slipHz.toFixed(3)} Hz, above the ${limits.maximumFrequencyDifferenceHz} Hz limit; bring the islands within ${limits.maximumFrequencyDifferenceHz} Hz first`
}
