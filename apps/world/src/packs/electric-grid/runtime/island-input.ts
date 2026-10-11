import type { GridExternalSystemDefinition } from '../grid-model.ts'
import type { ExternalFrequencyEquivalent, FrequencyStorageUnit, IslandFrequencyInput } from './frequency/types.ts'
import { frequencyUnitFor } from './generator-dynamics.ts'
import { hvdcInjectionIntoIslandMw } from './hvdc.ts'
import type { GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { generatorIsSynchronised, generatorMinimumStableMw } from './unit-commitment.ts'
import { noReserves } from './frequency/governors.ts'
import { branchClosed, generatorOnline, generatorStopping, type GridGeneratorArrays } from './state/arrays.ts'
import { readReserves } from './state/views.ts'
import { gridTablesFor } from './state/tables.ts'

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
  const tables = gridTablesFor(grid.definition)
  const members: IslandMembers = {
    busIndices: island.busIndices,
    generatorBuses: island.generatorIndices.map(generator => tables.generatorBus[generator]!),
    loadBuses: island.loadIndices.map(load => tables.loadBus[load]!),
    storageBuses: island.storageIndices.map(item => tables.storageBus[item]!),
    externals: Array.from(island.externalIndices, system => index.externalSystems[system]!),
    connectionPointIds: Array.from(island.connectionPointIndices, point => model.connectionPoints[point]!.id),
  }
  membersByIsland.set(island, members)
  return members
}

const participationEntries = new WeakMap<GridExternalSystemDefinition, Int32Array>()

/** Position in `participation` of the first area listing each bus as a boundary bus of `system`, −1 for none. */
const participationEntryOfBus = (
  grid: GridRuntimeInstance,
  system: GridExternalSystemDefinition,
  participation: NonNullable<GridExternalSystemDefinition['areaParticipation']>,
): Int32Array => {
  const cached = participationEntries.get(system)
  if (cached !== undefined) return cached
  const network = gridTablesFor(grid.definition).network
  const entries = new Int32Array(network.busCount).fill(-1)
  for (let entry = participation.length - 1; entry >= 0; entry -= 1) {
    for (const busId of participation[entry]!.boundaryBusIds) {
      const bus = network.busIndexById.get(busId)
      if (bus !== undefined) entries[bus] = entry
    }
  }
  participationEntries.set(system, entries)
  return entries
}

/**
 * How a synchronous external system's exchange with one Norwegian AC component is shared among
 * the given boundary buses of that component: by area participation (renormalised over the areas
 * present), then within an area by the derated rating of each bus's closed ties. Writes the share
 * of `boundaryBuses[k]` (bus indices) into `shares[k]`; `capacities` is scratch of the same length.
 */
export const externalBoundarySharesInto = (
  grid: GridRuntimeInstance,
  system: GridExternalSystemDefinition,
  boundaryBuses: ArrayLike<number>,
  count: number,
  capacities: Float64Array,
  shares: Float64Array,
): void => {
  const participation = system.areaParticipation
  if (participation === undefined) throw new Error(`${system.id} has no area participation to share its exchange`)
  const busIds = gridTablesFor(grid.definition).network.busIds
  const entryOfBus = participationEntryOfBus(grid, system, participation)
  const entryOf = (position: number) => {
    const entry = entryOfBus[boundaryBuses[position]!]!
    if (entry === -1) throw new Error(`${system.id}: boundary bus ${busIds[boundaryBuses[position]!]!} lies in no participating area`)
    return participation[entry]!
  }
  for (let position = 0; position < count; position += 1) capacities[position] = boundaryTieCapacityAt(grid, boundaryBuses[position]!)
  // Areas present, each counted once in order of first appearance.
  let presentShare = 0
  for (let position = 0; position < count; position += 1) {
    const entry = entryOf(position)
    let seen = false
    for (let earlier = 0; earlier < position && !seen; earlier += 1) seen = entryOf(earlier) === entry
    if (!seen) presentShare += entry.share
  }
  for (let position = 0; position < count; position += 1) {
    const entry = entryOf(position)
    let areaCapacityMw = 0
    for (let other = 0; other < count; other += 1) if (entryOf(other) === entry) areaCapacityMw += capacities[other]!
    if (!(areaCapacityMw > 0)) throw new Error(`${system.id}: the ties of ${entry.area} at ${busIds[boundaryBuses[position]!]!} carry no rating`)
    shares[position] = entry.share / presentShare * capacities[position]! / areaCapacityMw
  }
}

/** Scratch for one external system's boundary buses in one component: bus indices, tie capacities, shares. */
export interface ExternalBoundaryScratch {
  readonly buses: Int32Array
  readonly capacities: Float64Array
  readonly shares: Float64Array
}

