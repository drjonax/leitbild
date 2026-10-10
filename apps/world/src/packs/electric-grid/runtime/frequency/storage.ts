import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { fcrDDownActivation, fcrDUpActivation } from './governors.ts'
import type { ResponseElement } from './swing.ts'
import type { FrequencyStorageUnit } from './types.ts'

export type StorageOperatingState = 'idle' | 'charging' | 'discharging' | 'disconnected'
export type FfrPhase = 'armed' | 'active' | 'deactivating' | 'recovering'

export interface StorageFrequencyState {
  /** Frequency response on top of the schedule; positive discharges. */
  readonly responseMw: number
  readonly stateOfChargeFraction: number
  readonly operatingState: StorageOperatingState
  readonly ffrPhase: FfrPhase
  readonly ffrPhaseStartedAtSeconds: number
}

// Output below 0.1 % of the larger rating is reported as idle (metering resolution).
const idleResolutionFraction = 0.001

const secondsPerHour = 3_600

export const storageOperatingState = (unit: FrequencyStorageUnit, powerMw: number): StorageOperatingState => {
  if (!unit.connected) return 'disconnected'
  const resolutionMw = idleResolutionFraction * Math.max(unit.maximumDischargeMw, unit.maximumChargeMw)
  return powerMw > resolutionMw ? 'discharging' : powerMw < -resolutionMw ? 'charging' : 'idle'
}

export const createStorageFrequencyState = (unit: FrequencyStorageUnit, stateOfChargeFraction: number, nowSeconds: number): StorageFrequencyState => {
  if (!(stateOfChargeFraction >= 0 && stateOfChargeFraction <= 1)) throw new Error(`storage ${unit.id} state of charge must be within 0..1`)
  return {
    responseMw: 0,
    stateOfChargeFraction,
    operatingState: storageOperatingState(unit, unit.connected ? unit.scheduledMw : 0),
    ffrPhase: 'armed',
    ffrPhaseStartedAtSeconds: nowSeconds,
  }
}

export interface StorageSubStepPlan {
  readonly scheduledMw: number
  /** True when the energy left within the step limits the schedule or the response. */
  readonly limitedByStateOfCharge: boolean
  readonly upCapMw: number
  readonly downCapMw: number
  /** Lagged response for droop and FCR-D modes. */
  readonly element: ResponseElement | null
  /** Ramped FFR response, linear from start to end of the step. */
  readonly ffr: { readonly startMw: number; readonly endMw: number } | null
  readonly ffrPhase: FfrPhase
  readonly ffrPhaseStartedAtSeconds: number
}

type StorageConfig = GridAutomation['storage']

const stateOfChargeLimits = (config: StorageConfig): { readonly minimumFraction: number; readonly maximumFraction: number } =>
  config.mode === 'off' ? { minimumFraction: 0, maximumFraction: 1 } : config.stateOfChargeLimits

const limited = (outputMw: number, upMw: number, downMw: number): number => Math.min(upMw, Math.max(-downMw, outputMw))

/**
 * Plans one sub-step: power limits from the ratings and from the energy left before the
 * state-of-charge limits are reached within this step, then the mode's response.
 */
