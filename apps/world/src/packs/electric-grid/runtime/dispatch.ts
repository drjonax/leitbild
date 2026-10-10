import { applyGridDemand } from './demand.ts'
import { advanceGridFrequencyControl } from './frequency-control.ts'
import type { GridGeneratorDefinition } from '../grid-model.ts'
import type { GridIsland, GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import {
  externalFrequencyEquivalent,
  islandFixedInjectionMw,
  islandLossesMw,
  islandMembers,
} from './island-input.ts'
import { reconcileGridIslands, resetGridIslandFrequencies } from './island-lifecycle.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { solveGridNetwork } from './power-flow.ts'
import { allocateIslandReserves, upwardReserveMw } from './reserve-allocation.ts'
import { topologyPlanForGrid } from './topology.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

// Losses enter the dispatch from the previous solve; three passes settle them below 0.01 MW on Norway.
const lossPasses = 3

/** Transfer capability between an external system and Norway: the ratings of the closed AC branches at its boundary bus (MW). */
const boundaryTransferLimitMw = (grid: GridRuntimeInstance, boundaryBusId: string): number =>
  (grid.definition.index.branchesByBus.get(boundaryBusId) ?? []).reduce((sum, branch) => {
    const state = grid.branches.get(branch.id)!
    return sum + (state.state === 'closed' ? branch.ratingMw * state.availability : 0)
  }, 0)

/**
 * Dispatch of one energised island: its online units share the island's residual demand
 * (connected demand + losses − connected-system and HVDC injections) between their minimum stable
 * generation and their availability, in proportion to that range. A synchronous external system
 * takes what the units cannot: the surplus below their minimum as export, the deficit above their
 * capacity as import, within the transfer capability of its ties. An island without one whose
 * units' minimum exceeds the residual takes units offline, smallest first, until it fits (an
 * island with no demand runs none). Anything else is an explicit error, never a silent cap.
 */
const dispatchIsland = (grid: GridRuntimeInstance, plan: GridTopologyPlan, island: GridIsland): void => {
  const structure = plan.islands[island.planIndex]!
  const demandMw = structure.loads.reduce((sum, load) => sum + connectedGridLoadMw(grid.loads.get(load.id)!), 0)
  const residualMw = demandMw + islandLossesMw(grid, structure) - islandFixedInjectionMw(grid, structure)
  const externals = islandMembers(grid, structure).externals
  const limitMw = externals.reduce((sum, system) => sum + boundaryTransferLimitMw(grid, system.boundaryBusIds[0]!), 0)
  const online = () => structure.generators.filter(definition => grid.generators.get(definition.id)!.state === 'online')
  const minimumMw = (units: ReadonlyArray<GridGeneratorDefinition>) => units.reduce((sum, definition) => sum + generatorMinimumStableMw(definition), 0)
  if (externals.length === 0) {
    const bySize = [...online()].sort((a, b) => a.capacityMw - b.capacityMw || (a.id < b.id ? -1 : 1))
    while (bySize.length > 0 && minimumMw(bySize) > residualMw) {
      const state = grid.generators.get(bySize.shift()!.id)!
      state.state = 'offline'
      state.targetMw = 0
    }
  }
  const units = online()
  const floorMw = minimumMw(units)
  const availableMw = units.reduce((sum, definition) => sum + grid.generators.get(definition.id)!.availableMw, 0)
  const unitsMw = Math.min(Math.max(residualMw, floorMw), availableMw)
  const exchangeMw = residualMw - unitsMw
  if (exchangeMw !== 0 && (externals.length === 0 || Math.abs(exchangeMw) > limitMw)) {
    const need = exchangeMw > 0
      ? `needs ${residualMw.toFixed(1)} MW but its online units can supply ${availableMw.toFixed(1)} MW`
      : `has ${residualMw.toFixed(1)} MW of residual demand below its online units' ${floorMw.toFixed(1)} MW minimum stable generation`
    throw new Error(`Grid ${grid.definition.gridId} dispatch is infeasible: island ${island.id} ${need}${externals.length === 0 ? '' : ` and its ties to ${externals.map(system => system.id).join(', ')} carry at most ${limitMw.toFixed(0)} MW`}`)
  }
  const rangeMw = availableMw - floorMw
  for (const definition of units) {
    const state = grid.generators.get(definition.id)!
    const unitMinimumMw = generatorMinimumStableMw(definition)
    state.targetMw = unitMinimumMw + (rangeMw > 0 ? (unitsMw - floorMw) * (state.availableMw - unitMinimumMw) / rangeMw : 0)
  }
  for (const system of externals) {
    grid.externalSystems.get(system.id)!.scheduledImportMw = limitMw > 0 ? exchangeMw * boundaryTransferLimitMw(grid, system.boundaryBusIds[0]!) / limitMw : 0
  }
  const allocation = allocateIslandReserves({
    automation: grid.definition.automation,
    units: structure.generators.map(definition => {
      const state = grid.generators.get(definition.id)!
      return { definition, synchronised: state.state === 'online', minimumMw: generatorMinimumStableMw(definition), availableMw: state.availableMw, targetMw: state.targetMw }
    }),
    islandLoadMw: demandMw,
    externals: externals.map(system => externalFrequencyEquivalent(grid, system).reserves),
  })
  for (const definition of structure.generators) {
    const state = grid.generators.get(definition.id)!
    state.reserves = allocation.allocations.get(definition.id)!
    state.reserveMw = upwardReserveMw(state.reserves)
  }
}

/**
 * Dispatches every energised island of the live topology at `epochMs` and allocates its reserves,
 * then restarts each island steady at nominal frequency. Replaces any earlier set-points.
 */
export const dispatchGridFromLiveIslands = (grid: GridRuntimeInstance, epochMs: number): void => {
  const plan = topologyPlanForGrid(grid)
  applyGridDemand(grid, epochMs)
  // Online units start from minimum stable generation, the lowest set-point they hold; dispatchIsland
  // raises it or takes the unit offline. Every other unit holds 0 MW.
  for (const definition of grid.definition.model.generators) {
    const state = grid.generators.get(definition.id)!
    state.targetMw = state.state === 'online' ? generatorMinimumStableMw(definition) : 0
  }
  for (let pass = 0; pass < lossPasses; pass += 1) {
    resetGridIslandFrequencies(grid)
    const islands = reconcileGridIslands(grid, plan)
    for (const island of islands.islands) if (island.energized) dispatchIsland(grid, plan, island)
    resetGridIslandFrequencies(grid)
    const restarted = reconcileGridIslands(grid, plan)
    advanceGridFrequencyControl(grid, restarted, 0)
    solveGridNetwork(grid, restarted, 0)
  }
}
