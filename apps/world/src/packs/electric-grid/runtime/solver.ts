import type { IsoTimestamp } from '../../../core/model/index.ts'
import { applyGridDemand } from './demand.ts'
import { advanceGridFrequencyControl } from './frequency-control.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { solveGridNetwork } from './power-flow.ts'
import { projectGridSystem } from './projection.ts'
import { topologyPlanForGrid } from './topology.ts'
import { advanceGridUnitCommitment } from './unit-commitment.ts'

/** One Grid tick: topology, unit commitment, demand, frequency control, network solution, then system projection. */
export const advanceGrid = (grid: GridRuntimeInstance, dtSeconds: number, at: IsoTimestamp): void => {
  const startedAtMs = performance.now()
  const plan = topologyPlanForGrid(grid)
  const dynamicSeconds = Math.max(0, dtSeconds)
  grid.elapsedMs += dynamicSeconds * 1_000
  grid.tick += 1

  advanceGridUnitCommitment(grid)
  applyGridDemand(grid, at)
  const frequencyByIsland = advanceGridFrequencyControl(grid, plan, dynamicSeconds)
  grid.frequencyByIsland = frequencyByIsland
  solveGridNetwork(grid, plan, frequencyByIsland)
  projectGridSystem(grid, plan, frequencyByIsland, at)

  const tickDurationMs = performance.now() - startedAtMs
  grid.diagnostics.lastSuccessfulTickAt = at
  grid.diagnostics.lastTickDurationMs = tickDurationMs
  grid.diagnostics.maximumTickDurationMs = Math.max(grid.diagnostics.maximumTickDurationMs, tickDurationMs)
}