export const planStorageSubStep = (config: StorageConfig, fcrD: GridAutomation['fcrD'], unit: FrequencyStorageUnit, state: StorageFrequencyState, input: {
  readonly frequencyHz: number
  readonly nominalFrequencyHz: number
  readonly nowSeconds: number
  readonly stepSeconds: number
}): StorageSubStepPlan => {
  const h = input.stepSeconds
  const limits = stateOfChargeLimits(config)
  const energyMws = unit.energyCapacityMwh * secondsPerHour
  const dischargeLimitMw = Math.min(unit.maximumDischargeMw, Math.max(0, state.stateOfChargeFraction - limits.minimumFraction) * energyMws * unit.dischargeEfficiency / h)
  const chargeLimitMw = Math.min(unit.maximumChargeMw, Math.max(0, limits.maximumFraction - state.stateOfChargeFraction) * energyMws / unit.chargeEfficiency / h)
  const scheduledMw = limited(unit.scheduledMw, dischargeLimitMw, chargeLimitMw)
  const upCapMw = dischargeLimitMw - scheduledMw
  const downCapMw = chargeLimitMw + scheduledMw
  const limitedByStateOfCharge = scheduledMw !== unit.scheduledMw || dischargeLimitMw < unit.maximumDischargeMw || chargeLimitMw < unit.maximumChargeMw
  const base = { scheduledMw, limitedByStateOfCharge, upCapMw, downCapMw }
  const outputMw = limited(state.responseMw, upCapMw, downCapMw)
  if (config.mode === 'off') {
    return { ...base, element: null, ffr: null, ffrPhase: state.ffrPhase, ffrPhaseStartedAtSeconds: state.ffrPhaseStartedAtSeconds }
  }
  if (config.mode === 'droop') {
    const fullDeviationHz = input.nominalFrequencyHz * config.droopPercent / 100
    return {
      ...base,
      element: {
        outputMw,
        timeConstantSeconds: config.timeConstantSeconds,
        target: frequencyHz => {
          const deviationHz = frequencyHz - input.nominalFrequencyHz
          const effectiveHz = Math.max(0, Math.abs(deviationHz) - config.deadbandHz)
          return deviationHz < 0
            ? Math.min(upCapMw, unit.maximumDischargeMw * effectiveHz / fullDeviationHz)
            : -Math.min(downCapMw, unit.maximumChargeMw * effectiveHz / fullDeviationHz)
        },
      },
      ffr: null,
      ffrPhase: state.ffrPhase,
      ffrPhaseStartedAtSeconds: state.ffrPhaseStartedAtSeconds,
    }
  }
  if (config.mode === 'fcr-d') {
    return {
      ...base,
      element: {
        outputMw,
        timeConstantSeconds: config.timeConstantSeconds,
        target: frequencyHz => fcrDUpActivation(frequencyHz, fcrD.up) * upCapMw - fcrDDownActivation(frequencyHz, fcrD.down) * downCapMw,
      },
      ffr: null,
      ffrPhase: state.ffrPhase,
      ffrPhaseStartedAtSeconds: state.ffrPhaseStartedAtSeconds,
    }
  }
  let phase = state.ffrPhase
  let startedAt = state.ffrPhaseStartedAtSeconds
  if (phase === 'armed' && input.frequencyHz <= config.triggerHz) {
    phase = 'active'
    startedAt = input.nowSeconds
  } else if (phase === 'active' && input.nowSeconds - startedAt + 1e-9 >= config.supportDurationSeconds) {
    phase = 'deactivating'
    startedAt = input.nowSeconds
  } else if (phase === 'recovering' && input.nowSeconds - startedAt + 1e-9 >= config.rearmDelaySeconds && input.frequencyHz > config.triggerHz) {
    phase = 'armed'
    startedAt = input.nowSeconds
  }
  const startMw = Math.max(0, outputMw)
  const endMw = phase === 'active'
    ? Math.min(upCapMw, startMw + unit.maximumDischargeMw * h / config.fullActivationSeconds)
    : phase === 'deactivating'
      ? Math.max(0, startMw - config.deactivationRateFractionPerSecond * unit.maximumDischargeMw * h)
      : 0
  return { ...base, element: null, ffr: { startMw, endMw }, ffrPhase: phase, ffrPhaseStartedAtSeconds: startedAt }
}

/** Applies the step's response to the state of charge and reports an operating-state change. */
export const completeStorageSubStep = (config: StorageConfig, unit: FrequencyStorageUnit, state: StorageFrequencyState, plan: StorageSubStepPlan, input: {
  readonly responseEndMw: number
  readonly responseEnergyMws: number
  readonly stepSeconds: number
  readonly nowSeconds: number
}): StorageFrequencyState => {
  const energyMws = plan.scheduledMw * input.stepSeconds + input.responseEnergyMws
  const capacityMws = unit.energyCapacityMwh * secondsPerHour
  const stateOfChargeFraction = energyMws >= 0
    ? state.stateOfChargeFraction - energyMws / unit.dischargeEfficiency / capacityMws
    : state.stateOfChargeFraction - energyMws * unit.chargeEfficiency / capacityMws
  const limits = stateOfChargeLimits(config)
  if (stateOfChargeFraction < limits.minimumFraction - 1e-9 || stateOfChargeFraction > limits.maximumFraction + 1e-9) {
    throw new Error(`storage ${unit.id} state of charge ${stateOfChargeFraction} left its limits within a sub-step`)
  }
  const ffrDone = plan.ffrPhase === 'deactivating' && input.responseEndMw <= 0
  return {
    responseMw: input.responseEndMw,
    stateOfChargeFraction,
    operatingState: storageOperatingState(unit, plan.scheduledMw + input.responseEndMw),
    ffrPhase: ffrDone ? 'recovering' : plan.ffrPhase,
    ffrPhaseStartedAtSeconds: ffrDone ? input.nowSeconds : plan.ffrPhaseStartedAtSeconds,
  }
}
