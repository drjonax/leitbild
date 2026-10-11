import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridIslandProjection } from '../model.ts'
import { gridAlarmCounts } from './alarms.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance } from './instance.ts'
import { externalFrequencyEquivalent, gridGeneratorIsSynchronised, islandFixedInjectionMw, islandMembers } from './island-input.ts'

// Status turns "working" when the headline island is 50 mHz off nominal: half the standard range.
const workingDeviationHz = 0.05

// Projection values are rounded to metering resolution (0.1 MW, 0.1 mHz) to keep the shared object compact.
const mw = (value: number): number => Math.round(value * 10) / 10
const hz = (value: number): number => Math.round(value * 10_000) / 10_000

const islandProjection = (grid: GridRuntimeInstance, islands: GridIslandPlan, island: GridIsland, alarmCount: number): GridIslandProjection | null => {
  const structure = islands.plan.islands[island.planIndex]!
  const members = islandMembers(grid, structure)
  if (structure.generators.length + structure.loads.length + structure.storage.length + members.externals.length + members.connectionPointIds.length === 0) return null
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const generationMw = structure.generators.reduce((sum, definition) => sum + grid.generators.get(definition.id)!.dispatchMw, 0)
    + structure.storage.reduce((sum, definition) => sum + grid.storage.get(definition.id)!.dispatchMw, 0)
  const importMw = island.energized
    ? members.externals.reduce((sum, system) => sum + grid.externalSystems.get(system.id)!.importMw, 0) + islandFixedInjectionMw(grid, structure)
    : 0
  const loadMw = structure.loads.reduce((sum, definition) => sum + grid.loads.get(definition.id)!.demandMw, 0)
  const servedLoadMw = structure.loads.reduce((sum, definition) => sum + grid.loads.get(definition.id)!.servedMw, 0)
  let lossesMw = 0
  for (const bus of members.busIndices) lossesMw += grid.lossLoadByBusMw[bus]!
  const reserves = { fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrUpMw: 0, afrrDownMw: 0, mfrrUpMw: 0, mfrrDownMw: 0 }
  if (island.energized) {
    for (const definition of structure.generators) {
      const state = grid.generators.get(definition.id)!
      if (!gridGeneratorIsSynchronised(state)) continue
      for (const key of Object.keys(reserves) as Array<keyof typeof reserves>) reserves[key] += state.reserves[key]
    }
    for (const system of members.externals) {
      const external = externalFrequencyEquivalent(grid, system).reserves
      reserves.fcrNMw += external.fcrNMw
      reserves.fcrDUpMw += external.fcrDUpMw
      reserves.fcrDDownMw += external.fcrDDownMw
      reserves.afrrUpMw += external.afrrUpMw
      reserves.afrrDownMw += external.afrrDownMw
    }
  }
  const frequencyHz = island.energized ? island.frequency!.frequencyHz! : null
  return {
    id: island.id,
    energized: island.energized,
    busCount: structure.buses.length,
    frequencyHz: frequencyHz === null ? null : hz(frequencyHz),
    rocofHzPerSecond: island.energized && island.rocofHzPerSecond !== null ? hz(island.rocofHzPerSecond) : null,
    generationMw: mw(generationMw),
    importMw: mw(importMw),
    loadMw: mw(loadMw),
    servedLoadMw: mw(servedLoadMw),
    lossesMw: mw(lossesMw),
    reserves: {
      fcrNMw: mw(reserves.fcrNMw), fcrDUpMw: mw(reserves.fcrDUpMw), fcrDDownMw: mw(reserves.fcrDDownMw),
      afrrUpMw: mw(reserves.afrrUpMw), afrrDownMw: mw(reserves.afrrDownMw), mfrrUpMw: mw(reserves.mfrrUpMw), mfrrDownMw: mw(reserves.mfrrDownMw),
    },
    alarmCount,
  }
}

/**
 * System projection: per-island state, the headline frequency of the largest-load energised island,
 * and totals. Alarm counts are the active, unshelved alarm records (island alarms per island).
 */
