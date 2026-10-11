import { z } from 'zod'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridOpenBranchCommandKind,
} from '../commands/branch.ts'
import {
  gridDispatchGeneratorCommandKind,
  gridResetGeneratorTripCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridStartGeneratorCommandKind,
  gridStopGeneratorCommandKind,
  gridTripGeneratorCommandKind,
} from '../commands/generator.ts'
import {
  gridBlockHvdcCommandKind,
  gridDeblockHvdcCommandKind,
  gridResetHvdcTripCommandKind,
  gridSetHvdcSetpointCommandKind,
  gridTripHvdcCommandKind,
} from '../commands/hvdc.ts'
import {
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridShedLoadCommandKind,
} from '../commands/load.ts'
import { gridResetBranchProtectionCommandKind } from '../commands/protection.ts'
import type { GridAssetDefinition, GridGeneratorDefinition, GridHvdcLinkDefinition, GridLoadDefinition } from '../grid-model.ts'
import { unpoweredHvdcTerminal } from '../runtime/hvdc.ts'
import type { GridAssetSnapshot, GridBranchState, GridGeneratorState, GridHvdcLinkState, GridLoadState, GridRuntimeInstance } from '../runtime/instance.ts'
import { generatorMinimumStableMw } from '../runtime/unit-commitment.ts'
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

const mapTargetFor = (grid: GridRuntimeInstance, definition: GridAssetDefinition | GridHvdcLinkDefinition): z.infer<typeof mapTargetSchema> | undefined => {
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

const generatorOperationIds = (definition: GridGeneratorDefinition, state: GridGeneratorState): ReadonlyArray<string> => {
  if (state.state === 'online') return [gridDispatchGeneratorCommandKind, gridStopGeneratorCommandKind, gridTripGeneratorCommandKind, gridSetGeneratorAvailabilityCommandKind]
  if (state.state === 'starting') return [gridStopGeneratorCommandKind, gridTripGeneratorCommandKind, gridSetGeneratorAvailabilityCommandKind]
  if (state.state === 'stopping') return [gridTripGeneratorCommandKind, gridSetGeneratorAvailabilityCommandKind]
  if (state.state === 'tripped') return [gridResetGeneratorTripCommandKind, gridSetGeneratorAvailabilityCommandKind]
  const startable = state.availableMw > 0 && state.availableMw >= generatorMinimumStableMw(definition)
  return [...(startable ? [gridStartGeneratorCommandKind] : []), gridSetGeneratorAvailabilityCommandKind]
}

const loadOperationIds = (definition: GridLoadDefinition, state: GridLoadState): ReadonlyArray<string> => {
  if (definition.priority === 'critical') return []
  return [
    gridShedLoadCommandKind,
    ...(state.manualDemandLimitMw === null ? [] : [gridRestoreLoadCommandKind]),
    ...(definition.kind === 'ev_charging' ? [gridSetEvChargingDemandCommandKind] : []),
  ]
}

const branchOperationIds = (state: GridBranchState): ReadonlyArray<string> => [
  state.state === 'closed' ? gridOpenBranchCommandKind : state.state === 'open' ? gridCloseBranchCommandKind : gridResetBranchProtectionCommandKind,
  ...(state.availability < 1 ? [gridDerateBranchCommandKind, gridClearDerateCommandKind] : [gridDerateBranchCommandKind]),
]

const hvdcOperationIds = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition, state: GridHvdcLinkState): ReadonlyArray<string> => {
  if (state.state === 'deblocked') return [gridSetHvdcSetpointCommandKind, gridBlockHvdcCommandKind, gridTripHvdcCommandKind]
  if (state.state === 'tripped') return [gridResetHvdcTripCommandKind]
  return unpoweredHvdcTerminal(grid, link) === null ? [gridDeblockHvdcCommandKind] : []
}

const applicableOperationIdsFor = (grid: GridRuntimeInstance, asset: GridAssetSnapshot): ReadonlyArray<string> => {
  const entry = grid.definition.index.assetById.get(asset.id)!
  if (entry.kind === 'generator') return generatorOperationIds(entry.definition, grid.generators.get(asset.id)!)
  if (entry.kind === 'branch') return branchOperationIds(grid.branches.get(asset.id)!)
  if (entry.kind === 'load') return loadOperationIds(entry.definition, grid.loads.get(asset.id)!)
  return []
}

