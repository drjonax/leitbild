import type { GridModelDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance, GridTopologyComponent, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import { compiledGridNetworkFor, type CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'
import { branchClosed } from './state/arrays.ts'
import { gridTablesFor, type GridIndexByBus, type GridTables } from './state/tables.ts'

/** One AC component structure (its buses and closed branches) with the DC factor built from it. */
interface CachedIsland {
  readonly buses: Int32Array
  readonly branches: Int32Array
  readonly system: GridIslandSystem
}

/** Component structures of a grid's current and previous plan, so unchanged components and a branch switched back reuse their factors. */
interface IslandCache {
  readonly current: Map<number, CachedIsland[]>
  readonly previous: Map<number, CachedIsland[]>
}

const islandCaches = new WeakMap<GridRuntimeInstance, IslandCache>()

// 32-bit FNV-1a offset basis and prime.
const fnvOffsetBasis = 2166136261
const fnvPrime = 16777619

const structureHash = (buses: Int32Array, branches: Int32Array): number => {
  let hash = fnvOffsetBasis
  for (let index = 0; index < buses.length; index += 1) hash = Math.imul(hash ^ buses[index]!, fnvPrime)
  hash = Math.imul(hash ^ -1, fnvPrime)
  for (let index = 0; index < branches.length; index += 1) hash = Math.imul(hash ^ branches[index]!, fnvPrime)
  return hash >>> 0
}

const sameIndices = (a: Int32Array, b: Int32Array): boolean => {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

const cachedIsland = (cache: ReadonlyMap<number, ReadonlyArray<CachedIsland>>, hash: number, buses: Int32Array, branches: Int32Array): CachedIsland | undefined =>
  cache.get(hash)?.find(entry => sameIndices(entry.buses, buses) && sameIndices(entry.branches, branches))

/** Closed flag (1) per branch from the branch states. */
const closedBranchFlags = (grid: GridRuntimeInstance): Uint8Array => {
  const status = grid.arrays.branches.status
  const closed = new Uint8Array(status.length)
  for (let index = 0; index < status.length; index += 1) closed[index] = status[index] === branchClosed ? 1 : 0
  return closed
}

const closedBranchesChanged = (grid: GridRuntimeInstance, closed: Uint8Array): boolean => {
  const status = grid.arrays.branches.status
  for (let index = 0; index < status.length; index += 1) if ((status[index] === branchClosed ? 1 : 0) !== closed[index]) return true
  return false
}

const createCachedIsland = (network: CompiledGridNetwork, buses: Int32Array, branches: Int32Array, localOfBus: Int32Array): CachedIsland => {
  let namingBus = buses[0]!
  for (const bus of buses) if (network.busIdSortRank[bus]! < network.busIdSortRank[namingBus]!) namingBus = bus
  return { buses, branches, system: createGridIslandSystem({ network, islandId: `component:${network.busIds[namingBus]!}`, buses, branches, localOfBus }) }
}

/**
 * Synchronous islands over AC components: components holding boundary buses of the same
 * synchronous external system run at that system's frequency and form one island. A boundary bus
 * whose ties are all open is a component of its own, not coupled to Norway: it joins no island and
 * stays de-energised (the system has no voltage-forming source of its own there).
 */
const synchronousIslandOfComponent = (grid: GridRuntimeInstance, network: CompiledGridNetwork, componentOfBus: Int32Array, componentCount: number, componentBusCount: (component: number) => number): Int32Array => {
  const parent = Int32Array.from({ length: componentCount }, (_, index) => index)
  const find = (node: number): number => {
    let current = node
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!
      current = parent[current]!
    }
    return current
  }
  for (const system of grid.definition.index.externalSystems) {
    if (!system.synchronous) continue
    const coupled = system.boundaryBusIds
      .map(busId => componentOfBus[network.busIndexById.get(busId)!]!)
      .filter(component => componentBusCount(component) > 1)
    if (coupled.length === 0) continue
    const first = find(coupled[0]!)
    for (const component of coupled.slice(1)) {
      const other = find(component)
      if (other !== first) parent[other] = first
    }
  }
  // Islands are numbered in the order of their first component, which is the order of their first bus.
  const islandOfRoot = new Int32Array(componentCount).fill(-1)
  const islandOfComponent = new Int32Array(componentCount)
  let count = 0
  for (let component = 0; component < componentCount; component += 1) {
    const root = find(component)
    if (islandOfRoot[root] === -1) {
      islandOfRoot[root] = count
      count += 1
    }
    islandOfComponent[component] = islandOfRoot[root]!
  }
  return islandOfComponent
}

/** Items grouped by island: island k's are `items[start[k] .. start[k + 1])`, in the order they were added. */
interface IslandGroups {
  readonly start: Int32Array
  readonly items: Int32Array
}

/** Groups items by island in item order; `islandOf` returns −1 for an item in no island. */
const groupByIsland = (islandCount: number, itemCount: number, islandOf: (item: number) => number): IslandGroups => {
  const start = new Int32Array(islandCount + 1)
  for (let item = 0; item < itemCount; item += 1) {
    const island = islandOf(item)
    if (island >= 0) start[island + 1] = start[island + 1]! + 1
  }
  for (let island = 0; island < islandCount; island += 1) start[island + 1] = start[island + 1]! + start[island]!
  const fill = start.slice(0, islandCount)
  const items = new Int32Array(start[islandCount]!)
  for (let item = 0; item < itemCount; item += 1) {
    const island = islandOf(item)
    if (island < 0) continue
    items[fill[island]!] = item
    fill[island] = fill[island]! + 1
  }
  return { start, items }
}

/** Per island, the items each of its buses holds (`byBus`), bus by bus in ascending order. */
const groupBusItems = (islandCount: number, buses: IslandGroups, byBus: GridIndexByBus): IslandGroups => {
  const start = new Int32Array(islandCount + 1)
  for (let island = 0; island < islandCount; island += 1) {
    let count = 0
    for (let position = buses.start[island]!; position < buses.start[island + 1]!; position += 1) {
      const bus = buses.items[position]!
      count += byBus.start[bus + 1]! - byBus.start[bus]!
    }
    start[island + 1] = start[island]! + count
  }
  const items = new Int32Array(start[islandCount]!)
  let at = 0
  for (let position = 0; position < buses.items.length; position += 1) {
    const bus = buses.items[position]!
    for (let entry = byBus.start[bus]!; entry < byBus.start[bus + 1]!; entry += 1) items[at++] = byBus.items[entry]!
  }
  return { start, items }
}

const slice = (groups: IslandGroups, island: number): Int32Array => groups.items.subarray(groups.start[island]!, groups.start[island + 1]!)

/** A property computed on its first read and kept; the runtime reads the integer lists, readers at the boundary these. */
const defineLazy = <T extends object, K extends string, V>(target: T, key: K, compute: () => V): void => {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get: () => {
      const value = compute()
      Object.defineProperty(target, key, { value, enumerable: true })
      return value
    },
  })
}

