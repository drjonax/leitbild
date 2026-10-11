import { balanceToleranceMw, rebalancePart, type CaseParticipation, type PartBalance } from './contingency-balance.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import type { GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import { boundaryTieCapacityMw, externalFrequencyEquivalent, externalKineticEnergyMws, gridGeneratorIsSynchronised } from './island-input.ts'
import { solvedGridIslands } from './island-lifecycle.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'

// A screening case: a private copy of the solved network state (switching, injections, flows) on
// which contingencies and remedial actions are evaluated. Building one never writes to the Grid:
// it reads the live plan's factors and copies everything it changes. A screening copies the case
// once more into a shared-memory snapshot (contingency-snapshot.ts) that the N-1 kernel reads.

/**
 * Where an island's base (pre-contingency) branch flows come from. `dc`: the runtime's DC solution,
 * on which its branch relays and loading act. The N-1 kernel adds DC sensitivities (LODF and
 * compensating solves on the island's DC factor) to whichever base flows the case declares.
 */
export type ContingencyBaseFlowModel = 'dc'

export interface CaseIsland {
  /** Buses ascending; buses[0] is the angle reference. */
  readonly buses: Int32Array
  /** Closed branches inside the island. */
  readonly branches: Int32Array
  /** The island's factor; the kernel reads it only through a snapshot copy. */
  readonly system: GridIslandSystem
  readonly energised: boolean
  /** The model of this island's entries in the case's `flowsMw`. */
  readonly baseFlowModel: ContingencyBaseFlowModel
}

export interface ContingencyCase {
  readonly grid: GridRuntimeInstance
  readonly network: CompiledGridNetwork
  readonly closed: Uint8Array
  readonly islandOfBus: Int32Array
  readonly islands: ReadonlyArray<CaseIsland>
  readonly injectionsMw: Float64Array
  /** Base flow per branch (MW, positive from-bus to to-bus) in its island's declared `baseFlowModel`; 0 on open branches. */
  readonly flowsMw: Float64Array
  readonly participation: CaseParticipation
  /** Unit outputs a remedial redispatch set in this case (MW); other units keep their solved output. */
  readonly redispatchedMw: ReadonlyMap<string, number>
}

/** A unit's electrical output in the case (MW). */
export const caseGeneratorOutputMw = (screeningCase: ContingencyCase, generatorId: string): number =>
  screeningCase.redispatchedMw.has(generatorId) ? screeningCase.redispatchedMw.get(generatorId)! : screeningCase.grid.generators.get(generatorId)!.dispatchMw

const caseIsland = (system: GridIslandSystem, energised: boolean, baseFlowModel: ContingencyBaseFlowModel): CaseIsland => ({
  buses: system.buses, branches: system.branches, system, energised, baseFlowModel,
})

/** DC flows of every closed branch of one island from bus angles (radians). */
const islandFlowsInto = (network: CompiledGridNetwork, island: CaseIsland, anglesRad: Float64Array, flowsMw: Float64Array): void => {
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
    const reserves = externalFrequencyEquivalent(grid, system).reserves
    // The equivalent acts at its boundary buses in proportion to their closed ties, as it closes balances in the runtime.
    const boundaries = system.boundaryBusIds.map(busId => network.busIndexById.get(busId)!).filter(energisedBus)
    const capacities = boundaries.map(bus => boundaryTieCapacityMw(grid, network.busIds[bus]!))
    const totalCapacityMw = capacities.reduce((sum, capacity) => sum + capacity, 0)
    boundaries.forEach((bus, position) => {
      const share = totalCapacityMw > 0 ? capacities[position]! / totalCapacityMw : 1 / boundaries.length
      upMw[bus] = upMw[bus]! + (reserves.fcrNMw + reserves.fcrDUpMw) * share
      downMw[bus] = downMw[bus]! + (reserves.fcrNMw + reserves.fcrDDownMw) * share
      kineticEnergyMws[bus] = kineticEnergyMws[bus]! + externalKineticEnergyMws(system) * share
      formingCount[bus] = formingCount[bus]! + 1
    })
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
  // A case island is one AC component: each closes its own balance (through its boundary buses where the
  // synchronous equivalent ties several components into one synchronous island).
  // The runtime's branch flows, relays and loading are the DC solution of every island.
  const caseIslands = plan.systems.map((system, index) => caseIsland(system, energisedPlanIsland[plan.components[index]!.islandIndex] === 1, 'dc'))
  const flowsMw = new Float64Array(network.branchCount)
  for (const island of caseIslands) if (island.energised) islandFlowsInto(network, island, plan.anglesRad, flowsMw)
  return {
    grid,
    network,
    closed: plan.closedBranches.slice(),
    islandOfBus: plan.componentIndexOfBus.slice(),
    islands: caseIslands,
    injectionsMw: plan.injectionsMw.slice(),
    flowsMw,
    participation: participationFor(grid, network, bus => energisedPlanIsland[plan.islandIndexOfBus[bus]!] === 1),
    redispatchedMw: new Map(),
  }
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
    // A remedial case has no AC solution: its base flows are its own DC solve.
    islands.push(caseIsland(system, balance.balancing !== 'de-energised', 'dc'))
  }
  const anglesRad = new Float64Array(network.busCount)
  const flowsMw = new Float64Array(network.branchCount)
  for (const island of islands) {
    if (!island.energised) continue
    // The case's own factor and solve vectors: nothing here belongs to the live plan.
    solveGridIslandInto(network, island.system, injectionsMw, anglesRad)
    islandFlowsInto(network, island, anglesRad, flowsMw)
  }
  return {
    case: { grid: base.grid, network, closed, islandOfBus: found.islandOfBus, islands, injectionsMw, flowsMw, participation, redispatchedMw: changes.redispatchedMw },
    balances,
  }
}