export const assetPresentationFor = (grid: GridRuntimeInstance, asset: GridAssetSnapshot): z.infer<typeof assetListItemSchema> => {
  let subkind = asset.kind === 'bus' ? 'substation-bus' : asset.kind
  let tone: 'ready' | 'working' | 'error' | 'idle' = 'ready'
  let statusLabel = 'Normal'
  let summary: string = asset.kind
  const terminal = asset.kind === 'bus' ? grid.hvdcTerminals.get(asset.id) : undefined
  if (terminal !== undefined) {
    // In no island and outside Norwegian energisation: described by its system and its links.
    const system = grid.definition.index.externalSystems.find(candidate => candidate.id === terminal.externalSystemId)!
    const links = terminal.links
    subkind = 'hvdc-terminal'
    tone = links.some(link => link.state === 'deblocked') ? 'ready' : 'idle'
    statusLabel = 'HVDC terminal'
    summary = [system.label, ...links.map(link => {
      const label = grid.definition.index.hvdcLinks.find(candidate => candidate.id === link.linkId)!.label
      if (link.state !== 'deblocked') return `${label} ${link.state}`
      return `${label} ${Math.round(Math.abs(link.transferMw)).toLocaleString()} MW ${link.transferMw >= 0 ? 'export' : 'import'}`
    })].join(' · ')
  } else if (asset.kind === 'bus') {
    const state = grid.busStates.get(asset.id)
    const definition = asset.definition as typeof grid.definition.model.buses[number]
    const connections = [...grid.externalConnections.values()].filter(connection => connection.busId === asset.id)
    const connectedCount = connections.filter(connection => connection.connected).length
    const connectedLabel = `${connectedCount}/${connections.length} connected`
    if (!state || !state.energized || state.frequencyHz === null) {
      // The DC model computes no voltage: a live bus is described by its island frequency, a dead one as de-energised.
      tone = state ? 'error' : 'idle'
      statusLabel = state ? connections.length === 0 ? 'De-energised' : `De-energised · ${connectedLabel}` : 'Initializing'
      summary = `${definition.nominalKv} kV · de-energised`
    } else {
      const frequency = state.frequencyHz
      const frequencyDeviation = Math.abs(frequency - grid.definition.model.nominalFrequencyHz)
      const externalSupplyMw = connections.reduce((total, connection) =>
        total + (connection.connected ? connection.systemActivePowerMw : 0), 0)
      tone = frequencyDeviation >= 0.5
        ? 'error'
        : frequencyDeviation >= 0.1 || (connections.length > 0 && connectedCount < connections.length)
          ? 'working'
          : 'ready'
      const externalPowerLabel = externalSupplyMw >= 0
        ? `${Math.round(externalSupplyMw).toLocaleString()} MW supplied`
        : `${Math.round(Math.abs(externalSupplyMw)).toLocaleString()} MW drawn`
      statusLabel = connections.length === 0 ? 'Energised' : connectedLabel
      summary = connections.length === 0
        ? `${definition.nominalKv} kV · ${frequency.toFixed(2)} Hz`
        : `${externalPowerLabel} · ${connectedLabel} · ${frequency.toFixed(2)} Hz`
    }
  } else if (asset.kind === 'branch') {
    const state = grid.branches.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.branches[number]
    subkind = definition.kind
    tone = state.state === 'tripped' ? 'error' : state.state === 'open' ? 'idle' : state.loadingPercent >= 100 ? 'error' : state.loadingPercent >= 85 || state.availability < 1 ? 'working' : 'ready'
    statusLabel = state.state === 'tripped' ? `Tripped (${state.protection.trip!.element})` : state.state === 'open' ? 'Open' : state.availability < 1 ? `Derated ${Math.round(state.availability * 100)}%` : 'Closed'
    summary = `${Math.round(state.flowMw).toLocaleString()} MW · ${Math.round(state.loadingPercent)}% loaded`
  } else if (asset.kind === 'generator') {
    const state = grid.generators.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.generators[number]
    subkind = definition.kind
    tone = state.state === 'online' ? (state.availableMw < definition.capacityMw ? 'working' : 'ready') : state.state === 'tripped' ? 'error' : state.state === 'offline' ? 'idle' : 'working'
    statusLabel = state.state
    summary = `${Math.round(state.dispatchMw).toLocaleString()} / ${Math.round(state.availableMw).toLocaleString()} MW`
  } else if (asset.kind === 'load') {
    const state = grid.loads.get(asset.id)!
    const definition = asset.definition as typeof grid.definition.model.loads[number]
    subkind = definition.kind
    tone = state.serviceState === 'outage' || state.serviceState === 'shed' ? 'error' : state.serviceState === 'constrained' ? 'working' : 'ready'
    statusLabel = state.serviceState === 'shed' ? `shed (${state.shedCauses.join(', ')})` : state.serviceState
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
    applicableOperationIds: [...applicableOperationIdsFor(grid, asset)],
    ...(mapTarget === undefined ? {} : { mapTarget }),
  }
}

/** An HVDC link: the Model keeps it apart from its AC assets, so it has its own presentation. */
export const hvdcPresentationFor = (grid: GridRuntimeInstance, link: GridHvdcLinkDefinition): z.infer<typeof assetListItemSchema> => {
  const state = grid.hvdcLinks.get(link.id)!
  const ramping = state.transferMw !== state.setpointMw
  const megawatts = (value: number): string => Math.round(value).toLocaleString()
  const mapTarget = mapTargetFor(grid, link)
  return {
    id: link.id,
    label: link.label,
    kind: 'hvdc',
    subkind: 'hvdc_link',
    status: {
      tone: state.state === 'tripped' ? 'error' : state.state === 'blocked' ? 'idle' : ramping ? 'working' : 'ready',
      label: state.state === 'tripped'
        ? `Tripped (${state.trip!.cause})`
        : state.state === 'blocked' ? 'Blocked' : ramping ? `Ramping to ${megawatts(state.setpointMw)} MW` : 'Deblocked',
    },
    summary: `${megawatts(state.transferMw)} / ${megawatts(state.setpointMw)} MW set-point · ±${megawatts(link.ratingMw)} MW`,
    applicableOperationIds: [...hvdcOperationIds(grid, link, state)],
    ...(mapTarget === undefined ? {} : { mapTarget }),
  }
}
