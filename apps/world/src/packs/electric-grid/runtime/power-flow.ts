import { gridAcState, solveGridAcLoadFlow } from './ac-load-flow.ts'
import { noteGridAcSolution } from './alarms.ts'
import { hvdcFromTerminalMw, hvdcToTerminalMw } from './hvdc.ts'
import type { GridBranchDefinition } from '../grid-model.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
import {
  boundaryBusesInComponent,
  externalBoundaryScratch,
  externalBoundarySharesInto,
  externalKineticEnergyMws,
  generatorSynchronisedAt,
  islandFixedInjectionMw,
  islandLossesMw,
} from './island-input.ts'
import { completeDeadGridLoad, completeLiveGridLoad } from './load-service.ts'
import { gridBranchFlowsMwInto } from './network/dc-power-flow.ts'
import { islandScratch, flowModelAc, flowModelDc, flowModelNone, publishedNullable, voltageModelAc, voltageModelDeEnergised, voltageModelNotConverged } from './state/arrays.ts'
import { gridTablesFor } from './state/tables.ts'
import { busStateViews } from './state/views.ts'
import { solvePlanInto } from './topology.ts'

/** The largest island injection sum the balance tolerates (MW); the balance closes by construction. */
export const islandBalanceToleranceMw = 1e-6

const flowScratch = new WeakMap<GridRuntimeInstance, Float64Array>()

const addAt = (values: Float64Array, index: number, amount: number): void => {
  values[index] = values[index]! + amount
}

const deEnergiseIsland = (grid: GridRuntimeInstance, island: GridTopologyIsland): void => {
  const generators = grid.arrays.generators
  for (const generator of island.generatorIndices) {
    generators.dispatchMw[generator] = 0
    generators.scheduledMw[generator] = 0
    generators.fcrMw[generator] = 0
    generators.afrrMw[generator] = 0
    generators.mfrrMw[generator] = 0
    generators.frequencyHz[generator] = Number.NaN
  }
  for (const load of island.loadIndices) completeDeadGridLoad(grid.arrays.loads, load)
  for (const item of island.storageIndices) {
    const state = grid.arrays.storage[item]!
    state.dispatchMw = 0
    state.frequencyHz = null
    state.voltagePu = 0
    state.state = 'unavailable'
  }
}

interface IslandBalance {
  suppliedMw: number
  servedMw: number
}

/**
 * Electrical injections of one energised island. Within the instant, the accelerating power
 * ΔP = Σ mechanical + fixed injections − served load − losses is shared by the synchronous machines
 * (and synchronous external systems) in proportion to their kinetic energy H·S, so the island's
 * injections sum to zero by construction and its angle-reference bus absorbs nothing. Adds the
 * island's supplied and served power to `balance`.
 */
