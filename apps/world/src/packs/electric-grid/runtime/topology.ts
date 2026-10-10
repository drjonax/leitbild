import type { GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import { compiledGridNetworkFor, type CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'

/** One island structure (its buses and closed branches) with the views and factor built from it. */
interface CachedIsland {
  readonly buses: Int32Array
  readonly branches: Int32Array
  readonly island: GridTopologyIsland
  readonly system: GridIslandSystem
}

/** Island structures of a grid's current and previous plan, so unchanged islands and a branch switched back reuse their factors. */
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

const createCachedIsland = (
  grid: GridRuntimeInstance,
  network: CompiledGridNetwork,
  buses: Int32Array,
  branches: Int32Array,
  localOfBus: Int32Array,
): CachedIsland => {
  const { model, index } = grid.definition
  let namingBus = buses[0]!
  for (const bus of buses) if (network.busIdSortRank[bus]! < network.busIdSortRank[namingBus]!) namingBus = bus
  const id = `island:${network.busIds[namingBus]!}`
  const busIds = Array.from(buses, bus => network.busIds[bus]!)
  const island: GridTopologyIsland = {
    id,
    referenceBusId: busIds[0]!,
    buses: busIds,
    busSet: new Set(busIds),
    branches: Array.from(branches, branch => model.branches[branch]!),
    generators: busIds.flatMap(busId => index.generatorsByBus.get(busId) ?? []),
    loads: busIds.flatMap(busId => index.loadsByBus.get(busId) ?? []),
    storage: busIds.flatMap(busId => index.storageByBus.get(busId) ?? []),
  }
  return { buses, branches, island, system: createGridIslandSystem({ network, islandId: id, buses, branches, localOfBus }) }
}

const buildTopologyPlan = (grid: GridRuntimeInstance, network: CompiledGridNetwork, closedBranches: Uint8Array): GridTopologyPlan => {
  const found = findGridIslands(network, closedBranches)
  const cache = islandCaches.get(grid) ?? { current: new Map(), previous: new Map() }
  const generation = new Map<number, CachedIsland[]>()
  const localOfBus = new Int32Array(network.busCount)
  const islands: GridTopologyIsland[] = []
  const systems: GridIslandSystem[] = []
  const islandIdByBus = new Map<string, string>()
  for (let island = 0; island < found.count; island += 1) {
    const buses = found.busOrder.subarray(found.busStart[island]!, found.busStart[island + 1]!)
    const branches = found.branchOrder.subarray(found.branchStart[island]!, found.branchStart[island + 1]!)
    const hash = structureHash(buses, branches)
    const entry = cachedIsland(cache.current, hash, buses, branches)
      ?? cachedIsland(cache.previous, hash, buses, branches)
      ?? createCachedIsland(grid, network, buses.slice(), branches.slice(), localOfBus)
    const sameHash = generation.get(hash)
    if (sameHash) sameHash.push(entry)
    else generation.set(hash, [entry])
    islands.push(entry.island)
    systems.push(entry.system)
    for (const busId of entry.island.buses) islandIdByBus.set(busId, entry.island.id)
  }
  islandCaches.set(grid, { current: generation, previous: cache.current })
  return {
    network,
    closedBranches,
    islands,
    systems,
    islandIdByBus,
    islandIndexOfBus: found.islandOfBus,
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
 * Solves the islands flagged in `solveIsland` from the plan's `injectionsMw` into `anglesRad` (radians,
 * reference bus 0) and `referenceMismatchMw` (the island's injection sum); other islands get angle 0.
 */
export const solvePlanInto = (plan: GridTopologyPlan, solveIsland: Uint8Array): void => {
  const { network, injectionsMw, anglesRad } = plan
  for (let island = 0; island < plan.systems.length; island += 1) {
    if (solveIsland[island] === 1) {
      plan.referenceMismatchMw[island] = solveGridIslandInto(network, plan.systems[island]!, injectionsMw, anglesRad)
      continue
    }
    plan.referenceMismatchMw[island] = 0
    for (const bus of plan.systems[island]!.buses) anglesRad[bus] = 0
  }
}

/** Solves every island into the plan's per-bus angle and per-island reference-mismatch arrays. */
const solvePlan = (plan: GridTopologyPlan, injections: ReadonlyMap<string, number>): void => {
  const { network, injectionsMw, anglesRad } = plan
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const injectionMw = injections.get(network.busIds[bus]!)
    if (injectionMw === undefined || !Number.isFinite(injectionMw)) throw new Error(`Grid bus ${network.busIds[bus]!} has no finite injection: ${injectionMw}`)
    injectionsMw[bus] = injectionMw
  }
  for (let island = 0; island < plan.systems.length; island += 1) {
    plan.referenceMismatchMw[island] = solveGridIslandInto(network, plan.systems[island]!, injectionsMw, anglesRad)
  }
}

/** Bus voltage angles in radians for bus injections in MW. */
export const solveGridAngles = (plan: GridTopologyPlan, injections: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  solvePlan(plan, injections)
  const angles = new Map<string, number>()
  for (let bus = 0; bus < plan.network.busCount; bus += 1) angles.set(plan.network.busIds[bus]!, plan.anglesRad[bus]!)
  return angles
}
