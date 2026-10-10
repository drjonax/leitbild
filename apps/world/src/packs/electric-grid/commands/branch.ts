import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridOpenBranchCommandKind = 'world.electric-grid.open-branch'
export const gridCloseBranchCommandKind = 'world.electric-grid.close-branch'
export const gridDerateBranchCommandKind = 'world.electric-grid.derate-branch'
export const gridClearDerateCommandKind = 'world.electric-grid.clear-derate'

export const gridOpenBranchPayloadSchema = assetPayload
export const gridCloseBranchPayloadSchema = assetPayload
export const gridDerateBranchPayloadSchema = assetPayload.extend({ availability: z.number().finite().min(0.05).max(1) }).strict()
export const gridClearDeratePayloadSchema = assetPayload

export const gridBranchCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability(gridOpenBranchCommandKind, 'Open branch', 'Opens a line, cable, transformer, HVDC link, or switch without changing its availability.', gridOpenBranchPayloadSchema),
  gridCommandCapability(gridCloseBranchCommandKind, 'Close branch', 'Closes an available Grid branch while retaining its current derate.', gridCloseBranchPayloadSchema),
  gridCommandCapability(gridDerateBranchCommandKind, 'Derate branch', 'Applies an available-capacity fraction to a Grid branch.', gridDerateBranchPayloadSchema),
  gridCommandCapability(gridClearDerateCommandKind, 'Clear branch derate', 'Restores full branch availability without changing open/closed state.', gridClearDeratePayloadSchema),
]
