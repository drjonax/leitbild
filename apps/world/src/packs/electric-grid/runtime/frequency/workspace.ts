import type { GovernorClass, GridAutomation } from '../../schemas/grid-automation.ts'
import type { AgcState } from './agc.ts'
import { resetGeneratorProtection, type GeneratorProtectionState } from './generator-protection.ts'
import type { ExternalFrequencyState, FrequencyAction, IslandFrequencyState, UnitFrequencyState } from './island-state.ts'
import type { LfddState } from './lfdd.ts'
import type { MfrrState, MfrrUnitRamp } from './mfrr.ts'
import type { StorageFrequencyState, StorageOperatingState } from './storage.ts'
import type { ExternalFrequencyEquivalent, FrequencyLoadPriority, FrequencyStorageUnit } from './types.ts'

// The frequency-control state of one island as arrays aligned with its units, loads, storage and
// external systems, advanced in place (advance.ts). IslandFrequencyState, the persisted shape with
// records by id, is produced from it on demand (frequencyStateOf) and loaded into it
// (loadFrequencyState); the runtime never builds it per advance.

/** Product eligibility bits of a unit's governor class under the Automation. */
export const eligibleFcrN = 1
export const eligibleFcrD = 2
export const eligibleAfrr = 4
export const eligibleMfrr = 8

/** What each unit brings to the next advance (FrequencyUnit, field by field); the caller refreshes it. */
export interface UnitInputArrays {
  readonly synchronised: Uint8Array
  /** 1: synchronous machine; 0: converter-connected. */
  readonly synchronous: Uint8Array
  readonly governorClass: ReadonlyArray<GovernorClass>
  /** eligible* bits of the governor class. */
  readonly eligibility: Uint8Array
  readonly ratedMva: Float64Array
  readonly inertiaConstantSeconds: Float64Array
  readonly minimumMw: Float64Array
  readonly maximumMw: Float64Array
  readonly targetMw: Float64Array
  readonly rampRateMwPerSecond: Float64Array
  readonly fcrNReserveMw: Float64Array
  readonly fcrDUpReserveMw: Float64Array
  readonly fcrDDownReserveMw: Float64Array
  readonly afrrUpReserveMw: Float64Array
  readonly afrrDownReserveMw: Float64Array
  readonly mfrrUpReserveMw: Float64Array
  readonly mfrrDownReserveMw: Float64Array
}

export interface StorageFrequencyOutput {
  readonly id: string
  readonly powerMw: number
  readonly responseMw: number
  readonly stateOfChargeFraction: number
  readonly operatingState: StorageOperatingState
  readonly limitedByStateOfCharge: boolean
}

export interface ExternalFrequencyOutput {
  readonly id: string
  /** Net power the external system releases towards the island before inertial sharing: schedule, reserves and demand self-regulation. */
  readonly mechanicalMw: number
  readonly fcrNMw: number
  readonly fcrDMw: number
  readonly afrrMw: number
}

/** Lowest and highest frequency reached at any sub-step boundary of an advance. */
export interface FrequencyExtremes {
  minimumHz: number
  minimumAtSeconds: number
  maximumHz: number
  maximumAtSeconds: number
}

export interface IslandFrequencyWorkspace {
  readonly islandId: string
  readonly automationId: string
  readonly unitIds: ReadonlyArray<string>
  readonly storageIds: ReadonlyArray<string>
  readonly externalIds: ReadonlyArray<string>
  readonly loadIds: ReadonlyArray<string>
  readonly loadPositionById: ReadonlyMap<string, number>
  // State between advances.
  elapsedSeconds: number
  /** null once the island has collapsed (no synchronous machine left). */
  frequencyHz: number | null
  rocofHzPerSecond: number
  agc: AgcState | null
  mfrr: MfrrState | null
  lfdd: LfddState
  readonly scheduledMw: Float64Array
  readonly fcrNMw: Float64Array
  readonly fcrDUpMw: Float64Array
  readonly fcrDDownMw: Float64Array
  readonly afrrMw: Float64Array
  readonly mfrrRamp: MfrrUnitRamp[]
  readonly protection: GeneratorProtectionState[]
  readonly storage: StorageFrequencyState[]
  readonly externals: ExternalFrequencyState[]
  // Inputs of the next advance.
  readonly units: UnitInputArrays
  readonly loadDemandMw: Float64Array
  readonly loadProtectedMw: Float64Array
  readonly loadPriority: ReadonlyArray<FrequencyLoadPriority>
  readonly storageUnits: FrequencyStorageUnit[]
  readonly externalEquivalents: ExternalFrequencyEquivalent[]
  lossesMw: number
  fixedInjectionMw: number
  tieLineDeviationMw: number | undefined
  // Outputs of the last advance.
  readonly outputSynchronised: Uint8Array
  readonly outputMw: Float64Array
  readonly outputFcrNMw: Float64Array
  readonly outputFcrDMw: Float64Array
  readonly outputMfrrMw: Float64Array
  readonly loadServedMw: Float64Array
  readonly loadLfddShedMw: Float64Array
  readonly storageOutputs: StorageFrequencyOutput[]
  readonly externalOutputs: ExternalFrequencyOutput[]
  readonly actions: FrequencyAction[]
  readonly extremes: FrequencyExtremes
  hasExtremes: boolean
  /** Total LFDD shed fraction of each load for `shedFractionsOf`; recomputed when the LFDD state object changes. */
  readonly loadShedFraction: Float64Array
  shedFractionsOf: LfddState | null
  /** Changes with every change of the state, so a produced IslandFrequencyState can be reused until then. */
  version: number
}

