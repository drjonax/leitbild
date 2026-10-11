import { resetIslandGeneratorProtection, type FrequencyAction } from './frequency/island-state.ts'
import { advanceIslandFrequency, type IslandFrequencyAdvance } from './frequency/island.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { allocateGridIslandReserves } from './island-reserves.ts'
import { generatorSynchronisedAt, islandFrequencyInput } from './island-input.ts'
import { generatorTripped } from './state/arrays.ts'
import { gridTablesFor } from './state/tables.ts'

// Enough recent actions for an operator or Agent to see a cascade; older ones are in the journal.
const retainedFrequencyEvents = 200

const storageStateFor = (operatingState: string): 'idle' | 'charging' | 'discharging' | 'unavailable' =>
  operatingState === 'disconnected' ? 'unavailable' : operatingState as 'idle' | 'charging' | 'discharging'

const actionSummary = (action: FrequencyAction): string => {
  switch (action.kind) {
    case 'generator-trip': return `${action.unitId} tripped by ${action.cause} protection (${action.elementId})`
    case 'lfdd-stage-operated': return `LFDD ${action.stageId} shed ${action.shedMw.toFixed(1)} of ${action.requestedMw.toFixed(1)} MW`
    case 'mfrr-activated': return `mFRR activated ${action.activatedMw.toFixed(1)} MW (shortfall ${action.shortfallMw.toFixed(1)} MW)`
    case 'storage-state-changed': return `${action.storageId} ${action.from} → ${action.to}`
    case 'island-collapsed': return `island collapsed: ${action.cause}`
  }
}

const recordActions = (grid: GridRuntimeInstance, islandId: string, actions: ReadonlyArray<FrequencyAction>): void => {
  for (const action of actions) {
    grid.frequencyEvents.push({
      islandId, atElapsedSeconds: action.atSeconds, kind: action.kind, summary: actionSummary(action),
      ...(action.kind === 'generator-trip' ? { trip: { unitId: action.unitId, elementId: action.elementId, cause: action.cause } } : {}),
    })
  }
  if (grid.frequencyEvents.length > retainedFrequencyEvents) grid.frequencyEvents.splice(0, grid.frequencyEvents.length - retainedFrequencyEvents)
}

/**
 * Writes one advance's mechanical outputs and latches into the Grid asset states; electrical outputs
 * follow in the network solve. The advance lists units, storage, loads and externals in the
 * island's order.
 */
const applyAdvance = (grid: GridRuntimeInstance, island: GridIsland, structure: GridTopologyIsland, advance: IslandFrequencyAdvance): void => {
  const generators = grid.arrays.generators
  advance.units.forEach((unit, position) => {
    const generator = structure.generatorIndices[position]!
    generators.scheduledMw[generator] = unit.synchronised ? unit.scheduledMw : 0
    generators.fcrMw[generator] = unit.synchronised ? unit.fcrNMw + unit.fcrDMw : 0
    generators.afrrMw[generator] = unit.synchronised ? unit.afrrMw : 0
    generators.mfrrMw[generator] = unit.synchronised ? unit.mfrrMw : 0
  })
  for (const action of advance.actions) {
    if (action.kind !== 'generator-trip') continue
    const generator = gridTablesFor(grid.definition).generatorIndexById.get(action.unitId)!
    generators.lifecycle[generator] = generatorTripped
    generators.targetMw[generator] = 0
    generators.scheduledMw[generator] = 0
    generators.fcrMw[generator] = 0
    generators.afrrMw[generator] = 0
    generators.mfrrMw[generator] = 0
  }
  advance.storage.forEach((item, position) => {
    const state = grid.arrays.storage[structure.storageIndices[position]!]!
    state.dispatchMw = item.powerMw
    state.stateOfChargeFraction = item.stateOfChargeFraction
    state.state = storageStateFor(item.operatingState)
  })
  const loads = grid.arrays.loads
  advance.loads.forEach((item, position) => {
    const load = structure.loadIndices[position]!
    loads.servedMw[load] = item.servedMw
    loads.lfddShedMw[load] = item.lfddShedMw
  })
  advance.externals.forEach((external, position) => {
    const state = grid.arrays.externalSystems[structure.externalIndices[position]!]!
    state.mechanicalMw = external.mechanicalMw
    state.fcrMw = external.fcrNMw + external.fcrDMw
    state.afrrMw = external.afrrMw
  })
  island.frequency = advance.state
  if (advance.state.frequencyHz === null) {
    island.energized = false
    island.frequency = null
    island.rocofHzPerSecond = null
    return
  }
  island.rocofHzPerSecond = advance.state.rocofHzPerSecond
  if (advance.extremes) {
    island.minimumHz = Math.min(island.minimumHz ?? advance.extremes.minimumHz, advance.extremes.minimumHz)
    island.maximumHz = Math.max(island.maximumHz ?? advance.extremes.maximumHz, advance.extremes.maximumHz)
  }
}

/**
 * A unit returned to service by command has had its trip reset by that command; the frequency
 * state's protection latch follows so the unit can synchronise again.
 */
const resetReturnedUnits = (grid: GridRuntimeInstance, island: GridIsland): void => {
  const frequency = island.frequency!
  for (const [unitId, unit] of Object.entries(frequency.units)) {
    if (unit.protection.trip && generatorSynchronisedAt(grid.arrays.generators, gridTablesFor(grid.definition).generatorIndexById.get(unitId)!)) {
      island.frequency = resetIslandGeneratorProtection(grid.definition.automation, island.frequency!, unitId)
    }
  }
}

/**
 * Advances every energised island's swing equation, reserves, LFDD and protection by `seconds` in
 * the Automation's fixed sub-steps, against the demand and injections currently set on the Grid.
 */
export const advanceGridFrequencyControl = (grid: GridRuntimeInstance, islands: GridIslandPlan, seconds: number): void => {
  for (const island of islands.islands) {
    if (!island.energized || island.frequency === null) continue
    resetReturnedUnits(grid, island)
    const structure = islands.plan.islands[island.planIndex]!
    allocateGridIslandReserves(grid, structure)
    const advance = advanceIslandFrequency(grid.definition.automation, island.frequency!, islandFrequencyInput(grid, structure, island.id), seconds)
    recordActions(grid, island.id, advance.actions)
    applyAdvance(grid, island, structure, advance)
  }
}
