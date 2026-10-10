import type { IsoTimestamp } from '../../../core/model/index.ts'
import { gridGeneratorIsOnline } from './dynamics.ts'
import type { GridRuntimeInstance, GridTopologyPlan } from './instance.ts'

/** System-level projection: totals, weighted system frequency, alarm count, and status. */
export const projectGridSystem = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  frequencyByIsland: ReadonlyMap<string, number>,
  at: IsoTimestamp,
): void => {
  const model = grid.definition.model
  const busStates = grid.busStates
  const externalSupplyMw = [...grid.externalConnections.values()]
    .reduce((sum, connection) => sum + (connection.connected ? Math.max(0, connection.systemActivePowerMw) : 0), 0)
  const externalDemandMw = [...grid.externalConnections.values()]
    .reduce((sum, connection) => sum + (connection.connected ? Math.max(0, -connection.systemActivePowerMw) : 0), 0)
  const totalGenerationMw = [...grid.generators.values()].reduce((sum, item) => sum + item.dispatchMw, 0) + externalSupplyMw
  const totalLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.demandMw, 0) + externalDemandMw
  const servedLoadMw = [...grid.loads.values()].reduce((sum, item) => sum + item.servedMw, 0) + externalDemandMw
  const unservedLoadMw = totalLoadMw - servedLoadMw
  const reserveMarginMw = [...grid.generators.values()].reduce((sum, item) => sum + (gridGeneratorIsOnline(item.state) ? Math.min(item.reserveMw, Math.max(0, item.availableMw - item.dispatchMw)) : 0), 0)
  const highestBranchLoadingPercent = [...grid.branches.values()].reduce((highest, item) => Math.max(highest, item.loadingPercent), 0)
  const lowestVoltagePu = [...busStates.values()].reduce((lowest, item) => Math.min(lowest, item.voltagePu), 1)
  const islandFrequencyWeights = plan.islands.map(island => {
    const internalSupplyMw = island.generators.reduce((sum, generator) => sum + grid.generators.get(generator.id)!.dispatchMw, 0)
      + island.storage.reduce((sum, item) => sum + Math.max(0, grid.storage.get(item.id)!.dispatchMw), 0)
    const internalDemandMw = island.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.servedMw, 0)
      + island.storage.reduce((sum, item) => sum + Math.max(0, -grid.storage.get(item.id)!.dispatchMw), 0)
    const external = [...grid.externalConnections.values()]
      .filter(connection => connection.connected && island.busSet.has(connection.busId))
      .reduce((totals, connection) => ({
        supplyMw: totals.supplyMw + Math.max(0, connection.systemActivePowerMw),
        demandMw: totals.demandMw + Math.max(0, -connection.systemActivePowerMw),
      }), { supplyMw: 0, demandMw: 0 })
    return {
      frequencyHz: frequencyByIsland.get(island.id) ?? model.nominalFrequencyHz,
      weightMw: Math.max(internalSupplyMw + external.supplyMw, internalDemandMw + external.demandMw),
    }
  })
  const totalFrequencyWeight = islandFrequencyWeights.reduce((sum, island) => sum + island.weightMw, 0)
  const frequencyHz = totalFrequencyWeight <= 0
    ? model.nominalFrequencyHz
    : islandFrequencyWeights.reduce((sum, island) => sum + island.frequencyHz * island.weightMw, 0) / totalFrequencyWeight
  const activeAlarmCount = [
    Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.15,
    highestBranchLoadingPercent >= 85,
    lowestVoltagePu < 0.95,
    unservedLoadMw > 0.1,
  ].filter(Boolean).length
  const activeIslandCount = islandFrequencyWeights.filter(island => island.weightMw > 0).length
  const statusTone = activeAlarmCount > 0 ? 'error' as const : Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.05 ? 'working' as const : 'ready' as const
  grid.projection = {
    statusTone,
    statusLabel: activeAlarmCount > 0 ? `${activeAlarmCount} active alarm${activeAlarmCount === 1 ? '' : 's'}` : 'Normal',
    summary: `${frequencyHz.toFixed(2)} Hz · ${Math.round(servedLoadMw).toLocaleString()} MW served · ${activeAlarmCount} alarms`,
    nominalFrequencyHz: model.nominalFrequencyHz,
    frequencyHz,
    totalGenerationMw,
    totalLoadMw,
    servedLoadMw,
    unservedLoadMw,
    reserveMarginMw,
    highestBranchLoadingPercent,
    lowestVoltagePu,
    activeIslandCount: Math.max(1, activeIslandCount),
    activeAlarmCount,
    tick: grid.tick,
    updatedAt: at,
  }
}
