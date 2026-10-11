import type { GridAutomation, ReserveRequirement } from '../schemas/grid-automation.ts'
import type { GridAlarmSettings, GridAlarmTiming } from '../schemas/grid-protection-automation.ts'
import { gridAlarmId, type GridAlarmObservation, type GridAlarmState } from './alarms.ts'
import { reserveRequirementFor } from './frequency/governors.ts'
import { operatingPointImportMw } from './boundary-separation.ts'
import { hvdcTripReason } from './hvdc.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalReserveVolumes } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { branchClosed, branchTripped, flowModelAc, generatorOnline, generatorTripped, type GridGeneratorArrays } from './state/arrays.ts'
import { gridTablesFor } from './state/tables.ts'

const mw = (value: number): string => `${value.toFixed(1)} MW`

type Emit = (observation: GridAlarmObservation) => void

const islandObservation = (island: GridIsland, condition: string, timing: GridAlarmTiming, fields: Pick<GridAlarmObservation, 'raising' | 'title' | 'message' | 'value' | 'limit' | 'unit'>): GridAlarmObservation => ({
  id: gridAlarmId('island', island.id, condition),
  scope: 'island',
  assetId: island.id,
  condition,
  timing,
  islandId: island.id,
  ...fields,
})

const frequencyObservations = (settings: GridAlarmSettings, nominalHz: number, island: GridIsland, emit: Emit): void => {
  const frequencyHz = island.workspace!.frequencyHz!
  const deviationHz = frequencyHz - nominalHz
  const side = deviationHz < 0 ? 'under' : 'over'
  for (const band of settings.islandFrequency) {
    if (Math.abs(deviationHz) < band.clearDeviationHz) continue
    const limitHz = side === 'under' ? nominalHz - band.deviationHz : nominalHz + band.deviationHz
    emit(islandObservation(island, `${side}-frequency-${band.id}`, band, {
      raising: Math.abs(deviationHz) > band.deviationHz,
      title: `${side === 'under' ? 'Under' : 'Over'}-frequency (${band.id})`,
      message: `Island ${island.id} at ${frequencyHz.toFixed(3)} Hz, ${side === 'under' ? 'below' : 'above'} ${limitHz.toFixed(2)} Hz`,
      value: frequencyHz,
      limit: limitHz,
      unit: 'Hz',
    }))
  }
}

/** A reserve product's alarm: its condition name, requirement, units' allocation and external volume (externalReserveVolumes position, −1: none). */
interface ReserveProductAlarm {
  readonly product: string
  readonly requirement: ReserveRequirement
  readonly allocated: (generators: GridGeneratorArrays) => Float64Array
  readonly externalVolume: number
}

const productAlarms = new WeakMap<GridAutomation, ReadonlyArray<ReserveProductAlarm>>()

/** Reserve products of the Automation, computed once per Automation. */
const reserveProducts = (automation: GridAutomation): ReadonlyArray<ReserveProductAlarm> => {
  const cached = productAlarms.get(automation)
  if (cached) return cached
  const products: ReserveProductAlarm[] = [
    { product: 'fcr-n', requirement: automation.fcrN.requirement, allocated: generators => generators.fcrNReserveMw, externalVolume: 0 },
    { product: 'fcr-d-up', requirement: automation.fcrD.up.requirement, allocated: generators => generators.fcrDUpReserveMw, externalVolume: 1 },
    { product: 'fcr-d-down', requirement: automation.fcrD.down.requirement, allocated: generators => generators.fcrDDownReserveMw, externalVolume: 2 },
    ...(automation.afrr.enabled ? [
      { product: 'afrr-up', requirement: automation.afrr.requirement.up, allocated: (generators: GridGeneratorArrays) => generators.afrrUpReserveMw, externalVolume: 3 },
      { product: 'afrr-down', requirement: automation.afrr.requirement.down, allocated: (generators: GridGeneratorArrays) => generators.afrrDownReserveMw, externalVolume: 4 },
    ] : []),
    ...(automation.mfrr.enabled ? [
      { product: 'mfrr-up', requirement: automation.mfrr.requirement.up, allocated: (generators: GridGeneratorArrays) => generators.mfrrUpReserveMw, externalVolume: -1 },
      { product: 'mfrr-down', requirement: automation.mfrr.requirement.down, allocated: (generators: GridGeneratorArrays) => generators.mfrrDownReserveMw, externalVolume: -1 },
    ] : []),
  ]
  productAlarms.set(automation, products)
  return products
}

