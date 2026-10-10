import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridShedLoadCommandKind = 'world.electric-grid.shed-load'
export const gridRestoreLoadCommandKind = 'world.electric-grid.restore-load'
export const gridSetEvChargingDemandCommandKind = 'world.electric-grid.set-ev-charging-demand'

export const gridShedLoadPayloadSchema = assetPayload.extend({ amountMw: z.number().finite().positive() }).strict()
export const gridRestoreLoadPayloadSchema = assetPayload
export const gridSetEvChargingDemandPayloadSchema = assetPayload.extend({ demandMw: z.number().finite().nonnegative() }).strict()

export const gridLoadCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability(gridShedLoadCommandKind, 'Shed load', 'Reduces a controllable load by an explicit MW amount without shedding critical demand.', gridShedLoadPayloadSchema),
  gridCommandCapability(gridRestoreLoadCommandKind, 'Restore load', 'Restores a controllable load to its Model and Operating Point demand.', gridRestoreLoadPayloadSchema),
  gridCommandCapability(gridSetEvChargingDemandCommandKind, 'Set EV charging demand', 'Sets scheduled demand for a controllable EV charging Grid Asset.', gridSetEvChargingDemandPayloadSchema),
]
