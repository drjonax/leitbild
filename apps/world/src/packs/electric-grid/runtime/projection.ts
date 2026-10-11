import type { IsoTimestamp } from '../../../core/model/index.ts'
import type { GridIslandProjection } from '../model.ts'
import { gridAlarmCounts } from './alarms.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance } from './instance.ts'
import { externalFrequencyEquivalent, gridGeneratorIsSynchronised, islandAssetStates, islandFixedInjectionMw, islandMembers } from './island-input.ts'
import { publishedNullable } from './state/arrays.ts'

// Status turns "working" when the headline island is 50 mHz off nominal: half the standard range.
const workingDeviationHz = 0.05

// Projection values are rounded to metering resolution (0.1 MW, 0.1 mHz) to keep the shared object compact.
const mw = (value: number): number => Math.round(value * 10) / 10
const hz = (value: number): number => Math.round(value * 10_000) / 10_000
const pu = (value: number): number => Math.round(value * 10_000) / 10_000

/** The island's AC result: converged with its bus voltage range and AC flows, not converged (DC flows), or de-energised. */
const islandVoltage = (grid: GridRuntimeInstance, island: GridIsland, buses: Int32Array): Pick<GridIslandProjection, 'voltageModel' | 'voltageMinPu' | 'voltageMaxPu' | 'flowModel'> => {
  if (!island.energized) return { voltageModel: 'de-energised', voltageMinPu: null, voltageMaxPu: null, flowModel: null }
  const outcome = grid.acOutcomeByIsland.get(island.id)
  if (outcome === undefined) throw new Error(`Grid ${grid.definition.gridId} island ${island.id} is energised but has no AC load-flow outcome`)
  if (!outcome.converged) return { voltageModel: 'not-converged', voltageMinPu: null, voltageMaxPu: null, flowModel: 'dc' }
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  const voltages = grid.arrays.buses.voltagePu
  for (const bus of buses) {
    const voltage = publishedNullable(voltages[bus]!)!
    if (voltage < minimum) minimum = voltage
    if (voltage > maximum) maximum = voltage
  }
  return { voltageModel: 'ac-fdlf', voltageMinPu: pu(minimum), voltageMaxPu: pu(maximum), flowModel: 'ac' }
}

const islandProjection = (grid: GridRuntimeInstance, islands: GridIslandPlan, island: GridIsland, alarmCount: number): GridIslandProjection | null => {
  const structure = islands.plan.islands[island.planIndex]!
  const members = islandMembers(grid, structure)
  if (structure.generatorIndices.length + structure.loadIndices.length + structure.storageIndices.length + members.externals.length + members.connectionPointIds.length === 0) return null
  const nominalHz = grid.definition.automation.swing.nominalFrequencyHz
  const states = islandAssetStates(grid, structure)
  const generationMw = states.generators.reduce((sum, state) => sum + state.dispatchMw, 0)
    + states.storage.reduce((sum, state) => sum + state.dispatchMw, 0)
  const importMw = island.energized
    ? members.externals.reduce((sum, system) => sum + grid.externalSystems.get(system.id)!.importMw, 0) + islandFixedInjectionMw(grid, structure)
    : 0
  const loadMw = states.loads.reduce((sum, state) => sum + state.demandMw, 0)
  const servedLoadMw = states.loads.reduce((sum, state) => sum + state.servedMw, 0)
  let lossesMw = 0
  for (const bus of members.busIndices) lossesMw += grid.lossLoadByBusMw[bus]!
  const reserves = { fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrUpMw: 0, afrrDownMw: 0, mfrrUpMw: 0, mfrrDownMw: 0 }
  if (island.energized) {
    for (const state of states.generators) {
      if (!gridGeneratorIsSynchronised(state)) continue
      const allocated = state.reserves
      reserves.fcrNMw += allocated.fcrNMw
      reserves.fcrDUpMw += allocated.fcrDUpMw
      reserves.fcrDDownMw += allocated.fcrDDownMw
      reserves.afrrUpMw += allocated.afrrUpMw
      reserves.afrrDownMw += allocated.afrrDownMw
      reserves.mfrrUpMw += allocated.mfrrUpMw
      reserves.mfrrDownMw += allocated.mfrrDownMw
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
    busCount: structure.busIndices.length,
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
    ...islandVoltage(grid, island, structure.busIndices),
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
  const converged = projected.filter(island => island.voltageModel === 'ac-fdlf')
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
  const branchArrays = grid.arrays.branches
  for (let index = 0; index < branchArrays.lossesMw.length; index += 1) lossesMw += branchArrays.lossesMw[index]!
  for (const state of grid.hvdcLinks.values()) lossesMw += state.lossesMw
  let highestBranchLoadingPercent = 0
  for (let index = 0; index < branchArrays.loadingPercent.length; index += 1) highestBranchLoadingPercent = Math.max(highestBranchLoadingPercent, branchArrays.loadingPercent[index]!)
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
    voltageModel: 'ac-fdlf',
    voltageMinPu: converged.length === 0 ? null : Math.min(...converged.map(island => island.voltageMinPu!)),
    voltageMaxPu: converged.length === 0 ? null : Math.max(...converged.map(island => island.voltageMaxPu!)),
    notConvergedIslandCount: projected.filter(island => island.voltageModel === 'not-converged').length,
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
