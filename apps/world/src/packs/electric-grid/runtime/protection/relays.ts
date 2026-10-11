import type { IsoTimestamp } from '../../../../core/model/index.ts'
import type { GridBranchDefinition } from '../../grid-model.ts'
import type { GridBranchProtectionSettings } from '../../schemas/grid-protection-automation.ts'
import { queueGridSignal } from '../grid-signals.ts'
import type { GridRuntimeInstance } from '../instance.ts'
import { branchClosed, branchTripped, type GridBranchArrays } from '../state/arrays.ts'
import type { GridBranchTripElement } from './state.ts'

// Sampled branch relays. At every sample the relay reads the solved flow it is rated for (the AC
// apparent power where the island's load flow converged, else the DC flow: GridBranchState
// apparentPowerMva) and updates three elements:
// - thermal (inverse time): a first-order conductor state θ heats towards (flow / derated rating)²
//   with the branch kind's time constant τ, θ' = L² + (θ − L²)·e^(−Ts/τ), exact for a flow held over
//   the sample interval Ts; it trips at the level a branch reaches when it carries its emergency
//   rating for its emergency duration from its continuous rating, so the thermal element agrees
//   with the Model's transitory admissible overload;
// - emergency duration (definite time): above the derated emergency rating for the emergency duration;
// - instantaneous: above the instantaneous pickup, at once.

export type EnabledBranchProtection = Extract<GridBranchProtectionSettings, { readonly enabled: true }>

/** Thermal level at which the thermal element trips: θ after the emergency duration at the emergency rating from θ = 1. */
export const branchThermalTripLevel = (branch: GridBranchDefinition, settings: EnabledBranchProtection): number => {
  const emergencySquared = (branch.emergencyRatingMw / branch.ratingMw) ** 2
  const decay = Math.exp(-branch.emergencyDurationSeconds / settings.thermalTimeConstantSeconds[branch.kind])
  return emergencySquared - (emergencySquared - 1) * decay
}

export interface BranchTripDecision {
  readonly index: number
  readonly element: GridBranchTripElement
}

const noTrips: ReadonlyArray<BranchTripDecision> = Object.freeze([])

/** Rated flow over the derated continuous rating. */
const loadingRatio = (branch: GridBranchDefinition, arrays: GridBranchArrays, index: number): number =>
  arrays.apparentPowerMva[index]! / (branch.ratingMw * arrays.availability[index]!)

const instantaneousOperates = (branch: GridBranchDefinition, arrays: GridBranchArrays, index: number, settings: EnabledBranchProtection): boolean =>
  loadingRatio(branch, arrays, index) * 100 > settings.instantaneousPercentOfRating

const tripLevels = new WeakMap<EnabledBranchProtection, WeakMap<ReadonlyArray<GridBranchDefinition>, Float64Array>>()

/** branchThermalTripLevel of every branch, computed once per Model and protection settings. */
const thermalTripLevels = (branches: ReadonlyArray<GridBranchDefinition>, settings: EnabledBranchProtection): Float64Array => {
  let bySettings = tripLevels.get(settings)
  if (bySettings === undefined) {
    bySettings = new WeakMap()
    tripLevels.set(settings, bySettings)
  }
  let levels = bySettings.get(branches)
  if (levels === undefined) {
    levels = Float64Array.from(branches, branch => branchThermalTripLevel(branch, settings))
    bySettings.set(branches, levels)
  }
  return levels
}

/**
 * Sets every branch's thermal state when the relays arm: the steady state of its present flow, but
 * at most the rated temperature (θ = 1). A Grid starts from a permissible state; a branch it starts
 * above its rating heats from its rated temperature with its time constant, so its overload alarm
 * comes at once and its thermal element operates only if the overload is not relieved in time.
 */
