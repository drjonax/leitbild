import type { GridExternalSystemDefinition } from '../grid-model.ts'
import type { ExternalFrequencyEquivalent, FrequencyStorageUnit, IslandFrequencyInput } from './frequency/types.ts'
import { frequencyUnitFor, generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import { hvdcInjectionAtBusesMw } from './hvdc.ts'
import type { GridGeneratorState, GridLoadState, GridRuntimeInstance, GridStorageState, GridTopologyIsland } from './instance.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { generatorIsSynchronised, generatorMinimumStableMw } from './unit-commitment.ts'
import { noReserves } from './frequency/governors.ts'
import { compiledGridNetworkFor } from './network/compiled-network.ts'

// Converter, cable and transformer losses of a battery in each direction: √0.85, from the 85 %
// round-trip efficiency of utility-scale Li-ion storage (NREL Annual Technology Baseline 2024).
const storageEfficiencyPerDirection = Math.sqrt(0.85)

interface IslandMembers {
  readonly busIndices: Int32Array
  /** Bus index of each generator, load and storage unit, aligned with the island's lists. */
  readonly generatorBuses: Int32Array
  readonly loadBuses: Int32Array
  readonly storageBuses: Int32Array
  readonly externals: ReadonlyArray<GridExternalSystemDefinition>
  readonly connectionPointIds: ReadonlyArray<string>
}

const membersByIsland = new WeakMap<GridTopologyIsland, IslandMembers>()

/** Bus indices, synchronous external systems and connection points of a structural island, computed once per structure. */
export const islandMembers = (grid: GridRuntimeInstance, island: GridTopologyIsland): IslandMembers => {
  const cached = membersByIsland.get(island)
  if (cached) return cached
  const { index, model } = grid.definition
  const network = compiledGridNetworkFor(model)
  const members: IslandMembers = {
    busIndices: Int32Array.from(island.buses, busId => network.busIndexById.get(busId)!),
    generatorBuses: Int32Array.from(island.generators, item => network.busIndexById.get(item.busId)!),
    loadBuses: Int32Array.from(island.loads, item => network.busIndexById.get(item.busId)!),
    storageBuses: Int32Array.from(island.storage, item => network.busIndexById.get(item.busId)!),
    // A synchronous system couples to the island only through a boundary bus with a closed tie in it.
    externals: [...new Set(island.buses.flatMap(busId => {
      const system = index.synchronousExternalByBus.get(busId)
      if (system === undefined || !island.branches.some(branch => branch.fromBusId === busId || branch.toBusId === busId)) return []
      return [system]
    }))],
    connectionPointIds: model.connectionPoints.filter(point => island.busSet.has(point.busId)).map(point => point.id),
  }
  membersByIsland.set(island, members)
  return members
}

/** The runtime states of a structural island's generators, loads and storage, aligned with its lists. */
export interface IslandAssetStates {
  readonly generators: ReadonlyArray<GridGeneratorState>
  readonly loads: ReadonlyArray<GridLoadState>
  readonly storage: ReadonlyArray<GridStorageState>
  /** Reactive demand per MW served of each load: tan(acos(power factor)). */
  readonly loadReactivePerMw: Float64Array
}

// A Grid's asset state objects live as long as the Grid and are updated in place, so the lookups
// of one structural island are made once (per Grid: structures are model-derived and may be shared).
const assetStatesByGrid = new WeakMap<GridRuntimeInstance, WeakMap<GridTopologyIsland, IslandAssetStates>>()

export const islandAssetStates = (grid: GridRuntimeInstance, island: GridTopologyIsland): IslandAssetStates => {
  let byIsland = assetStatesByGrid.get(grid)
  if (byIsland === undefined) {
    byIsland = new WeakMap()
    assetStatesByGrid.set(grid, byIsland)
  }
  const cached = byIsland.get(island)
  if (cached !== undefined) return cached
  const states: IslandAssetStates = {
    generators: island.generators.map(definition => grid.generators.get(definition.id)!),
    loads: island.loads.map(definition => grid.loads.get(definition.id)!),
    storage: island.storage.map(definition => grid.storage.get(definition.id)!),
    loadReactivePerMw: Float64Array.from(island.loads, definition => Math.tan(Math.acos(definition.powerFactor))),
  }
  byIsland.set(island, states)
  return states
}

/**
 * How a synchronous external system's exchange with one Norwegian AC component is shared among
 * the given boundary buses of that component: by area participation (renormalised over the areas
 * present), then within an area by the derated rating of each bus's closed ties.
 */
export const externalBoundaryShares = (grid: GridRuntimeInstance, system: GridExternalSystemDefinition, boundaryBusIds: ReadonlyArray<string>): ReadonlyArray<number> => {
  const participation = system.areaParticipation
  if (participation === undefined) throw new Error(`${system.id} has no area participation to share its exchange`)
  const entryOf = (busId: string) => {
    const entry = participation.find(candidate => candidate.boundaryBusIds.includes(busId))
    if (entry === undefined) throw new Error(`${system.id}: boundary bus ${busId} lies in no participating area`)
    return entry
  }
  const entries = boundaryBusIds.map(entryOf)
  const capacities = boundaryBusIds.map(busId => boundaryTieCapacityMw(grid, busId))
  const presentAreas = [...new Set(entries)]
  const presentShare = presentAreas.reduce((sum, entry) => sum + entry.share, 0)
  return boundaryBusIds.map((busId, index) => {
    const entry = entries[index]!
    let areaCapacityMw = 0
    entries.forEach((candidate, position) => { if (candidate === entry) areaCapacityMw += capacities[position]! })
    if (!(areaCapacityMw > 0)) throw new Error(`${system.id}: the ties of ${entry.area} at ${busId} carry no rating`)
    return entry.share / presentShare * capacities[index]! / areaCapacityMw
  })
}

/** Rating of the closed AC ties at a boundary bus, derated by their availability (MW). */
export const boundaryTieCapacityMw = (grid: GridRuntimeInstance, boundaryBusId: string): number =>
  (grid.definition.index.branchesByBus.get(boundaryBusId) ?? []).reduce((sum, branch) => {
    const state = grid.branches.get(branch.id)!
    return sum + (state.state === 'closed' ? branch.ratingMw * state.availability : 0)
  }, 0)

/** Synchronised units: online, or stopping until its breaker opens at 0 MW (unit-commitment.ts). */
export const gridGeneratorIsSynchronised = generatorIsSynchronised

/**
 * An island is energised only while a voltage-forming source holds it: a synchronised synchronous
 * generator or a synchronous external system. Converters, storage and connected systems (Plants)
 * follow an existing voltage and cannot energise an island on their own.
 */
export const islandHasVoltageFormingSource = (grid: GridRuntimeInstance, island: GridTopologyIsland): boolean =>
  islandMembers(grid, island).externals.length > 0
  || island.generators.some(definition => generatorIsVoltageForming(definition) && gridGeneratorIsSynchronised(grid.generators.get(definition.id)!))

/** Kinetic energy Σ H·S of synchronised synchronous units plus synchronous external systems (MWs). */
export const islandKineticEnergyMws = (grid: GridRuntimeInstance, island: GridTopologyIsland): number =>
  island.generators.reduce((sum, definition) =>
    sum + (gridGeneratorIsSynchronised(grid.generators.get(definition.id)!) ? generatorKineticEnergyMws(definition) : 0), 0)
  + islandMembers(grid, island).externals.reduce((sum, system) => sum + externalKineticEnergyMws(system), 0)

export const externalKineticEnergyMws = (system: GridExternalSystemDefinition): number => {
  if (system.inertiaGws === undefined) throw new Error(`synchronous external system ${system.id} has no inertia`)
  return system.inertiaGws * 1_000
}

/** Connected systems (Plants) and HVDC converters inject fixed power into the island over an advance. */
export const islandFixedInjectionMw = (grid: GridRuntimeInstance, island: GridTopologyIsland): number => {
  let injectionMw = 0
  for (const pointId of islandMembers(grid, island).connectionPointIds) {
    const connection = grid.externalConnections.get(pointId)
    if (connection?.connected === true) injectionMw += connection.systemActivePowerMw
  }
  return injectionMw + hvdcInjectionAtBusesMw(grid, island.busSet)
}

export const islandLossesMw = (grid: GridRuntimeInstance, island: GridTopologyIsland): number => {
  let lossesMw = 0
  for (const bus of islandMembers(grid, island).busIndices) lossesMw += grid.lossLoadByBusMw[bus]!
  return lossesMw
}

const requiredExternalValue = (system: GridExternalSystemDefinition, field: 'loadMw' | 'fcrNMwPerHz' | 'fcrDUpMw' | 'fcrDDownMw' | 'afrrUpMw' | 'afrrDownMw'): number => {
  const value = system[field]
  if (value === undefined) throw new Error(`synchronous external system ${system.id} has no ${field}`)
  return value
}

export const externalFrequencyEquivalent = (grid: GridRuntimeInstance, system: GridExternalSystemDefinition): ExternalFrequencyEquivalent => {
  const automation = grid.definition.automation
  const state = grid.externalSystems.get(system.id)!
  return {
    id: system.id,
    kineticEnergyMws: externalKineticEnergyMws(system),
    scheduledImportMw: state.scheduledImportMw,
    loadMw: requiredExternalValue(system, 'loadMw'),
    reserves: {
      fcrNMw: requiredExternalValue(system, 'fcrNMwPerHz') * automation.fcrN.fullActivationDeviationHz,
      fcrDUpMw: requiredExternalValue(system, 'fcrDUpMw'),
      fcrDDownMw: requiredExternalValue(system, 'fcrDDownMw'),
      // An Automation without aFRR runs no restoration in the synchronous area at all.
      afrrUpMw: automation.afrr.enabled ? requiredExternalValue(system, 'afrrUpMw') : 0,
      afrrDownMw: automation.afrr.enabled ? requiredExternalValue(system, 'afrrDownMw') : 0,
    },
  }
}

export const storageFrequencyUnit = (definition: { readonly id: string; readonly maxDischargeMw: number; readonly maxChargeMw: number; readonly capacityMwh: number }): FrequencyStorageUnit => ({
  id: definition.id,
  connected: true,
  maximumDischargeMw: definition.maxDischargeMw,
  maximumChargeMw: definition.maxChargeMw,
  energyCapacityMwh: definition.capacityMwh,
  chargeEfficiency: storageEfficiencyPerDirection,
  dischargeEfficiency: storageEfficiencyPerDirection,
  scheduledMw: 0,
})

/** The frequency library's view of one energised island for the next advance. */
export const islandFrequencyInput = (grid: GridRuntimeInstance, island: GridTopologyIsland, islandId: string): IslandFrequencyInput => {
  const states = islandAssetStates(grid, island)
  return {
  islandId,
  units: island.generators.map((definition, index) => {
    const state = states.generators[index]!
    // Only an online unit runs between its minimum stable generation and its availability; a
    // stopping unit unloads to 0 MW and holds no reserve; an unsynchronised unit has no operating range.
    const online = state.state === 'online'
    return frequencyUnitFor({
      definition,
      synchronised: gridGeneratorIsSynchronised(state),
      minimumMw: online ? generatorMinimumStableMw(definition) : 0,
      availableMw: state.availableMw,
      targetMw: state.targetMw,
      reserves: state.state === 'stopping' ? noReserves : state.reserves,
    })
  }),
  storage: island.storage.map(storageFrequencyUnit),
  loads: island.loads.map((definition, index) => ({
    id: definition.id,
    priority: definition.priority,
    demandMw: connectedGridLoadMw(states.loads[index]!),
    protectedMw: definition.criticalMw,
  })),
  externals: islandMembers(grid, island).externals.map(system => externalFrequencyEquivalent(grid, system)),
  lossesMw: islandLossesMw(grid, island),
  fixedInjectionMw: islandFixedInjectionMw(grid, island),
  }
}
