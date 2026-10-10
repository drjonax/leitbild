import type { CompiledGridNetwork } from './compiled-network.ts'

export interface GridNetworkIslands {
  readonly count: number
  readonly islandOfBus: Int32Array
  /** Buses of island k are `busOrder[busStart[k] .. busStart[k + 1])`, ascending; islands are ordered by their first bus. */
  readonly busStart: Int32Array
  readonly busOrder: Int32Array
  /** Closed branches of island k are `branchOrder[branchStart[k] .. branchStart[k + 1])`, ascending. */
  readonly branchStart: Int32Array
  readonly branchOrder: Int32Array
}

/** Connected components over closed branches by union-find (union by size, path halving). */
export const findGridIslands = (network: CompiledGridNetwork, closedBranches: Uint8Array): GridNetworkIslands => {
  const { busCount, branchCount, branchFrom, branchTo } = network
  if (closedBranches.length !== branchCount) throw new Error(`closed-branch flags cover ${closedBranches.length} of ${branchCount} branches`)
  const parent = new Int32Array(busCount)
  const size = new Int32Array(busCount)
  for (let bus = 0; bus < busCount; bus += 1) {
    parent[bus] = bus
    size[bus] = 1
  }
  const find = (bus: number): number => {
    let current = bus
    while (parent[current] !== current) {
      const grandparent = parent[parent[current]!]!
      parent[current] = grandparent
      current = grandparent
    }
    return current
  }
  for (let branch = 0; branch < branchCount; branch += 1) {
    if (closedBranches[branch] !== 1) continue
    let a = find(branchFrom[branch]!)
    let b = find(branchTo[branch]!)
    if (a === b) continue
    if (size[a]! < size[b]!) [a, b] = [b, a]
    parent[b] = a
    size[a] = size[a]! + size[b]!
  }
  const islandOfRoot = new Int32Array(busCount).fill(-1)
  const islandOfBus = new Int32Array(busCount)
  let count = 0
  for (let bus = 0; bus < busCount; bus += 1) {
    const root = find(bus)
    if (islandOfRoot[root] === -1) {
      islandOfRoot[root] = count
      count += 1
    }
    islandOfBus[bus] = islandOfRoot[root]!
  }
  const busStart = new Int32Array(count + 1)
  for (let bus = 0; bus < busCount; bus += 1) busStart[islandOfBus[bus]! + 1] = busStart[islandOfBus[bus]! + 1]! + 1
  for (let island = 0; island < count; island += 1) busStart[island + 1] = busStart[island + 1]! + busStart[island]!
  const busOrder = new Int32Array(busCount)
  const busFill = busStart.slice(0, count)
  for (let bus = 0; bus < busCount; bus += 1) {
    const island = islandOfBus[bus]!
    busOrder[busFill[island]!] = bus
    busFill[island] = busFill[island]! + 1
  }
  const branchStart = new Int32Array(count + 1)
  for (let branch = 0; branch < branchCount; branch += 1) {
    if (closedBranches[branch] !== 1) continue
    const island = islandOfBus[branchFrom[branch]!]!
    branchStart[island + 1] = branchStart[island + 1]! + 1
  }
  for (let island = 0; island < count; island += 1) branchStart[island + 1] = branchStart[island + 1]! + branchStart[island]!
  const branchOrder = new Int32Array(branchStart[count]!)
  const branchFill = branchStart.slice(0, count)
  for (let branch = 0; branch < branchCount; branch += 1) {
    if (closedBranches[branch] !== 1) continue
    const island = islandOfBus[branchFrom[branch]!]!
    branchOrder[branchFill[island]!] = branch
    branchFill[island] = branchFill[island]! + 1
  }
  return { count, islandOfBus, busStart, busOrder, branchStart, branchOrder }
}
