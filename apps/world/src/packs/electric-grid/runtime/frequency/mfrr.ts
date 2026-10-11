import type { GridAutomation } from '../../schemas/grid-automation.ts'
import type { FrequencyUnit } from './types.ts'

export type EnabledMfrr = Extract<GridAutomation['mfrr'], { readonly enabled: true }>

/** Tracks how long aFRR utilisation has stayed beyond the activation threshold in one direction. */
export interface MfrrState {
  readonly sustainedSeconds: number
  readonly sustainedDirection: 'up' | 'down' | null
}

export const createMfrrState = (): MfrrState => ({ sustainedSeconds: 0, sustainedDirection: null })

/** One unit's mFRR activation: holds fromMw through the preparation time, then ramps linearly to toMw by full activation. */
export interface MfrrUnitRamp {
  readonly fromMw: number
  readonly toMw: number
  readonly startedAtSeconds: number
}

export const idleMfrrRamp: MfrrUnitRamp = Object.freeze({ fromMw: 0, toMw: 0, startedAtSeconds: 0 })

/** An activation holds its previous level through the preparation time, then ramps linearly until full activation. */
export interface MfrrTiming {
  readonly preparationSeconds: number
  readonly fullActivationSeconds: number
}

export const mfrrTiming = (config: EnabledMfrr): MfrrTiming => ({ preparationSeconds: config.preparationSeconds, fullActivationSeconds: config.fullActivationSeconds })

export const mfrrOutputMw = (ramp: MfrrUnitRamp, nowSeconds: number, timing: MfrrTiming): number => {
  const progress = (nowSeconds - ramp.startedAtSeconds - timing.preparationSeconds) / (timing.fullActivationSeconds - timing.preparationSeconds)
  return progress >= 1 ? ramp.toMw : progress <= 0 ? ramp.fromMw : ramp.fromMw + (ramp.toMw - ramp.fromMw) * progress
}

export const mfrrRampInProgress = (ramp: MfrrUnitRamp, nowSeconds: number, timing: MfrrTiming): boolean =>
  ramp.fromMw !== ramp.toMw && nowSeconds < ramp.startedAtSeconds + timing.fullActivationSeconds

/**
 * Once aFRR utilisation has exceeded the threshold for the sustained time, requests mFRR equal
 * to all activated aFRR and FCR, so that both are freed as the mFRR ramps in. No new request
 * is made while an earlier activation is still ramping.
 */
export const evaluateMfrr = (config: EnabledMfrr, state: MfrrState, input: {
  readonly afrrUtilisation: number
  /** Signed sum of activated aFRR and FCR in the island; positive is upward. */
  readonly activatedReservesMw: number
  readonly cycleSeconds: number
  readonly rampInProgress: boolean
}): { readonly state: MfrrState; readonly activationMw: number } => {
  const threshold = config.afrrUtilisationThresholdFraction
  const direction = input.afrrUtilisation >= threshold ? 'up' : input.afrrUtilisation <= -threshold ? 'down' : null
  if (direction === null) return { state: createMfrrState(), activationMw: 0 }
  const sustainedSeconds = direction === state.sustainedDirection ? state.sustainedSeconds + input.cycleSeconds : input.cycleSeconds
  const sameDirection = direction === 'up' ? input.activatedReservesMw > 0 : input.activatedReservesMw < 0
  if (sustainedSeconds + 1e-9 < config.sustainedSeconds || input.rampInProgress || !sameDirection
    || Math.abs(input.activatedReservesMw) < config.minimumActivationMw) {
    return { state: { sustainedSeconds, sustainedDirection: direction }, activationMw: 0 }
  }
  return { state: createMfrrState(), activationMw: input.activatedReservesMw }
}

/**
 * Adds a signed activation to the units' mFRR levels in proportion to the room each has left
 * within its allocation in that direction. Returns the new levels and any part that no
 * provider could take.
 */
export const distributeMfrrActivation = (
  activationMw: number,
  units: ReadonlyArray<FrequencyUnit>,
  levels: ReadonlyMap<string, number>,
): { readonly levels: ReadonlyMap<string, number>; readonly activatedMw: number; readonly shortfallMw: number } => {
  // A unit takes activation up to its allocated mFRR and to the physical room its set-point leaves
  // between minimum and maximum output.
  const room = (unit: FrequencyUnit): number => {
    if (!unit.synchronised) return 0
    const level = levels.get(unit.id)!
    return activationMw >= 0
      ? Math.max(0, Math.min(unit.reserves.mfrrUpMw - level, unit.maximumMw - unit.targetMw - level))
      : Math.max(0, Math.min(unit.reserves.mfrrDownMw + level, unit.targetMw + level - unit.minimumMw))
  }
  const totalRoom = units.reduce((sum, unit) => sum + room(unit), 0)
  const magnitude = Math.min(Math.abs(activationMw), totalRoom)
  const sign = activationMw >= 0 ? 1 : -1
  const next = new Map(levels)
  for (const unit of units) {
    if (totalRoom > 0) next.set(unit.id, levels.get(unit.id)! + sign * magnitude * room(unit) / totalRoom)
  }
  return { levels: next, activatedMw: sign * magnitude, shortfallMw: Math.abs(activationMw) - magnitude }
}
