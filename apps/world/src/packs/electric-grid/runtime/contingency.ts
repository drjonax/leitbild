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
// one solve with the island's factor. Losing some of a multi-circuit branch's circuits is the same
// rank-one change scaled to the share lost, and the branch stays in service on the rest. An outage
// that splits an island (a bridge), one that separates a boundary bus (a bridge cutting off only
// boundary buses, which is no split), and a generator outage, change injections: each resulting
// part rebalances by its reserve participation and the flow change is one compensating solve on the
// intact factor. All equal a re-solve of the changed network. The kernel reads only the snapshot
// and writes only its own vectors and the records, so it runs the same on the main thread and in a
// worker thread.

export interface ContingencyPart extends PartBalance {
  readonly busCount: number
}

export interface ContingencyOutcome {
  /** The outage split its island; separating only boundary buses, which their external system holds in no island, is no split. */
  readonly islanding: boolean
  /** The parts that had to rebalance or lost supply. */
  readonly parts: ReadonlyArray<ContingencyPart>
  /** Pre-contingency flow of the circuits lost (all of the branch's, or their share of it) or output of the unit (MW). */
  readonly lostMw: number
  /** The branch a partial outage leaves in service on its remaining circuits, or -1. */
  readonly deratedBranch: number
  /** The share of that branch's circuits that remain in service, (n − m)/n; 1 without one. */
  readonly remainingShare: number
}

export interface ContingencyEngine {
  /**
   * Writes the post-contingency active flow of every branch for the snapshot's contingency at
   * `position` into `flowsMw` (MW), and marks with 1 in `outOfService` the branches the outage
   * takes out: the outaged branch and every branch of a part that loses supply. A partial outage
   * (some of a branch's circuits) takes out no branch: it names the branch in `deratedBranch`.
   */
  readonly evaluate: (position: number, flowsMw: Float64Array, outOfService: Uint8Array) => ContingencyOutcome
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

  const takeOut = (branch: number, flowsMw: Float64Array, outOfService: Uint8Array): void => {
    flowsMw[branch] = 0
    outOfService[branch] = 1
  }

  const zeroFlowsOfBuses = (island: KernelIsland, inPart: (bus: number) => boolean, flowsMw: Float64Array, outOfService: Uint8Array): void => {
    for (const branch of island.branches) if (inPart(branchFrom[branch]!)) takeOut(branch, flowsMw, outOfService)
  }

  /** The PTDF column of a branch into `angles`: B·x = e_from − e_to (unit transfer), solved on its island's factor. */
  const solveTransfer = (island: KernelIsland, from: number, to: number): void => {
    for (const bus of island.buses) values[bus] = 0
    values[from] = 1
    values[to] = -1
    solveIsland(island, values, angles)
  }

  /** PTDF of a branch for the transfer `angles` holds. */
  const ptdfOf = (branch: number): number => (angles[branchFrom[branch]!]! - angles[branchTo[branch]!]!) * branchSusceptancePu[branch]!