/**
 * Synchronous external systems coupled to one island: those whose boundary bus in it has a closed tie
 * (a closed branch at a bus always lies in the bus's island), in bus order, each once.
 */
const coupledExternals = (tables: GridTables, buses: Int32Array, closedBranches: Uint8Array): Int32Array => {
  const found: number[] = []
  for (const bus of buses) {
    const system = tables.synchronousExternalOfBus[bus]!
    if (system < 0 || found.includes(system)) continue
    for (let entry = tables.branchesOfBus.start[bus]!; entry < tables.branchesOfBus.start[bus + 1]!; entry += 1) {
      if (closedBranches[tables.branchesOfBus.items[entry]!] !== 1) continue
      found.push(system)
      break
    }
  }
  return Int32Array.from(found)
}

const topologyIsland = (config: {
  readonly model: GridModelDefinition
  readonly network: CompiledGridNetwork
  readonly id: string
  readonly referenceBusId: string
  readonly busIndices: Int32Array
  readonly branchIndices: Int32Array
  readonly generatorIndices: Int32Array
  readonly loadIndices: Int32Array
  readonly storageIndices: Int32Array
  readonly connectionPointIndices: Int32Array
  readonly externalIndices: Int32Array
  readonly componentIndices: ReadonlyArray<number>
}): GridTopologyIsland => {
  const { model, network } = config
  const island = {
    id: config.id,
    referenceBusId: config.referenceBusId,
    busIndices: config.busIndices,
    branchIndices: config.branchIndices,
    generatorIndices: config.generatorIndices,
    loadIndices: config.loadIndices,
    storageIndices: config.storageIndices,
    connectionPointIndices: config.connectionPointIndices,
    externalIndices: config.externalIndices,
    componentIndices: config.componentIndices,
  }
  defineLazy(island, 'buses', () => Array.from(config.busIndices, bus => network.busIds[bus]!))
  defineLazy(island, 'busSet', () => new Set((island as unknown as GridTopologyIsland).buses))
  defineLazy(island, 'branches', () => Array.from(config.branchIndices, branch => model.branches[branch]!))
  defineLazy(island, 'generators', () => Array.from(config.generatorIndices, generator => model.generators[generator]!))
  defineLazy(island, 'loads', () => Array.from(config.loadIndices, load => model.loads[load]!))
  defineLazy(island, 'storage', () => Array.from(config.storageIndices, item => model.storage[item]!))
  return island as unknown as GridTopologyIsland
}

