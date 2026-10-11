import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { advanceFrequencyWorkspace, advancedSynchronised, workspaceAfrrStatus, workspaceKineticEnergyMws } from './advance.ts'
import type { FrequencyAction, IslandFrequencyState } from './island-state.ts'
import { validateIslandInput } from './island-state.ts'
import type { IslandFrequencyInput } from './types.ts'
import {
  createFrequencyWorkspace,
  frequencyStateOf,
  loadFrequencyState,
  type ExternalFrequencyOutput,
  type IslandFrequencyWorkspace,
  type StorageFrequencyOutput,
} from './workspace.ts'

export type { ExternalFrequencyOutput, StorageFrequencyOutput } from './workspace.ts'

export interface UnitFrequencyOutput {
  readonly id: string
  readonly synchronised: boolean
  readonly outputMw: number
  readonly scheduledMw: number
  readonly fcrNMw: number
  readonly fcrDMw: number
  /** aFRR and mFRR act as adjustments on top of the unit's targetMw. */
  readonly afrrMw: number
  readonly mfrrMw: number
}

export interface LoadFrequencyOutput {
  readonly id: string
  /** Served demand at the island frequency, after LFDD and load self-regulation. */
  readonly servedMw: number
  readonly lfddShedMw: number
}

export interface IslandFrequencyAdvance {
  readonly state: IslandFrequencyState
  readonly actions: ReadonlyArray<FrequencyAction>
  readonly units: ReadonlyArray<UnitFrequencyOutput>
  readonly storage: ReadonlyArray<StorageFrequencyOutput>
  readonly loads: ReadonlyArray<LoadFrequencyOutput>
  readonly externals: ReadonlyArray<ExternalFrequencyOutput>
  readonly kineticEnergyMws: number
  /**
   * Σ mechanical power − served load − losses at the end of the advance (MW): the power the
   * synchronous machines' kinetic energy supplies (negative) or absorbs at that instant.
   */
  readonly acceleratingPowerMw: number
  /** Lowest and highest frequency reached at any sub-step boundary of this advance. */
  readonly extremes: { readonly minimumHz: number; readonly minimumAtSeconds: number; readonly maximumHz: number; readonly maximumAtSeconds: number } | null
  /** Island aFRR request, the part providers deliver, and the request as a share of allocated aFRR. */
  readonly afrr: { readonly requestMw: number; readonly deliveredMw: number; readonly utilisation: number } | null
}

/** A workspace for `input`'s members holding `state`, with `input` as the inputs of the next advance. */
export const workspaceForInput = (automation: GridAutomation, state: IslandFrequencyState, input: IslandFrequencyInput): IslandFrequencyWorkspace => {
  const workspace = createFrequencyWorkspace({
    automation,
    islandId: input.islandId,
    unitIds: input.units.map(unit => unit.id),
    governorClasses: input.units.map(unit => unit.governorClass),
    storageIds: input.storage.map(unit => unit.id),
    externalIds: input.externals.map(external => external.id),
    loadIds: input.loads.map(load => load.id),
    loadPriority: input.loads.map(load => load.priority),
    loadProtectedMw: input.loads.map(load => load.protectedMw),
  })
  loadFrequencyState(workspace, state)
  const units = workspace.units
  input.units.forEach((unit, position) => {
    units.synchronised[position] = unit.synchronised ? 1 : 0
    units.synchronous[position] = unit.connection === 'synchronous' ? 1 : 0
    units.ratedMva[position] = unit.ratedMva
    units.inertiaConstantSeconds[position] = unit.inertiaConstantSeconds
    units.minimumMw[position] = unit.minimumMw
    units.maximumMw[position] = unit.maximumMw
    units.targetMw[position] = unit.targetMw
    units.rampRateMwPerSecond[position] = unit.rampRateMwPerSecond
    units.fcrNReserveMw[position] = unit.reserves.fcrNMw
    units.fcrDUpReserveMw[position] = unit.reserves.fcrDUpMw
    units.fcrDDownReserveMw[position] = unit.reserves.fcrDDownMw
    units.afrrUpReserveMw[position] = unit.reserves.afrrUpMw
    units.afrrDownReserveMw[position] = unit.reserves.afrrDownMw
    units.mfrrUpReserveMw[position] = unit.reserves.mfrrUpMw
    units.mfrrDownReserveMw[position] = unit.reserves.mfrrDownMw
  })
  input.loads.forEach((load, position) => { workspace.loadDemandMw[position] = load.demandMw })
  input.storage.forEach((unit, position) => { workspace.storageUnits[position] = unit })
  input.externals.forEach((external, position) => { workspace.externalEquivalents[position] = external })
  workspace.lossesMw = input.lossesMw
  workspace.fixedInjectionMw = input.fixedInjectionMw
  workspace.tieLineDeviationMw = input.tieLineDeviationMw
  return workspace
}