  /**
   * Losing m of a branch's n identical circuits removes the share α = m/n of its susceptance b, the
   * rank-one change ΔB = −α·b·a·aᵀ (a = e_from − e_to). By Sherman–Morrison the base flow of the
   * lost circuits, α·f, moves onto every other branch l by the fractional outage distribution factor
   * PTDF(l,k) / (1 − α·PTDF(k,k)), and the remaining circuits carry (1 − α)·f / (1 − α·PTDF(k,k));
   * at α = 1 this is the LODF of a full outage. The branch stays closed, so nothing splits or
   * rebalances: across a bridge (PTDF(k,k) = 1) the remaining circuits carry the whole flow.
   */
  const circuitOutage = (branchIndex: number, circuitsLost: number, circuits: number, flowsMw: Float64Array): ContingencyOutcome => {
    const flowMw = snapshot.flowsMw[branchIndex]!
    const lostShare = circuitsLost / circuits
    const remainingShare = (circuits - circuitsLost) / circuits
    const lostMw = flowMw * lostShare
    flowsMw.set(snapshot.flowsMw)
    if (bridges.childOf[branchIndex]! >= 0) return { islanding: false, parts: [], lostMw, deratedBranch: branchIndex, remainingShare }
    const from = branchFrom[branchIndex]!
    const to = branchTo[branchIndex]!
    const island = islands[snapshot.islands.islandOfBus[from]!]!
    solveTransfer(island, from, to)
    const denominator = 1 - lostShare * ptdfOf(branchIndex)
    const scale = lostMw / denominator
    for (const branch of island.branches) {
      if (branch === branchIndex) continue
      flowsMw[branch] = flowsMw[branch]! + ptdfOf(branch) * scale
    }
    flowsMw[branchIndex] = remainingShare * flowMw / denominator
    return { islanding: false, parts: [], lostMw, deratedBranch: branchIndex, remainingShare }
  }

  const branchOutage = (branchIndex: number, flowsMw: Float64Array, outOfService: Uint8Array): ContingencyOutcome => {
    const from = branchFrom[branchIndex]!
    const to = branchTo[branchIndex]!
    const island = islands[snapshot.islands.islandOfBus[from]!]!
    const lostMw = snapshot.flowsMw[branchIndex]!
    flowsMw.set(snapshot.flowsMw)
    const child = bridges.childOf[branchIndex]!
    if (child < 0) {
      solveTransfer(island, from, to)
      const selfPtdf = ptdfOf(branchIndex)
      const scale = lostMw / (1 - selfPtdf)
      for (const branch of island.branches) {
        if (branch === branchIndex) continue
        flowsMw[branch] = flowsMw[branch]! + ptdfOf(branch) * scale
      }
      takeOut(branchIndex, flowsMw, outOfService)
      return { islanding: false, parts: [], lostMw, deratedBranch: -1, remainingShare: 1 }
    }
    const inChild = (bus: number): boolean => bridges.entry[bus]! >= bridges.entry[child]! && bridges.entry[bus]! <= bridges.exit[child]!
    const childBuses: number[] = []
    const otherBuses: number[] = []
    for (const bus of island.buses) {
      delta[bus] = snapshot.injectionsMw[bus]!
      if (inChild(bus)) childBuses.push(bus)
      else otherBuses.push(bus)
    }
    const norwegian = (members: ReadonlyArray<number>): boolean => members.some(bus => network.norwegianBus[bus] === 1)
    if (!norwegian(childBuses) || !norwegian(otherBuses)) {
      // A part without a Norwegian bus is a separated boundary bus, which its external system holds
      // in no island (boundary-separation.ts): no split. It carries nothing; the rest rebalances.
      const [separated, rest] = norwegian(childBuses) ? [otherBuses, childBuses] : [childBuses, otherBuses]
      for (const bus of separated) delta[bus] = 0
      const part = { ...rebalancePart({ participation, members: rest, injections: delta, removed: null }), busCount: rest.length }
      for (const bus of island.buses) delta[bus] = delta[bus]! - snapshot.injectionsMw[bus]!
      addCompensation(island, flowsMw)
      takeOut(branchIndex, flowsMw, outOfService)
      const separatedBus = (bus: number): boolean => separated.includes(bus)
      zeroFlowsOfBuses(island, separatedBus, flowsMw, outOfService)
      if (part.balancing === 'de-energised') zeroFlowsOfBuses(island, bus => !separatedBus(bus), flowsMw, outOfService)
      return { islanding: false, parts: [part], lostMw, deratedBranch: -1, remainingShare: 1 }
    }
    const parts = [childBuses, otherBuses].map(members => ({ ...rebalancePart({ participation, members, injections: delta, removed: null }), busCount: members.length }))
    for (const bus of island.buses) delta[bus] = delta[bus]! - snapshot.injectionsMw[bus]!
    addCompensation(island, flowsMw)
    takeOut(branchIndex, flowsMw, outOfService)
    if (parts[0]!.balancing === 'de-energised') zeroFlowsOfBuses(island, inChild, flowsMw, outOfService)
    if (parts[1]!.balancing === 'de-energised') zeroFlowsOfBuses(island, bus => !inChild(bus), flowsMw, outOfService)
    return { islanding: true, parts, lostMw, deratedBranch: -1, remainingShare: 1 }
  }

