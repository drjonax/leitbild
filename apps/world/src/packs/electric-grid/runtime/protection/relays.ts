import type { IsoTimestamp } from '../../../../core/model/index.ts'
import type { GridBranchDefinition } from '../../grid-model.ts'
import type { GridBranchProtectionSettings } from '../../schemas/grid-protection-automation.ts'
import { queueGridSignal } from '../grid-signals.ts'
import type { GridBranchState, GridRuntimeInstance } from '../instance.ts'
import type { GridBranchTripElement } from './state.ts'

// Sampled branch relays. At every sample the relay reads the solved flow and updates three elements:
// - thermal (inverse time): a first-order conductor state θ heats towards (flow / derated rating)²
//   with the branch kind's time constant τ, θ' = L² + (θ − L²)·e^(−Ts/τ), exact for a flow held over
//   the sample interval Ts; it trips at the level a branch reaches when it carries its emergency
//   rating for its emergency duration from its continuous rating, so the thermal element agrees
//   with the Model's transitory admissible overload;
// - emergency duration (definite time): above the derated emergency rating for the emergency duration;
// - instantaneous: above the instantaneous pickup, at once.

export type EnabledBranchProtection = Extract<GridBranchProtectionSettings, { readonly enabled: true }>

/** The Model's emergency duration; a v1 Model gives none, so the Automation's applies. */
export const branchEmergencyDurationSeconds = (branch: GridBranchDefinition, settings: EnabledBranchProtection): number =>
  branch.emergencyDurationSeconds ?? settings.emergencyDurationSeconds

/** Thermal level at which the thermal element trips: θ after the emergency duration at the emergency rating from θ = 1. */
export const branchThermalTripLevel = (branch: GridBranchDefinition, settings: EnabledBranchProtection): number => {
  const emergencySquared = (branch.emergencyRatingMw / branch.ratingMw) ** 2
  const decay = Math.exp(-branchEmergencyDurationSeconds(branch, settings) / settings.thermalTimeConstantSeconds[branch.kind])
  return emergencySquared - (emergencySquared - 1) * decay
}

/** Flow over the derated continuous rating. */
const loadingRatio = (branch: GridBranchDefinition, state: GridBranchState): number => Math.abs(state.flowMw) / (branch.ratingMw * state.availability)

export interface BranchTripDecision {
  readonly index: number
  readonly element: GridBranchTripElement
}

const instantaneousOperates = (branch: GridBranchDefinition, state: GridBranchState, settings: EnabledBranchProtection): boolean =>
  loadingRatio(branch, state) * 100 > settings.instantaneousPercentOfRating

/** Sets every branch's thermal state to the steady state of its present flow. */
export const initialiseBranchThermalStates = (grid: GridRuntimeInstance): void => {
  const branches = grid.definition.model.branches
  let index = 0
  for (const state of grid.branches.values()) {
    const ratio = loadingRatio(branches[index]!, state)
    state.protection.thermalLevel = ratio * ratio
    index += 1
  }
}

/**
 * One relay sample at Grid elapsed `elapsedMs`, `intervalSeconds` after the previous one: updates
 * every branch's thermal state and definite-time timer from its solved flow and returns the closed
 * branches whose relays operate, in Model order.
 */
export const sampleBranchRelays = (grid: GridRuntimeInstance, settings: EnabledBranchProtection, elapsedMs: number, intervalSeconds: number): ReadonlyArray<BranchTripDecision> => {
  const branches = grid.definition.model.branches
  const trips: BranchTripDecision[] = []
  let index = 0
  for (const state of grid.branches.values()) {
    const branch = branches[index]!
    const ratio = loadingRatio(branch, state)
    const steady = ratio * ratio
    const protection = state.protection
    protection.thermalLevel = steady + (protection.thermalLevel - steady) * Math.exp(-intervalSeconds / settings.thermalTimeConstantSeconds[branch.kind])
    const aboveEmergency = Math.abs(state.flowMw) > branch.emergencyRatingMw * state.availability
    protection.overEmergencySinceElapsedMs = state.state === 'closed' && aboveEmergency ? protection.overEmergencySinceElapsedMs ?? elapsedMs : null
    if (state.state === 'closed') {
      const element: GridBranchTripElement | null = instantaneousOperates(branch, state, settings)
        ? 'instantaneous'
        : protection.overEmergencySinceElapsedMs !== null && elapsedMs - protection.overEmergencySinceElapsedMs >= branchEmergencyDurationSeconds(branch, settings) * 1_000
          ? 'emergency-duration'
          : protection.thermalLevel >= branchThermalTripLevel(branch, settings) ? 'thermal' : null
      if (element !== null) trips.push({ index, element })
    }
    index += 1
  }
  return trips
}

/** Closed branches whose instantaneous element operates on the present flows (a cascade within one instant). */
export const instantaneousBranchTrips = (grid: GridRuntimeInstance, settings: EnabledBranchProtection): ReadonlyArray<BranchTripDecision> => {
  const branches = grid.definition.model.branches
  const trips: BranchTripDecision[] = []
  let index = 0
  for (const state of grid.branches.values()) {
    if (state.state === 'closed' && instantaneousOperates(branches[index]!, state, settings)) trips.push({ index, element: 'instantaneous' })
    index += 1
  }
  return trips
}

/** Opens the tripped branches' breakers by protection and queues one protection event per trip. */
export const applyBranchTrips = (grid: GridRuntimeInstance, trips: ReadonlyArray<BranchTripDecision>, at: IsoTimestamp, elapsedMs: number): void => {
  const branches = grid.definition.model.branches
  const states = [...grid.branches.values()]
  for (const trip of trips) {
    const branch = branches[trip.index]!
    const state = states[trip.index]!
    const loadingPercent = loadingRatio(branch, state) * 100
    state.state = 'tripped'
    state.protection.trip = { element: trip.element, at, atElapsedMs: elapsedMs, flowMw: state.flowMw, loadingPercent, thermalLevel: state.protection.thermalLevel }
    state.protection.overEmergencySinceElapsedMs = null
    queueGridSignal(grid, {
      type: 'electric-grid.protection.tripped',
      severity: 'critical',
      key: `trip|${branch.id}|${elapsedMs}`,
      payload: {
        gridId: grid.definition.gridId,
        assetId: branch.id,
        assetKind: 'branch',
        label: branch.label,
        element: trip.element,
        flowMw: state.flowMw,
        loadingPercent,
        thermalLevel: state.protection.thermalLevel,
        islandId: grid.busStates.get(branch.fromBusId)!.islandId,
        simulationTime: at,
        elapsedSeconds: elapsedMs / 1_000,
      },
    })
  }
}
