import type { IsoTimestamp } from '../../../../core/model/index.ts'
import { evaluateGridAlarms } from '../alarms.ts'
import type { GridIslandPlan, GridRuntimeInstance } from '../instance.ts'
import { reconcileGridIslands, refreshGridIslandEnergisation } from '../island-lifecycle.ts'
import { solveGridNetwork } from '../power-flow.ts'
import { topologyPlanForGrid } from '../topology.ts'
import { recordGeneratorTrips } from './generator-trips.ts'
import { applyBranchTrips, initialiseBranchThermalStates, instantaneousBranchTrips, sampleBranchRelays } from './relays.ts'

// Elapsed times within half a millisecond of a sample instant are that instant: real-time steps
// carry floating-point remainders of whole milliseconds.
const sampleToleranceMs = 0.5

/**
 * Network solutions inside one advance. With branch protection enabled, relays sample on a fixed
 * grid of Grid elapsed time: the advance is split at every sample instant and the network solved
 * there, so trips, cascades and alarms do not depend on the adapter step (real time or fast-forward).
 */
export interface GridNetworkSampler {
  /** Epoch ms of the first relay sample after `cursorMs`; +∞ without branch protection. */
  readonly nextSampleMs: (cursorMs: number) => number
  /** Whether `epochMs` is a relay sample instant not sampled yet. */
  readonly samplesAt: (epochMs: number) => boolean
  /**
   * Solves the network at `epochMs` (the Grid's elapsed time is already there), samples the relays
   * if it is a sample instant and applies their trips with the instantaneous cascade they cause,
   * records generator trips and evaluates alarms. Returns the islands after any trip.
   */
  readonly solveAt: (epochMs: number, at: IsoTimestamp, islands: GridIslandPlan) => GridIslandPlan
}

export const createGridNetworkSampler = (grid: GridRuntimeInstance, startMs: number, startElapsedMs: number): GridNetworkSampler => {
  const settings = grid.definition.automation.branchProtection
  const intervalMs = settings.enabled ? settings.sampleIntervalSeconds * 1_000 : Number.POSITIVE_INFINITY
  const elapsedAt = (epochMs: number): number => startElapsedMs + (epochMs - startMs)
  /** The sample instant at `elapsedMs` not sampled yet, or null. */
  const sampleInstant = (elapsedMs: number): number | null => {
    if (!settings.enabled) return null
    const instant = Math.round(elapsedMs / intervalMs) * intervalMs
    if (Math.abs(elapsedMs - instant) > sampleToleranceMs) return null
    const last = grid.protection.lastSampleElapsedMs
    return last === null || instant > last + sampleToleranceMs ? instant : null
  }
  let lastSolveMs = startMs
  return {
    nextSampleMs: cursorMs => {
      if (!settings.enabled) return Number.POSITIVE_INFINITY
      const next = (Math.floor((elapsedAt(cursorMs) + sampleToleranceMs) / intervalMs) + 1) * intervalMs
      return Math.max(cursorMs + 1, Math.round(startMs + (next - startElapsedMs)))
    },
    samplesAt: epochMs => sampleInstant(elapsedAt(epochMs)) !== null,
    solveAt: (epochMs, at, islands) => {
      const elapsedMs = grid.elapsedMs
      const previousSolveElapsedMs = elapsedAt(lastSolveMs)
      // A unit tripped by frequency protection on the last sub-step can leave an island without a
      // voltage-forming source before frequency control notices its collapse: it de-energises now.
      refreshGridIslandEnergisation(grid, islands)
      const instant = sampleInstant(elapsedMs)
      // Without relays every solution carries its losses; with them, only those at sample instants.
      solveGridNetwork(grid, islands, (epochMs - lastSolveMs) / 1_000, !settings.enabled || instant !== null)
      lastSolveMs = epochMs
      let current = islands
      const armed = !grid.protection.startingDispatchPending
      if (armed && !grid.protection.thermalInitialised) {
        initialiseBranchThermalStates(grid)
        grid.protection.thermalInitialised = true
      }
      if (settings.enabled && armed && instant !== null) {
        const last = grid.protection.lastSampleElapsedMs
        grid.protection.lastSampleElapsedMs = instant
        let trips = sampleBranchRelays(grid, settings, instant, last === null ? settings.sampleIntervalSeconds : (instant - last) / 1_000)
        while (trips.length > 0) {
          applyBranchTrips(grid, trips, at, instant)
          current = reconcileGridIslands(grid, topologyPlanForGrid(grid))
          solveGridNetwork(grid, current, 0, true)
          trips = instantaneousBranchTrips(grid, settings)
        }
      }
      recordGeneratorTrips(grid, at, elapsedMs, previousSolveElapsedMs)
      evaluateGridAlarms(grid, current, at, elapsedMs)
      return current
    },
  }
}
