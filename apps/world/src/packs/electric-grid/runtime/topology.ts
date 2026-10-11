import type { GridRuntimeInstance, GridTopologyComponent, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import { compiledGridNetworkFor, type CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'

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

/** Branch states are keyed in model order; any other order means the runtime state no longer matches its Model. */
const branchStateOrderError = (grid: GridRuntimeInstance, detail: string): Error =>
  new Error(`Grid ${grid.definition.gridId} branch states do not follow its Model's branch order: ${detail}`)

const closedBranchFlags = (grid: GridRuntimeInstance, network: CompiledGridNetwork): Uint8Array => {
  const closed = new Uint8Array(network.branchCount)
  let index = 0
  for (const [id, state] of grid.branches) {
    if (id !== network.branchIds[index]) throw branchStateOrderError(grid, `found ${id} at position ${index}`)
    closed[index] = state.state === 'closed' ? 1 : 0
    index += 1
  }
  if (index !== network.branchCount) throw branchStateOrderError(grid, `${index} states for ${network.branchCount} branches`)
  return closed
}

const closedBranchesChanged = (grid: GridRuntimeInstance, network: CompiledGridNetwork, closed: Uint8Array): boolean => {
  let index = 0
  for (const [id, state] of grid.branches) {
    if (id !== network.branchIds[index]) throw branchStateOrderError(grid, `found ${id} at position ${index}`)
    if ((state.state === 'closed' ? 1 : 0) !== closed[index]) return true
    index += 1
  }
  if (index !== network.branchCount) throw branchStateOrderError(grid, `${index} states for ${network.branchCount} branches`)
  return false
}

const createCachedIsland = (network: CompiledGridNetwork, buses: Int32Array, branches: Int32Array, localOfBus: Int32Array): CachedIsland => {
  let namingBus = buses[0]!
  for (const bus of buses) if (network.busIdSortRank[bus]! < network.busIdSortRank[namingBus]!) namingBus = bus
  return { buses, branches, system: createGridIslandSystem({ network, islandId: `component:${network.busIds[namingBus]!}`, buses, branches, localOfBus }) }
}

/**
 * Synchronous islands over AC components: components holding boundary buses of the same
 * synchronous external system run at that system's frequency and form one island.
 */
const synchronousIslandOfComponent = (grid: GridRuntimeInstance, network: CompiledGridNetwork, componentOfBus: Int32Array, componentCount: number): Int32Array => {
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
    const first = find(componentOfBus[network.busIndexById.get(system.boundaryBusIds[0]!)!]!)
    for (const busId of system.boundaryBusIds.slice(1)) {
      const other = find(componentOfBus[network.busIndexById.get(busId)!]!)
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

const buildTopologyPlan = (grid: GridRuntimeInstance, network: CompiledGridNetwork, closedBranches: Uint8Array): GridTopologyPlan => {
  const { model, index } = grid.definition
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
  const islandOfComponent = synchronousIslandOfComponent(grid, network, found.islandOfBus, found.count)
  const islandCount = found.count === 0 ? 0 : Math.max(...islandOfComponent) + 1
  const components: GridTopologyComponent[] = systems.map((system, component) => ({
    referenceBusId: network.busIds[system.buses[0]!]!,
    buses: Array.from(system.buses, bus => network.busIds[bus]!),
    busIndices: system.buses,
    islandIndex: islandOfComponent[component]!,
  }))
  const componentsOfIsland: number[][] = Array.from({ length: islandCount }, () => [])
  components.forEach((component, componentIndex) => componentsOfIsland[component.islandIndex]!.push(componentIndex))
  const islandIndexOfBus = new Int32Array(network.busCount)
  for (let bus = 0; bus < network.busCount; bus += 1) islandIndexOfBus[bus] = islandOfComponent[found.islandOfBus[bus]!]!
  const islandIdByBus = new Map<string, string>()
  const islands: GridTopologyIsland[] = componentsOfIsland.map(componentIndices => {
    const busIndices = componentIndices.flatMap(component => Array.from(systems[component]!.buses)).sort((a, b) => a - b)
    let namingBus = busIndices[0]!
    for (const bus of busIndices) if (network.busIdSortRank[bus]! < network.busIdSortRank[namingBus]!) namingBus = bus
    const id = `island:${network.busIds[namingBus]!}`
    const busIds = busIndices.map(bus => network.busIds[bus]!)
    for (const busId of busIds) islandIdByBus.set(busId, id)
    return {
      id,
      referenceBusId: components[componentIndices[0]!]!.referenceBusId,
      buses: busIds,
      busSet: new Set(busIds),
      branches: componentIndices.flatMap(component => Array.from(systems[component]!.branches)).sort((a, b) => a - b).map(branch => model.branches[branch]!),
      generators: busIds.flatMap(busId => index.generatorsByBus.get(busId) ?? []),
      loads: busIds.flatMap(busId => index.loadsByBus.get(busId) ?? []),
      storage: busIds.flatMap(busId => index.storageByBus.get(busId) ?? []),
      componentIndices,
    }
  })
  return {
    network,
    closedBranches,
    islands,
    components,
    systems,
    islandIdByBus,
    islandIndexOfBus,
    componentIndexOfBus: found.islandOfBus,
    injectionsMw: new Float64Array(network.busCount),
    anglesRad: new Float64Array(network.busCount),
    referenceMismatchMw: new Float64Array(found.count),
  }
}

/** The grid's islands and factors; rebuilt only when a branch's closed state differs from the cached plan, however it changed. */
export const topologyPlanForGrid = (grid: GridRuntimeInstance): GridTopologyPlan => {
  const network = compiledGridNetworkFor(grid.definition.model)
  const cached = grid.topologyPlan
  if (cached !== null && cached.network === network && !closedBranchesChanged(grid, network, cached.closedBranches)) return cached
  const startedAtMs = performance.now()
  const plan = buildTopologyPlan(grid, network, closedBranchFlags(grid, network))
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