/**
 * Requirement of each product for the island not covered by its online units' allocations and its
 * external systems, dimensioned per synchronous area as island-reserves.ts allocates them.
 */
const reserveObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, island: GridIsland, structure: GridTopologyIsland, emit: Emit): void => {
  const generators = grid.arrays.generators
  const externalSystems = grid.definition.index.externalSystems
  let loadMw = 0
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    loadMw += connectedGridLoadMw(grid.arrays.loads, load)
  }
  let externalLoadMw = 0
  for (let systemPosition = 0; systemPosition < structure.externalIndices.length; systemPosition += 1) {
    const system = structure.externalIndices[systemPosition]!
    externalLoadMw += externalReserveVolumes(grid, externalSystems[system]!)[5]!
  }
  const areaLoadMw = loadMw + externalLoadMw
  let largestUnitMw = 0
  for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
    const generator = structure.generatorIndices[generatorPosition]!
    if (generators.lifecycle[generator] === generatorOnline) largestUnitMw = Math.max(largestUnitMw, generators.targetMw[generator]!)
  }
  const alarm = settings.reserveDeficit
  for (const { product, requirement, allocated, externalVolume } of reserveProducts(grid.definition.automation)) {
    // A detached island has no share of a fixed area volume to fall short of.
    if (requirement.basis === 'fixed' && structure.externalIndices.length === 0) continue
    const requiredMw = reserveRequirementFor(requirement, areaLoadMw, largestUnitMw)
    let externalMw = 0
    for (let systemPosition = 0; externalVolume >= 0 && systemPosition < structure.externalIndices.length; systemPosition += 1) {
      externalMw += externalReserveVolumes(grid, externalSystems[structure.externalIndices[systemPosition]!]!)[externalVolume]!
    }
    const allocation = allocated(generators)
    let unitsMw = 0
    for (let generatorPosition = 0; generatorPosition < structure.generatorIndices.length; generatorPosition += 1) {
      const generator = structure.generatorIndices[generatorPosition]!
      unitsMw += generators.lifecycle[generator] === generatorOnline ? allocation[generator]! : 0
    }
    const heldMw = externalMw + unitsMw
    const deficitMw = Math.max(0, requiredMw - heldMw)
    if (deficitMw < alarm.clearMw) continue
    emit(islandObservation(island, `reserve-deficit-${product}`, alarm, {
      raising: deficitMw > alarm.raiseMw,
      title: `Reserve deficit (${product})`,
      message: `Island ${island.id} holds ${mw(heldMw)} of the ${mw(requiredMw)} ${product} requirement`,
      value: deficitMw,
      limit: alarm.raiseMw,
      unit: 'MW',
    }))
  }
}

const energisedIslandObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, state: GridAlarmState, island: GridIsland, structure: GridTopologyIsland, emit: Emit): void => {
  const automation = grid.definition.automation
  frequencyObservations(settings, automation.swing.nominalFrequencyHz, island, emit)
  if (state.baseIslandIds !== null && !state.baseIslandIds.has(island.id)) {
    emit(islandObservation(island, 'formed', settings.islandFormed, {
      raising: true,
      title: 'Island formed',
      message: `Island ${island.id} (${structure.busIndices.length} buses) runs separated from the Grid's starting topology`,
      value: null,
      limit: null,
      unit: null,
    }))
  }
  reserveObservations(grid, settings, island, structure, emit)
  const loads = grid.arrays.loads
  let shedMw = 0
  let lfddMw = 0
  let emergencyMw = 0
  for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
    const load = structure.loadIndices[loadPosition]!
    shedMw += loads.shedMw[load]!
    lfddMw += loads.lfddShedMw[load]!
    if (loads.manualShedEmergency[load] === 1) emergencyMw += loads.curtailedMw[load]!
  }
  if (shedMw >= settings.unservedLoad.clearMw) {
    emit(islandObservation(island, 'unserved-load', settings.unservedLoad, {
      raising: shedMw > settings.unservedLoad.raiseMw,
      title: 'Unserved load',
      message: `Island ${island.id} sheds ${mw(shedMw)}: ${mw(lfddMw)} by LFDD, ${mw(emergencyMw)} by emergency shedding, ${mw(shedMw - lfddMw - emergencyMw)} by curtailment`,
      value: shedMw,
      limit: settings.unservedLoad.raiseMw,
      unit: 'MW',
    }))
  }
  for (const stage of automation.lfdd.stages) {
    if (island.workspace!.lfdd.stages[stage.id]?.status !== 'operated') continue
    emit(islandObservation(island, `lfdd-${stage.id}-operated`, settings.lfddStageOperated, {
      raising: true,
      title: `LFDD ${stage.id} operated`,
      message: `LFDD ${stage.id} (${stage.thresholdHz} Hz) disconnected feeders in island ${island.id}; restore-lfdd-stage reconnects them`,
      value: null,
      limit: stage.thresholdHz,
      unit: 'Hz',
    }))
  }
  const acReason = state.acNonConvergence.get(island.id)
  if (acReason !== undefined) {
    emit(islandObservation(island, 'ac-non-convergence', settings.acNonConvergence, {
      raising: true,
      title: 'AC load flow did not converge',
      message: `Island ${island.id}: ${acReason}`,
      value: null,
      limit: null,
      unit: null,
    }))
  }
}

const branchObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, emit: Emit): void => {
  const lowestClearPercent = Math.min(...settings.branchLoading.map(band => band.clearPercent))
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  const buses = grid.arrays.buses
  const branchFrom = gridTablesFor(grid.definition).network.branchFrom
  for (let index = 0; index < branches.length; index += 1) {
    const definition = branches[index]!
    const status = arrays.status[index]!
    if (status !== branchTripped && status !== branchClosed) continue
    const islandId = buses.solvedIslandIds[buses.solvedIsland[branchFrom[index]!]!]!
    if (status === branchTripped) {
      const trip = arrays.trip[index]!
      emit({
        id: gridAlarmId('branch', definition.id, 'tripped'),
        scope: 'branch',
        assetId: definition.id,
        condition: 'tripped',
        timing: settings.branchTripped,
        islandId,
        raising: true,
          title: 'Branch tripped',
        message: `${definition.label} tripped by its ${trip.element} protection at ${mw(Math.abs(trip.flowMw))} (${trip.loadingPercent.toFixed(0)} % of its derated rating); reset-branch-protection before closing it`,
        value: trip.loadingPercent,
        limit: null,
        unit: '%',
      })
      continue
    }
    const continuousPercent = arrays.loadingPercent[index]!
    const apparentPowerMva = arrays.apparentPowerMva[index]!
    const availability = arrays.availability[index]!
    // Loading acts on the rated flow: the AC apparent power, or the DC flow where the island's AC load flow failed.
    const emergencyPercent = apparentPowerMva / (definition.emergencyRatingMw * availability) * 100
    // Branches below every band's clear loading produce no observation; their records clear.
    if (continuousPercent < lowestClearPercent && emergencyPercent < lowestClearPercent) continue
    for (const band of settings.branchLoading) {
      const loadingPercent = band.basis === 'continuous-rating' ? continuousPercent : emergencyPercent
      if (loadingPercent < band.clearPercent) continue
      const ratingMw = (band.basis === 'continuous-rating' ? definition.ratingMw : definition.emergencyRatingMw) * availability
      emit({
        id: gridAlarmId('branch', definition.id, `loading-${band.id}`),
        scope: 'branch',
        assetId: definition.id,
        condition: `loading-${band.id}`,
        timing: band,
        islandId,
        raising: loadingPercent >= band.raisePercent,
          title: `Branch loading (${band.id})`,
        message: `${definition.label} carries ${arrays.flowModel[index] === flowModelAc ? `${apparentPowerMva.toFixed(1)} MVA` : `${mw(apparentPowerMva)} (DC flow)`}, ${loadingPercent.toFixed(1)} % of its ${band.basis === 'continuous-rating' ? 'continuous' : 'emergency'} rating ${mw(ratingMw)}`,
        value: loadingPercent,
        limit: band.raisePercent,
        unit: '%',
      })
    }
  }
}

const generatorObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, emit: Emit): void => {
  const generators = grid.definition.model.generators
  const lifecycle = grid.arrays.generators.lifecycle
  for (let generator = 0; generator < generators.length; generator += 1) {
    if (lifecycle[generator] !== generatorTripped) continue
    const definition = generators[generator]!
    const trip = grid.protection.recordedGeneratorTrips.get(definition.id)
    emit({
      id: gridAlarmId('generator', definition.id, 'tripped'),
      scope: 'generator',
      assetId: definition.id,
      condition: 'tripped',
      timing: settings.generatorTripped,
      islandId: grid.busStates.get(definition.busId)!.islandId,
      raising: true,
      title: 'Generator tripped',
      message: trip === undefined || trip.element === 'command'
        ? `${definition.label} is tripped by command; reset-generator-trip returns it to offline`
        : `${definition.label} tripped by ${trip.element} protection (${trip.elementId}); reset-generator-trip returns it to offline`,
      value: null,
      limit: null,
      unit: null,
    })
  }
}

const hvdcObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, emit: Emit): void => {
  const links = grid.definition.index.hvdcLinks
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!
    const trip = grid.arrays.hvdcLinks[index]!.trip
    if (trip === null) continue
    emit({
      id: gridAlarmId('hvdc', link.id, 'tripped'),
      scope: 'hvdc',
      assetId: link.id,
      condition: 'tripped',
      timing: settings.hvdcTripped,
      islandId: grid.busStates.get(link.fromBusId)!.islandId,
      raising: true,
      title: 'HVDC link tripped',
      message: `${link.label} ${hvdcTripReason(trip)}; reset-hvdc-trip, then deblock-hvdc`,
      value: Math.abs(trip.transferMw),
      limit: null,
      unit: 'MW',
    })
  }
}

const externalObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, emit: Emit): void => {
  const systems = grid.definition.index.externalSystems
  for (let position = 0; position < systems.length; position += 1) {
    const state = grid.arrays.externalSystems[position]!
    if (!state.exchangeVoided) continue
    const system = systems[position]!
    const operatingPointExportMw = 0 - operatingPointImportMw(grid, system)
    const scheduledExportMw = 0 - state.scheduledImportMw
    emit({
      id: gridAlarmId('external', system.id, 'exchange-voided'),
      scope: 'external',
      assetId: system.id,
      condition: 'exchange-voided',
      timing: settings.externalExchangeVoided,
      islandId: state.islandId,
      raising: true,
      title: 'External exchange voided by separation',
      message: `${system.label} was separated from every Norwegian island, which voided its scheduled exchange: ${mw(scheduledExportMw)} scheduled (target ${mw(0 - state.targetImportMw)}) against the Operating Point's ${mw(operatingPointExportMw)}, positive exports from Norway; once a tie is closed, set-external-exchange restores it`,
      value: Math.abs(scheduledExportMw - operatingPointExportMw),
      limit: null,
      unit: 'MW',
    })
  }
}

/** Observations of every alarm condition near or beyond its limit at the latest solve. */
export const gridAlarmObservations = (grid: GridRuntimeInstance, islands: GridIslandPlan, settings: GridAlarmSettings, state: GridAlarmState): ReadonlyArray<GridAlarmObservation> => {
  const observations: GridAlarmObservation[] = []
  const emit: Emit = observation => { observations.push(observation) }
  for (const island of islands.islands) {
    const structure = islands.plan.islands[island.planIndex]!
    if (island.energized) {
      energisedIslandObservations(grid, settings, state, island, structure, emit)
      continue
    }
    let demandMw = 0
    for (let loadPosition = 0; loadPosition < structure.loadIndices.length; loadPosition += 1) {
      const load = structure.loadIndices[loadPosition]!
      demandMw += grid.arrays.loads.demandMw[load]!
    }
    const plantConnections = structure.connectionPointIndices.length
    if (demandMw <= 0 && plantConnections === 0) continue
    emit(islandObservation(island, 'de-energised', settings.islandDeEnergised, {
      raising: true,
      title: 'Island de-energised',
      message: `Island ${island.id} has no voltage-forming source: ${mw(demandMw)} of demand${plantConnections > 0 ? ` and ${plantConnections} Plant connection${plantConnections === 1 ? '' : 's'}` : ''} without supply`,
      value: demandMw,
      limit: null,
      unit: 'MW',
    }))
  }
  branchObservations(grid, settings, emit)
  generatorObservations(grid, settings, emit)
  hvdcObservations(grid, settings, emit)
  externalObservations(grid, settings, emit)
  return observations
}
