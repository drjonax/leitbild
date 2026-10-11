import type { GridExternalSystemDefinition } from '../grid-model.ts'
import type { ExternalFrequencyEquivalent, FrequencyStorageUnit, IslandFrequencyInput } from './frequency/types.ts'
import { frequencyUnitFor, generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import { hvdcInjectionAtBusesMw } from './hvdc.ts'
import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
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
    externals: [...new Set(island.buses.flatMap(busId => {
      const system = index.synchronousExternalByBus.get(busId)
      return system === undefined ? [] : [system]
    }))],
    connectionPointIds: model.connectionPoints.filter(point => island.busSet.has(point.busId)).map(point => point.id),
  }
  membersByIsland.set(island, members)
  return members
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
export const islandFrequencyInput = (grid: GridRuntimeInstance, island: GridTopologyIsland, islandId: string): IslandFrequencyInput => ({
  islandId,
  units: island.generators.map(definition => {
    const state = grid.generators.get(definition.id)!
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
  loads: island.loads.map(definition => ({
    id: definition.id,
    priority: definition.priority,
    demandMw: connectedGridLoadMw(grid.loads.get(definition.id)!),
    protectedMw: definition.criticalMw,
  })),
  externals: islandMembers(grid, island).externals.map(system => externalFrequencyEquivalent(grid, system)),
  lossesMw: islandLossesMw(grid, island),
  fixedInjectionMw: islandFixedInjectionMw(grid, island),
})
