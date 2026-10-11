import type { GridLoadDefinition } from '../grid-model.ts'
import { queueGridSignal } from './grid-signals.ts'
import type { GridLoadState, GridRuntimeInstance } from './instance.ts'

// Manual load reduction has two tiers. Curtailment uses a load's interruptible demand (contractual
// or technical flexibility from the Model) and needs no emergency; shedding beyond it is emergency
// shedding and must say so. Neither ever disconnects critical demand, and a load whose priority is
// critical is never reduced by hand. LFDD is automatic and keeps its own priority order.

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`

/** Interruptible demand an EV charging schedule below the modelled demand has not used (MW). */
export const remainingInterruptibleMw = (definition: GridLoadDefinition, state: GridLoadState): number =>
  Math.max(0, definition.interruptibleMw - Math.max(0, state.modelledDemandMw - state.nominalDemandMw))

/**
 * Why a manual limit of `targetMw` on a load drawing `demandMw` is not allowed, or null when it is.
 * Without `emergency` the reduction must stay within the load's remaining interruptible demand.
 */
export const manualShedRejection = (config: {
  readonly definition: GridLoadDefinition
  readonly state: GridLoadState
  readonly demandMw: number
  readonly targetMw: number
  readonly emergency: boolean
}): string | null => {
  const { definition, state, demandMw, targetMw, emergency } = config
  if (definition.priority === 'critical') return `load Grid Asset ${definition.id} is critical in full; manual shedding never disconnects it`
  if (targetMw < definition.criticalMw) return `target demand ${mw(targetMw)} is below the critical demand ${mw(definition.criticalMw)} of ${definition.id}, which cannot be shed`
  if (targetMw >= demandMw) return `target demand ${mw(targetMw)} would shed nothing: ${definition.id} currently draws ${mw(demandMw)}`
  if (emergency) return null
  const interruptibleMw = remainingInterruptibleMw(definition, state)
  if (demandMw - targetMw <= interruptibleMw + 1e-9) return null
  const lowestMw = Math.max(definition.criticalMw, demandMw - interruptibleMw)
  return `shedding ${definition.id} to ${mw(targetMw)} disconnects ${mw(demandMw - targetMw)}, beyond its ${mw(interruptibleMw)} of interruptible demand`
    + `${interruptibleMw < definition.interruptibleMw ? ` (${mw(definition.interruptibleMw)} less what its EV schedule uses)` : ''}: `
    + `curtailment goes no lower than ${mw(lowestMw)}; set emergency to shed down to its critical demand ${mw(definition.criticalMw)}`
}

/** Demand the manual limit disconnects in this demand sample: within the interruptible demand unless the limit is emergency shedding. */
export const manualCurtailmentMw = (definition: GridLoadDefinition, state: GridLoadState): number => {
  const limitMw = state.manualDemandLimitMw
  if (limitMw === null) return 0
  const requestedMw = Math.max(0, state.demandMw - Math.max(definition.criticalMw, limitMw))
  return state.manualShedEmergency ? requestedMw : Math.min(requestedMw, remainingInterruptibleMw(definition, state))
}

/** Records emergency shedding as a Simulation Run signal next to the command that set it. */
export const queueEmergencyShed = (grid: GridRuntimeInstance, definition: GridLoadDefinition, state: GridLoadState): void => {
  const clock = grid.alarms.clock
  if (clock === null) throw new Error(`Grid ${grid.definition.gridId} has not been solved yet; advance the Grid first`)
  queueGridSignal(grid, {
    type: 'electric-grid.load.emergency-shed',
    severity: 'warning',
    key: `emergency-shed|${definition.id}|${clock.elapsedMs}|${state.manualDemandLimitMw}`,
    payload: {
      gridId: grid.definition.gridId,
      loadId: definition.id,
      label: definition.label,
      targetDemandMw: state.manualDemandLimitMw,
      demandMw: state.demandMw,
      interruptibleMw: definition.interruptibleMw,
      criticalMw: definition.criticalMw,
      islandId: grid.busStates.get(definition.busId)!.islandId,
      simulationTime: clock.at,
      elapsedSeconds: clock.elapsedMs / 1_000,
    },
  })
}
