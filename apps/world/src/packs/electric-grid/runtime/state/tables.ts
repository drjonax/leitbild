import type { CompiledGridModelIndex, GridModelDefinition } from '../../grid-model.ts'
import { demandProfileStride } from '../demand-profiles.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from '../generator-dynamics.ts'
import { compiledGridNetworkFor, type CompiledGridNetwork } from '../network/compiled-network.ts'

/** Items grouped by bus: the items of bus b are `items[start[b] .. start[b + 1])`, in model order. */
export interface GridIndexByBus {
  readonly start: Int32Array
  readonly items: Int32Array
}

/**
 * Integer index tables of one Grid Model, compiled once per Model: the position of every asset in
 * its Model list is the index the runtime works with. String ids are looked up only at the boundary
 * (commands, queries, persistence); the runtime walks these tables.
 */
export interface GridTables {
  readonly network: CompiledGridNetwork
  readonly branchIndexById: ReadonlyMap<string, number>
  readonly generatorIndexById: ReadonlyMap<string, number>
  readonly loadIndexById: ReadonlyMap<string, number>
  readonly storageIndexById: ReadonlyMap<string, number>
  readonly externalIndexById: ReadonlyMap<string, number>
  readonly hvdcIndexById: ReadonlyMap<string, number>
  readonly connectionPointIndexById: ReadonlyMap<string, number>
  /** Bus of each generator, load, storage unit and connection point. */
  readonly generatorBus: Int32Array
  readonly loadBus: Int32Array
  readonly storageBus: Int32Array
  readonly connectionPointBus: Int32Array
  readonly generatorsOfBus: GridIndexByBus
  readonly loadsOfBus: GridIndexByBus
  readonly storageOfBus: GridIndexByBus
  /** Branches at each bus (either end), in model order. */
  readonly branchesOfBus: GridIndexByBus
  /** The synchronous external system whose boundary bus each bus is, or −1. */
  readonly synchronousExternalOfBus: Int32Array
  /** 1 on the boundary buses of asynchronous external systems (HVDC terminals outside the AC network). */
  readonly asynchronousBoundaryBus: Uint8Array
  /** Boundary buses of each external system, in its Model order: system k's are `items[start[k] .. start[k + 1])`. */
  readonly externalBoundaryBuses: GridIndexByBus
  /** Converter terminal buses of each HVDC link. */
  readonly hvdcFromBus: Int32Array
  readonly hvdcToBus: Int32Array
  /** 1 for a synchronous (voltage-forming) unit, and its kinetic energy H·S (MWs; 0 when converter-connected). */
  readonly generatorSynchronous: Uint8Array
  readonly generatorKineticEnergyMws: Float64Array
  /** Branch parameters the network solution reads per branch: r and x² (pu), the from-end tap ratio (1 off transformers), the rating (MW). */
  readonly branchResistancePu: Float64Array
  readonly branchReactanceSquaredPu: Float64Array
  readonly branchFromTap: Float64Array
  readonly branchRatingMw: Float64Array
  /** Reactive demand per MW served of each load: tan(acos(power factor)). */
  readonly loadReactivePerMw: Float64Array
  /** Each load's demand profile: its position in the Model's demandProfiles. */
  readonly loadDemandProfile: Int32Array
  /** Hour values of the Model's demand profiles: profile p's weekday hours 0..23 from p·48, then its weekend hours. */
  readonly demandProfileHours: Float64Array
}

const indexById = (items: ReadonlyArray<{ readonly id: string }>): ReadonlyMap<string, number> =>
  new Map(items.map((item, position) => [item.id, position]))

const indexByBus = (busCount: number, busOfItem: Int32Array): GridIndexByBus => {
  const start = new Int32Array(busCount + 1)
  for (const bus of busOfItem) start[bus + 1] = start[bus + 1]! + 1
  for (let bus = 0; bus < busCount; bus += 1) start[bus + 1] = start[bus + 1]! + start[bus]!
  const fill = start.slice(0, busCount)
  const items = new Int32Array(busOfItem.length)
  busOfItem.forEach((bus, item) => {
    items[fill[bus]!] = item
    fill[bus] = fill[bus]! + 1
  })
  return { start, items }
}

