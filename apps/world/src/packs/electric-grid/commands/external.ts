import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridSetExternalExchangeCommandKind = 'world.electric-grid.set-external-exchange'

export const gridSetExternalExchangePayloadSchema = assetPayload.extend({
  scheduledExportMw: z.number().finite().describe('Target scheduled exchange with the synchronous external system (MW): positive exports from Norway, negative imports, as the Operating Point states it.'),
}).strict()

export const gridExternalCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridSetExternalExchangeCommandKind,
    title: 'Set external exchange',
    description: 'Sets the target scheduled exchange (MW, positive exports from Norway) of a synchronous external system, for example the Nordic equivalent (assetId external:nordic-remainder; world.electric-grid.grid.summary lists each system\'s scheduled, target and Operating Point exchange). The schedule ramps to the target at the Automation\'s externalExchange.rampMwPerMinute; the equivalent\'s units carry it, so the Norwegian island\'s frequency control takes up the change. A separation from every Norwegian island voids the exchange to 0 MW; this command restores it once a tie is closed again. Rejected while the system is coupled to no Norwegian island, beyond the rating of its closed ties, for a system reached only by HVDC (set-hvdc-setpoint), and for the target it already has.',
    payloadSchema: gridSetExternalExchangePayloadSchema,
    risk: 'write',
    searchTerms: ['exchange', 'schedule', 'import', 'export', 'Nordic', 'Sweden', 'Finland', 'tie', 'resynchronisation', 'counter-trade', 'utveksling', 'utvekslingsplan', 'import', 'eksport', 'Sverige', 'Finland', 'resynkronisering'],
  }),
]
