import { gridAcState, gridIslandFlowModel } from './ac-load-flow.ts'
import { balanceToleranceMw, rebalancePart, type CaseParticipation, type PartBalance } from './contingency-balance.ts'
import { generatorIsVoltageForming, generatorKineticEnergyMws } from './generator-dynamics.ts'
import type { GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import { externalBoundaryShares, externalFrequencyEquivalent, externalKineticEnergyMws, gridGeneratorIsSynchronised } from './island-input.ts'
import { solvedGridIslands } from './island-lifecycle.ts'
import type { CompiledGridNetwork } from './network/compiled-network.ts'
import { createGridIslandSystem, solveGridIslandInto, type GridIslandSystem } from './network/dc-power-flow.ts'
import { findGridIslands } from './network/islands.ts'
import { gridTablesFor } from './state/tables.ts'

// A screening case: a private copy of the solved network state (switching, injections, flows) on
// which contingencies and remedial actions are evaluated. Building one never writes to the Grid:
// it reads the live plan's factors and copies everything it changes. A screening copies the case
// once more into a shared-memory snapshot (contingency-snapshot.ts) that the N-1 kernel reads.

/**
 * Where an island's base (pre-contingency) branch flows come from, as the runtime declares them:
 * `ac` from its converged AC load flow (active power at the from end), `dc` from the DC solution
 * where it did not converge. The N-1 increments are DC whatever the base: line outage distribution
 * factors and compensating solves on the island's DC factor, added to the base flows.
 */
export type ContingencyBaseFlowModel = 'ac' | 'dc'

/** The base flow model of one energised island of the live Grid, by its stable id. */
export interface IslandBaseFlowModel {
  readonly islandId: string
  readonly flowModel: ContingencyBaseFlowModel
}

/**
 * What each branch's loading is judged on, as the runtime judges it: on an island whose AC load
 * flow converged (`mva` 1), the larger end apparent power, with each end's reactive power held at
 * its base value and the active power moved by the DC increment; elsewhere |active power|.
 */
export interface CaseLoadingBase {
  readonly mva: Uint8Array
  /** Base active power entering the branch at its to end (MW); with flowsMw it closes the branch's AC series loss. */
  readonly toActiveMw: Float64Array
  /** Base reactive power entering at each end (Mvar), held through a contingency. */
  readonly fromReactiveMvar: Float64Array
  readonly toReactiveMvar: Float64Array
}

const emptyLoadingBase = (branchCount: number): CaseLoadingBase => ({
  mva: new Uint8Array(branchCount),
  toActiveMw: new Float64Array(branchCount),
  fromReactiveMvar: new Float64Array(branchCount),
  toReactiveMvar: new Float64Array(branchCount),
})

export interface CaseIsland {
  /** Buses ascending; buses[0] is the angle reference. */
  readonly buses: Int32Array
  /** Closed branches inside the island. */
  readonly branches: Int32Array
  /** The island's factor; the kernel reads it only through a snapshot copy. */
  readonly system: GridIslandSystem
  readonly energised: boolean
}

export interface ContingencyCase {
  readonly grid: GridRuntimeInstance
  readonly network: CompiledGridNetwork
  readonly closed: Uint8Array
  readonly islandOfBus: Int32Array
  readonly islands: ReadonlyArray<CaseIsland>
  /** DC balance injections per bus (MW): what the DC increments rebalance. */
  readonly injectionsMw: Float64Array
  /** Base flow per branch (MW, positive from-bus to to-bus) in the model `baseFlowModels` declares for its island; 0 off the energised network. */
  readonly flowsMw: Float64Array
  /** The DC solution's flow per branch (MW); a derived case adds its own DC change to `flowsMw`. */
  readonly dcFlowsMw: Float64Array
  /** DC bus angles of the case (radians, each AC component's reference bus at 0). */
  readonly anglesRad: Float64Array
  /**
   * The bus angles a loop-closing synchro-check reads (radians, relative within each AC component),
   * as the close-branch command reads them: on the live Grid's case the AC load-flow angles of each
   * island whose AC load flow converged (`loopAngleFromAc` 1 at its buses) and the DC angles
   * elsewhere; on a case derived by remedial changes its own DC angles, since it has no AC solution.
   */
  readonly loopAnglesRad: Float64Array
  readonly loopAngleFromAc: Uint8Array
  /** The base flow model of each energised island of the live Grid the case derives from. */
  readonly baseFlowModels: ReadonlyArray<IslandBaseFlowModel>
  readonly loadingBase: CaseLoadingBase
  readonly participation: CaseParticipation
  /** Unit outputs a remedial redispatch set in this case (MW); other units keep their solved output. */
  readonly redispatchedMw: ReadonlyMap<string, number>
}

/** A unit's electrical output in the case (MW). */
export const caseGeneratorOutputMw = (screeningCase: ContingencyCase, generatorId: string): number =>
  screeningCase.redispatchedMw.has(generatorId) ? screeningCase.redispatchedMw.get(generatorId)! : screeningCase.grid.generators.get(generatorId)!.dispatchMw

const caseIsland = (system: GridIslandSystem, energised: boolean): CaseIsland => ({ buses: system.buses, branches: system.branches, system, energised })

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
    // The equivalent acts at its energised boundary buses by area participation, as it closes balances in the runtime.
    const boundaries = system.boundaryBusIds.map(busId => network.busIndexById.get(busId)!).filter(energisedBus)
    if (boundaries.length === 0) continue
    const shares = externalBoundaryShares(grid, system, boundaries.map(bus => network.busIds[bus]!))
    boundaries.forEach((bus, position) => {
      const share = shares[position]!
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
  const modelOfPlanIsland: Array<ContingencyBaseFlowModel | null> = plan.islands.map(() => null)
  const baseFlowModels: IslandBaseFlowModel[] = []
  for (const island of islands.islands) {
    energisedPlanIsland[island.planIndex] = island.energized ? 1 : 0
    const flowModel = gridIslandFlowModel(grid, island)
    modelOfPlanIsland[island.planIndex] = flowModel
    if (flowModel !== null) baseFlowModels.push({ islandId: island.id, flowModel })
  }
  // A case island is one AC component: each closes its own balance (through its boundary buses where the
  // synchronous equivalent ties several components into one synchronous island). An HVDC terminal's
  // component lies in no island and carries nothing.
  const energisedPlanIslandOf = (planIsland: number): boolean => planIsland >= 0 && energisedPlanIsland[planIsland] === 1
  const caseIslands = plan.systems.map((system, index) => caseIsland(system, energisedPlanIslandOf(plan.components[index]!.islandIndex)))
  const dcFlowsMw = new Float64Array(network.branchCount)
  for (const island of caseIslands) if (island.energised) islandFlowsInto(network, island, plan.anglesRad, dcFlowsMw)
  // Base flows are the branch states' flows, in the model the runtime declares for their island; an AC
  // branch's to-end active power is its AC series loss less its from-end flow.
  const flowsMw = new Float64Array(network.branchCount)
  const loadingBase = emptyLoadingBase(network.branchCount)
  grid.definition.model.branches.forEach((branch, index) => {
    const state = grid.branches.get(branch.id)!
    const expected = plan.closedBranches[index] === 1 ? modelOfPlanIsland[plan.islandIndexOfBus[network.branchFrom[index]!]!]! : null
    if (state.flowModel !== expected) throw new Error(`branch ${branch.id} carries ${state.flowModel ?? 'no'} flow where its island's solution is ${expected ?? 'none'}`)
    if (expected === null) return
    flowsMw[index] = state.flowMw
    if (expected === 'dc') return
    if (state.reactiveFromMvar === null || state.reactiveToMvar === null) throw new Error(`branch ${branch.id} carries AC flow without reactive power at its ends`)
    loadingBase.mva[index] = 1
    loadingBase.toActiveMw[index] = state.lossesMw - state.flowMw
    loadingBase.fromReactiveMvar[index] = state.reactiveFromMvar
    loadingBase.toReactiveMvar[index] = state.reactiveToMvar
  })
  const loopAnglesRad = plan.anglesRad.slice()
  const loopAngleFromAc = new Uint8Array(network.busCount)
  const acAnglesRad = gridAcState(grid)?.angleRad
  for (const island of islands.islands) {
    if (modelOfPlanIsland[island.planIndex] !== 'ac') continue
    if (acAnglesRad === undefined) throw new Error(`Grid ${grid.definition.gridId} island ${island.id} has converged with no AC state`)
    const buses = plan.islands[island.planIndex]!.busIndices
    for (let position = 0; position < buses.length; position += 1) {
      const bus = buses[position]!
      loopAnglesRad[bus] = acAnglesRad[bus]!
      loopAngleFromAc[bus] = 1
    }
  }
  return {
    grid,
    network,
    closed: plan.closedBranches.slice(),
    islandOfBus: plan.componentIndexOfBus.slice(),
    islands: caseIslands,
    injectionsMw: plan.injectionsMw.slice(),
    flowsMw,
    dcFlowsMw,
    anglesRad: plan.anglesRad.slice(),
    loopAnglesRad,
    loopAngleFromAc,
    baseFlowModels,
    loadingBase,
    participation: participationFor(grid, network, bus => energisedPlanIslandOf(plan.islandIndexOfBus[bus]!)),
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
 * factorised privately, DC flows solved. Its base flows are `base`'s plus the DC change the
 * changes make, as for a contingency; branches off the energised network carry none. Returns the
 * parts that had to rebalance or lost supply.
 */
export const switchedContingencyCase = (base: ContingencyCase, changes: CaseChanges): { readonly case: ContingencyCase; readonly balances: ReadonlyArray<PartBalance & { readonly busCount: number }> } => {
  const { network } = base
  const { closed, injections, participation } = changes
  const found = findGridIslands(network, closed)
  const scratch = new Int32Array(network.busCount)
  const injectionsMw = injections.slice()
  const balances: Array<PartBalance & { readonly busCount: number }> = []
  const islands: CaseIsland[] = []
  const norwegianBus = gridTablesFor(base.grid.definition).norwegianBus
  for (let index = 0; index < found.count; index += 1) {
    const buses = found.busOrder.slice(found.busStart[index]!, found.busStart[index + 1]!)
    const branches = found.branchOrder.slice(found.branchStart[index]!, found.branchStart[index + 1]!)
    const system = createGridIslandSystem({ network, islandId: `case-island-${index}`, buses, branches, localOfBus: scratch })
    if (!buses.some(bus => norwegianBus[bus] === 1)) {
      // Boundary buses with every tie open lie in no island (boundary-separation.ts): they carry nothing and need no balance.
      for (const bus of buses) injectionsMw[bus] = 0
      islands.push(caseIsland(system, false))
      continue
    }
    const balance = rebalancePart({ participation, members: buses, injections: injectionsMw, removed: null })
    if ((balance.balancing === 'de-energised' && balance.unservedLoadMw > 0) || Math.abs(balance.imbalanceMw) > balanceToleranceMw) balances.push({ ...balance, busCount: buses.length })
    islands.push(caseIsland(system, balance.balancing !== 'de-energised'))
  }
  const anglesRad = new Float64Array(network.busCount)
  const dcFlowsMw = new Float64Array(network.branchCount)
  const flowsMw = new Float64Array(network.branchCount)
  const loadingBase = emptyLoadingBase(network.branchCount)
  for (const island of islands) {
    if (!island.energised) continue
    // The case's own factor and solve vectors: nothing here belongs to the live plan.
    solveGridIslandInto(network, island.system, injectionsMw, anglesRad)
    islandFlowsInto(network, island, anglesRad, dcFlowsMw)
    for (const branch of island.branches) {
      const changeMw = dcFlowsMw[branch]! - base.dcFlowsMw[branch]!
      flowsMw[branch] = base.flowsMw[branch]! + changeMw
      // A branch the actions closed has no AC base: it is judged on active power.
      if (base.loadingBase.mva[branch] !== 1) continue
      loadingBase.mva[branch] = 1
      loadingBase.toActiveMw[branch] = base.loadingBase.toActiveMw[branch]! - changeMw
      loadingBase.fromReactiveMvar[branch] = base.loadingBase.fromReactiveMvar[branch]!
      loadingBase.toReactiveMvar[branch] = base.loadingBase.toReactiveMvar[branch]!
    }
  }
  return {
    case: {
      grid: base.grid, network, closed, islandOfBus: found.islandOfBus, islands, injectionsMw, flowsMw, dcFlowsMw, anglesRad,
      loopAnglesRad: anglesRad, loopAngleFromAc: new Uint8Array(network.busCount), baseFlowModels: base.baseFlowModels, loadingBase, participation, redispatchedMw: changes.redispatchedMw,
    },
    balances,
  }
}
