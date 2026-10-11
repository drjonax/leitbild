import type { CommandEnvelope } from '../../../core/model/index.ts'
import {
  gridClearDerateCommandKind,
  gridClearDeratePayloadSchema,
  gridCloseBranchCommandKind,
  gridCloseBranchPayloadSchema,
  gridDerateBranchCommandKind,
  gridDerateBranchPayloadSchema,
  gridOpenBranchCommandKind,
  gridOpenBranchPayloadSchema,
} from '../commands/branch.ts'
import {
  gridDispatchGeneratorCommandKind,
  gridDispatchGeneratorPayloadSchema,
  gridResetGeneratorTripCommandKind,
  gridResetGeneratorTripPayloadSchema,
  gridSetGeneratorAvailabilityCommandKind,
  gridSetGeneratorAvailabilityPayloadSchema,
  gridStartGeneratorCommandKind,
  gridStartGeneratorPayloadSchema,
  gridStopGeneratorCommandKind,
  gridStopGeneratorPayloadSchema,
  gridTripGeneratorCommandKind,
  gridTripGeneratorPayloadSchema,
} from '../commands/generator.ts'
import type { electricGridCommandKinds } from '../commands/index.ts'
import {
  gridRestoreLoadCommandKind,
  gridRestoreLoadPayloadSchema,
  gridSetEvChargingDemandCommandKind,
  gridSetEvChargingDemandPayloadSchema,
  gridShedLoadCommandKind,
  gridShedLoadPayloadSchema,
} from '../commands/load.ts'
import type { GridBranchDefinition, GridGeneratorDefinition, GridLoadDefinition } from '../grid-model.ts'
import type { GridBranchState, GridGeneratorState, GridLoadState, GridRuntimeInstance } from './instance.ts'
import { gridFrequencyCommandHandlers } from './lfdd-commands.ts'
import { gridLifecycleCommandHandlers } from './lifecycle-commands.ts'
import { manualShedRejection, queueEmergencyShed } from './load-shedding.ts'
import { synchroCheckBlockReason } from './synchro-check.ts'
import { generatorMinimumStableMw, generatorStartupSeconds } from './unit-commitment.ts'

