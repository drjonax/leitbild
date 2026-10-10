import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { advanceRelayTimer } from './relay-timer.ts'

export type GeneratorTripCause = 'under-frequency' | 'over-frequency' | 'rocof'

export interface GeneratorTrip {
  readonly atSeconds: number
  readonly elementId: string
  readonly cause: GeneratorTripCause
}

export interface GeneratorProtectionState {
  /** Time each element's pick-up condition has continuously held, keyed by element id ("rocof" for RoCoF). */
  readonly timersSeconds: Readonly<Record<string, number>>
  readonly trip: GeneratorTrip | null
}

const rocofElementId = 'rocof'

export const createGeneratorProtectionState = (config: GridAutomation['generatorProtection']): GeneratorProtectionState => ({
  timersSeconds: Object.fromEntries([
    ...config.underFrequency.map(element => [element.id, 0] as const),
    ...config.overFrequency.map(element => [element.id, 0] as const),
    [rocofElementId, 0] as const,
  ]),
  trip: null,
})

/**
 * Advances the under-frequency, over-frequency and RoCoF elements of one synchronised unit
 * over a sub-step. The first element whose delay elapses trips the unit; a tripped unit
 * stays tripped until its protection is reset.
 */
export const evaluateGeneratorProtection = (config: GridAutomation['generatorProtection'], state: GeneratorProtectionState, input: {
  readonly previousFrequencyHz: number
  readonly frequencyHz: number
  readonly rocofHzPerSecond: number
  readonly stepSeconds: number
  readonly nowSeconds: number
}): GeneratorProtectionState => {
  if (state.trip) return state
  const timersSeconds: Record<string, number> = {}
  let trip: GeneratorTrip | null = null
  const timer = (elementId: string): number => {
    const value = state.timersSeconds[elementId]
    if (value === undefined) throw new Error(`generator protection state has no element ${elementId}`)
    return value
  }
  const consider = (elementId: string, cause: GeneratorTripCause, seconds: number, delaySeconds: number): void => {
    timersSeconds[elementId] = seconds
    if (!trip && seconds > 0 && seconds + 1e-9 >= delaySeconds) trip = { atSeconds: input.nowSeconds, elementId, cause }
  }
  for (const element of config.underFrequency) {
    consider(element.id, 'under-frequency', advanceRelayTimer({
      timerSeconds: timer(element.id), previousValue: input.previousFrequencyHz, value: input.frequencyHz,
      thresholdValue: element.thresholdHz, direction: 'below', stepSeconds: input.stepSeconds,
    }), element.delaySeconds)
  }
  for (const element of config.overFrequency) {
    consider(element.id, 'over-frequency', advanceRelayTimer({
      timerSeconds: timer(element.id), previousValue: input.previousFrequencyHz, value: input.frequencyHz,
      thresholdValue: element.thresholdHz, direction: 'above', stepSeconds: input.stepSeconds,
    }), element.delaySeconds)
  }
  const rocofSeconds = Math.abs(input.rocofHzPerSecond) > config.rocof.thresholdHzPerSecond ? timer(rocofElementId) + input.stepSeconds : 0
  consider(rocofElementId, 'rocof', rocofSeconds, config.rocof.delaySeconds)
  return { timersSeconds, trip }
}

/** Clears a protection trip so the unit can be returned to service by command. */
export const resetGeneratorProtection = (config: GridAutomation['generatorProtection'], state: GeneratorProtectionState, unitId: string): GeneratorProtectionState => {
  if (!state.trip) throw new Error(`unit ${unitId} has no protection trip to reset`)
  return createGeneratorProtectionState(config)
}
