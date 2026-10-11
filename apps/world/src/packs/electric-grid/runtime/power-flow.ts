import { gridAcState, solveGridAcLoadFlow } from './ac-load-flow.ts'
import { noteGridAcSolution } from './alarms.ts'
import { generatorKineticEnergyMws } from './generator-dynamics.ts'
import { hvdcTerminalInjectionsMw } from './hvdc.ts'
import type { GridBranchDefinition, GridExternalSystemDefinition } from '../grid-model.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import {
  externalBoundaryShares,
  externalKineticEnergyMws,
  gridGeneratorIsSynchronised,
  islandAssetStates,
  islandFixedInjectionMw,
  islandLossesMw,
  islandMembers,
} from './island-input.ts'
import { completeDeadGridLoad, completeLiveGridLoad } from './load-service.ts'
import { gridBranchFlowsMwInto } from './network/dc-power-flow.ts'
import { islandScratch, flowModelAc, flowModelDc, flowModelNone, publishedNullable, voltageModelAc, voltageModelDeEnergised, voltageModelNotConverged } from './state/arrays.ts'
import { busStateViews } from './state/views.ts'
import { solvePlanInto } from './topology.ts'

/** The largest island injection sum the balance tolerates (MW); the balance closes by construction. */
export const islandBalanceToleranceMw = 1e-6

const flowScratch = new WeakMap<GridRuntimeInstance, Float64Array>()

const addAt = (values: Float64Array, index: number, amount: number): void => {
  values[index] = values[index]! + amount
}

const deEnergiseIsland = (grid: GridRuntimeInstance, island: GridTopologyIsland): void => {
  const states = islandAssetStates(grid, island)
  for (const state of states.generators) {
    state.dispatchMw = 0
    state.scheduledMw = 0
    state.fcrMw = 0
    state.afrrMw = 0
    state.mfrrMw = 0
    state.frequencyHz = null
  }
  for (const state of states.loads) completeDeadGridLoad(state)
  for (const state of states.storage) {
    state.dispatchMw = 0
    state.frequencyHz = null
    state.voltagePu = 0
    state.state = 'unavailable'
  }
}

interface IslandBalance {
  readonly suppliedMw: number
  readonly servedMw: number
  readonly lossesMw: number
}

/**
 * Electrical injections of one energised island. Within the instant, the accelerating power
 * ΔP = Σ mechanical + fixed injections − served load − losses is shared by the synchronous machines
 * (and synchronous external systems) in proportion to their kinetic energy H·S, so the island's
 * injections sum to zero by construction and its angle-reference bus absorbs nothing.
 */
