import type { GridAutomation } from '../../schemas/grid-automation.ts'
import { advanceRelayTimer } from './relay-timer.ts'
import type { FrequencyLoad, FrequencyLoadPriority } from './types.ts'

/**
 * armed: the relay can operate. operated: its feeders are open and stay open until an
 * explicit restore. disarmed: restored but not yet re-armed, so step-wise restoration
 * cannot re-trip it.
 */
export type LfddStageStatus = 'armed' | 'operated' | 'disarmed'

export interface LfddStageState {
  readonly status: LfddStageStatus
  readonly belowThresholdSeconds: number
  readonly operatedAtSeconds: number | null
  /** Share of each load's demand this stage disconnected. */
  readonly shedFractionByLoad: Readonly<Record<string, number>>
}

export interface LfddState {
  readonly stages: Readonly<Record<string, LfddStageState>>
}

export interface LfddOperation {
  readonly stageId: string
  readonly atSeconds: number
  readonly requestedMw: number
  readonly shedMw: number
  /** Demand the stage should have shed but no sheddable feeder remained for. */
  readonly shortfallMw: number
  readonly shedMwByLoad: Readonly<Record<string, number>>
}

const armedStage: LfddStageState = Object.freeze({ status: 'armed', belowThresholdSeconds: 0, operatedAtSeconds: null, shedFractionByLoad: Object.freeze({}) })

export const createLfddState = (config: GridAutomation['lfdd']): LfddState => ({
  stages: Object.fromEntries(config.stages.map(stage => [stage.id, armedStage])),
})

/** Total share of each load's demand disconnected by all operated stages. */
export const lfddShedFractionByLoad = (state: LfddState): ReadonlyMap<string, number> => {
  const totals = new Map<string, number>()
  for (const stage of Object.values(state.stages)) {
    for (const [loadId, fraction] of Object.entries(stage.shedFractionByLoad)) totals.set(loadId, (totals.get(loadId) ?? 0) + fraction)
  }
  return totals
}

/** Lowest priority is shed first; critical loads only once nothing else is left. */
const sheddingOrder: ReadonlyArray<FrequencyLoadPriority> = ['low', 'normal', 'high', 'critical']

const shedForStage = (requestedMw: number, loads: ReadonlyArray<FrequencyLoad>, shedFractions: ReadonlyMap<string, number>): Map<string, number> => {
  const shedMwByLoad = new Map<string, number>()
  let remainingMw = requestedMw
  for (const priority of sheddingOrder) {
    if (remainingMw <= 0) break
    const candidates = loads
      .filter(load => load.priority === priority && load.demandMw > 0)
      .map(load => ({ load, sheddableMw: Math.max(0, load.demandMw * (1 - (shedFractions.get(load.id) ?? 0)) - load.protectedMw) }))
      .filter(candidate => candidate.sheddableMw > 0)
    const availableMw = candidates.reduce((sum, candidate) => sum + candidate.sheddableMw, 0)
    if (availableMw <= 0) continue
    if (availableMw <= remainingMw) {
      for (const candidate of candidates) shedMwByLoad.set(candidate.load.id, candidate.sheddableMw)
      remainingMw -= availableMw
      continue
    }
    const share = remainingMw / availableMw
    for (const candidate of candidates) shedMwByLoad.set(candidate.load.id, candidate.sheddableMw * share)
    remainingMw = 0
  }
  return shedMwByLoad
}

/**
 * Advances every armed stage's relay over one sub-step and operates the stages whose delay has
 * elapsed, highest threshold first. An operated stage stays latched whatever the frequency does.
 */
export const evaluateLfdd = (config: GridAutomation['lfdd'], state: LfddState, input: {
  readonly previousFrequencyHz: number
  readonly frequencyHz: number
  readonly stepSeconds: number
  readonly nowSeconds: number
  readonly loads: ReadonlyArray<FrequencyLoad>
}): { readonly state: LfddState; readonly operations: ReadonlyArray<LfddOperation> } => {
  // Above every armed threshold with no relay timing, nothing can operate in this step.
  const low = Math.min(input.previousFrequencyHz, input.frequencyHz)
  if (config.stages.every(stage => {
    const current = state.stages[stage.id]
    return current !== undefined && (current.status !== 'armed' || (current.belowThresholdSeconds === 0 && low >= stage.thresholdHz))
  })) return { state, operations: [] }
  const stages: Record<string, LfddStageState> = { ...state.stages }
  const operations: LfddOperation[] = []
  const connectedDemandMw = input.loads.reduce((sum, load) => sum + load.demandMw, 0)
  for (const stage of config.stages) {
    const current = stages[stage.id]
    if (!current) throw new Error(`LFDD state has no stage ${stage.id}`)
    if (current.status !== 'armed') continue
    const belowThresholdSeconds = advanceRelayTimer({
      timerSeconds: current.belowThresholdSeconds,
      previousValue: input.previousFrequencyHz,
      value: input.frequencyHz,
      thresholdValue: stage.thresholdHz,
      direction: 'below',
      stepSeconds: input.stepSeconds,
    })
    if (belowThresholdSeconds === 0 || belowThresholdSeconds + 1e-9 < stage.delaySeconds) {
      stages[stage.id] = { ...current, belowThresholdSeconds }
      continue
    }
    const requestedMw = stage.shareOfLoad * connectedDemandMw
    const shedMwByLoad = shedForStage(requestedMw, input.loads, lfddShedFractionByLoad({ stages }))
    const shedMw = [...shedMwByLoad.values()].reduce((sum, mw) => sum + mw, 0)
    const demandById = new Map(input.loads.map(load => [load.id, load.demandMw]))
    stages[stage.id] = {
      status: 'operated',
      belowThresholdSeconds: 0,
      operatedAtSeconds: input.nowSeconds,
      shedFractionByLoad: Object.fromEntries([...shedMwByLoad].map(([loadId, mw]) => [loadId, mw / demandById.get(loadId)!])),
    }
    operations.push({
      stageId: stage.id,
      atSeconds: input.nowSeconds,
      requestedMw,
      shedMw,
      shortfallMw: Math.max(0, requestedMw - shedMw),
      shedMwByLoad: Object.fromEntries(shedMwByLoad),
    })
  }
  return { state: { stages }, operations }
}

/** Reconnects an operated stage's feeders. The stage stays disarmed until re-armed. */
export const restoreLfddStage = (state: LfddState, stageId: string): {
  readonly state: LfddState
  readonly reconnectedFractionByLoad: Readonly<Record<string, number>>
} => {
  const stage = state.stages[stageId]
  if (!stage) throw new Error(`unknown LFDD stage ${stageId}`)
  if (stage.status !== 'operated') throw new Error(`LFDD stage ${stageId} is ${stage.status}; only an operated stage can be restored`)
  return {
    state: { stages: { ...state.stages, [stageId]: { status: 'disarmed', belowThresholdSeconds: 0, operatedAtSeconds: null, shedFractionByLoad: {} } } },
    reconnectedFractionByLoad: stage.shedFractionByLoad,
  }
}

export const rearmLfddStage = (state: LfddState, stageId: string): LfddState => {
  const stage = state.stages[stageId]
  if (!stage) throw new Error(`unknown LFDD stage ${stageId}`)
  if (stage.status !== 'disarmed') throw new Error(`LFDD stage ${stageId} is ${stage.status}; only a restored stage can be re-armed`)
  return { stages: { ...state.stages, [stageId]: armedStage } }
}
