import { rebalancePart, type PartBalance, type RemovedParticipant } from './contingency-balance.ts'
import {
  balancingByCode,
  maximumListedOverloads,
  maximumRecordParts,
  recordInteger,
  recordIntegerWidth,
  recordValue,
  recordValueWidth,
  type ContingencySnapshot,
  type ScreeningRecords,
} from './contingency-snapshot.ts'
import { solveSparseCholesky, type SparseCholeskyFactor } from './network/sparse-cholesky.ts'

// N-1 screening kernel on a contingency snapshot. A branch outage that keeps its island connected
// moves its flow by line outage distribution factors, LODF(l,k) = PTDF(l,k) / (1 − PTDF(k,k)), from
// one solve with the island's factor. An outage that splits an island (a bridge), and a generator
// outage, change injections: each resulting part rebalances by its reserve participation and the
// flow change is one compensating solve on the intact factor. Both equal a re-solve of the changed
// network. The kernel reads only the snapshot and writes only its own vectors and the records, so
// it runs the same on the main thread and in a worker thread.

export interface ContingencyPart extends PartBalance {
  readonly busCount: number
}

export interface ContingencyOutcome {
  /** The outage split its island. */
  readonly islanding: boolean
  /** The parts that had to rebalance or lost supply. */
  readonly parts: ReadonlyArray<ContingencyPart>
  /** Pre-contingency flow of the branch or output of the unit (MW). */
  readonly lostMw: number
}

export interface ContingencyEngine {
  /** Writes the post-contingency flow of every branch for the snapshot's contingency at `position` into `flowsMw` (MW). */
  readonly evaluate: (position: number, flowsMw: Float64Array) => ContingencyOutcome
}

interface KernelIsland {
  readonly buses: Int32Array
  readonly branches: Int32Array
  readonly factor: SparseCholeskyFactor
  readonly rhs: Float64Array
  readonly solution: Float64Array
}

const kernelIslands = (snapshot: ContingencySnapshot): ReadonlyArray<KernelIsland> => {
  const { islands, factors } = snapshot
  return Array.from({ length: islands.count }, (_, index): KernelIsland => {
    const busStart = islands.busStart[index]!
    const size = islands.busStart[index + 1]! - busStart - 1
    const reducedStart = busStart - index
    return {
      buses: islands.buses.subarray(busStart, islands.busStart[index + 1]!),
      branches: islands.branches.subarray(islands.branchStart[index]!, islands.branchStart[index + 1]!),
      factor: {
        structure: {
          size,
          perm: factors.perm.subarray(reducedStart, reducedStart + size),
          iperm: factors.iperm.subarray(reducedStart, reducedStart + size),
          columnStart: factors.columnStart.subarray(busStart, busStart + size + 1),
          rowIndex: factors.rowIndex.subarray(factors.entryStart[index]!, factors.entryStart[index + 1]!),
          rowStart: factors.rowStart.subarray(busStart, busStart + size + 1),
          rowColumns: factors.rowColumns.subarray(factors.linkStart[index]!, factors.linkStart[index + 1]!),
        },
        values: factors.values.subarray(factors.entryStart[index]!, factors.entryStart[index + 1]!),
        work: new Float64Array(size),
      },
      rhs: new Float64Array(size),
      solution: new Float64Array(size),
    }
  })
}

/** Solves B·x = values over one island's reduced buses; x is 0 at the reference. */
const solveIsland = (island: KernelIsland, values: Float64Array, into: Float64Array): void => {
  const { buses, rhs, solution } = island
  for (let reduced = 0; reduced < rhs.length; reduced += 1) rhs[reduced] = values[buses[reduced + 1]!]!
  solveSparseCholesky(island.factor, rhs, solution)
  into[buses[0]!] = 0
  for (let reduced = 0; reduced < solution.length; reduced += 1) into[buses[reduced + 1]!] = solution[reduced]!
}

