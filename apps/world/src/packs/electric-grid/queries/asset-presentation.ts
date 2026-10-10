import { z } from 'zod'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridDispatchGeneratorCommandKind,
  gridOpenBranchCommandKind,
  gridRestoreLoadCommandKind,
  gridReturnGeneratorToServiceCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridShedLoadCommandKind,
  gridTripGeneratorCommandKind,
} from '../commands.ts'
import type { GridAssetDefinition } from '../grid-model.ts'
import type { GridAssetSnapshot, GridRuntimeInstance } from '../runtime/instance.ts'
import { assetKindSchema } from './common.ts'

const mapTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), center: z.tuple([z.number(), z.number()]) }).strict(),
  z.object({ kind: z.literal('bounds'), bounds: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]) }).strict(),
])
const assetStatusSchema = z.object({ tone: z.enum(['ready', 'working', 'error', 'idle']), label: z.string() }).strict()
export const assetListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: assetKindSchema,
  subkind: z.string(),
  status: assetStatusSchema,
  summary: z.string(),
  applicableOperationIds: z.array(z.string()),
  mapTarget: mapTargetSchema.optional(),
}).strict()

const mapTargetFor = (grid: GridRuntimeInstance, definition: GridAssetDefinition): z.infer<typeof mapTargetSchema> | undefined => {
  if ('location' in definition) return { kind: 'point', center: [definition.location[0], definition.location[1]] }
  if ('fromBusId' in definition) {
    const from = grid.definition.index.busById.get(definition.fromBusId)?.location
    const to = grid.definition.index.busById.get(definition.toBusId)?.location
    if (!from || !to) return undefined
    return {
      kind: 'bounds',
      bounds: [
        [Math.min(from[0], to[0]), Math.min(from[1], to[1])],
        [Math.max(from[0], to[0]), Math.max(from[1], to[1])],
      ],
    }
  }
  return undefined
}

const applicableOperationIdsFor = (asset: GridAssetSnapshot): ReadonlyArray<string> => {
  if (asset.kind === 'generator') {
    const state = asset.state as GridRuntimeInstance['generators'] extends Map<string, infer T> ? T : never
    return state.state === 'online'
      ? [gridDispatchGeneratorCommandKind, gridTripGeneratorCommandKind, gridSetGeneratorAvailabilityCommandKind]
      : [gridSetGeneratorAvailabilityCommandKind, ...(state.availableMw > 0 ? [gridReturnGeneratorToServiceCommandKind] : [])]
  }
  if (asset.kind === 'branch') {
    const state = asset.state as GridRuntimeInstance['branches'] extends Map<string, infer T> ? T : never
    return [
      state.state === 'closed' ? gridOpenBranchCommandKind : gridCloseBranchCommandKind,
      ...(state.availability < 1 ? [gridClearDerateCommandKind] : [gridDerateBranchCommandKind]),
    ]
  }
  if (asset.kind === 'load') {
    const definition = asset.definition as typeof asset.definition & { readonly controllable?: boolean; readonly kind?: string }
    if (definition.controllable !== true) return []
    return [gridShedLoadCommandKind, gridRestoreLoadCommandKind, ...(definition.kind === 'ev_charging' ? [gridSetEvChargingDemandCommandKind] : [])]
  }
  return []
}

export const assetPresentationFor = (grid: GridRuntimeInstance, asset: GridAssetSnapshot): z.infer<typeof assetListItemSchema> => {
  let subkind = asset.kind === 'bus' ? 'substation-bus' : asset.kind
  let tone: 'ready' | 'working' | 'error' | 'idle' = 'ready'
  let statusLabel = 'Normal'
  let summary: string = asset.kind
  if (asset.kind === 'bus') {
    const state = grid.busStates.get(asset.id)
    const definition = asset.definition as typeof grid.definition.model.buses[number]
    const voltage = state?.voltagePu ?? 1
    const frequency = state?.frequencyHz ?? grid.definition.model.nominalFrequencyHz
    const frequencyDeviation = Math.abs(frequency - grid.definition.model.nominalFrequencyHz)
    const connections = [...grid.externalConnections.values()].filter(connection => connection.busId === asset.id)
    const connectedCount = connections.filter(connection => connection.connected).length
    const externalSupplyMw = connections.reduce((total, connection) =>
      total + (connection.connected ? connection.systemActivePowerMw : 0), 0)
    tone = voltage < 0.95 || frequencyDeviation >= 0.5
      ? 'error'
      : voltage < 0.98 || frequencyDeviation >= 0.1 || (connections.length > 0 && connectedCount < connections.length)
        ? 'working'
        : 'ready'
    const externalPowerLabel = externalSupplyMw >= 0
      ? `${Math.round(externalSupplyMw).toLocaleString()} MW supplied`
      : `${Math.round(Math.abs(externalSupplyMw)).toLocaleString()} MW drawn`
    statusLabel = connections.length === 0
      ? state ? `${state.voltagePu.toFixed(3)} pu` : 'Initializing'
      : `${connectedCount}/${connections.length} connected`
    summary = connections.length === 0
      ? `${definition.nominalKv} kV · ${frequency.toFixed(2)} Hz`
      : `${externalPowerLabel} · ${connectedCount}/${connections.length} connected · ${frequency.toFixed(2)} Hz`
  } else if (asset.kind === 'branch') {
    const state = grid.branches.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.branches[number]
    subkind = definition.kind
    tone = state.state === 'open' ? 'idle' : state.loadingPercent >= 100 ? 'error' : state.loadingPercent >= 85 || state.availability < 1 ? 'working' : 'ready'
    statusLabel = state.state === 'open' ? 'Open' : state.availability < 1 ? `Derated ${Math.round(state.availability * 100)}%` : 'Closed'
    summary = `${Math.round(state.flowMw).toLocaleString()} MW · ${Math.round(state.loadingPercent)}% loaded`
  } else if (asset.kind === 'generator') {
    const state = grid.generators.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.generators[number]
    subkind = definition.kind
    tone = state.state === 'online' ? (state.availableMw < definition.capacityMw ? 'working' : 'ready') : state.state === 'tripped' ? 'error' : 'idle'
    statusLabel = state.state
    summary = `${Math.round(state.dispatchMw).toLocaleString()} / ${Math.round(state.availableMw).toLocaleString()} MW`
  } else if (asset.kind === 'load') {
    const state = grid.loads.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.loads[number]
    subkind = definition.kind
    tone = state.serviceState === 'outage' || state.serviceState === 'shed' ? 'error' : state.serviceState === 'constrained' ? 'working' : 'ready'
    statusLabel = state.serviceState
    summary = `${Math.round(state.servedMw).toLocaleString()} / ${Math.round(state.demandMw).toLocaleString()} MW served`
  } else {
    const state = grid.storage.get(asset.id)!
    tone = state.state === 'unavailable' ? 'error' : state.state === 'idle' ? 'idle' : 'working'
    statusLabel = state.state
    summary = `${Math.round(state.stateOfChargeFraction * 100)}% charged · ${Math.round(state.dispatchMw).toLocaleString()} MW`
  }
  const mapTarget = mapTargetFor(grid, asset.definition)
  return {
    id: asset.id,
    label: asset.label,
    kind: asset.kind,
    subkind,
    status: { tone, label: statusLabel },
    summary,
    applicableOperationIds: [...applicableOperationIdsFor(asset)],
    ...(mapTarget === undefined ? {} : { mapTarget }),
  }
}