const buildTopologyPlan = (grid: GridRuntimeInstance, network: CompiledGridNetwork, closedBranches: Uint8Array): GridTopologyPlan => {
  const { model } = grid.definition
  const tables = gridTablesFor(grid.definition)
  const found = findGridIslands(network, closedBranches)
  const cache = islandCaches.get(grid) ?? { current: new Map(), previous: new Map() }
  const generation = new Map<number, CachedIsland[]>()
  const localOfBus = new Int32Array(network.busCount)
  const systems: GridIslandSystem[] = []
  for (let component = 0; component < found.count; component += 1) {
    const buses = found.busOrder.subarray(found.busStart[component]!, found.busStart[component + 1]!)
    const branches = found.branchOrder.subarray(found.branchStart[component]!, found.branchStart[component + 1]!)
    const hash = structureHash(buses, branches)
    const entry = cachedIsland(cache.current, hash, buses, branches)
      ?? cachedIsland(cache.previous, hash, buses, branches)
      ?? createCachedIsland(network, buses.slice(), branches.slice(), localOfBus)
    const sameHash = generation.get(hash)
    if (sameHash) sameHash.push(entry)
    else generation.set(hash, [entry])
    systems.push(entry.system)
  }
  islandCaches.set(grid, { current: generation, previous: cache.current })
  const islandOfComponent = synchronousIslandOfComponent(grid, network, found.islandOfBus, found.count, component => found.busStart[component + 1]! - found.busStart[component]!)
  const islandCount = found.count === 0 ? 0 : Math.max(...islandOfComponent) + 1
  const components: GridTopologyComponent[] = systems.map((system, component) => {
    const item = { referenceBusId: network.busIds[system.buses[0]!]!, busIndices: system.buses, islandIndex: islandOfComponent[component]! }
    defineLazy(item, 'buses', () => Array.from(system.buses, bus => network.busIds[bus]!))
    return item as GridTopologyComponent
  })
  const componentsOfIsland: number[][] = Array.from({ length: islandCount }, () => [])
  components.forEach((component, componentIndex) => componentsOfIsland[component.islandIndex]!.push(componentIndex))
  const islandIndexOfBus = new Int32Array(network.busCount)
  for (let bus = 0; bus < network.busCount; bus += 1) islandIndexOfBus[bus] = islandOfComponent[found.islandOfBus[bus]!]!
  // Members of every island as integer lists: buses and closed branches ascending; generators, loads
  // and storage bus by bus in model order within a bus; connection points in model order.
  const buses = groupByIsland(islandCount, network.busCount, bus => islandIndexOfBus[bus]!)
  const branches = groupByIsland(islandCount, network.branchCount, branch => closedBranches[branch] === 1 ? islandIndexOfBus[network.branchFrom[branch]!]! : -1)
  const generators = groupBusItems(islandCount, buses, tables.generatorsOfBus)
  const loads = groupBusItems(islandCount, buses, tables.loadsOfBus)
  const storage = groupBusItems(islandCount, buses, tables.storageOfBus)
  const connectionPoints = groupByIsland(islandCount, model.connectionPoints.length, point => islandIndexOfBus[tables.connectionPointBus[point]!]!)
  const islands: GridTopologyIsland[] = componentsOfIsland.map((componentIndices, island) => {
    const busIndices = slice(buses, island)
    let namingBus = busIndices[0]!
    for (const bus of busIndices) if (network.busIdSortRank[bus]! < network.busIdSortRank[namingBus]!) namingBus = bus
    return topologyIsland({
      model,
      network,
      id: `island:${network.busIds[namingBus]!}`,
      referenceBusId: components[componentIndices[0]!]!.referenceBusId,
      busIndices,
      branchIndices: slice(branches, island),
      generatorIndices: slice(generators, island),
      loadIndices: slice(loads, island),
      storageIndices: slice(storage, island),
      connectionPointIndices: slice(connectionPoints, island),
      externalIndices: coupledExternals(tables, busIndices, closedBranches),
      componentIndices,
    })
  })
  const plan = {
    network,
    closedBranches,
    islands,
    components,
    systems,
    islandIndexOfBus,
    componentIndexOfBus: found.islandOfBus,
    injectionsMw: new Float64Array(network.busCount),
    anglesRad: new Float64Array(network.busCount),
    referenceMismatchMw: new Float64Array(found.count),
  }
  defineLazy(plan, 'islandIdByBus', () => {
    const idByBus = new Map<string, string>()
    for (const island of islands) for (const bus of island.busIndices) idByBus.set(network.busIds[bus]!, island.id)
    return idByBus
  })
  return plan as unknown as GridTopologyPlan
}

