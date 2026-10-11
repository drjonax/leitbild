import { caseGeneratorOutputMw, type ContingencyCase } from './contingency-case.ts'
import {
  sharedFloat64,
  sharedInt32,
  sharedUint8,
  type ContingencySnapshot,
  type GridContingency,
  type SnapshotBridges,
  type SnapshotContingencies,
  type SnapshotFactors,
  type SnapshotIslands,
} from './contingency-snapshot.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import { gridGeneratorIsSynchronised } from './island-input.ts'
import { gridTablesFor } from './state/tables.ts'

export type ContingencyRatingBasis = 'normal' | 'emergency'

const sharedCopyInt32 = (source: Int32Array): Int32Array => {
  const copy = sharedInt32(source.length)
  copy.set(source)
  return copy
}

const sharedCopyUint8 = (source: Uint8Array): Uint8Array => {
  const copy = sharedUint8(source.length)
  copy.set(source)
  return copy
}

const sharedCopyFloat64 = (source: Float64Array): Float64Array => {
  const copy = sharedFloat64(source.length)
  copy.set(source)
  return copy
}

const islandsOf = (screeningCase: ContingencyCase): SnapshotIslands => {
  const count = screeningCase.islands.length
  const energised = sharedUint8(count)
  const busStart = sharedInt32(count + 1)
  const branchStart = sharedInt32(count + 1)
  screeningCase.islands.forEach((island, index) => {
    energised[index] = island.energised ? 1 : 0
    busStart[index + 1] = busStart[index]! + island.buses.length
    branchStart[index + 1] = branchStart[index]! + island.branches.length
  })
  const buses = sharedInt32(busStart[count]!)
  const branches = sharedInt32(branchStart[count]!)
  screeningCase.islands.forEach((island, index) => {
    buses.set(island.buses, busStart[index]!)
    branches.set(island.branches, branchStart[index]!)
  })
  return { count, energised, busStart, buses, branchStart, branches, islandOfBus: sharedCopyInt32(screeningCase.islandOfBus) }
}

const factorsOf = (screeningCase: ContingencyCase, islands: SnapshotIslands): SnapshotFactors => {
  const count = islands.count
  const entryStart = sharedInt32(count + 1)
  const linkStart = sharedInt32(count + 1)
  screeningCase.islands.forEach((island, index) => {
    const structure = island.system.factor.structure
    if (structure.size !== island.buses.length - 1) throw new Error(`screening case island ${index} has a factor of size ${structure.size} for ${island.buses.length} buses`)
    entryStart[index + 1] = entryStart[index]! + structure.rowIndex.length
    linkStart[index + 1] = linkStart[index]! + structure.rowColumns.length
  })
  const reducedTotal = islands.busStart[count]! - count
  const factors: SnapshotFactors = {
    perm: sharedInt32(reducedTotal),
    iperm: sharedInt32(reducedTotal),
    columnStart: sharedInt32(islands.busStart[count]!),
    rowStart: sharedInt32(islands.busStart[count]!),
    entryStart,
    rowIndex: sharedInt32(entryStart[count]!),
    values: sharedFloat64(entryStart[count]!),
    linkStart,
    rowColumns: sharedInt32(linkStart[count]!),
  }
  screeningCase.islands.forEach((island, index) => {
    const { structure, values } = island.system.factor
    factors.perm.set(structure.perm, islands.busStart[index]! - index)
    factors.iperm.set(structure.iperm, islands.busStart[index]! - index)
    factors.columnStart.set(structure.columnStart, islands.busStart[index]!)
    factors.rowStart.set(structure.rowStart, islands.busStart[index]!)
    factors.rowIndex.set(structure.rowIndex, entryStart[index]!)
    factors.values.set(values, entryStart[index]!)
    factors.rowColumns.set(structure.rowColumns, linkStart[index]!)
  })
  return factors
}

/** Bridges of every energised island by an iterative Tarjan search over closed branches (parallel circuits are not bridges). */
const bridgesOf = (screeningCase: ContingencyCase): SnapshotBridges => {
  const { network } = screeningCase
  const busCount = network.busCount
  const start = new Int32Array(busCount + 1)
  for (const island of screeningCase.islands) {
    for (const branch of island.branches) {
      const from = network.branchFrom[branch]! + 1
      const to = network.branchTo[branch]! + 1
      start[from] = start[from]! + 1
      start[to] = start[to]! + 1
    }
  }
  for (let bus = 0; bus < busCount; bus += 1) start[bus + 1] = start[bus + 1]! + start[bus]!
  const edges = new Int32Array(start[busCount]!)
  const fill = start.slice(0, busCount)
  for (const island of screeningCase.islands) {
    for (const branch of island.branches) {
      const from = network.branchFrom[branch]!
      const to = network.branchTo[branch]!
      edges[fill[from]!] = branch
      fill[from] = fill[from]! + 1
      edges[fill[to]!] = branch
      fill[to] = fill[to]! + 1
    }
  }
  const childOf = sharedInt32(network.branchCount).fill(-1)
  const entry = sharedInt32(busCount).fill(-1)
  const exit = sharedInt32(busCount)
  const low = new Int32Array(busCount)
  const parentEdge = new Int32Array(busCount).fill(-1)
  const cursor = new Int32Array(busCount)
  const stack = new Int32Array(busCount)
  let timer = 0
  for (const island of screeningCase.islands) {
    if (!island.energised) continue
    const root = island.buses[0]!
    let depth = 0
    stack[0] = root
    entry[root] = timer
    low[root] = timer
    timer += 1
    cursor[root] = start[root]!
    while (depth >= 0) {
      const bus = stack[depth]!
      if (cursor[bus]! < start[bus + 1]!) {
        const branch = edges[cursor[bus]!]!
        cursor[bus] = cursor[bus]! + 1
        if (branch === parentEdge[bus]) continue
        const other = network.branchFrom[branch] === bus ? network.branchTo[branch]! : network.branchFrom[branch]!
        if (entry[other] === -1) {
          parentEdge[other] = branch
          entry[other] = timer
          low[other] = timer
          timer += 1
          cursor[other] = start[other]!
          depth += 1
          stack[depth] = other
        } else if (entry[other]! < low[bus]!) {
          low[bus] = entry[other]!
        }
        continue
      }
      exit[bus] = timer - 1
      depth -= 1
      if (depth < 0) break
      const parent = stack[depth]!
      if (low[bus]! < low[parent]!) low[parent] = low[bus]!
      if (low[bus]! > entry[parent]!) childOf[parentEdge[bus]!] = bus
    }
  }
  return { childOf, entry, exit }
}

