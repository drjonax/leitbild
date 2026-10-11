import {
  gridBlockHvdcCommandKind,
  gridDeblockHvdcCommandKind,
  gridHvdcLinkPayloadSchema,
  gridResetHvdcTripCommandKind,
  gridSetHvdcSetpointCommandKind,
  gridSetHvdcSetpointPayloadSchema,
  gridTripHvdcCommandKind,
} from '../commands/hvdc.ts'
import { hvdcLinkFor, hvdcTripReason, queueHvdcTransition, stopHvdcLink, tripHvdcLink, unpoweredHvdcTerminal } from './hvdc.ts'
import type { GridRuntimeInstance } from './instance.ts'

const mw = (value: number): string => `${Math.round(value * 10) / 10} MW`

/**
 * HVDC link commands. deblocked →(block)→ blocked →(deblock)→ deblocked at 0 MW; deblocked →(trip
 * or loss of AC voltage)→ tripped →(reset)→ blocked. Only a deblocked link takes a set-point.
 */
export const gridHvdcCommandHandlers = {
  [gridSetHvdcSetpointCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridSetHvdcSetpointPayloadSchema.parse(rawPayload)
    const { definition, state } = hvdcLinkFor(grid, payload.assetId)
    if (state.state === 'blocked') throw new Error(`HVDC link ${payload.assetId} is blocked; deblock-hvdc returns it to service at 0 MW before a set-point applies`)
    if (state.state === 'tripped') throw new Error(`HVDC link ${payload.assetId} is tripped (${hvdcTripReason(state.trip!)}); reset-hvdc-trip, then deblock-hvdc, before a set-point applies`)
    if (Math.abs(payload.setpointMw) > definition.ratingMw) {
      throw new Error(`HVDC link ${payload.assetId} set-point ${mw(payload.setpointMw)} lies outside its ±${mw(definition.ratingMw)} rating (positive exports from ${definition.fromBusId})`)
    }
    if (payload.setpointMw === state.setpointMw) throw new Error(`HVDC link ${payload.assetId} already has the set-point ${mw(state.setpointMw)} (transfer ${mw(state.transferMw)})`)
    state.setpointMw = payload.setpointMw
  },
  [gridBlockHvdcCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridHvdcLinkPayloadSchema.parse(rawPayload)
    const { definition, state } = hvdcLinkFor(grid, payload.assetId)
    if (state.state === 'blocked') throw new Error(`HVDC link ${payload.assetId} is already blocked`)
    if (state.state === 'tripped') throw new Error(`HVDC link ${payload.assetId} is already stopped: tripped (${hvdcTripReason(state.trip!)})`)
    const transferMw = state.transferMw
    state.state = 'blocked'
    stopHvdcLink(state)
    queueHvdcTransition(grid, definition, 'blocked', transferMw)
  },
  [gridDeblockHvdcCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridHvdcLinkPayloadSchema.parse(rawPayload)
    const { definition, state } = hvdcLinkFor(grid, payload.assetId)
    if (state.state === 'deblocked') throw new Error(`HVDC link ${payload.assetId} is already deblocked`)
    if (state.state === 'tripped') throw new Error(`HVDC link ${payload.assetId} is tripped (${hvdcTripReason(state.trip!)}); reset it with reset-hvdc-trip before deblocking it`)
    const unpowered = unpoweredHvdcTerminal(grid, definition)
    if (unpowered !== null) throw new Error(`HVDC link ${payload.assetId} cannot deblock: its converter terminal ${unpowered} has no AC voltage`)
    state.state = 'deblocked'
    stopHvdcLink(state)
    queueHvdcTransition(grid, definition, 'deblocked', 0)
  },
  [gridTripHvdcCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridHvdcLinkPayloadSchema.parse(rawPayload)
    const { definition, state } = hvdcLinkFor(grid, payload.assetId)
    if (state.state !== 'deblocked') throw new Error(`HVDC link ${payload.assetId} is ${state.state}; there is nothing to trip`)
    tripHvdcLink(grid, definition, state, 'command')
  },
  [gridResetHvdcTripCommandKind]: (grid: GridRuntimeInstance, rawPayload: unknown): void => {
    const payload = gridHvdcLinkPayloadSchema.parse(rawPayload)
    const { definition, state } = hvdcLinkFor(grid, payload.assetId)
    if (state.state !== 'tripped') throw new Error(`HVDC link ${payload.assetId} is ${state.state}, not tripped; there is no trip to reset`)
    state.state = 'blocked'
    state.trip = null
    queueHvdcTransition(grid, definition, 'trip-reset', 0)
  },
} as const
