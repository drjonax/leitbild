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
  gridReturnGeneratorToServiceCommandKind,
  gridReturnGeneratorToServicePayloadSchema,
  gridSetGeneratorAvailabilityCommandKind,
  gridSetGeneratorAvailabilityPayloadSchema,
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
import type { GridRuntimeInstance } from './instance.ts'

export type GridCommandApplication =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Validates one command payload and applies it to the Grid; throws to reject. */
type GridCommandHandler = (grid: GridRuntimeInstance, rawPayload: unknown) => void

const generatorHandlers = {
  [gridDispatchGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridDispatchGeneratorPayloadSchema.parse(rawPayload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    if (state.state !== 'online') throw new Error(`generator Grid Asset ${payload.assetId} is ${state.state}; return it to service before dispatching`)
    state.targetMw = Math.min(payload.targetMw, state.availableMw)
  },
  [gridTripGeneratorCommandKind]: (grid, rawPayload) => {
    const payload = gridTripGeneratorPayloadSchema.parse(rawPayload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.state = 'tripped'
    state.dispatchMw = 0
    state.targetMw = 0
  },
  [gridSetGeneratorAvailabilityCommandKind]: (grid, rawPayload) => {
    const payload = gridSetGeneratorAvailabilityPayloadSchema.parse(rawPayload)
    const state = grid.generators.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'generator' ? entry.definition : undefined
    if (!state || !definition) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    state.availableMw = Math.min(payload.availableMw, definition.capacityMw)
    state.targetMw = Math.min(state.targetMw, state.availableMw)
    state.dispatchMw = Math.min(state.dispatchMw, state.availableMw)
    if (state.availableMw === 0 && state.state === 'online') state.state = 'offline'
  },
  [gridReturnGeneratorToServiceCommandKind]: (grid, rawPayload) => {
    const payload = gridReturnGeneratorToServicePayloadSchema.parse(rawPayload)
    const state = grid.generators.get(payload.assetId)
    if (!state) throw new Error(`generator Grid Asset not found: ${payload.assetId}`)
    if (state.availableMw <= 0) throw new Error(`generator Grid Asset ${payload.assetId} has no available capacity`)
    state.state = 'online'
    state.dispatchMw = 0
    state.targetMw = 0
  },
} satisfies Record<string, GridCommandHandler>

const branchStateFor = (grid: GridRuntimeInstance, assetId: string) => {
  const state = grid.branches.get(assetId)
  if (!state) throw new Error(`branch Grid Asset not found: ${assetId}`)
  return state
}

const branchHandlers = {
  [gridOpenBranchCommandKind]: (grid, rawPayload) => {
    const state = branchStateFor(grid, gridOpenBranchPayloadSchema.parse(rawPayload).assetId)
    state.state = 'open'
    grid.topologyPlan = null
  },
  [gridCloseBranchCommandKind]: (grid, rawPayload) => {
    const state = branchStateFor(grid, gridCloseBranchPayloadSchema.parse(rawPayload).assetId)
    state.state = 'closed'
    grid.topologyPlan = null
  },
  [gridDerateBranchCommandKind]: (grid, rawPayload) => {
    const payload = gridDerateBranchPayloadSchema.parse(rawPayload)
    branchStateFor(grid, payload.assetId).availability = payload.availability
  },
  [gridClearDerateCommandKind]: (grid, rawPayload) => {
    branchStateFor(grid, gridClearDeratePayloadSchema.parse(rawPayload).assetId).availability = 1
  },
} satisfies Record<string, GridCommandHandler>

const loadHandlers = {
  [gridShedLoadCommandKind]: (grid, rawPayload) => {
    const payload = gridShedLoadPayloadSchema.parse(rawPayload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || !definition.controllable) throw new Error(`controllable load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, state.nominalDemandMw - payload.amountMw)
  },
  [gridRestoreLoadCommandKind]: (grid, rawPayload) => {
    const payload = gridRestoreLoadPayloadSchema.parse(rawPayload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || !definition.controllable) throw new Error(`controllable load Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = definition.demandMw * grid.definition.operatingPoint.loadScale
  },
  [gridSetEvChargingDemandCommandKind]: (grid, rawPayload) => {
    const payload = gridSetEvChargingDemandPayloadSchema.parse(rawPayload)
    const state = grid.loads.get(payload.assetId)
    const entry = grid.definition.index.assetById.get(payload.assetId)
    const definition = entry?.kind === 'load' ? entry.definition : undefined
    if (!state || !definition || definition.kind !== 'ev_charging' || !definition.controllable) throw new Error(`controllable EV charging Grid Asset not found: ${payload.assetId}`)
    state.nominalDemandMw = Math.max(definition.criticalMw, payload.demandMw)
  },
} satisfies Record<string, GridCommandHandler>

const handlers = {
  ...generatorHandlers,
  ...branchHandlers,
  ...loadHandlers,
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