const compileGridTables = (model: GridModelDefinition, index: CompiledGridModelIndex): GridTables => {
  const network = compiledGridNetworkFor(model)
  const busOf = (busId: string): number => network.busIndexById.get(busId)!
  const generatorBus = Int32Array.from(model.generators, item => busOf(item.busId))
  const loadBus = Int32Array.from(model.loads, item => busOf(item.busId))
  const storageBus = Int32Array.from(model.storage, item => busOf(item.busId))
  // Each branch at its from bus, then at its to bus, in model order (as the Model index groups them).
  const branchEnds = new Int32Array(network.branchCount * 2)
  const branchOfEnd = new Int32Array(network.branchCount * 2)
  for (let branch = 0; branch < network.branchCount; branch += 1) {
    branchEnds[branch * 2] = network.branchFrom[branch]!
    branchEnds[branch * 2 + 1] = network.branchTo[branch]!
    branchOfEnd[branch * 2] = branch
    branchOfEnd[branch * 2 + 1] = branch
  }
  const endsOfBus = indexByBus(network.busCount, branchEnds)
  const synchronousExternalOfBus = new Int32Array(network.busCount).fill(-1)
  const asynchronousBoundaryBus = new Uint8Array(network.busCount)
  index.externalSystems.forEach((system, position) => {
    for (const busId of system.boundaryBusIds) {
      if (system.synchronous) synchronousExternalOfBus[busOf(busId)] = position
      else asynchronousBoundaryBus[busOf(busId)] = 1
    }
  })
  const demandProfileIndexById = indexById(model.demandProfiles)
  const demandProfileHours = new Float64Array(model.demandProfiles.length * demandProfileStride)
  model.demandProfiles.forEach((profile, position) => {
    demandProfileHours.set(profile.weekday, position * demandProfileStride)
    demandProfileHours.set(profile.weekend, position * demandProfileStride + 24)
  })
  const boundaryStart = new Int32Array(index.externalSystems.length + 1)
  index.externalSystems.forEach((system, position) => { boundaryStart[position + 1] = boundaryStart[position]! + system.boundaryBusIds.length })
  const boundaryItems = Int32Array.from(index.externalSystems.flatMap(system => system.boundaryBusIds), busOf)
  return {
    network,
    externalBoundaryBuses: { start: boundaryStart, items: boundaryItems },
    branchIndexById: indexById(model.branches),
    generatorIndexById: indexById(model.generators),
    loadIndexById: indexById(model.loads),
    storageIndexById: indexById(model.storage),
    externalIndexById: indexById(index.externalSystems),
    hvdcIndexById: indexById(index.hvdcLinks),
    connectionPointIndexById: indexById(model.connectionPoints),
    generatorBus,
    loadBus,
    storageBus,
    connectionPointBus: Int32Array.from(model.connectionPoints, item => busOf(item.busId)),
    generatorsOfBus: indexByBus(network.busCount, generatorBus),
    loadsOfBus: indexByBus(network.busCount, loadBus),
    storageOfBus: indexByBus(network.busCount, storageBus),
    branchesOfBus: { start: endsOfBus.start, items: endsOfBus.items.map(end => branchOfEnd[end]!) },
    synchronousExternalOfBus,
    asynchronousBoundaryBus,
    hvdcFromBus: Int32Array.from(index.hvdcLinks, link => busOf(link.fromBusId)),
    hvdcToBus: Int32Array.from(index.hvdcLinks, link => busOf(link.toBusId)),
    generatorSynchronous: Uint8Array.from(model.generators, generator => generatorIsVoltageForming(generator) ? 1 : 0),
    generatorKineticEnergyMws: Float64Array.from(model.generators, generatorKineticEnergyMws),
    branchResistancePu: Float64Array.from(model.branches, branch => branch.resistancePu),
    branchReactanceSquaredPu: Float64Array.from(model.branches, branch => branch.reactancePu ** 2),
    // Lines and cables have no transformer: their ratio is exactly 1.
    branchFromTap: Float64Array.from(model.branches, branch => branch.kind === 'transformer' ? branch.tapRatio! : 1),
    branchRatingMw: Float64Array.from(model.branches, branch => branch.ratingMw),
    loadReactivePerMw: Float64Array.from(model.loads, load => Math.tan(Math.acos(load.powerFactor))),
    loadDemandProfile: Int32Array.from(model.loads, load => demandProfileIndexById.get(load.demandProfileId)!),
    demandProfileHours,
  }
}

const tablesByIndex = new WeakMap<CompiledGridModelIndex, GridTables>()

/** The index tables of a compiled definition's Model, compiled once per Model index. */
export const gridTablesFor = (definition: { readonly model: GridModelDefinition; readonly index: CompiledGridModelIndex }): GridTables => {
  const cached = tablesByIndex.get(definition.index)
  if (cached) return cached
  const tables = compileGridTables(definition.model, definition.index)
  tablesByIndex.set(definition.index, tables)
  return tables
}
