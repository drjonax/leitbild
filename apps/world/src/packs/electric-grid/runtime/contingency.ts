import { generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import { gridGeneratorIsSynchronised } from './island-input.ts'
import { caseGeneratorOutputMw, rebalancePart, solveIsland, type CaseIsland, type ContingencyCase, type PartBalance, type RemovedParticipant } from './contingency-case.ts'

// N-1 screening on a screening case. A branch outage that keeps its island connected moves its flow
// by line outage distribution factors, LODF(l,k) = PTDF(l,k) / (1 − PTDF(k,k)), from one solve with
// the island's cached factor. An outage that splits an island (a bridge), and a generator outage,
// change injections: each resulting part rebalances by its reserve participation and the flow change
// is one compensating solve on the intact factor. Both equal a re-solve of the changed network.

export type GridContingency =
  | { readonly kind: 'branch'; readonly branchIndex: number }
  | { readonly kind: 'generator'; readonly generatorId: string }

export interface ContingencyPart extends PartBalance {
  readonly busCount: number
}

export interface ContingencyOutcome {
  /** The island the outage acts on, as an index into the case's islands. */
  readonly islandIndex: number
  /** The outage split its island. */
  readonly islanding: boolean
  /** The parts that had to rebalance or lost supply. */
  readonly parts: ReadonlyArray<ContingencyPart>
  /** Pre-contingency flow of the branch or output of the unit (MW). */
  readonly lostMw: number
}

interface Bridges {
  /** Per branch: the bus whose DFS subtree separates when the branch opens, or -1 when it is no bridge. */
  readonly childOf: Int32Array
  /** DFS entry time per bus and the last entry time in its subtree. */
  readonly entry: Int32Array
  readonly exit: Int32Array
}

/** Bridges of every energised island by an iterative Tarjan search over closed branches (parallel circuits are not bridges). */
const findBridges = (screeningCase: ContingencyCase): Bridges => {
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
  const childOf = new Int32Array(network.branchCount).fill(-1)
  const entry = new Int32Array(busCount).fill(-1)
  const exit = new Int32Array(busCount)
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

export interface ContingencyEngine {
  readonly screeningCase: ContingencyCase
  /** Writes the post-contingency flow of every branch into `flowsMw` (MW, positive from-bus to to-bus). */
  readonly evaluate: (contingency: GridContingency, flowsMw: Float64Array) => ContingencyOutcome
}

export const createContingencyEngine = (screeningCase: ContingencyCase): ContingencyEngine => {
  const { network, participation, grid } = screeningCase
  const bridges = findBridges(screeningCase)
  const values = new Float64Array(network.busCount)
  const delta = new Float64Array(network.busCount)
  const angles = new Float64Array(network.busCount)
  const islandOf = (bus: number): CaseIsland => screeningCase.islands[screeningCase.islandOfBus[bus]!]!

  const baseFlowsInto = (flowsMw: Float64Array): void => { flowsMw.set(screeningCase.flowsMw) }

  /** Adds the flows of the injection change `delta` over the island's buses, solved on the intact factor. */
  const addCompensation = (island: CaseIsland, flowsMw: Float64Array): void => {
    for (const bus of island.buses) values[bus] = delta[bus]! / network.sBaseMva
    solveIsland(island, values, angles)
    for (const branch of island.branches) {
      flowsMw[branch] = flowsMw[branch]! + (angles[network.branchFrom[branch]!]! - angles[network.branchTo[branch]!]!) * network.sBaseMva * network.branchSusceptancePu[branch]!
    }
  }

  const zeroFlowsOfBuses = (island: CaseIsland, inPart: (bus: number) => boolean, flowsMw: Float64Array): void => {
    for (const branch of island.branches) if (inPart(network.branchFrom[branch]!)) flowsMw[branch] = 0
  }

  const branchOutage = (branchIndex: number, flowsMw: Float64Array): ContingencyOutcome => {
    const from = network.branchFrom[branchIndex]!
    const to = network.branchTo[branchIndex]!
    const islandIndex = screeningCase.islandOfBus[from]!
    const island = screeningCase.islands[islandIndex]!
    const lostMw = screeningCase.flowsMw[branchIndex]!
    baseFlowsInto(flowsMw)
    const child = bridges.childOf[branchIndex]!
    if (child < 0) {
      // PTDF column of the outaged branch: B·x = e_from − e_to (unit transfer).
      for (const bus of island.buses) values[bus] = 0
      values[from] = 1
      values[to] = -1
      solveIsland(island, values, angles)
      const susceptance = network.branchSusceptancePu
      const selfPtdf = (angles[from]! - angles[to]!) * susceptance[branchIndex]!
      const scale = lostMw / (1 - selfPtdf)
      for (const branch of island.branches) {
        if (branch === branchIndex) continue
        const ptdf = (angles[network.branchFrom[branch]!]! - angles[network.branchTo[branch]!]!) * susceptance[branch]!
        flowsMw[branch] = flowsMw[branch]! + ptdf * scale
      }
      flowsMw[branchIndex] = 0
      return { islandIndex, islanding: false, parts: [], lostMw }
    }
    const inChild = (bus: number): boolean => bridges.entry[bus]! >= bridges.entry[child]! && bridges.entry[bus]! <= bridges.exit[child]!
    const childBuses: number[] = []
    const otherBuses: number[] = []
    for (const bus of island.buses) {
      delta[bus] = screeningCase.injectionsMw[bus]!
      if (inChild(bus)) childBuses.push(bus)
      else otherBuses.push(bus)
    }
    const parts = [childBuses, otherBuses].map(members => ({ ...rebalancePart({ participation, members, injections: delta, removed: null }), busCount: members.length }))
    for (const bus of island.buses) delta[bus] = delta[bus]! - screeningCase.injectionsMw[bus]!
    addCompensation(island, flowsMw)
    flowsMw[branchIndex] = 0
    if (parts[0]!.balancing === 'de-energised') zeroFlowsOfBuses(island, inChild, flowsMw)
    if (parts[1]!.balancing === 'de-energised') zeroFlowsOfBuses(island, bus => !inChild(bus), flowsMw)
    return { islandIndex, islanding: true, parts, lostMw }
  }

  const generatorOutage = (generatorId: string, flowsMw: Float64Array): ContingencyOutcome => {
    const entry = grid.definition.index.assetById.get(generatorId)
    if (entry?.kind !== 'generator') throw new Error(`generator Grid Asset not found: ${generatorId}`)
    const definition = entry.definition
    const state = grid.generators.get(generatorId)!
    const bus = network.busIndexById.get(definition.busId)!
    const islandIndex = screeningCase.islandOfBus[bus]!
    const island = screeningCase.islands[islandIndex]!
    if (!gridGeneratorIsSynchronised(state) || !island.energised) throw new Error(`generator ${generatorId} is ${state.state} and not synchronised to an energised island; it is not in service`)
    const lostMw = caseGeneratorOutputMw(screeningCase, generatorId)
    const removed: RemovedParticipant = {
      bus,
      upMw: state.reserves.fcrNMw + state.reserves.fcrDUpMw,
      downMw: state.reserves.fcrNMw + state.reserves.fcrDDownMw,
      kineticEnergyMws: generatorKineticEnergyMws(definition),
      forming: generatorIsVoltageForming(definition) ? 1 : 0,
    }
    baseFlowsInto(flowsMw)
    for (const member of island.buses) delta[member] = screeningCase.injectionsMw[member]!
    delta[bus] = delta[bus]! - lostMw
    const part = { ...rebalancePart({ participation, members: island.buses, injections: delta, removed }), busCount: island.buses.length }
    if (part.balancing === 'de-energised') {
      for (const branch of island.branches) flowsMw[branch] = 0
      return { islandIndex, islanding: false, parts: [part], lostMw }
    }
    for (const member of island.buses) delta[member] = delta[member]! - screeningCase.injectionsMw[member]!
    addCompensation(island, flowsMw)
    return { islandIndex, islanding: false, parts: [part], lostMw }
  }

  return {
    screeningCase,
    evaluate: (contingency, flowsMw) => {
      if (contingency.kind === 'generator') return generatorOutage(contingency.generatorId, flowsMw)
      const index = contingency.branchIndex
      if (screeningCase.closed[index] !== 1 || !islandOf(network.branchFrom[index]!).energised) {
        throw new Error(`branch ${network.branchIds[index]!} is not in service (open, tripped or de-energised)`)
      }
      return branchOutage(index, flowsMw)
    },
  }
}