const injectEnergisedIsland = (grid: GridRuntimeInstance, plans: GridIslandPlan, island: GridIsland, injections: Float64Array): IslandBalance => {
  const structure = plans.plan.islands[island.planIndex]!
  const network = plans.plan.network
  const members = islandMembers(grid, structure)
  const states = islandAssetStates(grid, structure)
  const frequencyHz = island.frequency!.frequencyHz!
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const busIndex = (busId: string): number => network.busIndexById.get(busId)!
  let mechanicalMw = 0
  let kineticEnergyMws = 0
  structure.generators.forEach((definition, index) => {
    const state = states.generators[index]!
    if (!gridGeneratorIsSynchronised(state)) return
    mechanicalMw += state.scheduledMw + state.fcrMw + state.afrrMw + state.mfrrMw
    kineticEnergyMws += generatorKineticEnergyMws(definition)
  })
  for (const state of states.storage) mechanicalMw += state.dispatchMw
  const externals = members.externals
  for (const system of externals) {
    mechanicalMw += grid.externalSystems.get(system.id)!.mechanicalMw
    kineticEnergyMws += externalKineticEnergyMws(system)
  }
  const fixedMw = islandFixedInjectionMw(grid, structure)
  const servedMw = states.loads.reduce((sum, state) => sum + state.servedMw, 0)
  const lossesMw = islandLossesMw(grid, structure)
  const acceleratingMw = mechanicalMw + fixedMw - servedMw - lossesMw
  if (!(kineticEnergyMws > 0)) throw new Error(`energised island ${island.id} has no synchronous kinetic energy`)
  let suppliedMw = fixedMw
  structure.generators.forEach((definition, index) => {
    const state = states.generators[index]!
    state.frequencyHz = frequencyHz
    if (!gridGeneratorIsSynchronised(state)) {
      state.dispatchMw = 0
      return
    }
    const mechanical = state.scheduledMw + state.fcrMw + state.afrrMw + state.mfrrMw
    state.dispatchMw = mechanical - generatorKineticEnergyMws(definition) / kineticEnergyMws * acceleratingMw
    addAt(injections, members.generatorBuses[index]!, state.dispatchMw)
    suppliedMw += state.dispatchMw
  })
  states.storage.forEach((state, index) => {
    state.frequencyHz = frequencyHz
    addAt(injections, members.storageBuses[index]!, state.dispatchMw)
    suppliedMw += state.dispatchMw
  })
  for (const pointId of members.connectionPointIds) {
    const connection = grid.externalConnections.get(pointId)
    if (connection?.connected === true) addAt(injections, busIndex(connection.busId), connection.systemActivePowerMw)
  }
  for (const link of grid.definition.index.hvdcLinks) {
    const terminals = hvdcTerminalInjectionsMw(grid, link)
    if (structure.busSet.has(link.fromBusId)) addAt(injections, busIndex(link.fromBusId), terminals.fromMw)
    if (structure.busSet.has(link.toBusId)) addAt(injections, busIndex(link.toBusId), terminals.toMw)
  }
  states.loads.forEach((state, index) => {
    addAt(injections, members.loadBuses[index]!, -state.servedMw)
    completeLiveGridLoad(state, frequencyHz, nominalHz)
  })
  for (const bus of members.busIndices) addAt(injections, bus, -grid.lossLoadByBusMw[bus]!)
  // The island holds at most one synchronous external system (definitions.ts).
  for (const system of externals) {
    const state = grid.externalSystems.get(system.id)!
    state.importMw = state.mechanicalMw - externalKineticEnergyMws(system) / kineticEnergyMws * acceleratingMw
    state.islandId = island.id
    state.energized = true
    const closingMw = closeComponentsThroughBoundaries(grid, plans.plan, structure, system, injections)
    if (!(Math.abs(closingMw - state.importMw) < islandBalanceToleranceMw)) {
      throw new Error(`Grid ${grid.definition.gridId} island ${island.id}: ${system.id} closes its components with ${closingMw} MW but its inertial share gives ${state.importMw} MW; the island balance must close within ${islandBalanceToleranceMw} MW`)
    }
    suppliedMw += state.importMw
  }
  return { suppliedMw, servedMw, lossesMw }
}

/**
 * Each AC component of the island closes its own balance through the external system's boundary
 * buses in it: the equivalent carries whatever the component's other injections leave over, split
 * between its boundary buses there in proportion to the rating of their closed ties (all to the
 * first one when none is closed). Returns the sum over components, which must equal the external
 * system's import from inertial sharing because the island's injections sum to zero by construction.
 */
const closeComponentsThroughBoundaries = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  island: GridTopologyIsland,
  system: GridExternalSystemDefinition,
  injections: Float64Array,
): number => {
  const network = plan.network
  let closingMw = 0
  for (const componentIndex of island.componentIndices) {
    const component = plan.components[componentIndex]!
    const boundaries = system.boundaryBusIds.filter(busId => plan.componentIndexOfBus[network.busIndexById.get(busId)!] === componentIndex)
    if (boundaries.length === 0) continue
    let othersMw = 0
    for (const bus of component.busIndices) othersMw += injections[bus]!
    const shares = externalBoundaryShares(grid, system, boundaries)
    boundaries.forEach((busId, position) => addAt(injections, network.busIndexById.get(busId)!, -othersMw * shares[position]!))
    closingMw -= othersMw
  }
  return closingMw
}

