import { externalVoltageSetpointPu, gridAcState, solveGridAcLoadFlow } from './ac-load-flow.ts'
import { noteGridAcSolution } from './alarms.ts'
import { hvdcFromTerminalMw, hvdcToTerminalMw } from './hvdc.ts'
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
import { islandScratch, flowModelAc, flowModelDc, flowModelNone, publishedNullable, voltageModelAc, voltageModelDeEnergised, voltageModelExternal, voltageModelNotConverged, type GridIslandScratch } from './state/arrays.ts'
import { externalSystemFrequencyHz } from './boundary-separation.ts'
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
  for (let generatorPosition = 0; generatorPosition < island.generatorIndices.length; generatorPosition += 1) {
    const generator = island.generatorIndices[generatorPosition]!
    generators.dispatchMw[generator] = 0
    generators.scheduledMw[generator] = 0
    generators.fcrMw[generator] = 0
    generators.afrrMw[generator] = 0
    generators.mfrrMw[generator] = 0
    generators.frequencyHz[generator] = Number.NaN
  }
  for (let loadPosition = 0; loadPosition < island.loadIndices.length; loadPosition += 1) {
    const load = island.loadIndices[loadPosition]!
    completeDeadGridLoad(grid.arrays.loads, load)
  }
  for (let itemPosition = 0; itemPosition < island.storageIndices.length; itemPosition += 1) {
    const item = island.storageIndices[itemPosition]!
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
  const frequencyHz = island.workspace!.frequencyHz!
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const externalSystems = grid.definition.index.externalSystems
  let mechanicalMw = 0
  let kineticEnergyMws = 0
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
    if (!generatorSynchronisedAt(generators, generator)) continue
    mechanicalMw += generators.scheduledMw[generator]! + generators.fcrMw[generator]! + generators.afrrMw[generator]! + generators.mfrrMw[generator]!
    kineticEnergyMws += tables.generatorKineticEnergyMws[generator]!
  }
  for (let itemPosition = 0; itemPosition < structure.storageIndices.length; itemPosition += 1) {
    const item = structure.storageIndices[itemPosition]!
    mechanicalMw += grid.arrays.storage[item]!.dispatchMw
  }
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    const system = structure.externalIndices[systemPosition]!
    mechanicalMw += grid.arrays.externalSystems[system]!.mechanicalMw
    kineticEnergyMws += externalKineticEnergyMws(externalSystems[system]!)
  }
  const fixedMw = islandFixedInjectionMw(grid, structure)
  let servedMw = 0
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    servedMw += loads.servedMw[load]!
  }
  const lossesMw = islandLossesMw(grid, structure)
  const acceleratingMw = mechanicalMw + fixedMw - servedMw - lossesMw
  if (!(kineticEnergyMws > 0)) throw new Error(`energised island ${island.id} has no synchronous kinetic energy`)
  let suppliedMw = fixedMw
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
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
  for (let itemPosition = 0; itemPosition < structure.storageIndices.length; itemPosition += 1) {
    const item = structure.storageIndices[itemPosition]!
    const state = grid.arrays.storage[item]!
    state.frequencyHz = frequencyHz
    addAt(injections, tables.storageBus[item]!, state.dispatchMw)
    suppliedMw += state.dispatchMw
  }
  for (let pointPosition = 0; pointPosition < structure.connectionPointIndices.length; pointPosition += 1) {
    const point = structure.connectionPointIndices[pointPosition]!
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
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    addAt(injections, tables.loadBus[load]!, -loads.servedMw[load]!)
    completeLiveGridLoad(loads, load, frequencyHz, nominalHz)
  }
  for (let busPosition = 0; busPosition < structure.busIndices.length; busPosition += 1) {
    const bus = structure.busIndices[busPosition]!
    addAt(injections, bus, -grid.lossLoadByBusMw[bus]!)
  }
  // The island holds at most one synchronous external system (definitions.ts).
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    const system = structure.externalIndices[systemPosition]!
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
  for (let componentPosition = 0; componentPosition < island.componentIndices.length; componentPosition += 1) {
    const componentIndex = island.componentIndices[componentPosition]!
    const count = boundaryBusesInComponent(grid, plan, system, componentIndex, scratch.buses)
    if (count === 0) continue
    let othersMw = 0
    const buses = plan.components[componentIndex]!.busIndices
    for (let busPosition = 0; busPosition < buses.length; busPosition += 1) othersMw += injections[buses[busPosition]!]!
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
 * Branch quantities of one solution in model order, and the losses the branches carry as load at
 * their ends (`lossLoad`); returns their sum. Flow and loading: the AC flows where the island
 * converged (the larger end apparent power is what the rating bounds), else the DC flow, labelled
 * so. Losses: the AC series loss r·|I|² where the island converged, else the quadratic DC estimate
 * r·P²/S_base. Voltages: the AC result where the island converged, unknown (NaN, published as
 * null) where it did not, 0 when de-energised.
 */
const writeBranchSolution = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  flows: Float64Array,
  ac: NonNullable<ReturnType<typeof gridAcState>>,
  lossLoad: Float64Array,
  scratch: GridIslandScratch,
): number => {
  const { network, closedBranches } = plan
  const { branchFrom, branchTo, sBaseMva } = network
  const islandOf = plan.islandIndexOfBus
  const { energised, acConverged } = scratch
  const frequencyOfIsland = scratch.frequencyHz
  const { voltagePu, angleRad, branchFromActiveMw, branchToActiveMw, branchFromReactiveMvar, branchToReactiveMvar } = ac
  const tables = gridTablesFor(grid.definition)
  const { branchResistancePu, branchReactanceSquaredPu, branchFromTap, branchRatingMw } = tables
  const branches = grid.arrays.branches
  const { flowModel, flowMw, toFlowMw, apparentPowerMva, lossesMw, loadingPercent, availability, frequencyHz, voltageFromPu, voltageToPu, reactiveFromMvar, reactiveToMvar } = branches
  let totalLossesMw = 0
  for (let index = 0; index < network.branchCount; index += 1) {
    const from = branchFrom[index]!
    const to = branchTo[index]!
    const island = islandOf[from]!
    const live = closedBranches[index] === 1 && energised[island] === 1
    const acLive = live && acConverged[island] === 1
    const dcFlowMw = live ? flows[index]! : 0
    let branchLossMw = 0
    if (acLive) {
      // r·|I|² with I = (V_from/τ − V_to)/(r + jx), the tap τ at the from end: the active power
      // entering both ends (the shunts carry none), never negative as their rounded sum can be.
      const fromPu = voltagePu[from]! / branchFromTap[index]!
      const toPu = voltagePu[to]!
      const half = Math.sin((angleRad[from]! - angleRad[to]!) / 2)
      const differenceSquared = (fromPu - toPu) ** 2 + 4 * fromPu * toPu * half * half
      const r = branchResistancePu[index]!
      branchLossMw = r * differenceSquared / (r * r + branchReactanceSquaredPu[index]!) * sBaseMva
    } else if (live) {
      branchLossMw = branchResistancePu[index]! * dcFlowMw * dcFlowMw / sBaseMva
    }
    lossLoad[from] = lossLoad[from]! + branchLossMw / 2
    lossLoad[to] = lossLoad[to]! + branchLossMw / 2
    totalLossesMw += branchLossMw
    let apparentMva: number
    if (acLive) {
      const fromMw = branchFromActiveMw[index]!
      const toMw = branchToActiveMw[index]!
      flowModel[index] = flowModelAc
      flowMw[index] = fromMw
      toFlowMw[index] = toMw
      apparentMva = Math.max(Math.hypot(fromMw, branchFromReactiveMvar[index]!), Math.hypot(toMw, branchToReactiveMvar[index]!))
    } else {
      flowModel[index] = live ? flowModelDc : flowModelNone
      flowMw[index] = dcFlowMw
      toFlowMw[index] = 0 - dcFlowMw
      apparentMva = Math.abs(dcFlowMw)
    }
    apparentPowerMva[index] = apparentMva
    lossesMw[index] = branchLossMw
    loadingPercent[index] = apparentMva / (branchRatingMw[index]! * availability[index]!) * 100
    frequencyHz[index] = live ? frequencyOfIsland[island]! : Number.NaN
    voltageFromPu[index] = energised[island] !== 1 ? 0 : acConverged[island] === 1 ? voltagePu[from]! : Number.NaN
    const toIsland = islandOf[to]!
    voltageToPu[index] = energised[toIsland] !== 1 ? 0 : acConverged[toIsland] === 1 ? voltagePu[to]! : Number.NaN
    reactiveFromMvar[index] = acLive ? branchFromReactiveMvar[index]! : Number.NaN
    reactiveToMvar[index] = acLive ? branchToReactiveMvar[index]! : Number.NaN
  }
  return totalLossesMw
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
    const componentIndices = plan.islands[island.planIndex]!.componentIndices
    for (let componentPosition = 0; componentPosition < componentIndices.length; componentPosition += 1) {
      const componentIndex = componentIndices[componentPosition]!
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
    const frequencyHz = island.energized ? island.workspace!.frequencyHz : null
    frequencyOfIsland[island.planIndex] = frequencyHz === null ? Number.NaN : frequencyHz
    solvedIds[island.planIndex] = island.id
  }
  lossesMw += writeBranchSolution(grid, plan, flows, ac, lossLoad, scratch)
  for (const link of grid.arrays.hvdcLinks) lossesMw += link.lossesMw

  const tables = gridTablesFor(grid.definition)
  if (grid.busStates.size === 0) {
    for (const [busId, state] of busStateViews(network.busIds, busArrays)) if (!grid.hvdcTerminals.has(busId)) grid.busStates.set(busId, state)
  }
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const planIndex = islandOf[bus]!
    if (planIndex < 0) {
      busArrays.solvedIsland[bus] = -1
      busArrays.reactiveInjectionMvar[bus] = Number.NaN
      const system = tables.synchronousExternalOfBus[bus]!
      if (system >= 0) {
        // A separated boundary bus: its external system holds it at the equivalent's voltage set-point and its own frequency.
        busArrays.energized[bus] = 1
        busArrays.voltagePu[bus] = externalVoltageSetpointPu
        busArrays.voltageModel[bus] = voltageModelExternal
        busArrays.frequencyHz[bus] = externalSystemFrequencyHz(grid, islands, system)
        continue
      }
      // An HVDC terminal lies in no island and has no bus state (grid.hvdcTerminals): no quantities here.
      busArrays.energized[bus] = 0
      busArrays.voltagePu[bus] = Number.NaN
      busArrays.voltageModel[bus] = voltageModelDeEnergised
      busArrays.frequencyHz[bus] = Number.NaN
      continue
    }
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
    for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
      const load = structure.loadIndices[loadPosition]!
      grid.arrays.loads.voltagePu[load] = busArrays.voltagePu[tables.loadBus[load]!]!
    }
    for (let itemPosition = 0; itemPosition < structure.storageIndices.length; itemPosition += 1) {
      const item = structure.storageIndices[itemPosition]!
      grid.arrays.storage[item]!.voltagePu = publishedNullable(busArrays.voltagePu[tables.storageBus[item]!]!)
    }
  }

  const audit = grid.diagnostics.energyAudit
  const hours = dtSeconds / 3_600
  audit.lastMaximumIslandMismatchMw = maximumMismatchMw
  audit.cumulativeMismatchMwh += mismatchSumMw * hours
  audit.suppliedEnergyMwh += suppliedMw * hours
  audit.servedEnergyMwh += servedMw * hours
  audit.lossEnergyMwh += lossesMw * hours
}
