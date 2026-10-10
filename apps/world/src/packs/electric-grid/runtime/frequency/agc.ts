import type { GridAutomation } from '../../schemas/grid-automation.ts'
import type { FrequencyUnit } from './types.ts'

export type EnabledAfrr = Extract<GridAutomation['afrr'], { readonly enabled: true }>

/** Island load-frequency controller (aFRR). The request is signed: positive raises generation. */
export interface AgcState {
  readonly requestMw: number
  readonly previousErrorMw: number
  readonly nextCycleAtSeconds: number
}

export const createAgcState = (startSeconds: number): AgcState => ({ requestMw: 0, previousErrorMw: 0, nextCycleAtSeconds: startSeconds })

export interface AgcCycleInput {
  readonly frequencyHz: number
  readonly nominalFrequencyHz: number
  /** Frequency bias B of the island, MW/Hz. */
  readonly frequencyBiasMwPerHz: number
  readonly tieLineDeviationMw?: number
  /** Allocated aFRR of the island's synchronised providers. */
  readonly upCapacityMw: number
  readonly downCapacityMw: number
}

export interface AgcCycleResult {
  readonly state: AgcState
  /** Area control error: tie-line deviation plus B·Δf; negative means a generation deficit. */
  readonly areaControlErrorMw: number
  /** Signed request as a share of allocated aFRR in its direction. */
  readonly utilisation: number
}

/**
 * One controller cycle in velocity form: the request moves by Kp·Δe + (cycle/Ti)·e and is
 * limited to the providers' full-activation ramp and allocated volume, so the integral
 * cannot wind up beyond what the providers deliver.
 */
export const runAgcCycle = (config: EnabledAfrr, state: AgcState, input: AgcCycleInput): AgcCycleResult => {
  const deviationHz = input.frequencyHz - input.nominalFrequencyHz
  let tieLineMw = 0
  if (config.controlMode === 'tie-line-bias') {
    if (input.tieLineDeviationMw === undefined) throw new Error('tie-line-bias aFRR needs the measured tie-line deviation')
    tieLineMw = input.tieLineDeviationMw
  }
  const areaControlErrorMw = tieLineMw + input.frequencyBiasMwPerHz * deviationHz
  const errorMw = -areaControlErrorMw
  const unlimited = state.requestMw + config.proportionalGain * (errorMw - state.previousErrorMw)
    + config.cycleSeconds / config.integralTimeSeconds * errorMw
  const rampCapacityMw = unlimited >= 0 ? input.upCapacityMw : input.downCapacityMw
  const maximumStepMw = rampCapacityMw * config.cycleSeconds / config.fullActivationSeconds
  const ramped = Math.min(state.requestMw + maximumStepMw, Math.max(state.requestMw - maximumStepMw, unlimited))
  const requestMw = Math.min(input.upCapacityMw, Math.max(-input.downCapacityMw, ramped))
  const capacity = requestMw >= 0 ? input.upCapacityMw : input.downCapacityMw
  return {
    state: { requestMw, previousErrorMw: errorMw, nextCycleAtSeconds: state.nextCycleAtSeconds + config.cycleSeconds },
    areaControlErrorMw,
    utilisation: capacity > 0 ? requestMw / capacity : 0,
  }
}

/** Splits a signed island request over synchronised providers by their allocation in that direction. */
export const distributeAfrrRequest = (requestMw: number, units: ReadonlyArray<FrequencyUnit>): ReadonlyMap<string, number> => {
  const allocation = (unit: FrequencyUnit): number => unit.synchronised ? requestMw >= 0 ? unit.reserves.afrrUpMw : unit.reserves.afrrDownMw : 0
  const total = units.reduce((sum, unit) => sum + allocation(unit), 0)
  return new Map(units.map(unit => [unit.id, total > 0 ? requestMw * allocation(unit) / total : 0]))
}

/** Allocated aFRR of the synchronised providers in each direction. */
export const afrrCapacity = (units: ReadonlyArray<FrequencyUnit>): { readonly upMw: number; readonly downMw: number } => ({
  upMw: units.reduce((sum, unit) => sum + (unit.synchronised ? unit.reserves.afrrUpMw : 0), 0),
  downMw: units.reduce((sum, unit) => sum + (unit.synchronised ? unit.reserves.afrrDownMw : 0), 0),
})
