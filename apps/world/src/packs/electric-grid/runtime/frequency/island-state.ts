import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { createAgcState, type AgcState } from './agc.ts'
import { createGeneratorProtectionState, resetGeneratorProtection, type GeneratorProtectionState, type GeneratorTripCause } from './generator-protection.ts'
import { createLfddState, rearmLfddStage, restoreLfddStage, type LfddOperation, type LfddState } from './lfdd.ts'
import { createMfrrState, idleMfrrRamp, type MfrrState, type MfrrUnitRamp } from './mfrr.ts'
import { createStorageFrequencyState, type StorageFrequencyState, type StorageOperatingState } from './storage.ts'
import type { IslandFrequencyInput } from './types.ts'

export interface UnitFrequencyState {
  /** Set-point following targetMw at the unit's ramp rate. */
  readonly scheduledMw: number
  readonly fcrNMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
  readonly afrrMw: number
  readonly mfrr: MfrrUnitRamp
  readonly protection: GeneratorProtectionState
}

/** Activated reserves of an external equivalent, in MW; positive raises its export into the island. */
export interface ExternalFrequencyState {
  readonly fcrNMw: number
  readonly fcrDUpMw: number
  readonly fcrDDownMw: number
  readonly afrrMw: number
}

export const idleExternalFrequencyState: ExternalFrequencyState = Object.freeze({ fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrMw: 0 })

/** Everything the frequency library owns for one synchronous island between advances. */
export interface IslandFrequencyState {
  readonly islandId: string
  readonly automationId: string
  readonly elapsedSeconds: number
  /** null once the island has collapsed (no synchronous machine left). */
  readonly frequencyHz: number | null
  readonly rocofHzPerSecond: number
  readonly units: Readonly<Record<string, UnitFrequencyState>>
  readonly storage: Readonly<Record<string, StorageFrequencyState>>
  readonly externals: Readonly<Record<string, ExternalFrequencyState>>
  readonly agc: AgcState | null
  readonly mfrr: MfrrState | null
  readonly lfdd: LfddState
}

export type FrequencyAction =
  | { readonly kind: 'generator-trip'; readonly unitId: string; readonly atSeconds: number; readonly elementId: string; readonly cause: GeneratorTripCause }
  | ({ readonly kind: 'lfdd-stage-operated' } & LfddOperation)
  | { readonly kind: 'mfrr-activated'; readonly atSeconds: number; readonly requestedMw: number; readonly activatedMw: number; readonly shortfallMw: number }
  | { readonly kind: 'storage-state-changed'; readonly storageId: string; readonly atSeconds: number; readonly from: StorageOperatingState; readonly to: StorageOperatingState }
  | { readonly kind: 'island-collapsed'; readonly atSeconds: number; readonly cause: 'no-synchronous-inertia' | 'under-frequency-beyond-model-range' | 'over-frequency-beyond-model-range' }

export const createUnitFrequencyState = (automation: GridAutomation, scheduledMw: number): UnitFrequencyState => ({
  scheduledMw,
  fcrNMw: 0,
  fcrDUpMw: 0,
  fcrDDownMw: 0,
  afrrMw: 0,
  mfrr: idleMfrrRamp,
  protection: createGeneratorProtectionState(automation.generatorProtection),
})

/** A steady starting state: synchronised units at their targets, no reserve activated. */
export const createIslandFrequencyState = (automation: GridAutomation, input: IslandFrequencyInput, config: {
  readonly frequencyHz: number
  readonly startSeconds: number
  readonly storageStateOfChargeFraction: Readonly<Record<string, number>>
}): IslandFrequencyState => {
  const state: IslandFrequencyState = {
    islandId: input.islandId,
    automationId: automation.id,
    elapsedSeconds: config.startSeconds,
    frequencyHz: config.frequencyHz,
    rocofHzPerSecond: 0,
    units: Object.fromEntries(input.units.map(unit => [unit.id, createUnitFrequencyState(automation, unit.synchronised ? unit.targetMw : 0)])),
    storage: Object.fromEntries(input.storage.map(unit => {
      const fraction = config.storageStateOfChargeFraction[unit.id]
      if (fraction === undefined) throw new Error(`no initial state of charge for storage ${unit.id}`)
      return [unit.id, createStorageFrequencyState(unit, fraction, config.startSeconds)]
    })),
    externals: Object.fromEntries(input.externals.map(external => [external.id, idleExternalFrequencyState])),
    agc: automation.afrr.enabled ? createAgcState(config.startSeconds) : null,
    mfrr: automation.mfrr.enabled ? createMfrrState() : null,
    lfdd: createLfddState(automation.lfdd),
  }
  validateIslandInput(automation, state, input)
  return state
}

/** Explicit restoration command: reconnects an operated LFDD stage, which then stays disarmed. */
export const restoreIslandLfddStage = (state: IslandFrequencyState, stageId: string): {
  readonly state: IslandFrequencyState
  readonly reconnectedFractionByLoad: Readonly<Record<string, number>>
} => {
  const restored = restoreLfddStage(state.lfdd, stageId)
  return { state: { ...state, lfdd: restored.state }, reconnectedFractionByLoad: restored.reconnectedFractionByLoad }
}