export const createContingencyEngine = (snapshot: ContingencySnapshot): ContingencyEngine => {
  const { network, participation, bridges, contingencies } = snapshot
  const { branchFrom, branchTo, branchSusceptancePu, sBaseMva } = network
  const islands = kernelIslands(snapshot)
  const values = new Float64Array(network.busCount)
  const delta = new Float64Array(network.busCount)
  const angles = new Float64Array(network.busCount)

  /** Adds the flows of the injection change `delta` over the island's buses, solved on the intact factor. */
  const addCompensation = (island: KernelIsland, flowsMw: Float64Array): void => {
    for (const bus of island.buses) values[bus] = delta[bus]! / sBaseMva
    solveIsland(island, values, angles)
    for (const branch of island.branches) {
      flowsMw[branch] = flowsMw[branch]! + (angles[branchFrom[branch]!]! - angles[branchTo[branch]!]!) * sBaseMva * branchSusceptancePu[branch]!
    }
  }

  const zeroFlowsOfBuses = (island: KernelIsland, inPart: (bus: number) => boolean, flowsMw: Float64Array): void => {
    for (const branch of island.branches) if (inPart(branchFrom[branch]!)) flowsMw[branch] = 0
  }

  const branchOutage = (branchIndex: number, flowsMw: Float64Array): ContingencyOutcome => {
    const from = branchFrom[branchIndex]!
    const to = branchTo[branchIndex]!
    const island = islands[snapshot.islands.islandOfBus[from]!]!
    const lostMw = snapshot.flowsMw[branchIndex]!
    flowsMw.set(snapshot.flowsMw)
    const child = bridges.childOf[branchIndex]!
    if (child < 0) {
      // PTDF column of the outaged branch: B·x = e_from − e_to (unit transfer).
      for (const bus of island.buses) values[bus] = 0
      values[from] = 1
      values[to] = -1
      solveIsland(island, values, angles)
      const selfPtdf = (angles[from]! - angles[to]!) * branchSusceptancePu[branchIndex]!
      const scale = lostMw / (1 - selfPtdf)
      for (const branch of island.branches) {
        if (branch === branchIndex) continue
        const ptdf = (angles[branchFrom[branch]!]! - angles[branchTo[branch]!]!) * branchSusceptancePu[branch]!
        flowsMw[branch] = flowsMw[branch]! + ptdf * scale
      }
      flowsMw[branchIndex] = 0
      return { islanding: false, parts: [], lostMw }
    }
    const inChild = (bus: number): boolean => bridges.entry[bus]! >= bridges.entry[child]! && bridges.entry[bus]! <= bridges.exit[child]!
    const childBuses: number[] = []
    const otherBuses: number[] = []
    for (const bus of island.buses) {
      delta[bus] = snapshot.injectionsMw[bus]!
      if (inChild(bus)) childBuses.push(bus)
      else otherBuses.push(bus)
    }
    const parts = [childBuses, otherBuses].map(members => ({ ...rebalancePart({ participation, members, injections: delta, removed: null }), busCount: members.length }))
    for (const bus of island.buses) delta[bus] = delta[bus]! - snapshot.injectionsMw[bus]!
    addCompensation(island, flowsMw)
    flowsMw[branchIndex] = 0
    if (parts[0]!.balancing === 'de-energised') zeroFlowsOfBuses(island, inChild, flowsMw)
    if (parts[1]!.balancing === 'de-energised') zeroFlowsOfBuses(island, bus => !inChild(bus), flowsMw)
    return { islanding: true, parts, lostMw }
  }

  const generatorOutage = (position: number, flowsMw: Float64Array): ContingencyOutcome => {
    const bus = contingencies.bus[position]!
    const island = islands[snapshot.islands.islandOfBus[bus]!]!
    const lostMw = contingencies.unitOutputMw[position]!
    const removed: RemovedParticipant = {
      bus,
      upMw: contingencies.removedUpMw[position]!,
      downMw: contingencies.removedDownMw[position]!,
      kineticEnergyMws: contingencies.removedKineticEnergyMws[position]!,
      forming: contingencies.removedForming[position]!,
    }
    flowsMw.set(snapshot.flowsMw)
    for (const member of island.buses) delta[member] = snapshot.injectionsMw[member]!
    delta[bus] = delta[bus]! - lostMw
    const part = { ...rebalancePart({ participation, members: island.buses, injections: delta, removed }), busCount: island.buses.length }
    if (part.balancing === 'de-energised') {
      for (const branch of island.branches) flowsMw[branch] = 0
      return { islanding: false, parts: [part], lostMw }
    }
    for (const member of island.buses) delta[member] = delta[member]! - snapshot.injectionsMw[member]!
    addCompensation(island, flowsMw)
    return { islanding: false, parts: [part], lostMw }
  }

  return {
    evaluate: (position, flowsMw) => {
      if (!Number.isInteger(position) || position < 0 || position >= contingencies.count) throw new Error(`contingency position ${position} is outside 0..${contingencies.count - 1}`)
      const branch = contingencies.branch[position]!
      return branch >= 0 ? branchOutage(branch, flowsMw) : generatorOutage(position, flowsMw)
    },
  }
}