const boundaryScratches = new WeakMap<GridRuntimeInstance, ExternalBoundaryScratch>()

/** The Grid's boundary scratch, sized for the Model's external system with the most boundary buses. */
export const externalBoundaryScratch = (grid: GridRuntimeInstance): ExternalBoundaryScratch => {
  let scratch = boundaryScratches.get(grid)
  if (scratch === undefined) {
    const size = Math.max(0, ...grid.definition.index.externalSystems.map(system => system.boundaryBusIds.length))
    scratch = { buses: new Int32Array(size), capacities: new Float64Array(size), shares: new Float64Array(size) }
    boundaryScratches.set(grid, scratch)
  }
  return scratch
}

/** Writes the boundary buses of external system `system` in plan component `component` into `buses`, in Model order; returns how many. */
export const boundaryBusesInComponent = (grid: GridRuntimeInstance, plan: GridTopologyPlan, system: number, component: number, buses: Int32Array): number => {
  const boundaryBuses = gridTablesFor(grid.definition).externalBoundaryBuses
  let count = 0
  for (let entry = boundaryBuses.start[system]!; entry < boundaryBuses.start[system + 1]!; entry += 1) {
    const bus = boundaryBuses.items[entry]!
    if (plan.componentIndexOfBus[bus] === component) buses[count++] = bus
  }
  return count
}

/** externalBoundaryShares for boundary bus ids: the shares in the order given. */
export const externalBoundaryShares = (grid: GridRuntimeInstance, system: GridExternalSystemDefinition, boundaryBusIds: ReadonlyArray<string>): ReadonlyArray<number> => {
  const busIndexById = gridTablesFor(grid.definition).network.busIndexById
  const buses = Int32Array.from(boundaryBusIds, busId => {
    const bus = busIndexById.get(busId)
    if (bus === undefined) throw new Error(`unknown Grid bus ${busId}`)
    return bus
  })
  const shares = new Float64Array(buses.length)
  externalBoundarySharesInto(grid, system, buses, buses.length, new Float64Array(buses.length), shares)
  return Array.from(shares)
}

/** Rating of the closed AC ties at a boundary bus, derated by their availability (MW). */
export const boundaryTieCapacityMw = (grid: GridRuntimeInstance, boundaryBusId: string): number => {
  const bus = gridTablesFor(grid.definition).network.busIndexById.get(boundaryBusId)
  if (bus === undefined) throw new Error(`unknown Grid bus ${boundaryBusId}`)
  return boundaryTieCapacityAt(grid, bus)
}

/** boundaryTieCapacityMw of bus index `bus`. */
export const boundaryTieCapacityAt = (grid: GridRuntimeInstance, bus: number): number => {
  const tables = gridTablesFor(grid.definition)
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  let capacityMw = 0
  for (let entry = tables.branchesOfBus.start[bus]!; entry < tables.branchesOfBus.start[bus + 1]!; entry += 1) {
    const branch = tables.branchesOfBus.items[entry]!
    capacityMw += arrays.status[branch] === branchClosed ? branches[branch]!.ratingMw * arrays.availability[branch]! : 0
  }
  return capacityMw
}

/** Synchronised units: online, or stopping until its breaker opens at 0 MW (unit-commitment.ts). */
export const gridGeneratorIsSynchronised = generatorIsSynchronised

/** Whether unit `index` is synchronised, from its lifecycle code. */
export const generatorSynchronisedAt = (generators: GridGeneratorArrays, index: number): boolean => {
  const lifecycle = generators.lifecycle[index]!
  return lifecycle === generatorOnline || lifecycle === generatorStopping
}

/**
 * An island is energised only while a voltage-forming source holds it: a synchronised synchronous
 * generator or a synchronous external system. Converters, storage and connected systems (Plants)
 * follow an existing voltage and cannot energise an island on their own.
 */
export const islandHasVoltageFormingSource = (grid: GridRuntimeInstance, island: GridTopologyIsland): boolean => {
  if (island.externalIndices.length > 0) return true
  const tables = gridTablesFor(grid.definition)
  const generators = grid.arrays.generators
  for (let generatorPosition = 0; generatorPosition < island.generatorIndices.length; generatorPosition += 1) {
    const generator = island.generatorIndices[generatorPosition]!
    if (tables.generatorSynchronous[generator] === 1 && generatorSynchronisedAt(generators, generator)) return true
  }
  return false
}