export const rearmIslandLfddStage = (state: IslandFrequencyState, stageId: string): IslandFrequencyState =>
  ({ ...state, lfdd: rearmLfddStage(state.lfdd, stageId) })

/** Explicit reset of a unit's protection trip; the unit then returns through its normal start-up. */
export const resetIslandGeneratorProtection = (automation: GridAutomation, state: IslandFrequencyState, unitId: string): IslandFrequencyState => {
  const unit = state.units[unitId]
  if (!unit) throw new Error(`island ${state.islandId} has no unit ${unitId}`)
  return { ...state, units: { ...state.units, [unitId]: { ...unit, protection: resetGeneratorProtection(automation.generatorProtection, unit.protection, unitId) } } }
}

const requireFinite = (value: number, subject: string, minimum?: number): void => {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`${subject} must be finite${minimum === undefined ? '' : ` and at least ${minimum}`}, got ${value}`)
  }
}

const reserveFields = ['fcrNMw', 'fcrDUpMw', 'fcrDDownMw', 'afrrUpMw', 'afrrDownMw', 'mfrrUpMw', 'mfrrDownMw'] as const

const requireSameIds = (kind: string, inputIds: ReadonlyArray<string>, stateRecord: Readonly<Record<string, unknown>>): void => {
  let stateCount = 0
  for (const id in stateRecord) if (Object.hasOwn(stateRecord, id)) stateCount += 1
  const input = new Set(inputIds)
  if (input.size === inputIds.length && stateCount === inputIds.length && inputIds.every(id => Object.hasOwn(stateRecord, id))) return
  if (input.size !== inputIds.length) throw new Error(`duplicate ${kind} ids in island input`)
  const stateIds = Object.keys(stateRecord)
  const missing = inputIds.filter(id => !Object.hasOwn(stateRecord, id))
  const extra = stateIds.filter(id => !input.has(id))
  throw new Error(`island ${kind} set changed without new frequency state (missing state: ${missing.join(', ') || 'none'}; not in input: ${extra.join(', ') || 'none'})`)
}

const finiteAtLeast = (value: number, minimum: number): boolean => Number.isFinite(value) && value >= minimum

/** The common case of one unit's checks, without building messages; failures are re-checked in detail. */
const unitPlainlyValid = (unit: IslandFrequencyInput['units'][number]): boolean => {
  const reserves = unit.reserves
  return finiteAtLeast(unit.ratedMva, Number.MIN_VALUE) && finiteAtLeast(unit.inertiaConstantSeconds, 0)
    && (unit.connection !== 'converter' || unit.inertiaConstantSeconds === 0)
    && finiteAtLeast(unit.minimumMw, 0) && finiteAtLeast(unit.maximumMw, unit.minimumMw)
    && finiteAtLeast(unit.rampRateMwPerSecond, Number.MIN_VALUE) && finiteAtLeast(unit.targetMw, 0)
    && (!unit.synchronised || (unit.targetMw >= unit.minimumMw && unit.targetMw <= unit.maximumMw))
    && finiteAtLeast(reserves.fcrNMw, 0) && finiteAtLeast(reserves.fcrDUpMw, 0) && finiteAtLeast(reserves.fcrDDownMw, 0)
    && finiteAtLeast(reserves.afrrUpMw, 0) && finiteAtLeast(reserves.afrrDownMw, 0) && finiteAtLeast(reserves.mfrrUpMw, 0) && finiteAtLeast(reserves.mfrrDownMw, 0)
}