const injectEnergisedIsland = (grid: GridRuntimeInstance, plans: GridIslandPlan, island: GridIsland, injections: Float64Array, balance: IslandBalance): void => {
  const structure = plans.plan.islands[island.planIndex]!
  const tables = gridTablesFor(grid.definition)
  const generators = grid.arrays.generators
  const loads = grid.arrays.loads
  const frequencyHz = island.frequency!.frequencyHz!
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const externalSystems = grid.definition.index.externalSystems
  let mechanicalMw = 0
  let kineticEnergyMws = 0
  for (const generator of structure.generatorIndices) {
    if (!generatorSynchronisedAt(generators, generator)) continue
    mechanicalMw += generators.scheduledMw[generator]! + generators.fcrMw[generator]! + generators.afrrMw[generator]! + generators.mfrrMw[generator]!
    kineticEnergyMws += tables.generatorKineticEnergyMws[generator]!
  }
  for (const item of structure.storageIndices) mechanicalMw += grid.arrays.storage[item]!.dispatchMw
  for (const system of structure.externalIndices) {
    mechanicalMw += grid.arrays.externalSystems[system]!.mechanicalMw
    kineticEnergyMws += externalKineticEnergyMws(externalSystems[system]!)
  }
  const fixedMw = islandFixedInjectionMw(grid, structure)
  let servedMw = 0
  for (const load of structure.loadIndices) servedMw += loads.servedMw[load]!
  const lossesMw = islandLossesMw(grid, structure)
  const acceleratingMw = mechanicalMw + fixedMw - servedMw - lossesMw
  if (!(kineticEnergyMws > 0)) throw new Error(`energised island ${island.id} has no synchronous kinetic energy`)
  let suppliedMw = fixedMw
  for (const generator of structure.generatorIndices) {
    generators.frequencyHz[generator] = frequencyHz
    if (!generatorSynchronisedAt(generators, generator)) {
      generators.dispatchMw[generator] = 0
      continue
    }
    const mechanical = generators.scheduledMw[generator]! + generators.fcrMw[generator]! + generators.afrrMw[generator]! + generators.mfrrMw[generator]!
    const dispatchMw = mechanical - tables.generatorKineticEnergyMws[generator]! / kineticEnergyMws * acceleratingMw
    generators.dispatchMw[generator] = dispatchMw
    addAt(injections, tables.generatorBus[generator]!, dispatchMw)
    suppliedMw += dispatchMw
  }
  for (const item of structure.storageIndices) {
    const state = grid.arrays.storage[item]!
    state.frequencyHz = frequencyHz
    addAt(injections, tables.storageBus[item]!, state.dispatchMw)
    suppliedMw += state.dispatchMw
  }
  for (const point of structure.connectionPointIndices) {
    const connection = grid.arrays.connections[point]!
    if (connection?.connected === true) addAt(injections, tables.connectionPointBus[point]!, connection.systemActivePowerMw)
  }
  const islandOf = plans.plan.islandIndexOfBus
  for (let link = 0; link < tables.hvdcFromBus.length; link += 1) {
    const from = tables.hvdcFromBus[link]!
    const to = tables.hvdcToBus[link]!
    if (islandOf[from] === island.planIndex) addAt(injections, from, hvdcFromTerminalMw(grid, link))
    if (islandOf[to] === island.planIndex) addAt(injections, to, hvdcToTerminalMw(grid, link))
  }
  for (const load of structure.loadIndices) {
    addAt(injections, tables.loadBus[load]!, -loads.servedMw[load]!)
    completeLiveGridLoad(loads, load, frequencyHz, nominalHz)
  }
  for (const bus of structure.busIndices) addAt(injections, bus, -grid.lossLoadByBusMw[bus]!)
  // The island holds at most one synchronous external system (definitions.ts).
  for (const system of structure.externalIndices) {
    const definition = externalSystems[system]!
    const state = grid.arrays.externalSystems[system]!
    state.importMw = state.mechanicalMw - externalKineticEnergyMws(definition) / kineticEnergyMws * acceleratingMw
    state.islandId = island.id
    state.energized = true
    const closingMw = closeComponentsThroughBoundaries(grid, plans.plan, structure, system, injections)
    if (!(Math.abs(closingMw - state.importMw) < islandBalanceToleranceMw)) {
      throw new Error(`Grid ${grid.definition.gridId} island ${island.id}: ${definition.id} closes its components with ${closingMw} MW but its inertial share gives ${state.importMw} MW; the island balance must close within ${islandBalanceToleranceMw} MW`)
    }
    suppliedMw += state.importMw
  }
  balance.suppliedMw += suppliedMw
  balance.servedMw += servedMw
}

/**
 * Each AC component of the island closes its own balance through the external system's boundary
 * buses in it: the equivalent carries whatever the component's other injections leave over, split
 * between its boundary buses there by externalBoundaryShares. Returns the sum over components,
 * which must equal the external system's import from inertial sharing because the island's
 * injections sum to zero by construction.
 */
const closeComponentsThroughBoundaries = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  island: GridTopologyIsland,
  system: number,
  injections: Float64Array,
): number => {
  const scratch = externalBoundaryScratch(grid)
  let closingMw = 0
  for (const componentIndex of island.componentIndices) {
    const count = boundaryBusesInComponent(grid, plan, system, componentIndex, scratch.buses)
    if (count === 0) continue
    let othersMw = 0
    for (const bus of plan.components[componentIndex]!.busIndices) othersMw += injections[bus]!
    externalBoundarySharesInto(grid, grid.definition.index.externalSystems[system]!, scratch.buses, count, scratch.capacities, scratch.shares)
    for (let position = 0; position < count; position += 1) addAt(injections, scratch.buses[position]!, -othersMw * scratch.shares[position]!)
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
  const balance = scratch.balance
  balance.suppliedMw = 0
  balance.servedMw = 0
  for (const system of grid.arrays.externalSystems) {
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
    injectEnergisedIsland(grid, islands, island, injections, balance)
  }
  const suppliedMw = balance.suppliedMw
  const servedMw = balance.servedMw
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
    const outcome = acOutcomes[island.planIndex]!
    if (outcome === null) continue
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
  for (const link of grid.arrays.hvdcLinks) lossesMw += link.lossesMw

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
  const tables = gridTablesFor(grid.definition)
  for (const island of islands.islands) {
    if (!island.energized) continue
    const structure = plan.islands[island.planIndex]!
    for (const load of structure.loadIndices) grid.arrays.loads.voltagePu[load] = busArrays.voltagePu[tables.loadBus[load]!]!
    for (const item of structure.storageIndices) grid.arrays.storage[item]!.voltagePu = publishedNullable(busArrays.voltagePu[tables.storageBus[item]!]!)
  }

  const audit = grid.diagnostics.energyAudit
  const hours = dtSeconds / 3_600
  audit.lastMaximumIslandMismatchMw = maximumMismatchMw
  audit.cumulativeMismatchMwh += mismatchSumMw * hours
  audit.suppliedEnergyMwh += suppliedMw * hours
  audit.servedEnergyMwh += servedMw * hours
  audit.lossEnergyMwh += lossesMw * hours
}
