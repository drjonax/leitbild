import type { GridBusState, GridRuntimeInstance, GridTopologyPlan } from './instance.ts'
import { gridBranchFlowMw } from './network/dc-power-flow.ts'
import { gridBranchIsClosed, solveGridAngles } from './topology.ts'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const busInjections = (grid: GridRuntimeInstance): Map<string, number> => {
  const model = grid.definition.model
  const injections = new Map(model.buses.map(bus => [bus.id, 0]))
  for (const generator of model.generators) injections.set(generator.busId, (injections.get(generator.busId) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  for (const load of model.loads) injections.set(load.busId, (injections.get(load.busId) ?? 0) - grid.loads.get(load.id)!.servedMw)
  for (const item of model.storage) injections.set(item.busId, (injections.get(item.busId) ?? 0) + grid.storage.get(item.id)!.dispatchMw)
  for (const connection of grid.externalConnections.values()) {
    if (connection.connected) injections.set(connection.busId, (injections.get(connection.busId) ?? 0) + connection.systemActivePowerMw)
  }
  return injections
}

/** Applies DC branch flows from bus angles; returns the highest branch loading at each bus. */
const applyBranchFlows = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  angles: ReadonlyMap<string, number>,
  frequencyByIsland: ReadonlyMap<string, number>,
): Map<string, number> => {
  const model = grid.definition.model
  const branchLoadingByBus = new Map<string, number>()
  for (const branch of model.branches) {
    const state = grid.branches.get(branch.id)!
    const flowMw = gridBranchIsClosed(grid, branch) ? gridBranchFlowMw(angles, branch) : 0
    const ratingMw = branch.ratingMw * state.availability
    state.flowMw = flowMw
    state.loadingPercent = Math.abs(flowMw) / Math.max(1, ratingMw) * 100
    state.frequencyHz = frequencyByIsland.get(plan.islandIdByBus.get(branch.fromBusId) ?? '') ?? model.nominalFrequencyHz
    state.lossesMw = Math.abs(flowMw) * branch.resistancePu * 0.006
    branchLoadingByBus.set(branch.fromBusId, Math.max(branchLoadingByBus.get(branch.fromBusId) ?? 0, state.loadingPercent))
    branchLoadingByBus.set(branch.toBusId, Math.max(branchLoadingByBus.get(branch.toBusId) ?? 0, state.loadingPercent))
  }
  return branchLoadingByBus
}

const busStatesFor = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  injections: ReadonlyMap<string, number>,
  angles: ReadonlyMap<string, number>,
  branchLoadingByBus: ReadonlyMap<string, number>,
  frequencyByIsland: ReadonlyMap<string, number>,
): Map<string, GridBusState> => {
  const model = grid.definition.model
  const generationByBus = new Map<string, number>()
  const loadByBus = new Map<string, number>()
  const reactiveByBus = new Map<string, number>()
  for (const generator of model.generators) generationByBus.set(generator.busId, (generationByBus.get(generator.busId) ?? 0) + grid.generators.get(generator.id)!.dispatchMw)
  for (const connection of grid.externalConnections.values()) {
    if (connection.connected) generationByBus.set(connection.busId, (generationByBus.get(connection.busId) ?? 0) + connection.systemActivePowerMw)
  }
  for (const load of model.loads) {
    loadByBus.set(load.busId, (loadByBus.get(load.busId) ?? 0) + grid.loads.get(load.id)!.servedMw)
    const state = grid.loads.get(load.id)!
    const reactive = load.demandMw <= 0 ? 0 : load.reactiveDemandMvar * state.demandMw / load.demandMw
    reactiveByBus.set(load.busId, (reactiveByBus.get(load.busId) ?? 0) + reactive)
  }
  const busStates = new Map<string, GridBusState>()
  for (const bus of model.buses) {
    const servedLoadMw = loadByBus.get(bus.id) ?? 0
    const loadStress = servedLoadMw <= 0 ? 0 : Math.min(0.055, (reactiveByBus.get(bus.id) ?? 0) / Math.max(1, servedLoadMw) * 0.035)
    const flowStress = Math.max(0, (branchLoadingByBus.get(bus.id) ?? 0) - 82) * 0.0015
    const generationSupport = Math.min(0.018, (generationByBus.get(bus.id) ?? 0) / Math.max(1, servedLoadMw + 100) * 0.01)
    const islandId = plan.islandIdByBus.get(bus.id)!
    busStates.set(bus.id, {
      busId: bus.id,
      voltagePu: clamp(1 - loadStress - flowStress + generationSupport, 0.88, 1.06),
      frequencyHz: frequencyByIsland.get(islandId) ?? model.nominalFrequencyHz,
      angleRad: angles.get(bus.id) ?? 0,
      islandId,
      netInjectionMw: injections.get(bus.id) ?? 0,
    })
  }
  return busStates
}

/**
 * Network solution for the current dispatch: bus injections, DC angle solve,
 * branch flows, approximate bus voltages, and voltage propagation to assets.
 */
export const solveGridNetwork = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  frequencyByIsland: ReadonlyMap<string, number>,
): void => {
  const model = grid.definition.model
  const injections = busInjections(grid)
  const angles = solveGridAngles(plan, injections)
  const branchLoadingByBus = applyBranchFlows(grid, plan, angles, frequencyByIsland)
  const busStates = busStatesFor(grid, plan, injections, angles, branchLoadingByBus, frequencyByIsland)
  grid.busStates = busStates
  for (const branch of model.branches) {
    const state = grid.branches.get(branch.id)!
    state.voltageFromPu = busStates.get(branch.fromBusId)?.voltagePu ?? 1
    state.voltageToPu = busStates.get(branch.toBusId)?.voltagePu ?? 1
  }
  for (const load of model.loads) grid.loads.get(load.id)!.voltagePu = busStates.get(load.busId)?.voltagePu ?? 1
  for (const item of model.storage) grid.storage.get(item.id)!.voltagePu = busStates.get(item.busId)?.voltagePu ?? 1
}