/** Validates an island input against its state before an advance. */
export const validateIslandInput = (automation: GridAutomation, state: IslandFrequencyState, input: IslandFrequencyInput): void => {
  if (state.islandId !== input.islandId) throw new Error(`frequency state belongs to island ${state.islandId}, not ${input.islandId}`)
  if (state.automationId !== automation.id) throw new Error(`frequency state was created for automation ${state.automationId}, not ${automation.id}`)
  requireSameIds('unit', input.units.map(unit => unit.id), state.units)
  requireSameIds('storage', input.storage.map(unit => unit.id), state.storage)
  requireSameIds('external equivalent', input.externals.map(external => external.id), state.externals)
  requireFinite(input.lossesMw, `island ${input.islandId} losses`, 0)
  requireFinite(input.fixedInjectionMw, `island ${input.islandId} fixed injection`)
  if (input.tieLineDeviationMw !== undefined) requireFinite(input.tieLineDeviationMw, 'tie-line deviation')
  const fcrNClasses: ReadonlyArray<string> = automation.fcrN.eligibleGovernorClasses
  const fcrDClasses: ReadonlyArray<string> = automation.fcrD.eligibleGovernorClasses
  const afrrClasses: ReadonlyArray<string> | null = automation.afrr.enabled ? automation.afrr.eligibleGovernorClasses : null
  const mfrrClasses: ReadonlyArray<string> | null = automation.mfrr.enabled ? automation.mfrr.eligibleGovernorClasses : null
  for (const unit of input.units) {
    const reserved = unit.reserves
    const eligible = (reserved.fcrNMw === 0 || fcrNClasses.includes(unit.governorClass))
      && ((reserved.fcrDUpMw === 0 && reserved.fcrDDownMw === 0) || fcrDClasses.includes(unit.governorClass))
      && ((reserved.afrrUpMw === 0 && reserved.afrrDownMw === 0) || (afrrClasses !== null && afrrClasses.includes(unit.governorClass)))
      && ((reserved.mfrrUpMw === 0 && reserved.mfrrDownMw === 0) || (mfrrClasses !== null && mfrrClasses.includes(unit.governorClass)))
    if (eligible && unitPlainlyValid(unit) && !(unit.synchronised && state.units[unit.id]!.protection.trip)) continue
    const subject = `unit ${unit.id}`
    requireFinite(unit.ratedMva, `${subject} rated MVA`, Number.MIN_VALUE)
    requireFinite(unit.inertiaConstantSeconds, `${subject} inertia constant`, 0)
    if (unit.connection === 'converter' && unit.inertiaConstantSeconds !== 0) throw new Error(`${subject} is converter-connected and cannot carry inertia`)
    requireFinite(unit.minimumMw, `${subject} minimum output`, 0)
    requireFinite(unit.maximumMw, `${subject} maximum output`, unit.minimumMw)
    requireFinite(unit.rampRateMwPerSecond, `${subject} ramp rate`, Number.MIN_VALUE)
    requireFinite(unit.targetMw, `${subject} target`, 0)
    if (unit.synchronised && (unit.targetMw < unit.minimumMw || unit.targetMw > unit.maximumMw)) {
      throw new Error(`${subject} target ${unit.targetMw} MW lies outside ${unit.minimumMw}..${unit.maximumMw} MW`)
    }
    for (const field of reserveFields) requireFinite(reserved[field], `${subject} ${field}`, 0)
    const isEligible = (classes: ReadonlyArray<string>): boolean => classes.includes(unit.governorClass)
    if ((reserved.fcrNMw > 0 && !isEligible(automation.fcrN.eligibleGovernorClasses))
      || ((reserved.fcrDUpMw > 0 || reserved.fcrDDownMw > 0) && !isEligible(automation.fcrD.eligibleGovernorClasses))
      || ((reserved.afrrUpMw > 0 || reserved.afrrDownMw > 0) && !(automation.afrr.enabled && isEligible(automation.afrr.eligibleGovernorClasses)))
      || ((reserved.mfrrUpMw > 0 || reserved.mfrrDownMw > 0) && !(automation.mfrr.enabled && isEligible(automation.mfrr.eligibleGovernorClasses)))) {
      throw new Error(`${subject} holds a reserve its governor class ${unit.governorClass} cannot provide under automation ${automation.id}`)
    }
    const trip = state.units[unit.id]!.protection.trip
    if (unit.synchronised && trip) {
      throw new Error(`${subject} was tripped by ${trip.cause} protection (${trip.elementId}) at ${trip.atSeconds} s and must be applied as out of service or reset first`)
    }
  }
  for (const unit of input.storage) {
    const subject = `storage ${unit.id}`
    requireFinite(unit.maximumDischargeMw, `${subject} maximum discharge`, 0)
    requireFinite(unit.maximumChargeMw, `${subject} maximum charge`, 0)
    requireFinite(unit.energyCapacityMwh, `${subject} energy capacity`, Number.MIN_VALUE)
    if (!(unit.chargeEfficiency > 0 && unit.chargeEfficiency <= 1)) throw new Error(`${subject} charge efficiency must lie in (0, 1]`)
    if (!(unit.dischargeEfficiency > 0 && unit.dischargeEfficiency <= 1)) throw new Error(`${subject} discharge efficiency must lie in (0, 1]`)
    if (!(unit.scheduledMw <= unit.maximumDischargeMw && unit.scheduledMw >= -unit.maximumChargeMw)) {
      throw new Error(`${subject} schedule ${unit.scheduledMw} MW exceeds its ratings`)
    }
  }
  for (const load of input.loads) {
    if (finiteAtLeast(load.demandMw, 0) && finiteAtLeast(load.protectedMw, 0)) continue
    requireFinite(load.demandMw, `load ${load.id} demand`, 0)
    requireFinite(load.protectedMw, `load ${load.id} protected demand`, 0)
  }
  for (const external of input.externals) {
    const subject = `external equivalent ${external.id}`
    requireFinite(external.kineticEnergyMws, `${subject} kinetic energy`, Number.MIN_VALUE)
    requireFinite(external.scheduledImportMw, `${subject} scheduled import`)
    requireFinite(external.loadMw, `${subject} load`, 0)
    for (const [field, value] of Object.entries(external.reserves)) requireFinite(value, `${subject} ${field}`, 0)
    if ((external.reserves.afrrUpMw > 0 || external.reserves.afrrDownMw > 0) && !automation.afrr.enabled) {
      throw new Error(`${subject} holds aFRR, which automation ${automation.id} does not run`)
    }
  }
}
