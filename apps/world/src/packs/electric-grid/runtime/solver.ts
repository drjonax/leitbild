import type { IsoTimestamp } from '../../../core/model/index.ts'
import { applyGridDemand, demandSampleMs, rampSampleMs, segmentEndMs } from './demand.ts'
import { advanceGridFrequencyControl } from './frequency-control.ts'
import { advanceHvdcLinks, hvdcLinksRamping } from './hvdc.ts'
import type { GridRuntimeInstance } from './instance.ts'
import { reconcileGridIslands, refreshGridIslandEnergisation } from './island-lifecycle.ts'
import { projectGridSystem } from './projection.ts'
import { createGridNetworkSampler } from './protection/sampling.ts'
import { topologyPlanForGrid } from './topology.ts'
import { advanceGridUnitCommitment, nextSynchronisationElapsedMs } from './unit-commitment.ts'

/** An advance longer than the Automation's maximum catch-up is a runtime fault, never a stretched step. */
const catchUpExceeded = (gridId: string, dtSeconds: number, maximumSeconds: number): Error =>
  Object.assign(new Error(`Grid ${gridId} was asked to advance ${dtSeconds.toFixed(3)} s in one step; the Automation allows at most ${maximumSeconds} s of catch-up`), { name: 'GridCatchUpExceededError' })

/**
 * One Grid tick ending at `at`: stable islands for the live topology, then unit commitment, demand
 * samples, HVDC ramps and island frequency control over the elapsed time in fixed sub-steps, then
 * one DC network solution with the balance check, alarms, then the system projection. With branch
 * protection the network is also solved at every relay sample inside the tick, where trips apply.
 */
export const advanceGrid = (grid: GridRuntimeInstance, dtSeconds: number, at: IsoTimestamp): void => {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new Error(`Grid ${grid.definition.gridId} advance needs a finite non-negative step, got ${dtSeconds}`)
  const maximumSeconds = grid.definition.automation.simulation.maximumCatchUpSeconds
  if (dtSeconds > maximumSeconds) throw catchUpExceeded(grid.definition.gridId, dtSeconds, maximumSeconds)
  const startedAtMs = performance.now()
  let islands = reconcileGridIslands(grid, topologyPlanForGrid(grid))
  for (const island of islands.islands) {
    island.minimumHz = island.frequency?.frequencyHz ?? null
    island.maximumHz = island.frequency?.frequencyHz ?? null
  }
  const endMs = Date.parse(at)
  if (!Number.isFinite(endMs)) throw new Error(`Grid ${grid.definition.gridId} advance has an invalid time ${at}`)
  const startMs = endMs - dtSeconds * 1_000
  const startElapsedMs = grid.elapsedMs
  const elapsedAtMs = (epochMs: number): number => startElapsedMs + (epochMs - startMs)
  const sampler = createGridNetworkSampler(grid, startMs, startElapsedMs)
  const commitUnits = (epochMs: number): void => {
    grid.elapsedMs = elapsedAtMs(epochMs)
    if (advanceGridUnitCommitment(grid)) refreshGridIslandEnergisation(grid, islands)
  }
  if (dtSeconds === 0) {
    commitUnits(endMs)
    applyGridDemand(grid, endMs)
    advanceGridFrequencyControl(grid, islands, 0)
  }
  // Segments on fixed absolute grids: demand samples every minute, every second while HVDC ramps,
  // and a boundary wherever a starting unit synchronises.
  for (let cursorMs = startMs; cursorMs < endMs;) {
    commitUnits(cursorMs)
    const synchronisesAtMs = nextSynchronisationElapsedMs(grid)
    const gridEndMs = Math.min(segmentEndMs(cursorMs, endMs, hvdcLinksRamping(grid) ? rampSampleMs : demandSampleMs), sampler.nextSampleMs(cursorMs))
    // Synchronisation boundaries fall on whole milliseconds after the cursor, so a segment always advances.
    const nextMs = synchronisesAtMs === null
      ? gridEndMs
      : Math.min(gridEndMs, Math.max(cursorMs + 1, Math.ceil(startMs + (synchronisesAtMs - startElapsedMs))))
    const seconds = (nextMs - cursorMs) / 1_000
    applyGridDemand(grid, cursorMs)
    advanceHvdcLinks(grid, seconds)
    advanceGridFrequencyControl(grid, islands, seconds)
    cursorMs = nextMs
    if (cursorMs < endMs && sampler.samplesAt(cursorMs)) {
      commitUnits(cursorMs)
      islands = sampler.solveAt(cursorMs, new Date(cursorMs).toISOString() as IsoTimestamp, islands)
    }
  }
  if (dtSeconds > 0) commitUnits(endMs)
  grid.elapsedMs = startElapsedMs + dtSeconds * 1_000
  islands = sampler.solveAt(endMs, at, islands)
  projectGridSystem(grid, islands, at)

  const tickDurationMs = performance.now() - startedAtMs
  grid.diagnostics.lastSuccessfulTickAt = at
  grid.diagnostics.lastTickDurationMs = tickDurationMs
  grid.diagnostics.maximumTickDurationMs = Math.max(grid.diagnostics.maximumTickDurationMs, tickDurationMs)
}