  const generatorOutage = (position: number, flowsMw: Float64Array, outOfService: Uint8Array): ContingencyOutcome => {
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
      for (const branch of island.branches) takeOut(branch, flowsMw, outOfService)
      return { islanding: false, parts: [part], lostMw, deratedBranch: -1, remainingShare: 1 }
    }
    for (const member of island.buses) delta[member] = delta[member]! - snapshot.injectionsMw[member]!
    addCompensation(island, flowsMw)
    return { islanding: false, parts: [part], lostMw, deratedBranch: -1, remainingShare: 1 }
  }

  return {
    evaluate: (position, flowsMw, outOfService) => {
      if (!Number.isInteger(position) || position < 0 || position >= contingencies.count) throw new Error(`contingency position ${position} is outside 0..${contingencies.count - 1}`)
      outOfService.fill(0)
      const branch = contingencies.branch[position]!
      if (branch < 0) return generatorOutage(position, flowsMw, outOfService)
      const circuitsLost = contingencies.circuitsLost[position]!
      const circuits = network.branchCircuits[branch]!
      return circuitsLost < circuits ? circuitOutage(branch, circuitsLost, circuits, flowsMw) : branchOutage(branch, flowsMw, outOfService)
    },
  }
}

export type LoadingBasis = 'mva' | 'mw'

/** The basis a branch's loading is judged on. */
export const branchLoadingBasis = (snapshot: ContingencySnapshot, branch: number): LoadingBasis => snapshot.loading.mva[branch] === 1 ? 'mva' : 'mw'

/**
 * Loading (%) of a branch in service carrying `flowMw` at its from end, against its capacity. On
 * the apparent-power basis, as the runtime judges a converged AC island: the active-power change
 * from the base moves both ends' active power, each end keeps its base reactive power, and the
 * larger end apparent power counts. Otherwise |flowMw|.
 */
export const branchLoadingPercent = (snapshot: ContingencySnapshot, branch: number, flowMw: number): number => {
  const capacityMw = snapshot.capacityMw[branch]!
  const { loading } = snapshot
  if (loading.mva[branch] !== 1) return Math.abs(flowMw) / capacityMw * 100
  const toMw = loading.toActiveMw[branch]! - (flowMw - snapshot.flowsMw[branch]!)
  const fromMvar = loading.fromReactiveMvar[branch]!
  const toMvar = loading.toReactiveMvar[branch]!
  return Math.sqrt(Math.max(flowMw * flowMw + fromMvar * fromMvar, toMw * toMw + toMvar * toMvar)) / capacityMw * 100
}

/**
 * Loading (%) of the circuits of a branch that stay in service after a partial outage, carrying
 * `flowMw` together, against `remainingShare` of the branch's capacity. Identical parallel circuits
 * share active and reactive power equally and each remaining circuit keeps its base reactive power,
 * so they are loaded as the whole branch would be at flowMw / remainingShare.
 */
export const remainingCircuitsLoadingPercent = (snapshot: ContingencySnapshot, branch: number, flowMw: number, remainingShare: number): number =>
  branchLoadingPercent(snapshot, branch, flowMw / remainingShare)

export interface BranchLoadingScan {
  /** Most loaded branch (the first of equals), or -1 without branches. */
  readonly worst: number
  readonly worstLoadingPercent: number
  /** Branches above 100 %. */
  readonly overloadedCount: number
  /** How many of the most-loaded overloaded branches `listed` holds, most loaded first and equals in index order. */
  readonly listedCount: number
}

