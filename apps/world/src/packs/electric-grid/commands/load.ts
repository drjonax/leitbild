import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridShedLoadCommandKind = 'world.electric-grid.shed-load'
export const gridRestoreLoadCommandKind = 'world.electric-grid.restore-load'
export const gridSetEvChargingDemandCommandKind = 'world.electric-grid.set-ev-charging-demand'

export const gridShedLoadPayloadSchema = assetPayload.extend({ targetDemandMw: z.number().finite().nonnegative() }).strict()
export const gridRestoreLoadPayloadSchema = assetPayload
export const gridSetEvChargingDemandPayloadSchema = assetPayload.extend({ demandMw: z.number().finite().nonnegative() }).strict()

const loadTerms = ['load', 'demand', 'consumer', 'consumption', 'last', 'forbruk', 'forbruker']

export const gridLoadCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridShedLoadCommandKind,
    title: 'Shed load',
    description: 'Sheds part of a load that is not critical in full by limiting it to draw at most targetDemandMw (MW, not below its critical demand). The shed demand counts as unserved load with shed cause manual until restore-load. The limit is absolute: repeating the command changes nothing.',
    payloadSchema: gridShedLoadPayloadSchema,
    risk: 'destructive',
    searchTerms: [...loadTerms, 'load shedding', 'shed', 'curtail', 'curtailment', 'demand response', 'disconnect', 'rationing', 'UFLS', 'frequency', 'reserve', 'lastfrakobling', 'lastavlastning', 'utkobling', 'rasjonering', 'frekvens', 'fleksibilitet', 'utkoblbart forbruk'],
  }),
  gridCommandCapability({
    id: gridRestoreLoadCommandKind,
    title: 'Restore load',
    description: 'Removes the manual shedding limit of a load so it draws its full demand again; an EV charging schedule is kept.',
    payloadSchema: gridRestoreLoadPayloadSchema,
    risk: 'write',
    searchTerms: [...loadTerms, 'restore', 'reconnect', 'load pick-up', 'restoration', 'gjenoppretting', 'innkobling', 'gjeninnkobling'],
  }),
  gridCommandCapability({
    id: gridSetEvChargingDemandCommandKind,
    title: 'Set EV charging demand',
    description: 'Sets the scheduled demand (MW) of an EV charging load, between its critical demand and its modelled demand. Scheduled demand is served, not shed.',
    payloadSchema: gridSetEvChargingDemandPayloadSchema,
    risk: 'write',
    searchTerms: [...loadTerms, 'EV', 'electric vehicle', 'charging', 'smart charging', 'demand response', 'schedule', 'elbil', 'lading', 'ladestasjon', 'smartlading', 'fleksibilitet'],
  }),
]