export type GridCommandApplication =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Validates one command payload and applies it to the Grid; throws to reject. */
type GridCommandHandler = (grid: GridRuntimeInstance, rawPayload: unknown) => void

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`

const generatorFor = (grid: GridRuntimeInstance, assetId: string): { readonly definition: GridGeneratorDefinition; readonly state: GridGeneratorState } => {
  const entry = grid.definition.index.assetById.get(assetId)
  const state = grid.generators.get(assetId)
  if (entry?.kind !== 'generator' || !state) throw new Error(`generator Grid Asset not found: ${assetId}`)
  return { definition: entry.definition, state }
}

const branchFor = (grid: GridRuntimeInstance, assetId: string): { readonly definition: GridBranchDefinition; readonly state: GridBranchState } => {
  const entry = grid.definition.index.assetById.get(assetId)
  const state = grid.branches.get(assetId)
  if (entry?.kind !== 'branch' || !state) throw new Error(`branch Grid Asset not found: ${assetId}`)
  return { definition: entry.definition, state }
}

const loadFor = (grid: GridRuntimeInstance, assetId: string): { readonly definition: GridLoadDefinition; readonly state: GridLoadState } => {
  const entry = grid.definition.index.assetById.get(assetId)
  const state = grid.loads.get(assetId)
  if (entry?.kind !== 'load' || !state) throw new Error(`load Grid Asset not found: ${assetId}`)
  return { definition: entry.definition, state }
}

/** Manual shedding may limit any load down to its critical demand; a load that is critical in full cannot be shed. */
const sheddableLoadFor = (grid: GridRuntimeInstance, assetId: string): { readonly definition: GridLoadDefinition; readonly state: GridLoadState } => {
  const load = loadFor(grid, assetId)
  if (load.definition.priority === 'critical') throw new Error(`load Grid Asset ${assetId} is critical in full; manual shedding never disconnects it`)
  return load
}

/** EV charging schedules stay within the modelled demand: the Model carries no charger capacity above it. */
const evChargingMaximumMw = (grid: GridRuntimeInstance, definition: GridLoadDefinition): number =>
  definition.demandMw * grid.definition.operatingPoint.loadScale

const generatorHandlers = {
  [gridDispatchGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridDispatchGeneratorPayloadSchema.parse(rawPayload)
    const { definition, state } = generatorFor(grid, payload.assetId)
    if (state.state !== 'online') throw new Error(`generator ${payload.assetId} is ${state.state}; only an online unit can be dispatched`)
    if (payload.targetMw > state.availableMw) throw new Error(`dispatch target ${mw(payload.targetMw)} exceeds the available capacity ${mw(state.availableMw)} of ${payload.assetId}`)
    const minimumStableMw = generatorMinimumStableMw(definition)
    if (payload.targetMw < minimumStableMw) {
      throw new Error(`dispatch target ${mw(payload.targetMw)} is below the minimum stable generation ${mw(minimumStableMw)} of ${payload.assetId}; use stop-generator to take it off`)
    }
    if (payload.targetMw === state.targetMw) throw new Error(`generator ${payload.assetId} is already dispatched to ${mw(state.targetMw)}`)
    state.targetMw = payload.targetMw
  },
  [gridTripGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridTripGeneratorPayloadSchema.parse(rawPayload)
    const { state } = generatorFor(grid, payload.assetId)
    if (state.state === 'tripped' || state.state === 'offline') throw new Error(`generator ${payload.assetId} is already ${state.state}; there is nothing to trip`)
    state.state = 'tripped'
    state.dispatchMw = 0
    state.targetMw = 0
    state.synchronisesAtElapsedMs = null
  },
  [gridSetGeneratorAvailabilityCommandKind]: (grid, rawPayload) => {
    const payload = gridSetGeneratorAvailabilityPayloadSchema.parse(rawPayload)
    const { definition, state } = generatorFor(grid, payload.assetId)
    if (payload.availableMw > definition.capacityMw) throw new Error(`available capacity ${mw(payload.availableMw)} exceeds the installed capacity ${mw(definition.capacityMw)} of ${payload.assetId}`)
    if (payload.availableMw === state.availableMw) throw new Error(`generator ${payload.assetId} already has ${mw(state.availableMw)} available`)
    const minimumStableMw = generatorMinimumStableMw(definition)
    if (state.state !== 'offline' && state.state !== 'tripped' && (payload.availableMw <= 0 || payload.availableMw < minimumStableMw)) {
      const next = state.state === 'stopping' ? 'wait until it is offline or trip it' : 'use stop-generator or trip-generator first'
      throw new Error(`generator ${payload.assetId} is ${state.state} and needs at least its minimum stable generation ${mw(minimumStableMw)} available; ${next}`)
    }
    state.availableMw = payload.availableMw
    state.targetMw = Math.min(state.targetMw, state.availableMw)
    state.dispatchMw = Math.min(state.dispatchMw, state.availableMw)
  },
  [gridResetGeneratorTripCommandKind]: (grid, rawPayload) => {
    const payload = gridResetGeneratorTripPayloadSchema.parse(rawPayload)
    const { state } = generatorFor(grid, payload.assetId)
    if (state.state !== 'tripped') throw new Error(`generator ${payload.assetId} is ${state.state}, not tripped; there is no trip to reset`)
    state.state = 'offline'
  },
  [gridStartGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridStartGeneratorPayloadSchema.parse(rawPayload)
    const { definition, state } = generatorFor(grid, payload.assetId)
    if (state.state === 'tripped') throw new Error(`generator ${payload.assetId} is tripped; reset its trip with reset-generator-trip before starting it`)
    if (state.state !== 'offline') throw new Error(`generator ${payload.assetId} is already ${state.state}; only an offline unit can be started`)
    const startupSeconds = generatorStartupSeconds(definition)
    const minimumStableMw = generatorMinimumStableMw(definition)
    if (state.availableMw <= 0 || state.availableMw < minimumStableMw) {
      throw new Error(`generator ${payload.assetId} has ${mw(state.availableMw)} available, below what it needs to run (minimum stable generation ${mw(minimumStableMw)})`)
    }
    state.state = 'starting'
    state.targetMw = 0
    state.synchronisesAtElapsedMs = grid.elapsedMs + startupSeconds * 1_000
  },
  [gridStopGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridStopGeneratorPayloadSchema.parse(rawPayload)
    const { state } = generatorFor(grid, payload.assetId)
    if (state.state === 'starting') {
      state.state = 'offline'
      state.synchronisesAtElapsedMs = null
      return
    }
    if (state.state !== 'online') throw new Error(`generator ${payload.assetId} is ${state.state}; only a starting or online unit can be stopped`)
    state.state = state.dispatchMw > 0 ? 'stopping' : 'offline'
    state.targetMw = 0
  },
} satisfies Record<string, GridCommandHandler>

const branchHandlers = {
  [gridOpenBranchCommandKind]: (grid, rawPayload) => {
    const payload = gridOpenBranchPayloadSchema.parse(rawPayload)
    const { state } = branchFor(grid, payload.assetId)
    if (state.state === 'open') throw new Error(`branch ${payload.assetId} is already open`)
    if (state.state === 'tripped') throw new Error(`branch ${payload.assetId} is already open: its protection tripped it; reset-branch-protection leaves it open`)
    state.state = 'open'
    grid.topologyPlan = null
  },
  [gridCloseBranchCommandKind]: (grid, rawPayload) => {
    const payload = gridCloseBranchPayloadSchema.parse(rawPayload)
    const { definition, state } = branchFor(grid, payload.assetId)
    if (state.state === 'closed') throw new Error(`branch ${payload.assetId} is already closed`)
    if (state.state === 'tripped') throw new Error(`branch ${payload.assetId} was tripped by its ${state.protection.trip!.element} protection; reset it with reset-branch-protection before closing it`)
    const blocked = synchroCheckBlockReason(grid, definition)
    if (blocked !== null) throw new Error(blocked)
    state.state = 'closed'
    grid.topologyPlan = null
  },
  [gridDerateBranchCommandKind]: (grid, rawPayload) => {
    const payload = gridDerateBranchPayloadSchema.parse(rawPayload)
    const { state } = branchFor(grid, payload.assetId)
    if (payload.availability === state.availability) throw new Error(`branch ${payload.assetId} already has availability ${state.availability}`)
    state.availability = payload.availability
  },
  [gridClearDerateCommandKind]: (grid, rawPayload) => {
    const payload = gridClearDeratePayloadSchema.parse(rawPayload)
    const { state } = branchFor(grid, payload.assetId)
    if (state.availability === 1) throw new Error(`branch ${payload.assetId} is not derated`)
    state.availability = 1
  },
} satisfies Record<string, GridCommandHandler>

const loadHandlers = {
  [gridShedLoadCommandKind]: (grid, rawPayload) => {
    const payload = gridShedLoadPayloadSchema.parse(rawPayload)
    const { definition, state } = loadFor(grid, payload.assetId)
    if (payload.targetDemandMw === state.manualDemandLimitMw && payload.emergency === state.manualShedEmergency) {
      throw new Error(`load ${payload.assetId} is already limited to ${mw(payload.targetDemandMw)}${payload.emergency ? ' as emergency shedding' : ''}`)
    }
    const rejection = manualShedRejection({ definition, state, demandMw: state.demandMw, targetMw: payload.targetDemandMw, emergency: payload.emergency })
    if (rejection !== null) throw new Error(rejection)
    state.manualDemandLimitMw = payload.targetDemandMw
    state.manualShedEmergency = payload.emergency
    if (payload.emergency) queueEmergencyShed(grid, definition, state)
  },
  [gridRestoreLoadCommandKind]: (grid, rawPayload) => {
    const payload = gridRestoreLoadPayloadSchema.parse(rawPayload)
    const { state } = sheddableLoadFor(grid, payload.assetId)
    if (state.manualDemandLimitMw === null) throw new Error(`load ${payload.assetId} is not shed manually; there is nothing to restore`)
    state.manualDemandLimitMw = null
    state.manualShedEmergency = false
  },
  [gridSetEvChargingDemandCommandKind]: (grid, rawPayload) => {
    const payload = gridSetEvChargingDemandPayloadSchema.parse(rawPayload)
    const { definition, state } = sheddableLoadFor(grid, payload.assetId)
    if (definition.kind !== 'ev_charging') throw new Error(`load ${payload.assetId} is ${definition.kind}, not EV charging`)
    const maximumMw = evChargingMaximumMw(grid, definition)
    if (payload.demandMw > maximumMw) throw new Error(`EV charging demand ${mw(payload.demandMw)} exceeds the modelled demand ${mw(maximumMw)} of ${payload.assetId}`)
    if (payload.demandMw < definition.criticalMw) throw new Error(`EV charging demand ${mw(payload.demandMw)} is below the critical demand ${mw(definition.criticalMw)} of ${payload.assetId}`)
    if (maximumMw - payload.demandMw > definition.interruptibleMw + 1e-9) {
      throw new Error(`EV charging demand ${mw(payload.demandMw)} is ${mw(maximumMw - payload.demandMw)} below the modelled demand ${mw(maximumMw)} of ${payload.assetId}, beyond its ${mw(definition.interruptibleMw)} of interruptible demand: the schedule goes no lower than ${mw(Math.max(definition.criticalMw, maximumMw - definition.interruptibleMw))}`)
    }
    if (payload.demandMw === state.nominalDemandMw) throw new Error(`EV charging demand of ${payload.assetId} is already ${mw(state.nominalDemandMw)}`)
    state.nominalDemandMw = payload.demandMw
  },
} satisfies Record<string, GridCommandHandler>

const handlers = {
  ...generatorHandlers,
  ...branchHandlers,
  ...loadHandlers,
  ...gridFrequencyCommandHandlers,
  ...gridLifecycleCommandHandlers,
} satisfies Record<typeof electricGridCommandKinds[number], GridCommandHandler>

const handlerByKind: ReadonlyMap<string, GridCommandHandler> = new Map(Object.entries(handlers))

/** Applies one accepted Grid command to the runtime instance; the caller advances and projects the Grid. */
export const applyGridCommand = (grid: GridRuntimeInstance, command: CommandEnvelope): GridCommandApplication => {
  const handler = handlerByKind.get(command.kind)
  if (!handler) return { ok: false, reason: `electric-grid runtime does not accept command kind: ${command.kind}` }
  try {
    handler(grid, command.payload)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
