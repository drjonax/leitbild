import { gridAcState, solveGridAcLoadFlow } from './ac-load-flow.ts'
import { noteGridAcSolution } from './alarms.ts'
import { generatorKineticEnergyMws } from './generator-dynamics.ts'
import { hvdcTerminalInjectionsMw } from './hvdc.ts'
import type { GridBranchDefinition, GridExternalSystemDefinition } from '../grid-model.ts'
import type { GridBusState, GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland, GridTopologyPlan } from './instance.ts'
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
import { solvePlanInto } from './topology.ts'

/** The largest island injection sum the balance tolerates (MW); the balance closes by construction. */
export const islandBalanceToleranceMw = 1e-6

const flowScratch = new WeakMap<GridRuntimeInstance, Float64Array>()

const addAt = (values: Float64Array, index: number, amount: number): void => {
  values[index] = values[index]! + amount
}

const deEnergiseIsland = (grid: GridRuntimeInstance, island: GridTopologyIsland): void => {
  for (const definition of island.generators) {
    const state = grid.generators.get(definition.id)!
    state.dispatchMw = 0
    state.scheduledMw = 0
    state.fcrMw = 0
    state.afrrMw = 0
    state.mfrrMw = 0
    state.frequencyHz = null
  }
  for (const definition of island.loads) completeDeadGridLoad(grid.loads.get(definition.id)!)
  for (const definition of island.storage) {
    const state = grid.storage.get(definition.id)!
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
  const solve = new Uint8Array(plan.islands.length)
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
  const acConvergedPlanIsland = new Uint8Array(plan.islands.length)
  for (const island of islands.islands) {
    const outcome = acOutcomes.get(island.planIndex)
    if (outcome === undefined) continue
    grid.acOutcomeByIsland.set(island.id, outcome)
    if (outcome.converged) acConvergedPlanIsland[island.planIndex] = 1
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
  const energisedPlanIsland = new Uint8Array(plan.islands.length)
  for (const island of islands.islands) energisedPlanIsland[island.planIndex] = island.energized ? 1 : 0
  const frequencyOfPlanIsland: Array<number | null> = new Array(plan.islands.length).fill(null)
  const idOfPlanIsland: string[] = new Array(plan.islands.length)
  for (const island of islands.islands) {
    frequencyOfPlanIsland[island.planIndex] = island.energized ? island.frequency!.frequencyHz : null
    idOfPlanIsland[island.planIndex] = island.id
  }
  /** A bus voltage: the AC result when its island converged, unknown (null) when it did not, 0 when de-energised. */
  const voltageAt = (bus: number): number | null => {
    const planIndex = islandOf[bus]!
    if (energisedPlanIsland[planIndex] !== 1) return 0
    return acConvergedPlanIsland[planIndex] === 1 ? ac.voltagePu[bus]! : null
  }
  // Branch states are kept in model order (topology.ts checks it), so they are walked alongside the model.
  let index = 0
  for (const state of grid.branches.values()) {
    const branch = model.branches[index]!
    const from = network.branchFrom[index]!
    const to = network.branchTo[index]!
    const live = plan.closedBranches[index] === 1 && energisedPlanIsland[islandOf[from]!] === 1
    const acLive = live && acConvergedPlanIsland[islandOf[from]!] === 1
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
    if (acLive) {
      const fromMw = ac.branchFromActiveMw[index]!
      const toMw = ac.branchToActiveMw[index]!
      state.flowModel = 'ac'
      state.flowMw = fromMw
      state.apparentPowerMva = Math.max(Math.hypot(fromMw, ac.branchFromReactiveMvar[index]!), Math.hypot(toMw, ac.branchToReactiveMvar[index]!))
    } else {
      state.flowModel = live ? 'dc' : null
      state.flowMw = dcFlowMw
      state.apparentPowerMva = Math.abs(dcFlowMw)
    }
    state.lossesMw = branchLossMw
    state.loadingPercent = state.apparentPowerMva / (branch.ratingMw * state.availability) * 100
    state.frequencyHz = live ? frequencyOfPlanIsland[islandOf[from]!]! : null
    state.voltageFromPu = voltageAt(from)
    state.voltageToPu = voltageAt(to)
    state.reactiveFromMvar = acLive ? ac.branchFromReactiveMvar[index]! : null
    state.reactiveToMvar = acLive ? ac.branchToReactiveMvar[index]! : null
    index += 1
  }
  for (const link of grid.definition.index.hvdcLinks) lossesMw += grid.hvdcLinks.get(link.id)!.lossesMw

  const busStates = grid.busStates
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const planIndex = islandOf[bus]!
    const energized = energisedPlanIsland[planIndex] === 1
    const converged = acConvergedPlanIsland[planIndex] === 1
    const busId = network.busIds[bus]!
    let state = busStates.get(busId)
    if (!state) {
      state = { busId, islandId: '', energized: false, voltagePu: 0, voltageModel: 'de-energised', reactiveInjectionMvar: 0, frequencyHz: null, angleRad: 0, netInjectionMw: 0 } satisfies GridBusState
      busStates.set(busId, state)
    }
    state.islandId = idOfPlanIsland[planIndex]!
    state.energized = energized
    state.voltagePu = voltageAt(bus)
    state.voltageModel = !energized ? 'de-energised' : converged ? 'ac-fdlf' : 'not-converged'
    state.reactiveInjectionMvar = !energized ? 0 : converged ? ac.reactiveInjectionMvar[bus]! : null
    state.frequencyHz = energized ? frequencyOfPlanIsland[planIndex]! : null
    state.angleRad = plan.anglesRad[bus]!
    state.netInjectionMw = injections[bus]!
  }
  for (const island of islands.islands) {
    if (!island.energized) continue
    const structure = plan.islands[island.planIndex]!
    const members = islandMembers(grid, structure)
    const states = islandAssetStates(grid, structure)
    states.loads.forEach((state, position) => { state.voltagePu = voltageAt(members.loadBuses[position]!) })
    states.storage.forEach((state, position) => { state.voltagePu = voltageAt(members.storageBuses[position]!) })
  }

  const audit = grid.diagnostics.energyAudit
  const hours = dtSeconds / 3_600
  audit.lastMaximumIslandMismatchMw = maximumMismatchMw
  audit.cumulativeMismatchMwh += mismatchSumMw * hours
  audit.suppliedEnergyMwh += suppliedMw * hours
  audit.servedEnergyMwh += servedMw * hours
  audit.lossEnergyMwh += lossesMw * hours
}