export const projectGridSystem = (grid: GridRuntimeInstance, islands: GridIslandPlan, at: IsoTimestamp): void => {
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const alarms = gridAlarmCounts(grid)
  const projected = islands.islands.flatMap(island => {
    const view = islandProjection(grid, islands, island, alarms.activeByIsland.get(island.id) ?? 0)
    return view === null ? [] : [view]
  })
  const energised = projected.filter(island => island.energized && island.frequencyHz !== null)
  const headline = [...energised].sort((a, b) => b.loadMw - a.loadMw || a.id.localeCompare(b.id))[0] ?? null
  const frequencies = energised.map(island => island.frequencyHz!)
  let plantSupplyMw = 0
  let plantDemandMw = 0
  for (const connection of grid.externalConnections.values()) {
    if (!connection.connected || grid.busStates.get(connection.busId)?.energized !== true) continue
    plantSupplyMw += Math.max(0, connection.systemActivePowerMw)
    plantDemandMw += Math.max(0, -connection.systemActivePowerMw)
  }
  let generationMw = plantSupplyMw
  let reserveMarginMw = 0
  for (const state of grid.generators.values()) {
    generationMw += Math.max(0, state.dispatchMw)
    if (gridGeneratorIsSynchronised(state)) reserveMarginMw += Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw))
  }
  for (const state of grid.storage.values()) generationMw += Math.max(0, state.dispatchMw)
  for (const state of grid.externalSystems.values()) generationMw += Math.max(0, state.importMw)
  let demandMw = 0
  let servedMw = 0
  let unservedMw = 0
  for (const state of grid.loads.values()) {
    demandMw += state.demandMw
    servedMw += state.servedMw
    unservedMw += state.unservedMw
  }
  let lossesMw = 0
  for (const state of grid.branches.values()) lossesMw += state.lossesMw
  for (const state of grid.hvdcLinks.values()) lossesMw += state.lossesMw
  const highestBranchLoadingPercent = [...grid.branches.values()].reduce((highest, item) => Math.max(highest, item.loadingPercent), 0)
  const activeAlarmCount = alarms.active
  const statusTone = activeAlarmCount > 0
    ? 'error' as const
    : headline === null || Math.abs(headline.frequencyHz! - nominalHz) >= workingDeviationHz ? 'working' as const : 'ready' as const
  const audit = grid.diagnostics.energyAudit
  grid.projection = {
    statusTone,
    statusLabel: activeAlarmCount > 0 ? `${activeAlarmCount} active alarm${activeAlarmCount === 1 ? '' : 's'}` : headline === null ? 'No island energised' : 'Normal',
    summary: headline === null
      ? `No island energised · ${Math.round(demandMw).toLocaleString()} MW unserved`
      : `${headline.frequencyHz!.toFixed(2)} Hz (largest island) · ${Math.round(servedMw + plantDemandMw).toLocaleString()} MW served · ${activeAlarmCount} alarms`,
    nominalFrequencyHz: nominalHz,
    frequencyHz: headline?.frequencyHz ?? null,
    frequencyBasis: 'largest-load-energized-island',
    frequencyIslandId: headline?.id ?? null,
    frequencyMinHz: frequencies.length === 0 ? null : Math.min(...frequencies),
    frequencyMaxHz: frequencies.length === 0 ? null : Math.max(...frequencies),
    voltageModel: 'dc-nominal',
    totalGenerationMw: generationMw,
    totalLoadMw: demandMw + plantDemandMw,
    servedLoadMw: servedMw + plantDemandMw,
    unservedLoadMw: unservedMw,
    lossesMw,
    reserveMarginMw,
    highestBranchLoadingPercent,
    activeIslandCount: islands.islands.filter(island => island.energized).length,
    islandCount: islands.islands.length,
    activeAlarmCount,
    islands: projected,
    energyAudit: { maximumIslandMismatchMw: audit.lastMaximumIslandMismatchMw, cumulativeMismatchMwh: audit.cumulativeMismatchMwh },
    tick: grid.tick,
    updatedAt: at,
  }
}