export const initialiseBranchThermalStates = (grid: GridRuntimeInstance): void => {
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  for (let index = 0; index < branches.length; index += 1) {
    const ratio = loadingRatio(branches[index]!, arrays, index)
    arrays.thermalLevel[index] = Math.min(1, ratio * ratio)
  }
}

/**
 * One relay sample at Grid elapsed `elapsedMs`, `intervalSeconds` after the previous one: updates
 * every branch's thermal state and definite-time timer from its solved flow and returns the closed
 * branches whose relays operate, in Model order.
 */
export const sampleBranchRelays = (grid: GridRuntimeInstance, settings: EnabledBranchProtection, elapsedMs: number, intervalSeconds: number): ReadonlyArray<BranchTripDecision> => {
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  const levels = thermalTripLevels(branches, settings)
  let trips: BranchTripDecision[] | null = null
  for (let index = 0; index < branches.length; index += 1) {
    const branch = branches[index]!
    const ratio = loadingRatio(branch, arrays, index)
    const steady = ratio * ratio
    const thermalLevel = steady + (arrays.thermalLevel[index]! - steady) * Math.exp(-intervalSeconds / settings.thermalTimeConstantSeconds[branch.kind])
    arrays.thermalLevel[index] = thermalLevel
    const closed = arrays.status[index] === branchClosed
    const aboveEmergency = arrays.apparentPowerMva[index]! > branch.emergencyRatingMw * arrays.availability[index]!
    const since = arrays.overEmergencySinceElapsedMs[index]!
    // NaN codes "not above the emergency rating" (null).
    const overEmergencySinceMs = closed && aboveEmergency ? (since === since ? since : elapsedMs) : Number.NaN
    arrays.overEmergencySinceElapsedMs[index] = overEmergencySinceMs
    if (!closed) continue
    const element: GridBranchTripElement | null = instantaneousOperates(branch, arrays, index, settings)
      ? 'instantaneous'
      : overEmergencySinceMs === overEmergencySinceMs && elapsedMs - overEmergencySinceMs >= branch.emergencyDurationSeconds * 1_000
        ? 'emergency-duration'
        : thermalLevel >= levels[index]! ? 'thermal' : null
    if (element !== null) (trips ??= []).push({ index, element })
  }
  return trips ?? noTrips
}

/** Closed branches whose instantaneous element operates on the present flows (a cascade within one instant). */
export const instantaneousBranchTrips = (grid: GridRuntimeInstance, settings: EnabledBranchProtection): ReadonlyArray<BranchTripDecision> => {
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  let trips: BranchTripDecision[] | null = null
  for (let index = 0; index < branches.length; index += 1) {
    if (arrays.status[index] === branchClosed && instantaneousOperates(branches[index]!, arrays, index, settings)) (trips ??= []).push({ index, element: 'instantaneous' })
  }
  return trips ?? noTrips
}

/** Opens the tripped branches' breakers by protection and queues one protection event per trip. */
export const applyBranchTrips = (grid: GridRuntimeInstance, trips: ReadonlyArray<BranchTripDecision>, at: IsoTimestamp, elapsedMs: number): void => {
  const branches = grid.definition.model.branches
  const arrays = grid.arrays.branches
  for (const trip of trips) {
    const branch = branches[trip.index]!
    const loadingPercent = loadingRatio(branch, arrays, trip.index) * 100
    const flowMw = arrays.flowMw[trip.index]!
    const thermalLevel = arrays.thermalLevel[trip.index]!
    arrays.status[trip.index] = branchTripped
    arrays.trip[trip.index] = { element: trip.element, at, atElapsedMs: elapsedMs, flowMw, loadingPercent, thermalLevel }
    arrays.overEmergencySinceElapsedMs[trip.index] = Number.NaN
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
        flowMw,
        loadingPercent,
        thermalLevel,
        islandId: grid.busStates.get(branch.fromBusId)!.islandId,
        simulationTime: at,
        elapsedSeconds: elapsedMs / 1_000,
      },
    })
  }
}