const floats = (count: number): Float64Array => new Float64Array(count)

/** The eligible* bits of a governor class under the Automation (aFRR and mFRR only when they run). */
export const governorEligibility = (automation: GridAutomation, governorClass: GovernorClass): number => {
  const classes = (list: ReadonlyArray<string>): boolean => list.includes(governorClass)
  return (classes(automation.fcrN.eligibleGovernorClasses) ? eligibleFcrN : 0)
    | (classes(automation.fcrD.eligibleGovernorClasses) ? eligibleFcrD : 0)
    | (automation.afrr.enabled && classes(automation.afrr.eligibleGovernorClasses) ? eligibleAfrr : 0)
    | (automation.mfrr.enabled && classes(automation.mfrr.eligibleGovernorClasses) ? eligibleMfrr : 0)
}

/**
 * An empty workspace for an island's members; its state is set by loadFrequencyState or directly by
 * the caller. `governorClasses` and the load priorities and protected demand are the members' static data.
 */
export const createFrequencyWorkspace = (config: {
  readonly automation: GridAutomation
  readonly islandId: string
  readonly unitIds: ReadonlyArray<string>
  readonly governorClasses: ReadonlyArray<GovernorClass>
  readonly storageIds: ReadonlyArray<string>
  readonly externalIds: ReadonlyArray<string>
  readonly loadIds: ReadonlyArray<string>
  readonly loadPriority: ReadonlyArray<FrequencyLoadPriority>
  readonly loadProtectedMw: ArrayLike<number>
}): IslandFrequencyWorkspace => {
  const { automation } = config
  const unitCount = config.unitIds.length
  const loadCount = config.loadIds.length
  return {
    islandId: config.islandId,
    automationId: automation.id,
    unitIds: config.unitIds,
    storageIds: config.storageIds,
    externalIds: config.externalIds,
    loadIds: config.loadIds,
    loadPositionById: new Map(config.loadIds.map((id, position) => [id, position])),
    elapsedSeconds: 0,
    frequencyHz: null,
    rocofHzPerSecond: 0,
    agc: null,
    mfrr: null,
    lfdd: { stages: {} },
    scheduledMw: floats(unitCount),
    fcrNMw: floats(unitCount),
    fcrDUpMw: floats(unitCount),
    fcrDDownMw: floats(unitCount),
    afrrMw: floats(unitCount),
    mfrrRamp: new Array<MfrrUnitRamp>(unitCount),
    protection: new Array<GeneratorProtectionState>(unitCount),
    storage: new Array<StorageFrequencyState>(config.storageIds.length),
    externals: new Array<ExternalFrequencyState>(config.externalIds.length),
    units: {
      synchronised: new Uint8Array(unitCount),
      synchronous: new Uint8Array(unitCount),
      governorClass: config.governorClasses,
      eligibility: Uint8Array.from(config.governorClasses, governorClass => governorEligibility(automation, governorClass)),
      ratedMva: floats(unitCount),
      inertiaConstantSeconds: floats(unitCount),
      minimumMw: floats(unitCount),
      maximumMw: floats(unitCount),
      targetMw: floats(unitCount),
      rampRateMwPerSecond: floats(unitCount),
      fcrNReserveMw: floats(unitCount),
      fcrDUpReserveMw: floats(unitCount),
      fcrDDownReserveMw: floats(unitCount),
      afrrUpReserveMw: floats(unitCount),
      afrrDownReserveMw: floats(unitCount),
      mfrrUpReserveMw: floats(unitCount),
      mfrrDownReserveMw: floats(unitCount),
    },
    loadDemandMw: floats(loadCount),
    loadProtectedMw: Float64Array.from(config.loadProtectedMw),
    loadPriority: config.loadPriority,
    storageUnits: new Array<FrequencyStorageUnit>(config.storageIds.length),
    externalEquivalents: new Array<ExternalFrequencyEquivalent>(config.externalIds.length),
    lossesMw: 0,
    fixedInjectionMw: 0,
    tieLineDeviationMw: undefined,
    outputSynchronised: new Uint8Array(unitCount),
    outputMw: floats(unitCount),
    outputFcrNMw: floats(unitCount),
    outputFcrDMw: floats(unitCount),
    outputMfrrMw: floats(unitCount),
    loadServedMw: floats(loadCount),
    loadLfddShedMw: floats(loadCount),
    storageOutputs: [],
    externalOutputs: [],
    actions: [],
    extremes: { minimumHz: 0, minimumAtSeconds: 0, maximumHz: 0, maximumAtSeconds: 0 },
    hasExtremes: false,
    loadShedFraction: floats(loadCount),
    shedFractionsOf: null,
    version: 0,
  }
}