/** The grid's islands and factors; rebuilt only when a branch's closed state differs from the cached plan, however it changed. */
export const topologyPlanForGrid = (grid: GridRuntimeInstance): GridTopologyPlan => {
  const network = compiledGridNetworkFor(grid.definition.model)
  const cached = grid.topologyPlan
  if (cached !== null && cached.network === network && !closedBranchesChanged(grid, cached.closedBranches)) return cached
  const startedAtMs = performance.now()
  const plan = buildTopologyPlan(grid, network, closedBranchFlags(grid))
  grid.topologyPlan = plan
  grid.diagnostics.topologyRebuildCount += 1
  grid.diagnostics.lastTopologyRebuildDurationMs = performance.now() - startedAtMs
  return plan
}

/**
 * Solves the components of the islands flagged in `solveIsland` from the plan's `injectionsMw` into
 * `anglesRad` (radians, each component's reference bus 0) and `referenceMismatchMw` (the component's
 * injection sum); the components of other islands get angle 0.
 */
export const solvePlanInto = (plan: GridTopologyPlan, solveIsland: Uint8Array): void => {
  const { network, injectionsMw, anglesRad } = plan
  for (let component = 0; component < plan.systems.length; component += 1) {
    if (solveIsland[plan.components[component]!.islandIndex] === 1) {
      plan.referenceMismatchMw[component] = solveGridIslandInto(network, plan.systems[component]!, injectionsMw, anglesRad)
      continue
    }
    plan.referenceMismatchMw[component] = 0
    for (const bus of plan.systems[component]!.buses) anglesRad[bus] = 0
  }
}

/** Solves every component into the plan's per-bus angle and per-component reference-mismatch arrays. */
const solvePlan = (plan: GridTopologyPlan, injections: ReadonlyMap<string, number>): void => {
  const { network, injectionsMw, anglesRad } = plan
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const injectionMw = injections.get(network.busIds[bus]!)
    if (injectionMw === undefined || !Number.isFinite(injectionMw)) throw new Error(`Grid bus ${network.busIds[bus]!} has no finite injection: ${injectionMw}`)
    injectionsMw[bus] = injectionMw
  }
  for (let component = 0; component < plan.systems.length; component += 1) {
    plan.referenceMismatchMw[component] = solveGridIslandInto(network, plan.systems[component]!, injectionsMw, anglesRad)
  }
}

/** Bus voltage angles in radians for bus injections in MW. */
export const solveGridAngles = (plan: GridTopologyPlan, injections: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  solvePlan(plan, injections)
  const angles = new Map<string, number>()
  for (let bus = 0; bus < plan.network.busCount; bus += 1) angles.set(plan.network.busIds[bus]!, plan.anglesRad[bus]!)
  return angles
}
