import { generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import type { GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import { externalFrequencyEquivalent, externalKineticEnergyMws, gridGeneratorIsSynchronised } from './island-input.ts'
import { solvedGridIslands } from './island-lifecycle.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'
import { solveSparseCholesky } from './network/sparse-cholesky.ts'

// A screening case: a private copy of the solved network state (switching, injections, flows) on
// which contingencies and remedial actions are evaluated. Building one never writes to the Grid:
// it reads the live plan's factors and copies everything it changes.

/** Below this an island's injection sum counts as balanced (MW); the runtime closes balances to 1e-6 MW. */
const balanceToleranceMw = 1e-6

export interface CaseIsland {
  /** Buses ascending; buses[0] is the angle reference. */
  readonly buses: Int32Array
  /** Closed branches inside the island. */
  readonly branches: Int32Array
  readonly system: GridIslandSystem
  readonly energised: boolean
  /** Private solve vectors over the reduced buses. */
  readonly rhs: Float64Array
  readonly solution: Float64Array
  readonly work: Float64Array
}

/** Reserve participation at each bus: what picks up an imbalance after a contingency. */
export interface CaseParticipation {
  /** FCR-N + FCR-D up of synchronised units and synchronous external systems (MW). */
  readonly upMw: Float64Array
  /** FCR-N + FCR-D down (MW). */
  readonly downMw: Float64Array
  /** Kinetic energy of synchronised synchronous units and external systems (MWs); shares an imbalance where no reserve can. */
  readonly kineticEnergyMws: Float64Array
  /** Voltage-forming sources (synchronised synchronous units and synchronous external systems). */
  readonly formingCount: Int32Array
  /** Demand served at each bus (MW). */
  readonly servedLoadMw: Float64Array
}

export interface ContingencyCase {
  readonly grid: GridRuntimeInstance
  readonly network: CompiledGridNetwork
  readonly closed: Uint8Array
  readonly islandOfBus: Int32Array
  readonly islands: ReadonlyArray<CaseIsland>
  readonly injectionsMw: Float64Array
  readonly flowsMw: Float64Array
  readonly participation: CaseParticipation
  /** Unit outputs a remedial redispatch set in this case (MW); other units keep their solved output. */
  readonly redispatchedMw: ReadonlyMap<string, number>
}

/** A unit's electrical output in the case (MW). */
export const caseGeneratorOutputMw = (screeningCase: ContingencyCase, generatorId: string): number =>
  screeningCase.redispatchedMw.has(generatorId) ? screeningCase.redispatchedMw.get(generatorId)! : screeningCase.grid.generators.get(generatorId)!.dispatchMw

const caseIsland = (system: GridIslandSystem, energised: boolean): CaseIsland => ({
  buses: system.buses,
  branches: system.branches,
  system,
  energised,
  rhs: new Float64Array(system.buses.length - 1),
  solution: new Float64Array(system.buses.length - 1),
  work: new Float64Array(system.buses.length - 1),
})

/** Solves B·x = values over one island's reduced buses with the island's factor and private vectors; x is 0 at the reference. */
export const solveIsland = (island: CaseIsland, values: Float64Array, into: Float64Array): void => {
  const { buses, rhs, solution } = island
  for (let reduced = 0; reduced < rhs.length; reduced += 1) rhs[reduced] = values[buses[reduced + 1]!]!
  solveSparseCholesky({ ...island.system.factor, work: island.work }, rhs, solution)
  into[buses[0]!] = 0
  for (let reduced = 0; reduced < solution.length; reduced += 1) into[buses[reduced + 1]!] = solution[reduced]!
}

/** DC flows of every closed branch of one island from bus angles (radians). */
export const islandFlowsInto = (network: CompiledGridNetwork, island: CaseIsland, anglesRad: Float64Array, flowsMw: Float64Array): void => {
  for (const branch of island.branches) {
    flowsMw[branch] = (anglesRad[network.branchFrom[branch]!]! - anglesRad[network.branchTo[branch]!]!) * network.sBaseMva * network.branchSusceptancePu[branch]!
  }
}

const participationFor = (grid: GridRuntimeInstance, network: CompiledGridNetwork, energisedBus: (bus: number) => boolean): CaseParticipation => {
  const busCount = network.busCount
  const upMw = new Float64Array(busCount)
  const downMw = new Float64Array(busCount)
  const kineticEnergyMws = new Float64Array(busCount)
  const formingCount = new Int32Array(busCount)
  const servedLoadMw = new Float64Array(busCount)
  for (const definition of grid.definition.model.generators) {
    const state = grid.generators.get(definition.id)!
    const bus = network.busIndexById.get(definition.busId)!
    if (!gridGeneratorIsSynchronised(state) || !energisedBus(bus)) continue
    upMw[bus] = upMw[bus]! + state.reserves.fcrNMw + state.reserves.fcrDUpMw
    downMw[bus] = downMw[bus]! + state.reserves.fcrNMw + state.reserves.fcrDDownMw
    kineticEnergyMws[bus] = kineticEnergyMws[bus]! + generatorKineticEnergyMws(definition)
    if (generatorIsVoltageForming(definition)) formingCount[bus] = formingCount[bus]! + 1
  }
  for (const system of grid.definition.index.externalSystems) {
    if (!system.synchronous) continue
    const bus = network.busIndexById.get(system.boundaryBusIds[0]!)!
    if (!energisedBus(bus)) continue
    const reserves = externalFrequencyEquivalent(grid, system).reserves
    upMw[bus] = upMw[bus]! + reserves.fcrNMw + reserves.fcrDUpMw
    downMw[bus] = downMw[bus]! + reserves.fcrNMw + reserves.fcrDDownMw
    kineticEnergyMws[bus] = kineticEnergyMws[bus]! + externalKineticEnergyMws(system)
    formingCount[bus] = formingCount[bus]! + 1
  }
  for (const definition of grid.definition.model.loads) {
    const bus = network.busIndexById.get(definition.busId)!
    servedLoadMw[bus] = servedLoadMw[bus]! + grid.loads.get(definition.id)!.servedMw
  }
  return { upMw, downMw, kineticEnergyMws, formingCount, servedLoadMw }
}

/** The live Grid's solved state as a screening case, on the plan's cached factors. */
export const liveContingencyCase = (grid: GridRuntimeInstance): ContingencyCase => {
  const islands = solvedGridIslands(grid)
  const plan: GridTopologyPlan = islands.plan
  const network = plan.network
  const energisedPlanIsland = new Uint8Array(plan.islands.length)
  for (const island of islands.islands) energisedPlanIsland[island.planIndex] = island.energized ? 1 : 0
  const caseIslands = plan.systems.map((system, index) => caseIsland(system, energisedPlanIsland[index] === 1))
  const flowsMw = new Float64Array(network.branchCount)
  for (const island of caseIslands) if (island.energised) islandFlowsInto(network, island, plan.anglesRad, flowsMw)
  return {
    grid,
    network,
    closed: plan.closedBranches.slice(),
    islandOfBus: plan.islandIndexOfBus.slice(),
    islands: caseIslands,
    injectionsMw: plan.injectionsMw.slice(),
    flowsMw,
    participation: participationFor(grid, network, bus => energisedPlanIsland[plan.islandIndexOfBus[bus]!] === 1),
    redispatchedMw: new Map(),
  }
}

export type Balancing = 'reserves' | 'inertia' | 'de-energised'

export interface PartBalance {
  readonly balancing: Balancing
  /** Injection sum the part had to absorb (MW, positive: surplus). */
  readonly imbalanceMw: number
  /** Imbalance beyond the part's reserve in that direction (MW). */
  readonly reserveShortfallMw: number
  readonly unservedLoadMw: number
}

/** One unit taken out of a part's participation (a generator contingency). */
export interface RemovedParticipant {
  readonly bus: number
  readonly upMw: number
  readonly downMw: number
  readonly kineticEnergyMws: number
  readonly forming: number
}

/**
 * Rebalances the buses `members` (one electrical part) in `injections`: a part without a
 * voltage-forming source loses every injection (its demand is unserved); a live part shares its
 * injection sum among its FCR providers in proportion to their reserve in the needed direction, or
 * by kinetic energy where it holds no such reserve. `removed` takes one unit out of the part.
 */
export const rebalancePart = (config: {
  readonly participation: CaseParticipation
  readonly members: ArrayLike<number>
  readonly injections: Float64Array
  readonly removed: RemovedParticipant | null
}): PartBalance => {
  const { participation, members, injections, removed } = config
  const at = (bus: number, values: Float64Array, field: 'upMw' | 'downMw' | 'kineticEnergyMws'): number =>
    removed !== null && removed.bus === bus ? values[bus]! - removed[field] : values[bus]!
  let sumMw = 0
  let forming = 0
  for (let index = 0; index < members.length; index += 1) {
    const bus = members[index]!
    sumMw += injections[bus]!
    forming += removed !== null && removed.bus === bus ? participation.formingCount[bus]! - removed.forming : participation.formingCount[bus]!
  }
  if (forming === 0) {
    let unservedMw = 0
    for (let index = 0; index < members.length; index += 1) {
      const bus = members[index]!
      unservedMw += participation.servedLoadMw[bus]!
      injections[bus] = 0
    }
    return { balancing: 'de-energised', imbalanceMw: sumMw, reserveShortfallMw: 0, unservedLoadMw: unservedMw }
  }
  if (Math.abs(sumMw) <= balanceToleranceMw) return { balancing: 'reserves', imbalanceMw: sumMw, reserveShortfallMw: 0, unservedLoadMw: 0 }
  // A surplus (sum > 0) is absorbed by downward reserve, a deficit by upward reserve.
  const surplus = sumMw > 0
  const reserve = (bus: number): number => surplus ? at(bus, participation.downMw, 'downMw') : at(bus, participation.upMw, 'upMw')
  const inertia = (bus: number): number => at(bus, participation.kineticEnergyMws, 'kineticEnergyMws')
  let reserveMw = 0
  for (let index = 0; index < members.length; index += 1) reserveMw += reserve(members[index]!)
  const byReserve = reserveMw > balanceToleranceMw
  const weight = byReserve ? reserve : inertia
  let totalWeight = 0
  for (let index = 0; index < members.length; index += 1) totalWeight += weight(members[index]!)
  for (let index = 0; index < members.length; index += 1) {
    const bus = members[index]!
    const share = weight(bus)
    if (share !== 0) injections[bus] = injections[bus]! - sumMw * share / totalWeight
  }
  return { balancing: byReserve ? 'reserves' : 'inertia', imbalanceMw: sumMw, reserveShortfallMw: Math.max(0, Math.abs(sumMw) - reserveMw), unservedLoadMw: 0 }
}

/** Switching, injections and participation of a case derived from another. */
export interface CaseChanges {
  readonly closed: Uint8Array
  readonly injections: Float64Array
  readonly participation: CaseParticipation
  readonly redispatchedMw: ReadonlyMap<string, number>
}

/**
 * A case derived from `base` by remedial changes: islands found anew for the switching, each
 * rebalanced by reserve participation (a part without a voltage-forming source loses supply) and
 * factorised privately, flows solved. Returns the parts that had to rebalance or lost supply.
 */
export const switchedContingencyCase = (base: ContingencyCase, changes: CaseChanges): { readonly case: ContingencyCase; readonly balances: ReadonlyArray<PartBalance & { readonly busCount: number }> } => {
  const { network } = base
  const { closed, injections, participation } = changes
  const found = findGridIslands(network, closed)
  const scratch = new Int32Array(network.busCount)
  const injectionsMw = injections.slice()
  const balances: Array<PartBalance & { readonly busCount: number }> = []
  const islands: CaseIsland[] = []
  for (let index = 0; index < found.count; index += 1) {
    const buses = found.busOrder.slice(found.busStart[index]!, found.busStart[index + 1]!)
    const branches = found.branchOrder.slice(found.branchStart[index]!, found.branchStart[index + 1]!)
    const balance = rebalancePart({ participation, members: buses, injections: injectionsMw, removed: null })
    if ((balance.balancing === 'de-energised' && balance.unservedLoadMw > 0) || Math.abs(balance.imbalanceMw) > balanceToleranceMw) balances.push({ ...balance, busCount: buses.length })
    const system = createGridIslandSystem({ network, islandId: `case-island-${index}`, buses, branches, localOfBus: scratch })
    islands.push(caseIsland(system, balance.balancing !== 'de-energised'))
  }
  const anglesRad = new Float64Array(network.busCount)
  const scaled = new Float64Array(network.busCount)
  for (let bus = 0; bus < network.busCount; bus += 1) scaled[bus] = injectionsMw[bus]! / network.sBaseMva
  const flowsMw = new Float64Array(network.branchCount)
  for (const island of islands) {
    if (!island.energised) continue
    solveIsland(island, scaled, anglesRad)
    islandFlowsInto(network, island, anglesRad, flowsMw)
  }
  return {
    case: { grid: base.grid, network, closed, islandOfBus: found.islandOfBus, islands, injectionsMw, flowsMw, participation, redispatchedMw: changes.redispatchedMw },
    balances,
  }
}