/** |flow| over capacity in percent. */
export const loadingPercent = (flowMw: number, capacityMw: number): number => Math.abs(flowMw) / capacityMw * 100

export interface BranchLoadingScan {
  /** Most loaded branch (the first of equals), or -1 without branches. */
  readonly worst: number
  /** Branches above 100 %. */
  readonly overloadedCount: number
  /** How many of the most-loaded overloaded branches `listed` holds, most loaded first and equals in index order. */
  readonly listedCount: number
}

/**
 * Loading of every branch in one pass: the most loaded branch, the overloaded count, and the
 * `listed.length` most-loaded overloaded branches written to `listed` — the head of a stable sort of
 * the overloaded branches by loading, kept by insertion instead of sorting them all.
 */
export const scanBranchLoading = (capacityMw: Float64Array, flowsMw: Float64Array, listed: Int32Array): BranchLoadingScan => {
  const capacity = listed.length
  const listedLoading = new Float64Array(capacity)
  let worst = -1
  let worstLoading = -1
  let overloadedCount = 0
  let listedCount = 0
  for (let branch = 0; branch < flowsMw.length; branch += 1) {
    const value = loadingPercent(flowsMw[branch]!, capacityMw[branch]!)
    if (value > worstLoading) {
      worstLoading = value
      worst = branch
    }
    if (!(value > 100)) continue
    overloadedCount += 1
    // Equal loadings keep index order, so a later branch enters only above the last listed one.
    if (listedCount === capacity && !(value > listedLoading[capacity - 1]!)) continue
    let slot = listedCount < capacity ? listedCount : capacity - 1
    if (listedCount < capacity) listedCount += 1
    while (slot > 0 && listedLoading[slot - 1]! < value) {
      listed[slot] = listed[slot - 1]!
      listedLoading[slot] = listedLoading[slot - 1]!
      slot -= 1
    }
    listed[slot] = branch
    listedLoading[slot] = value
  }
  return { worst, overloadedCount, listedCount }
}

/**
 * Screens the snapshot's contingencies at positions [start, end) and writes their records.
 * Each record depends only on the snapshot and its position, so any split into ranges, on any
 * thread, writes the same records.
 */
export const screenContingencyRange = (snapshot: ContingencySnapshot, records: ScreeningRecords, start: number, end: number): void => {
  if (records.count !== snapshot.contingencies.count) throw new Error(`screening records hold ${records.count} contingencies for a snapshot of ${snapshot.contingencies.count}`)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > records.count || start > end) throw new Error(`screening range ${start}..${end} is outside 0..${records.count}`)
  const engine = createContingencyEngine(snapshot)
  const flows = new Float64Array(snapshot.network.branchCount)
  for (let position = start; position < end; position += 1) {
    const outcome = engine.evaluate(position, flows)
    if (outcome.parts.length > maximumRecordParts) throw new Error(`contingency ${position} has ${outcome.parts.length} parts; records hold ${maximumRecordParts}`)
    const slots = position * maximumListedOverloads
    const listed = records.listedBranches.subarray(slots, slots + maximumListedOverloads)
    const { worst, overloadedCount, listedCount } = scanBranchLoading(snapshot.capacityMw, flows, listed)
    const integers = position * recordIntegerWidth
    const values = position * recordValueWidth
    records.integers[integers + recordInteger.islanding] = outcome.islanding ? 1 : 0
    records.integers[integers + recordInteger.partCount] = outcome.parts.length
    records.integers[integers + recordInteger.worstBranch] = worst
    records.integers[integers + recordInteger.violationCount] = overloadedCount
    records.integers[integers + recordInteger.listedCount] = listedCount
    records.values[values + recordValue.lostMw] = outcome.lostMw
    records.values[values + recordValue.worstFlowMw] = worst < 0 ? 0 : flows[worst]!
    outcome.parts.forEach((part, index) => {
      records.integers[integers + recordInteger.firstPart + 2 * index] = part.busCount
      records.integers[integers + recordInteger.firstPart + 2 * index + 1] = balancingByCode.indexOf(part.balancing)
      records.values[values + recordValue.firstPart + 3 * index] = part.imbalanceMw
      records.values[values + recordValue.firstPart + 3 * index + 1] = part.reserveShortfallMw
      records.values[values + recordValue.firstPart + 3 * index + 2] = part.unservedLoadMw
    })
    for (let index = 0; index < listedCount; index += 1) records.listedFlowsMw[slots + index] = flows[listed[index]!]!
  }
}