/**
 * The DC flows of the Grid's last network solution (MW, model branch order, 0 off the energised
 * network): the solution the island balances and bus injections close on. Published flows are the
 * AC ones where an island converged.
 */
export const gridDcFlowsMw = (grid: GridRuntimeInstance): Float64Array => {
  const flows = flowScratch.get(grid)
  if (flows === undefined) throw new Error(`Grid ${grid.definition.gridId} has not been solved yet`)
  return flows
}

const lossScratches = new WeakMap<GridRuntimeInstance, Float64Array>()
const lossScratch = (grid: GridRuntimeInstance, busCount: number): Float64Array => {
  const cached = lossScratches.get(grid)
  if (cached !== undefined && cached.length === busCount) return cached
  const created = new Float64Array(busCount)
  lossScratches.set(grid, created)
  return created
}

/**
 * AC series loss of a π branch, MW: r·|I|² with I = (V_from/τ − V_to)/(r + jx), the tap τ at the
 * from end. It equals the active power entering both ends (the shunt branches carry no active
 * power) and is never negative, which their rounded sum can be on a lossless branch.
 */
const acSeriesLossMw = (branch: GridBranchDefinition, fromPu: number, toPu: number, angleRad: number, sBaseMva: number): number => {
  // Lines and cables have no transformer: their ratio is exactly 1.
  const from = fromPu / (branch.kind === 'transformer' ? branch.tapRatio! : 1)
  const half = Math.sin(angleRad / 2)
  const differenceSquared = (from - toPu) ** 2 + 4 * from * toPu * half * half
  const r = branch.resistancePu
  return r * differenceSquared / (r * r + branch.reactancePu ** 2) * sBaseMva
}

/**
 * Network solution of one tick: electrical injections with inertial sharing, one DC solve per
 * energised island, the balance check, then the AC load flow of every energised island; the AC
 * losses (the DC estimate where an island did not converge) are what the islands carry as load
 * from the next advance on when `carryLosses`. Bus and branch states take the AC voltages and
 * reactive power. De-energised islands carry no power: zero voltage and no frequency.
 */
