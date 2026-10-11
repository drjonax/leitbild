import { applyGridDemand } from './demand.ts'
import { advanceGridFrequencyControl } from './frequency-control.ts'
import type { GridGeneratorDefinition } from '../grid-model.ts'
import type { GridIsland, GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import {
  boundaryTieCapacityMw,
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


/** Import the Operating Point schedules from a synchronous external system (MW; negative exports). */
const scheduledImportMw = (grid: GridRuntimeInstance, systemId: string): number => {
  const exchange = grid.definition.operatingPoint.externalExchanges.find(entry => entry.systemId === systemId)
  if (exchange === undefined) throw new Error(`Grid ${grid.definition.gridId} Operating Point has no scheduled exchange for ${systemId}`)
  return -exchange.scheduledExportMw
}

/**
 * Dispatch of one energised island: its online units share the island's residual demand
 * (connected demand + losses − connected-system and HVDC injections − the scheduled exchange with
 * its synchronous external systems) between their minimum stable generation and their
 * availability, in proportion to that range. A synchronous external system takes what the units
 * cannot: the surplus below their minimum as export, the deficit above their capacity as import,
 * within the transfer capability of its ties. An island without one whose
 * units' minimum exceeds the residual takes units offline, smallest first, until it fits (an
 * island with no demand runs none). Anything else is an explicit error, never a silent cap.
 */
const dispatchIsland = (grid: GridRuntimeInstance, plan: GridTopologyPlan, island: GridIsland): void => {
  const structure = plan.islands[island.planIndex]!
  const demandMw = structure.loads.reduce((sum, load) => sum + connectedGridLoadMw(grid.loads.get(load.id)!), 0)
  const residualMw = demandMw + islandLossesMw(grid, structure) - islandFixedInjectionMw(grid, structure)
  const externals = islandMembers(grid, structure).externals
  // Transfer capability between the external system and the island: the ties at its boundary buses in the island.
  const limitMw = externals.reduce((sum, system) => sum + system.boundaryBusIds
    .filter(busId => structure.busSet.has(busId))
    .reduce((ties, busId) => ties + boundaryTieCapacityMw(grid, busId), 0), 0)
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
  const preferredImportMw = externals.reduce((sum, system) => sum + scheduledImportMw(grid, system.id), 0)
  const unitsMw = Math.min(Math.max(residualMw - preferredImportMw, floorMw), availableMw)
  const exchangeMw = residualMw - unitsMw
  if (exchangeMw !== 0 && (externals.length === 0 || Math.abs(exchangeMw) > limitMw)) {
    const need = exchangeMw > 0
      ? `needs ${residualMw.toFixed(1)} MW but its online units can supply ${availableMw.toFixed(1)} MW`
      : `has ${residualMw.toFixed(1)} MW of residual demand below its online units' ${floorMw.toFixed(1)} MW minimum stable generation`
    throw new Error(`Grid ${grid.definition.gridId} dispatch is infeasible: island ${island.id} ${need}${externals.length === 0 ? '' : ` and its ties to ${externals.map(system => system.id).join(', ')} carry at most ${limitMw.toFixed(0)} MW`}`)
  }
  const rangeMw = availableMw - floorMw
  const share = rangeMw > 0 ? (unitsMw - floorMw) / rangeMw : 0
  for (const definition of units) {
    const state = grid.generators.get(definition.id)!
    const unitMinimumMw = generatorMinimumStableMw(definition)
    // The same share of every unit's range; at a share of 1 the floating-point sum may exceed availability by an ulp.
    state.targetMw = Math.min(state.availableMw, unitMinimumMw + share * (state.availableMw - unitMinimumMw))
  }
  // The island holds at most one synchronous external system (definitions.ts).
  for (const system of externals) grid.externalSystems.get(system.id)!.scheduledImportMw = exchangeMw
  const allocation = allocateIslandReserves({
    automation: grid.definition.automation,
    units: structure.generators.map(definition => {
      const state = grid.generators.get(definition.id)!
      return { definition, synchronised: state.state === 'online', minimumMw: generatorMinimumStableMw(definition), availableMw: state.availableMw, targetMw: state.targetMw }
    }),
    area: {
      islandLoadMw: demandMw,
      externals: externals.map(system => {
        const equivalent = externalFrequencyEquivalent(grid, system)
        return { reserves: equivalent.reserves, loadMw: equivalent.loadMw }
      }),
    },
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
    solveGridNetwork(grid, restarted, 0, true)
  }
}