const recordEntry = <T>(record: Readonly<Record<string, T>>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined

/** Whether a record holds exactly the given ids. */
const holdsExactly = (record: Readonly<Record<string, unknown>>, ids: ReadonlyArray<string>): boolean => {
  let count = 0
  for (const id in record) if (Object.hasOwn(record, id)) count += 1
  return count === ids.length && ids.every(id => Object.hasOwn(record, id))
}

/**
 * Sets the workspace state from an IslandFrequencyState of the same island and members; a state
 * of other members is an error (validateIslandInput reports which ids differ).
 */
export const loadFrequencyState = (workspace: IslandFrequencyWorkspace, state: IslandFrequencyState): void => {
  if (state.islandId !== workspace.islandId) throw new Error(`frequency state belongs to island ${state.islandId}, not ${workspace.islandId}`)
  if (state.automationId !== workspace.automationId) throw new Error(`frequency state was created for automation ${state.automationId}, not ${workspace.automationId}`)
  if (!holdsExactly(state.units, workspace.unitIds) || !holdsExactly(state.storage, workspace.storageIds) || !holdsExactly(state.externals, workspace.externalIds)) {
    throw new Error(`frequency state of island ${state.islandId} does not hold exactly the island's units, storage and external systems`)
  }
  workspace.elapsedSeconds = state.elapsedSeconds
  workspace.frequencyHz = state.frequencyHz
  workspace.rocofHzPerSecond = state.rocofHzPerSecond
  workspace.unitIds.forEach((id, position) => {
    const unit = recordEntry(state.units, id)!
    workspace.scheduledMw[position] = unit.scheduledMw
    workspace.fcrNMw[position] = unit.fcrNMw
    workspace.fcrDUpMw[position] = unit.fcrDUpMw
    workspace.fcrDDownMw[position] = unit.fcrDDownMw
    workspace.afrrMw[position] = unit.afrrMw
    workspace.mfrrRamp[position] = unit.mfrr
    workspace.protection[position] = unit.protection
  })
  workspace.storageIds.forEach((id, position) => { workspace.storage[position] = recordEntry(state.storage, id)! })
  workspace.externalIds.forEach((id, position) => { workspace.externals[position] = recordEntry(state.externals, id)! })
  workspace.agc = state.agc
  workspace.mfrr = state.mfrr
  workspace.lfdd = state.lfdd
  workspace.version += 1
}

/** The unit state of position `position` as published (UnitFrequencyState). */
const unitStateOf = (workspace: IslandFrequencyWorkspace, position: number): UnitFrequencyState => ({
  scheduledMw: workspace.scheduledMw[position]!,
  fcrNMw: workspace.fcrNMw[position]!,
  fcrDUpMw: workspace.fcrDUpMw[position]!,
  fcrDDownMw: workspace.fcrDDownMw[position]!,
  afrrMw: workspace.afrrMw[position]!,
  mfrr: workspace.mfrrRamp[position]!,
  protection: workspace.protection[position]!,
})

/** The workspace state as an IslandFrequencyState (records in member order). */
export const frequencyStateOf = (workspace: IslandFrequencyWorkspace): IslandFrequencyState => {
  const units: Record<string, UnitFrequencyState> = {}
  workspace.unitIds.forEach((id, position) => { units[id] = unitStateOf(workspace, position) })
  const storage: Record<string, StorageFrequencyState> = {}
  workspace.storageIds.forEach((id, position) => { storage[id] = workspace.storage[position]! })
  const externals: Record<string, ExternalFrequencyState> = {}
  workspace.externalIds.forEach((id, position) => { externals[id] = workspace.externals[position]! })
  return {
    islandId: workspace.islandId,
    automationId: workspace.automationId,
    elapsedSeconds: workspace.elapsedSeconds,
    frequencyHz: workspace.frequencyHz,
    rocofHzPerSecond: workspace.rocofHzPerSecond,
    units,
    storage,
    externals,
    agc: workspace.agc,
    mfrr: workspace.mfrr,
    lfdd: workspace.lfdd,
  }
}

/** Replaces the LFDD state, as a restore or re-arm command does. */
export const setWorkspaceLfdd = (workspace: IslandFrequencyWorkspace, lfdd: LfddState): void => {
  workspace.lfdd = lfdd
  workspace.version += 1
}

/** Explicit reset of unit `position`'s protection trip; the unit then returns through its normal start-up. */
export const resetWorkspaceUnitProtection = (automation: GridAutomation, workspace: IslandFrequencyWorkspace, position: number): void => {
  workspace.protection[position] = resetGeneratorProtection(automation.generatorProtection, workspace.protection[position]!, workspace.unitIds[position]!)
  workspace.version += 1
}