/**
 * Loading of every branch in one pass (0 on a branch out of service; on `deratedBranch`, of its
 * remaining circuits, `remainingShare` of them): the most loaded branch, the
 * overloaded count, and the `listed.length` most-loaded overloaded branches written to `listed`
 * with their loading in `listedLoadingPercent` — the head of a stable sort of the overloaded
 * branches by loading, kept by insertion instead of sorting them all.
 */
export const scanBranchLoading = (config: {
  readonly snapshot: ContingencySnapshot
  readonly flowsMw: Float64Array
  readonly outOfService: Uint8Array | null
  /** A branch left in service on part of its circuits (-1: none), and the share that remains. */
  readonly deratedBranch: number
  readonly remainingShare: number
  readonly listed: Int32Array
  readonly listedLoadingPercent: Float64Array
}): BranchLoadingScan => {
  const { snapshot, flowsMw, outOfService, deratedBranch, remainingShare, listed, listedLoadingPercent } = config
  const capacity = listed.length
  let worst = -1
  let worstLoadingPercent = -1
  let overloadedCount = 0
  let listedCount = 0
  for (let branch = 0; branch < flowsMw.length; branch += 1) {
    const value = outOfService !== null && outOfService[branch] === 1
      ? 0
      : branch === deratedBranch ? remainingCircuitsLoadingPercent(snapshot, branch, flowsMw[branch]!, remainingShare) : branchLoadingPercent(snapshot, branch, flowsMw[branch]!)
    if (value > worstLoadingPercent) {
      worstLoadingPercent = value
      worst = branch
    }
    if (!(value > 100)) continue
    overloadedCount += 1
    // Equal loadings keep index order, so a later branch enters only above the last listed one.
    if (listedCount === capacity && !(value > listedLoadingPercent[capacity - 1]!)) continue
    let slot = listedCount < capacity ? listedCount : capacity - 1
    if (listedCount < capacity) listedCount += 1
    while (slot > 0 && listedLoadingPercent[slot - 1]! < value) {
      listed[slot] = listed[slot - 1]!
      listedLoadingPercent[slot] = listedLoadingPercent[slot - 1]!
      slot -= 1
    }
    listed[slot] = branch
    listedLoadingPercent[slot] = value
  }
  return { worst, worstLoadingPercent, overloadedCount, listedCount }
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
  const outOfService = new Uint8Array(snapshot.network.branchCount)
  for (let position = start; position < end; position += 1) {
    const outcome = engine.evaluate(position, flows, outOfService)
    if (outcome.parts.length > maximumRecordParts) throw new Error(`contingency ${position} has ${outcome.parts.length} parts; records hold ${maximumRecordParts}`)
    const slots = position * maximumListedOverloads
    const listed = records.listedBranches.subarray(slots, slots + maximumListedOverloads)
    const { worst, worstLoadingPercent, overloadedCount, listedCount } = scanBranchLoading({
      snapshot,
      flowsMw: flows,
      outOfService,
      deratedBranch: outcome.deratedBranch,
      remainingShare: outcome.remainingShare,
      listed,
      listedLoadingPercent: records.listedLoadingPercent.subarray(slots, slots + maximumListedOverloads),
    })
    const integers = position * recordIntegerWidth
    const values = position * recordValueWidth
    records.integers[integers + recordInteger.islanding] = outcome.islanding ? 1 : 0
    records.integers[integers + recordInteger.partCount] = outcome.parts.length
    records.integers[integers + recordInteger.worstBranch] = worst
    records.integers[integers + recordInteger.violationCount] = overloadedCount
    records.integers[integers + recordInteger.listedCount] = listedCount
    records.values[values + recordValue.lostMw] = outcome.lostMw
    records.values[values + recordValue.worstFlowMw] = worst < 0 ? 0 : flows[worst]!
    records.values[values + recordValue.worstLoadingPercent] = worstLoadingPercent
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
