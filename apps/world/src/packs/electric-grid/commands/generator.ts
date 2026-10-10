import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridDispatchGeneratorCommandKind = 'world.electric-grid.dispatch-generator'
export const gridTripGeneratorCommandKind = 'world.electric-grid.trip-generator'
export const gridSetGeneratorAvailabilityCommandKind = 'world.electric-grid.set-generator-availability'
export const gridReturnGeneratorToServiceCommandKind = 'world.electric-grid.return-generator-to-service'

export const gridDispatchGeneratorPayloadSchema = assetPayload.extend({ targetMw: z.number().finite().nonnegative() }).strict()
export const gridTripGeneratorPayloadSchema = assetPayload
export const gridSetGeneratorAvailabilityPayloadSchema = assetPayload.extend({ availableMw: z.number().finite().nonnegative() }).strict()
export const gridReturnGeneratorToServicePayloadSchema = assetPayload

export const gridGeneratorCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability(gridDispatchGeneratorCommandKind, 'Dispatch generator', 'Sets the dispatch target of an online generator in MW.', gridDispatchGeneratorPayloadSchema),
  gridCommandCapability(gridTripGeneratorCommandKind, 'Trip generator', 'Trips a generator and removes its output and reserve.', gridTripGeneratorPayloadSchema),
  gridCommandCapability(gridSetGeneratorAvailabilityCommandKind, 'Set generator availability', 'Sets available generator capacity without changing a tripped or offline lifecycle state.', gridSetGeneratorAvailabilityPayloadSchema),
  gridCommandCapability(gridReturnGeneratorToServiceCommandKind, 'Return generator to service', 'Returns a generator with positive availability to online service at zero dispatch.', gridReturnGeneratorToServicePayloadSchema),
]
