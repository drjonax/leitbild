import { generatorKineticEnergyMws } from './generator-dynamics.ts'
import { hvdcTerminalInjectionsMw } from './hvdc.ts'
import type { GridBusState, GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import {
  externalKineticEnergyMws,
  gridGeneratorIsSynchronised,
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
  const frequencyHz = island.frequency!.frequencyHz!
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const busIndex = (busId: string): number => network.busIndexById.get(busId)!
  let mechanicalMw = 0
  let kineticEnergyMws = 0
  for (const definition of structure.generators) {
    const state = grid.generators.get(definition.id)!
    if (!gridGeneratorIsSynchronised(state)) continue
    mechanicalMw += state.scheduledMw + state.fcrMw + state.afrrMw + state.mfrrMw
    kineticEnergyMws += generatorKineticEnergyMws(definition)
  }
  for (const definition of structure.storage) mechanicalMw += grid.storage.get(definition.id)!.dispatchMw
  const externals = members.externals
  for (const system of externals) {
    mechanicalMw += grid.externalSystems.get(system.id)!.mechanicalMw
    kineticEnergyMws += externalKineticEnergyMws(system)
  }
  const fixedMw = islandFixedInjectionMw(grid, structure)
  const servedMw = structure.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.servedMw, 0)
  const lossesMw = islandLossesMw(grid, structure)
  const acceleratingMw = mechanicalMw + fixedMw - servedMw - lossesMw
  if (!(kineticEnergyMws > 0)) throw new Error(`energised island ${island.id} has no synchronous kinetic energy`)
  let suppliedMw = fixedMw
  structure.generators.forEach((definition, index) => {
    const state = grid.generators.get(definition.id)!
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
  structure.storage.forEach((definition, index) => {
    const state = grid.storage.get(definition.id)!
    state.frequencyHz = frequencyHz
    state.voltagePu = 1
    addAt(injections, members.storageBuses[index]!, state.dispatchMw)
    suppliedMw += state.dispatchMw
  })
  for (const system of externals) {
    const state = grid.externalSystems.get(system.id)!
    state.importMw = state.mechanicalMw - externalKineticEnergyMws(system) / kineticEnergyMws * acceleratingMw
    state.islandId = island.id
    state.energized = true
    addAt(injections, busIndex(system.boundaryBusIds[0]!), state.importMw)
    suppliedMw += state.importMw
  }
  for (const pointId of members.connectionPointIds) {
    const connection = grid.externalConnections.get(pointId)
    if (connection?.connected === true) addAt(injections, busIndex(connection.busId), connection.systemActivePowerMw)
  }
  for (const link of grid.definition.index.hvdcLinks) {
    const terminals = hvdcTerminalInjectionsMw(grid, link)
    if (structure.busSet.has(link.fromBusId)) addAt(injections, busIndex(link.fromBusId), terminals.fromMw)
    if (structure.busSet.has(link.toBusId)) addAt(injections, busIndex(link.toBusId), terminals.toMw)
  }
  structure.loads.forEach((definition, index) => {
    const state = grid.loads.get(definition.id)!
    addAt(injections, members.loadBuses[index]!, -state.servedMw)
    completeLiveGridLoad(state, frequencyHz, nominalHz)
  })
  for (const bus of members.busIndices) addAt(injections, bus, -grid.lossLoadByBusMw[bus]!)
  return { suppliedMw, servedMw, lossesMw }
}

/**
 * Network solution of one tick: electrical injections with inertial sharing, one DC solve per
 * energised island, the balance check, quadratic DC losses that the islands carry as load from the
 * next advance on, and bus and branch states. De-energised islands carry no power: zero voltage
 * and no frequency.
 */
export const solveGridNetwork = (grid: GridRuntimeInstance, islands: GridIslandPlan, dtSeconds: number): void => {
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
    const mismatchMw = Math.abs(plan.referenceMismatchMw[island.planIndex]!)
    if (!(mismatchMw < islandBalanceToleranceMw)) {
      throw new Error(`Grid ${grid.definition.gridId} island ${island.id} injections sum to ${plan.referenceMismatchMw[island.planIndex]} MW; the island balance must close within ${islandBalanceToleranceMw} MW`)
    }
    maximumMismatchMw = Math.max(maximumMismatchMw, mismatchMw)
    mismatchSumMw += mismatchMw
  }

  const flows = flowScratch.get(grid) ?? new Float64Array(network.branchCount)
  flowScratch.set(grid, flows)
  gridBranchFlowsMwInto(network, plan.closedBranches, plan.anglesRad, flows)
  const lossLoad = grid.lossLoadByBusMw
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
  model.branches.forEach((branch, index) => {
    const state = grid.branches.get(branch.id)!
    const from = network.branchFrom[index]!
    const live = plan.closedBranches[index] === 1 && energisedPlanIsland[islandOf[from]!] === 1
    const flowMw = live ? flows[index]! : 0
    // Quadratic DC loss r·P²/S_base, split equally between the branch ends as load for the next tick.
    const branchLossMw = live ? branch.resistancePu * flowMw * flowMw / network.sBaseMva : 0
    addAt(lossLoad, from, branchLossMw / 2)
    addAt(lossLoad, network.branchTo[index]!, branchLossMw / 2)
    lossesMw += branchLossMw
    const toLive = energisedPlanIsland[islandOf[network.branchTo[index]!]!] === 1
    state.flowMw = flowMw
    state.lossesMw = branchLossMw
    state.loadingPercent = Math.abs(flowMw) / (branch.ratingMw * state.availability) * 100
    state.frequencyHz = live ? frequencyOfPlanIsland[islandOf[from]!]! : null
    state.voltageFromPu = energisedPlanIsland[islandOf[from]!] === 1 ? 1 : 0
    state.voltageToPu = toLive ? 1 : 0
  })
  for (const link of grid.definition.index.hvdcLinks) lossesMw += grid.hvdcLinks.get(link.id)!.lossesMw

  const busStates = grid.busStates
  for (let bus = 0; bus < network.busCount; bus += 1) {
    const planIndex = islandOf[bus]!
    const energized = energisedPlanIsland[planIndex] === 1
    const busId = network.busIds[bus]!
    let state = busStates.get(busId)
    if (!state) {
      state = { busId, islandId: '', energized: false, voltagePu: 0, voltageModel: 'dc-nominal', frequencyHz: null, angleRad: 0, netInjectionMw: 0 } satisfies GridBusState
      busStates.set(busId, state)
    }
    state.islandId = idOfPlanIsland[planIndex]!
    state.energized = energized
    state.voltagePu = energized ? 1 : 0
    state.frequencyHz = energized ? frequencyOfPlanIsland[planIndex]! : null
    state.angleRad = plan.anglesRad[bus]!
    state.netInjectionMw = injections[bus]!
  }

  const audit = grid.diagnostics.energyAudit
  const hours = dtSeconds / 3_600
  audit.lastMaximumIslandMismatchMw = maximumMismatchMw
  audit.cumulativeMismatchMwh += mismatchSumMw * hours
  audit.suppliedEnergyMwh += suppliedMw * hours
  audit.servedEnergyMwh += servedMw * hours
  audit.lossEnergyMwh += lossesMw * hours
}