/** Kinetic energy Σ H·S of synchronised synchronous units plus synchronous external systems (MWs). */
export const islandKineticEnergyMws = (grid: GridRuntimeInstance, island: GridTopologyIsland): number => {
  const tables = gridTablesFor(grid.definition)
  const generators = grid.arrays.generators
  let kineticEnergyMws = 0
  for (let generatorPosition = 0; generatorPosition < island.generatorIndices.length; generatorPosition += 1) {
    const generator = island.generatorIndices[generatorPosition]!
    kineticEnergyMws += generatorSynchronisedAt(generators, generator) ? tables.generatorKineticEnergyMws[generator]! : 0
  }
  let externalMws = 0
  for (let systemPosition = 0; systemPosition < island.externalIndices.length; systemPosition += 1) {
    const system = island.externalIndices[systemPosition]!
    externalMws += externalKineticEnergyMws(grid.definition.index.externalSystems[system]!)
  }
  return kineticEnergyMws + externalMws
}

export const externalKineticEnergyMws = (system: GridExternalSystemDefinition): number => {
  if (system.inertiaGws === undefined) throw new Error(`synchronous external system ${system.id} has no inertia`)
  return system.inertiaGws * 1_000
}

/** Connected systems (Plants) and HVDC converters inject fixed power into the island over an advance. */
export const islandFixedInjectionMw = (grid: GridRuntimeInstance, island: GridTopologyIsland): number => {
  let injectionMw = 0
  for (let pointPosition = 0; pointPosition < island.connectionPointIndices.length; pointPosition += 1) {
    const point = island.connectionPointIndices[pointPosition]!
    const connection = grid.arrays.connections[point]!
    if (connection?.connected === true) injectionMw += connection.systemActivePowerMw
  }
  return injectionMw + hvdcInjectionIntoIslandMw(grid, island.busIndices)
}

export const islandLossesMw = (grid: GridRuntimeInstance, island: GridTopologyIsland): number => {
  let lossesMw = 0
  for (let busPosition = 0; busPosition < island.busIndices.length; busPosition += 1) {
    const bus = island.busIndices[busPosition]!
    lossesMw += grid.lossLoadByBusMw[bus]!
  }
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

const reserveVolumes = new WeakMap<GridRuntimeInstance, WeakMap<GridExternalSystemDefinition, Float64Array>>()

/**
 * The reserve volumes and load of a synchronous external system, as externalFrequencyEquivalent
 * gives them: FCR-N, FCR-D up, FCR-D down, aFRR up, aFRR down (MW) and its load (MW). They follow
 * from the definition and the Automation alone, so they are computed once per Grid.
 */
export const externalReserveVolumes = (grid: GridRuntimeInstance, system: GridExternalSystemDefinition): Float64Array => {
  let bySystem = reserveVolumes.get(grid)
  if (bySystem === undefined) {
    bySystem = new WeakMap()
    reserveVolumes.set(grid, bySystem)
  }
  let volumes = bySystem.get(system)
  if (volumes === undefined) {
    const equivalent = externalFrequencyEquivalent(grid, system)
    const reserves = equivalent.reserves
    volumes = Float64Array.of(reserves.fcrNMw, reserves.fcrDUpMw, reserves.fcrDDownMw, reserves.afrrUpMw, reserves.afrrDownMw, equivalent.loadMw)
    bySystem.set(system, volumes)
  }
  return volumes
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
  const { model } = grid.definition
  const generators = grid.arrays.generators
  const loads = grid.arrays.loads
  return {
    islandId,
    units: Array.from(island.generatorIndices, generator => {
      const definition = model.generators[generator]!
      const lifecycle = generators.lifecycle[generator]!
      // Only an online unit runs between its minimum stable generation and its availability; a
      // stopping unit unloads to 0 MW and holds no reserve; an unsynchronised unit has no operating range.
      const online = lifecycle === generatorOnline
      return frequencyUnitFor({
        definition,
        synchronised: generatorSynchronisedAt(generators, generator),
        minimumMw: online ? generatorMinimumStableMw(definition) : 0,
        availableMw: generators.availableMw[generator]!,
        targetMw: generators.targetMw[generator]!,
        reserves: lifecycle === generatorStopping ? noReserves : readReserves(generators, generator),
      })
    }),
    storage: Array.from(island.storageIndices, item => storageFrequencyUnit(model.storage[item]!)),
    loads: Array.from(island.loadIndices, load => {
      const definition = model.loads[load]!
      return { id: definition.id, priority: definition.priority, demandMw: connectedGridLoadMw(loads, load), protectedMw: definition.criticalMw }
    }),
    externals: Array.from(island.externalIndices, system => externalFrequencyEquivalent(grid, grid.definition.index.externalSystems[system]!)),
    lossesMw: islandLossesMw(grid, island),
    fixedInjectionMw: islandFixedInjectionMw(grid, island),
  }
}