/**
 * Advances one synchronous island by dtSeconds in fixed sub-steps of the automation's
 * subStepSeconds (a shorter final step covers any remainder). Within each sub-step the swing
 * equation, governors, storage, protection and LFDD are evaluated; aFRR and mFRR run on their
 * own cycle. Returns new state, per-asset outputs and the discrete actions taken; the input state
 * is never changed. The runtime advances its islands in place (advance.ts) with the same arithmetic.
 */
export const advanceIslandFrequency = (
  automation: GridAutomation,
  state: IslandFrequencyState,
  input: IslandFrequencyInput,
  dtSeconds: number,
): IslandFrequencyAdvance => {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) throw new Error(`frequency advance needs a finite non-negative step, got ${dtSeconds}`)
  if (dtSeconds > automation.simulation.maximumCatchUpSeconds) {
    throw new Error(`frequency advance of ${dtSeconds} s exceeds the maximum catch-up of ${automation.simulation.maximumCatchUpSeconds} s for island ${input.islandId}`)
  }
  if (state.frequencyHz === null) throw new Error(`island ${state.islandId} has collapsed; it must be re-energised with a new frequency state`)
  validateIslandInput(automation, state, input)
  const workspace = workspaceForInput(automation, state, input)
  advanceFrequencyWorkspace(automation, workspace, dtSeconds, { inputsValidated: true, validateInDetail: () => validateIslandInput(automation, state, input) })
  return frequencyAdvanceOf(workspace)
}

/** The results of a workspace's last advance as an IslandFrequencyAdvance (copies; the workspace keeps advancing). */
export const frequencyAdvanceOf = (workspace: IslandFrequencyWorkspace): IslandFrequencyAdvance => {
  const collapsed = workspace.frequencyHz === null
  const units: UnitFrequencyOutput[] = workspace.unitIds.map((id, position) => ({
    id,
    synchronised: workspace.outputSynchronised[position] === 1,
    outputMw: workspace.outputMw[position]!,
    scheduledMw: workspace.scheduledMw[position]!,
    fcrNMw: workspace.outputFcrNMw[position]!,
    fcrDMw: workspace.outputFcrDMw[position]!,
    afrrMw: workspace.afrrMw[position]!,
    mfrrMw: workspace.outputMfrrMw[position]!,
  }))
  const storage = [...workspace.storageOutputs]
  const loads: LoadFrequencyOutput[] = workspace.loadIds.map((id, position) => ({ id, servedMw: workspace.loadServedMw[position]!, lfddShedMw: workspace.loadLfddShedMw[position]! }))
  const externals = [...workspace.externalOutputs]
  const synchronised = advancedSynchronised(workspace)
  const acceleratingPowerMw = collapsed ? 0
    : units.reduce((sum, unit) => sum + unit.outputMw, 0)
      + storage.reduce((sum, unit) => sum + unit.powerMw, 0)
      + externals.reduce((sum, external) => sum + external.mechanicalMw, 0)
      + workspace.fixedInjectionMw - workspace.lossesMw
      - loads.reduce((sum, load) => sum + load.servedMw, 0)
  return {
    state: frequencyStateOf(workspace),
    actions: [...workspace.actions],
    units,
    storage,
    loads,
    externals,
    acceleratingPowerMw,
    kineticEnergyMws: collapsed ? 0 : workspaceKineticEnergyMws(workspace, synchronised),
    extremes: workspace.hasExtremes ? { ...workspace.extremes } : null,
    afrr: workspace.agc ? workspaceAfrrStatus(workspace, synchronised, workspace.agc.requestMw) : null,
  }
}