/** The outages resolved against the case; one that is not in service fails the capture naming it. */
const contingenciesOf = (screeningCase: ContingencyCase, selected: ReadonlyArray<GridContingency>): SnapshotContingencies => {
  const { network, grid } = screeningCase
  const count = selected.length
  const resolved: SnapshotContingencies = {
    count,
    branch: sharedInt32(count).fill(-1),
    bus: sharedInt32(count).fill(-1),
    unitOutputMw: sharedFloat64(count),
    removedUpMw: sharedFloat64(count),
    removedDownMw: sharedFloat64(count),
    removedKineticEnergyMws: sharedFloat64(count),
    removedForming: sharedInt32(count),
  }
  const energisedBus = (bus: number): boolean => screeningCase.islands[screeningCase.islandOfBus[bus]!]!.energised
  selected.forEach((contingency, position) => {
    if (contingency.kind === 'branch') {
      const index = contingency.branchIndex
      if (screeningCase.closed[index] !== 1 || !energisedBus(network.branchFrom[index]!)) {
        throw new Error(`branch ${network.branchIds[index]!} is not in service (open, tripped or de-energised)`)
      }
      resolved.branch[position] = index
      return
    }
    const entry = grid.definition.index.assetById.get(contingency.generatorId)
    if (entry?.kind !== 'generator') throw new Error(`generator Grid Asset not found: ${contingency.generatorId}`)
    const definition = entry.definition
    const state = grid.generators.get(contingency.generatorId)!
    const bus = network.busIndexById.get(definition.busId)!
    if (!gridGeneratorIsSynchronised(state) || !energisedBus(bus)) {
      throw new Error(`generator ${contingency.generatorId} is ${state.state} and not synchronised to an energised island; it is not in service`)
    }
    resolved.bus[position] = bus
    resolved.unitOutputMw[position] = caseGeneratorOutputMw(screeningCase, contingency.generatorId)
    resolved.removedUpMw[position] = state.reserves.fcrNMw + state.reserves.fcrDUpMw
    resolved.removedDownMw[position] = state.reserves.fcrNMw + state.reserves.fcrDDownMw
    resolved.removedKineticEnergyMws[position] = generatorKineticEnergyMws(definition)
    resolved.removedForming[position] = generatorIsVoltageForming(definition) ? 1 : 0
  })
  return resolved
}

/**
 * Copies a screening case, its outages and the branch capacities of the rating basis into a
 * self-contained snapshot. Reads the case and the Grid's current branch and unit states; writes
 * nothing but the snapshot.
 */
export const captureContingencySnapshot = (
  screeningCase: ContingencyCase,
  contingencies: ReadonlyArray<GridContingency>,
  ratingBasis: ContingencyRatingBasis,
): ContingencySnapshot => {
  const { network, grid } = screeningCase
  const islands = islandsOf(screeningCase)
  const capacityMw = sharedFloat64(network.branchCount)
  grid.definition.model.branches.forEach((branch, index) => {
    capacityMw[index] = (ratingBasis === 'normal' ? branch.ratingMw : branch.emergencyRatingMw) * grid.branches.get(branch.id)!.availability
  })
  const { participation } = screeningCase
  return {
    network: {
      sBaseMva: network.sBaseMva,
      busCount: network.busCount,
      branchCount: network.branchCount,
      branchFrom: sharedCopyInt32(network.branchFrom),
      branchTo: sharedCopyInt32(network.branchTo),
      branchSusceptancePu: sharedCopyFloat64(network.branchSusceptancePu),
      norwegianBus: sharedCopyUint8(gridTablesFor(grid.definition).norwegianBus),
    },
    islands,
    factors: factorsOf(screeningCase, islands),
    bridges: bridgesOf(screeningCase),
    participation: {
      upMw: sharedCopyFloat64(participation.upMw),
      downMw: sharedCopyFloat64(participation.downMw),
      kineticEnergyMws: sharedCopyFloat64(participation.kineticEnergyMws),
      formingCount: sharedCopyInt32(participation.formingCount),
      servedLoadMw: sharedCopyFloat64(participation.servedLoadMw),
    },
    injectionsMw: sharedCopyFloat64(screeningCase.injectionsMw),
    flowsMw: sharedCopyFloat64(screeningCase.flowsMw),
    capacityMw,
    loading: {
      mva: sharedCopyUint8(screeningCase.loadingBase.mva),
      toActiveMw: sharedCopyFloat64(screeningCase.loadingBase.toActiveMw),
      fromReactiveMvar: sharedCopyFloat64(screeningCase.loadingBase.fromReactiveMvar),
      toReactiveMvar: sharedCopyFloat64(screeningCase.loadingBase.toReactiveMvar),
    },
    contingencies: contingenciesOf(screeningCase, contingencies),
  }
}