export const solveGridNetwork = (grid: GridRuntimeInstance, islands: GridIslandPlan, dtSeconds: number, carryLosses: boolean): void => {
  const { plan } = islands
  const { network } = plan
  const model = grid.definition.model
  // The Grid's tick counts network solutions; readers use it as the revision of the solved state.
  grid.tick += 1
  const injections = plan.injectionsMw
  injections.fill(0)
  const scratch = islandScratch(grid.arrays, plan.islands.length)
  const solve = scratch.solve
  let suppliedMw = 0
  let servedMw = 0
  for (const system of grid.externalSystems.values()) {
    system.importMw = 0
    system.islandId = null
    system.energized = false
  }
  for (const island of islands.islands) {
    if (!island.energized) {
      deEnergiseIsland(grid, plan.islands[island.planIndex]!)
      continue
    }
    solve[island.planIndex] = 1
    const balance = injectEnergisedIsland(grid, islands, island, injections)
    suppliedMw += balance.suppliedMw
    servedMw += balance.servedMw
  }
  solvePlanInto(plan, solve)
  let maximumMismatchMw = 0
  let mismatchSumMw = 0
  for (const island of islands.islands) {
    if (!island.energized) continue
    for (const componentIndex of plan.islands[island.planIndex]!.componentIndices) {
      const mismatchMw = Math.abs(plan.referenceMismatchMw[componentIndex]!)
      if (!(mismatchMw < islandBalanceToleranceMw)) {
        throw new Error(`Grid ${grid.definition.gridId} island ${island.id}: component at ${plan.components[componentIndex]!.referenceBusId} injections sum to ${plan.referenceMismatchMw[componentIndex]} MW; the balance must close within ${islandBalanceToleranceMw} MW`)
      }
      maximumMismatchMw = Math.max(maximumMismatchMw, mismatchMw)
      mismatchSumMw += mismatchMw
    }
  }

  const flows = flowScratch.get(grid) ?? new Float64Array(network.branchCount)
  flowScratch.set(grid, flows)
  gridBranchFlowsMwInto(network, plan.closedBranches, plan.anglesRad, flows)

  // AC load flow per energised island; its outcome is published, and a failure raises the island's alarm.
  const acOutcomes = solveGridAcLoadFlow(grid, islands)
  const ac = gridAcState(grid)!
  grid.acOutcomeByIsland.clear()
  const acConverged = scratch.acConverged
  for (const island of islands.islands) {
    const outcome = acOutcomes.get(island.planIndex)
    if (outcome === undefined) continue
    grid.acOutcomeByIsland.set(island.id, outcome)
    if (outcome.converged) acConverged[island.planIndex] = 1
    noteGridAcSolution(grid, island.id, outcome.converged ? { converged: true } : { converged: false, reason: `${outcome.failure.reason}: ${outcome.failure.detail}` })
  }
  // An island that de-energised or merged has no load flow any more, so no non-convergence either.
  for (const islandId of grid.alarms.acNonConvergence.keys()) {
    if (!grid.acOutcomeByIsland.has(islandId)) noteGridAcSolution(grid, islandId, { converged: true })
  }

  // The losses the islands carry as load change only when `carryLosses`: with branch relays, at their
  // fixed sample instants, so the carried losses do not depend on where the adapter's ticks end.
  const lossLoad = carryLosses ? grid.lossLoadByBusMw : lossScratch(grid, network.busCount)
  lossLoad.fill(0)
  let lossesMw = 0
  const islandOf = plan.islandIndexOfBus
  const energised = scratch.energised
  const frequencyOfIsland = scratch.frequencyHz
  const busArrays = grid.arrays.buses
  const solvedIds = busArrays.solvedIslandIds
  solvedIds.length = plan.islands.length
  for (const island of islands.islands) {
    energised[island.planIndex] = island.energized ? 1 : 0
    // NaN codes null: an energised island always carries a frequency (gridIslandFrequencyHz).
    const frequencyHz = island.energized ? island.frequency!.frequencyHz : null
    frequencyOfIsland[island.planIndex] = frequencyHz === null ? Number.NaN : frequencyHz
    solvedIds[island.planIndex] = island.id
  }
  // Branch quantities in model order. Voltages: the AC result where the island converged, unknown
  // (NaN, published as null) where it did not, 0 when de-energised.
  const branchArrays = grid.arrays.branches
  for (let index = 0; index < network.branchCount; index += 1) {
    const branch = model.branches[index]!
    const from = network.branchFrom[index]!
    const to = network.branchTo[index]!
    const island = islandOf[from]!
    const live = plan.closedBranches[index] === 1 && energised[island] === 1
    const acLive = live && acConverged[island] === 1
    const dcFlowMw = live ? flows[index]! : 0
    // Losses carried as load at the branch ends from the next advance on: the AC series loss r·|I|²
    // where the island converged, else the quadratic DC estimate r·P²/S_base.
    const branchLossMw = acLive
      ? acSeriesLossMw(branch, ac.voltagePu[from]!, ac.voltagePu[to]!, ac.angleRad[from]! - ac.angleRad[to]!, network.sBaseMva)
      : live ? branch.resistancePu * dcFlowMw * dcFlowMw / network.sBaseMva : 0
    addAt(lossLoad, from, branchLossMw / 2)
    addAt(lossLoad, to, branchLossMw / 2)
    lossesMw += branchLossMw
    // Flow and loading: the AC flows where the island converged (the larger end apparent power is
    // what the rating bounds), else the DC flow, labelled so.
    let apparentPowerMva: number
    if (acLive) {
      const fromMw = ac.branchFromActiveMw[index]!
      const toMw = ac.branchToActiveMw[index]!
      branchArrays.flowModel[index] = flowModelAc
      branchArrays.flowMw[index] = fromMw
      apparentPowerMva = Math.max(Math.hypot(fromMw, ac.branchFromReactiveMvar[index]!), Math.hypot(toMw, ac.branchToReactiveMvar[index]!))
    } else {
      branchArrays.flowModel[index] = live ? flowModelDc : flowModelNone
      branchArrays.flowMw[index] = dcFlowMw
      apparentPowerMva = Math.abs(dcFlowMw)
    }
    branchArrays.apparentPowerMva[index] = apparentPowerMva
    branchArrays.lossesMw[index] = branchLossMw
    branchArrays.loadingPercent[index] = apparentPowerMva / (branch.ratingMw * branchArrays.availability[index]!) * 100
    branchArrays.frequencyHz[index] = live ? frequencyOfIsland[island]! : Number.NaN
    branchArrays.voltageFromPu[index] = energised[island] !== 1 ? 0 : acConverged[island] === 1 ? ac.voltagePu[from]! : Number.NaN
    const toIsland = islandOf[to]!
    branchArrays.voltageToPu[index] = energised[toIsland] !== 1 ? 0 : acConverged[toIsland] === 1 ? ac.voltagePu[to]! : Number.NaN
    branchArrays.reactiveFromMvar[index] = acLive ? ac.branchFromReactiveMvar[index]! : Number.NaN
    branchArrays.reactiveToMvar[index] = acLive ? ac.branchToReactiveMvar[index]! : Number.NaN
  }
  for (const link of grid.definition.index.hvdcLinks) lossesMw += grid.hvdcLinks.get(link.id)!.lossesMw

  if (grid.busStates.size === 0) for (const [busId, state] of busStateViews(network.busIds, busArrays)) grid.busStates.set(busId, state)
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const planIndex = islandOf[bus]!
    const energized = energised[planIndex] === 1
    const converged = acConverged[planIndex] === 1
    busArrays.solvedIsland[bus] = planIndex
    busArrays.energized[bus] = energized ? 1 : 0
    busArrays.voltagePu[bus] = !energized ? 0 : converged ? ac.voltagePu[bus]! : Number.NaN
    busArrays.voltageModel[bus] = !energized ? voltageModelDeEnergised : converged ? voltageModelAc : voltageModelNotConverged
    busArrays.reactiveInjectionMvar[bus] = !energized ? 0 : converged ? ac.reactiveInjectionMvar[bus]! : Number.NaN
    busArrays.frequencyHz[bus] = energized ? frequencyOfIsland[planIndex]! : Number.NaN
  }
  busArrays.angleRad.set(plan.anglesRad)
  busArrays.netInjectionMw.set(injections)
  for (const island of islands.islands) {
    if (!island.energized) continue
    const structure = plan.islands[island.planIndex]!
    const members = islandMembers(grid, structure)
    const states = islandAssetStates(grid, structure)
    states.loads.forEach((state, position) => { state.voltagePu = publishedNullable(busArrays.voltagePu[members.loadBuses[position]!]!) })
    states.storage.forEach((state, position) => { state.voltagePu = publishedNullable(busArrays.voltagePu[members.storageBuses[position]!]!) })
  }

  const audit = grid.diagnostics.energyAudit
  const hours = dtSeconds / 3_600
  audit.lastMaximumIslandMismatchMw = maximumMismatchMw
  audit.cumulativeMismatchMwh += mismatchSumMw * hours
  audit.suppliedEnergyMwh += suppliedMw * hours
  audit.servedEnergyMwh += servedMw * hours
  audit.lossEnergyMwh += lossesMw * hours
}
