import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import { gridTablesFor } from './state/tables.ts'

// Separated boundary buses: boundary buses of a synchronous external system whose ties are all
// open. Like an HVDC terminal they lie in no Norwegian island (topology.ts), but they stay
// energised: the external system holds them at its voltage set-point and frequency. That system is
// one synchronous area, so its frequency is the frequency of the Norwegian island it is still
// coupled to through other ties. Coupled to none, nothing connects it to Norway: its exchange is
// void (voidDetachedExchanges), so it has no imbalance and is held at nominal frequency. Its own
// transient while it absorbs the exchange it lost is internal balancing of the remainder, which the
// equivalent (the response Norway sees through its ties) does not model.

/** The synchronous external system holding bus `bus` as a separated boundary bus, or −1 (a bus in an island, or an HVDC terminal). */
export const separatedBoundarySystem = (grid: GridRuntimeInstance, plan: GridTopologyPlan, bus: number): number =>
  plan.islandIndexOfBus[bus]! < 0 ? gridTablesFor(grid.definition).synchronousExternalOfBus[bus]! : -1

/** The Norwegian island synchronous external system `system` is coupled to through a closed tie, or null while it is coupled to none. */
export const externalSystemIsland = (islands: GridIslandPlan, system: number): GridIsland | null => {
  for (const island of islands.islands) {
    const externals = islands.plan.islands[island.planIndex]!.externalIndices
    for (let position = 0; position < externals.length; position += 1) if (externals[position] === system) return island
  }
  return null
}

/** The frequency of synchronous external system `system`: that of the island it is coupled to, nominal while it is coupled to none (Hz). */
export const externalSystemFrequencyHz = (grid: GridRuntimeInstance, islands: GridIslandPlan, system: number): number => {
  const island = externalSystemIsland(islands, system)
  if (island === null) return grid.definition.automation.swing.nominalFrequencyHz
  const frequencyHz = island.workspace?.frequencyHz ?? null
  if (frequencyHz === null) throw new Error(`Grid island ${island.id} holds ${grid.definition.index.externalSystems[system]!.id} but has no frequency`)
  return frequencyHz
}

/**
 * A synchronous external system coupled to no Norwegian island exchanges nothing with Norway: its
 * scheduled import becomes 0, so reclosing a tie synchronises at zero exchange and the schedule
 * returns only with a new dispatch.
 */
export const voidDetachedExchanges = (grid: GridRuntimeInstance, plan: GridTopologyPlan): void => {
  const systems = grid.definition.index.externalSystems
  for (let system = 0; system < systems.length; system += 1) {
    if (!systems[system]!.synchronous) continue
    let coupled = false
    for (let island = 0; island < plan.islands.length && !coupled; island += 1) {
      const externals = plan.islands[island]!.externalIndices
      for (let position = 0; position < externals.length && !coupled; position += 1) coupled = externals[position] === system
    }
    if (!coupled) grid.arrays.externalSystems[system]!.scheduledImportMw = 0
  }
}
