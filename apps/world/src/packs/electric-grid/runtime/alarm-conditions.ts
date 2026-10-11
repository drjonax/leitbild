import type { ReserveRequirement } from '../schemas/grid-automation.ts'
import type { GridAlarmSettings, GridAlarmTiming } from '../schemas/grid-protection-automation.ts'
import { gridAlarmId, type GridAlarmObservation, type GridAlarmState } from './alarms.ts'
import { synchronousAreaRequirementMw } from './reserve-allocation.ts'
import type { FrequencyReserveAllocation } from './frequency/types.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalFrequencyEquivalent, islandMembers } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'

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
  const frequencyHz = island.frequency!.frequencyHz!
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

type ReserveProductField = keyof FrequencyReserveAllocation

/** Reserve products of the Automation: condition name, allocation field, requirement. */
const reserveProducts = (grid: GridRuntimeInstance): ReadonlyArray<readonly [string, ReserveProductField, ReserveRequirement]> => {
  const automation = grid.definition.automation
  return [
    ['fcr-n', 'fcrNMw', automation.fcrN.requirement],
    ['fcr-d-up', 'fcrDUpMw', automation.fcrD.up.requirement],
    ['fcr-d-down', 'fcrDDownMw', automation.fcrD.down.requirement],
    ...(automation.afrr.enabled ? [['afrr-up', 'afrrUpMw', automation.afrr.requirement.up], ['afrr-down', 'afrrDownMw', automation.afrr.requirement.down]] as const : []),
    ...(automation.mfrr.enabled ? [['mfrr-up', 'mfrrUpMw', automation.mfrr.requirement.up], ['mfrr-down', 'mfrrDownMw', automation.mfrr.requirement.down]] as const : []),
  ]
}

const externalReserveMw = (grid: GridRuntimeInstance, structure: GridTopologyIsland, field: ReserveProductField): number => {
  if (field === 'mfrrUpMw' || field === 'mfrrDownMw') return 0
  return islandMembers(grid, structure).externals.reduce((sum, system) => sum + externalFrequencyEquivalent(grid, system).reserves[field], 0)
}

/** Requirement of each product for the island not covered by its online units' allocations and its external systems. */
const reserveObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, island: GridIsland, structure: GridTopologyIsland, emit: Emit): void => {
  const units = structure.generators.map(definition => {
    const state = grid.generators.get(definition.id)!
    return { synchronised: state.state === 'online', targetMw: state.targetMw, reserves: state.reserves }
  })
  const loadMw = structure.loads.reduce((sum, load) => sum + connectedGridLoadMw(grid.loads.get(load.id)!), 0)
  const area = {
    islandLoadMw: loadMw,
    externals: islandMembers(grid, structure).externals.map(system => {
      const equivalent = externalFrequencyEquivalent(grid, system)
      return { reserves: equivalent.reserves, loadMw: equivalent.loadMw }
    }),
  }
  const alarm = settings.reserveDeficit
  for (const [product, field, requirement] of reserveProducts(grid)) {
    // Dimensioned per synchronous area; a detached island has no share of a fixed area volume to fall short of.
    const requiredMw = synchronousAreaRequirementMw(requirement, area, units)
    if (requiredMw === null) continue
    const heldMw = externalReserveMw(grid, structure, field) + units.reduce((sum, unit) => sum + (unit.synchronised ? unit.reserves[field] : 0), 0)
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
      message: `Island ${island.id} (${structure.buses.length} buses) runs separated from the Grid's starting topology`,
      value: null,
      limit: null,
      unit: null,
    }))
  }
  reserveObservations(grid, settings, island, structure, emit)
  let shedMw = 0
  let lfddMw = 0
  let emergencyMw = 0
  for (const load of structure.loads) {
    const service = grid.loads.get(load.id)!
    shedMw += service.shedMw
    lfddMw += service.lfddShedMw
    if (service.manualShedEmergency) emergencyMw += service.curtailedMw
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
    if (island.frequency!.lfdd.stages[stage.id]?.status !== 'operated') continue
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
  for (const definition of grid.definition.model.branches) {
    const state = grid.branches.get(definition.id)!
    const islandId = grid.busStates.get(definition.fromBusId)!.islandId
    if (state.state === 'tripped') {
      const trip = state.protection.trip!
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
    if (state.state !== 'closed') continue
    const continuousPercent = state.loadingPercent
    const emergencyPercent = Math.abs(state.flowMw) / (definition.emergencyRatingMw * state.availability) * 100
    // Branches below every band's clear loading produce no observation; their records clear.
    if (continuousPercent < lowestClearPercent && emergencyPercent < lowestClearPercent) continue
    for (const band of settings.branchLoading) {
      const loadingPercent = band.basis === 'continuous-rating' ? continuousPercent : emergencyPercent
      if (loadingPercent < band.clearPercent) continue
      const ratingMw = (band.basis === 'continuous-rating' ? definition.ratingMw : definition.emergencyRatingMw) * state.availability
      emit({
        id: gridAlarmId('branch', definition.id, `loading-${band.id}`),
        scope: 'branch',
        assetId: definition.id,
        condition: `loading-${band.id}`,
        timing: band,
        islandId,
        raising: loadingPercent >= band.raisePercent,
          title: `Branch loading (${band.id})`,
        message: `${definition.label} carries ${mw(Math.abs(state.flowMw))}, ${loadingPercent.toFixed(1)} % of its ${band.basis === 'continuous-rating' ? 'continuous' : 'emergency'} rating ${mw(ratingMw)}`,
        value: loadingPercent,
        limit: band.raisePercent,
        unit: '%',
      })
    }
  }
}

const generatorObservations = (grid: GridRuntimeInstance, settings: GridAlarmSettings, emit: Emit): void => {
  for (const definition of grid.definition.model.generators) {
    if (grid.generators.get(definition.id)!.state !== 'tripped') continue
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
    const demandMw = structure.loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.demandMw, 0)
    const plantConnections = islandMembers(grid, structure).connectionPointIds.length
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
  return observations
}
