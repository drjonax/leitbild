import { gridFrequencyStep, gridGeneratorIsOnline } from './dynamics.ts'
import type { GridRuntimeInstance, GridTopologyPlan } from './instance.ts'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const ramp = (current: number, target: number, maxDelta: number): number =>
  target > current ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta)

/**
 * Per-island primary frequency response, storage response, under-frequency
 * load shedding, and the aggregate frequency step. Returns the new frequency
 * of every island in the topology plan.
 */
export const advanceGridFrequencyControl = (
  grid: GridRuntimeInstance,
  plan: GridTopologyPlan,
  dynamicSeconds: number,
): Map<string, number> => {
  const model = grid.definition.model
  const frequencyByIsland = new Map<string, number>()
  for (const island of plan.islands) {
    const generators = island.generators
    const loads = island.loads
    const storage = island.storage
    const previousHz = grid.frequencyByIsland.get(island.id) ?? model.nominalFrequencyHz
    const reserveMw = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw)) : 0)
    }, 0)
    const downwardMw = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? state.dispatchMw : 0)
    }, 0)
    const requestedResponseMw = clamp(
      (model.nominalFrequencyHz - previousHz) * grid.definition.automation.primaryFrequencyResponseMwPerHz,
      -downwardMw,
      reserveMw,
    )
    for (const generator of generators) {
      const state = grid.generators.get(generator.id)!
      if (!gridGeneratorIsOnline(state.state)) {
        state.dispatchMw = ramp(state.dispatchMw, 0, generator.rampRateMwPerMinute * dynamicSeconds / 60)
        continue
      }
      const responseBasis = requestedResponseMw >= 0
        ? Math.min(state.reserveMw, Math.max(0, state.availableMw - state.dispatchMw))
        : state.dispatchMw
      const responseTotal = requestedResponseMw >= 0 ? reserveMw : downwardMw
      const responseMw = responseTotal <= 0 ? 0 : requestedResponseMw * responseBasis / responseTotal
      const target = clamp(state.targetMw + responseMw, 0, state.availableMw)
      const primaryRampMw = Math.abs(responseMw) * dynamicSeconds / 5
      state.dispatchMw = ramp(state.dispatchMw, target, Math.max(generator.rampRateMwPerMinute * dynamicSeconds / 60, primaryRampMw))
    }
    const internalGenerationMw = generators.reduce((sum, generator) => sum + grid.generators.get(generator.id)!.dispatchMw, 0)
    const externalConnections = [...grid.externalConnections.values()].filter(connection => island.busSet.has(connection.busId) && connection.connected)
    const externalGenerationMw = externalConnections.reduce((sum, connection) => sum + connection.systemActivePowerMw, 0)
    const inertiaSeconds = generators.reduce((sum, generator) => {
      const state = grid.generators.get(generator.id)!
      return sum + (gridGeneratorIsOnline(state.state) ? generator.inertiaSeconds * Math.max(0.1, state.dispatchMw / Math.max(1, generator.capacityMw)) : 0)
    }, 0) + externalConnections.reduce((sum, connection) => sum
      + (connection.definition.systemInertiaSeconds ?? 0)
        * Math.max(0.1, Math.max(0, connection.systemActivePowerMw) / Math.max(1, connection.definition.maximumSystemExportMw)), 0)
    for (const item of storage) {
      const state = grid.storage.get(item.id)!
      const canDischarge = state.stateOfChargeFraction > 0.02
      const canCharge = state.stateOfChargeFraction < 0.98
      state.dispatchMw = !grid.definition.automation.storageFrequencyResponse
        ? 0
        : previousHz < model.nominalFrequencyHz - 0.15 && canDischarge
          ? item.maxDischargeMw
          : previousHz > model.nominalFrequencyHz + 0.08 && canCharge
            ? -item.maxChargeMw
            : 0
      const energyMwh = state.dispatchMw >= 0
        ? state.dispatchMw * dynamicSeconds / 3_600 / 0.92
        : state.dispatchMw * dynamicSeconds / 3_600 * 0.92
      state.stateOfChargeFraction = clamp(state.stateOfChargeFraction - energyMwh / item.capacityMwh, 0, 1)
      state.state = state.dispatchMw > 0 ? 'discharging' : state.dispatchMw < 0 ? 'charging' : 'idle'
    }
    const shedFraction = !grid.definition.automation.underFrequencyLoadShedding
      ? 0
      : previousHz < model.nominalFrequencyHz - 0.85
        ? 0.45
        : previousHz < model.nominalFrequencyHz - 0.65
          ? 0.28
          : previousHz < model.nominalFrequencyHz - 0.35
            ? 0.12
            : 0
    for (const load of loads) {
      const state = grid.loads.get(load.id)!
      const interruptibleMw = Math.max(0, state.demandMw - load.criticalMw)
      state.shedMw = interruptibleMw * shedFraction
      state.servedMw = Math.max(load.criticalMw, state.demandMw - state.shedMw)
    }
    const servedLoadMw = loads.reduce((sum, load) => sum + grid.loads.get(load.id)!.servedMw, 0)
    const storageGenerationMw = storage.reduce((sum, item) => sum + grid.storage.get(item.id)!.dispatchMw, 0)
    const frequencyHz = gridFrequencyStep({
      nominalHz: model.nominalFrequencyHz,
      previousHz,
      generationMw: internalGenerationMw + externalGenerationMw + storageGenerationMw,
      loadMw: servedLoadMw,
      inertiaSeconds,
      dtSeconds: dynamicSeconds,
    })
    frequencyByIsland.set(island.id, frequencyHz)
    for (const load of loads) {
      const state = grid.loads.get(load.id)!
      state.frequencyHz = frequencyHz
      state.serviceState = state.servedMw <= 0 ? 'outage' : state.shedMw > 0 ? 'shed' : Math.abs(frequencyHz - model.nominalFrequencyHz) >= 0.2 ? 'constrained' : 'normal'
    }
    for (const item of storage) {
      const state = grid.storage.get(item.id)!
      state.frequencyHz = frequencyHz
    }
    for (const generator of generators) grid.generators.get(generator.id)!.frequencyHz = frequencyHz
  }
  return frequencyByIsland
}
