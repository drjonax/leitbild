import { gridDcFlowsMw } from '../../src/packs/electric-grid/runtime/power-flow.ts'
import type { GridRuntimeInstance } from '../../src/packs/electric-grid/runtime/instance.ts'

// Invariants of a solved Grid on its DC solution, which the island balances and bus injections
// close on (published branch flows are the AC ones where an island converged).

/** Largest Kirchhoff current-law residual over all buses: injection minus DC flows leaving (MW). */
export const largestKclResidualMw = (grid: GridRuntimeInstance): number => {
  const residuals = new Map([...grid.busStates].map(([busId, state]) => [busId, state.netInjectionMw]))
  const flows = gridDcFlowsMw(grid)
  grid.definition.model.branches.forEach((branch, index) => {
    const flowMw = grid.branches.get(branch.id)!.flowModel === null ? 0 : flows[index]!
    residuals.set(branch.fromBusId, residuals.get(branch.fromBusId)! - flowMw)
    residuals.set(branch.toBusId, residuals.get(branch.toBusId)! + flowMw)
  })
  return Math.max(...[...residuals.values()].map(Math.abs))
}

/** Sum of all injections of each energised island (MW); balance closes by construction. */
export const largestIslandInjectionSumMw = (grid: GridRuntimeInstance): number => {
  const sums = new Map<string, number>()
  for (const state of grid.busStates.values()) if (state.energized) sums.set(state.islandId, (sums.get(state.islandId) ?? 0) + state.netInjectionMw)
  return Math.max(0, ...[...sums.values()].map(Math.abs))
}
