import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridSetHvdcSetpointCommandKind = 'world.electric-grid.set-hvdc-setpoint'
export const gridBlockHvdcCommandKind = 'world.electric-grid.block-hvdc'
export const gridDeblockHvdcCommandKind = 'world.electric-grid.deblock-hvdc'
export const gridTripHvdcCommandKind = 'world.electric-grid.trip-hvdc'
export const gridResetHvdcTripCommandKind = 'world.electric-grid.reset-hvdc-trip'

export const gridHvdcCommandKinds = [
  gridSetHvdcSetpointCommandKind,
  gridBlockHvdcCommandKind,
  gridDeblockHvdcCommandKind,
  gridTripHvdcCommandKind,
  gridResetHvdcTripCommandKind,
] as const

export const gridSetHvdcSetpointPayloadSchema = assetPayload.extend({
  setpointMw: z.number().finite().describe('Transfer set-point (MW): positive sends from the link\'s Norwegian converter (fromBusId) to its far end, so positive exports from Norway and negative imports; at most ratingMw either way.'),
}).strict()
export const gridHvdcLinkPayloadSchema = assetPayload

const hvdcTerms = ['HVDC', 'interconnector', 'converter', 'link', 'NordLink', 'NorNed', 'North Sea Link', 'Skagerrak', 'utenlandsforbindelse', 'likestrømsforbindelse', 'omformer', 'kabel']

export const gridHvdcCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridSetHvdcSetpointCommandKind,
    title: 'Set HVDC set-point',
    description: 'Sets the transfer set-point (MW) of a deblocked HVDC link. Positive sends from the link\'s Norwegian converter (fromBusId) to its far end: positive exports from Norway, negative imports. The transfer ramps from its present value at the link\'s rampMwPerMinute, so a change of Δ MW takes |Δ| / rampMwPerMinute minutes; a link of a ramp group (world.electric-grid.asset.get rampGroup) also shares the group\'s limit on the change of its links\' aggregate transfer, so it ramps at most at that limit, slower while another link of the group ramps the same way and unhindered by one ramping the other way; the receiving converter delivers the sent power less lossPercent. Rejected beyond ±ratingMw, on a blocked or tripped link, and for the set-point the link already has; the reason gives the limits.',
    payloadSchema: gridSetHvdcSetpointPayloadSchema,
    risk: 'write',
    searchTerms: [...hvdcTerms, 'set-point', 'setpoint', 'schedule', 'import', 'export', 'ramp', 'exchange', 'settpunkt', 'eksport', 'utveksling', 'rampe'],
  }),
  gridCommandCapability({
    id: gridBlockHvdcCommandKind,
    title: 'Block HVDC link',
    description: 'Emergency stop of a deblocked HVDC link: both converters block at once and the transfer drops to 0 MW without ramping, so an import is lost as a step of infeed and an export as a step of demand. The set-point returns to 0 MW and the link stays blocked until deblock-hvdc. Rejected when the link is already blocked or tripped.',
    payloadSchema: gridHvdcLinkPayloadSchema,
    risk: 'destructive',
    searchTerms: [...hvdcTerms, 'block', 'emergency stop', 'stop', 'disconnect', 'loss of infeed', 'frequency event', 'blokkering', 'nødstopp', 'utkobling', 'frekvens'],
  }),
  gridCommandCapability({
    id: gridDeblockHvdcCommandKind,
    title: 'Deblock HVDC link',
    description: 'Returns a blocked HVDC link to service at 0 MW; set-hvdc-setpoint then ramps it. Both converter terminals must have AC voltage. A tripped link needs reset-hvdc-trip first.',
    payloadSchema: gridHvdcLinkPayloadSchema,
    risk: 'write',
    searchTerms: [...hvdcTerms, 'deblock', 'return to service', 'restart', 'restoration', 'start', 'deblokkering', 'innkobling', 'gjenoppretting'],
  }),
  gridCommandCapability({
    id: gridTripHvdcCommandKind,
    title: 'Trip HVDC link',
    description: 'Trips a deblocked HVDC link as its converter protection would (a fault for drills): the transfer drops to 0 MW at once, an HVDC trip alarm raises, and the link stays tripped until reset-hvdc-trip. A converter also trips by itself when its AC terminal loses voltage.',
    payloadSchema: gridHvdcLinkPayloadSchema,
    risk: 'destructive',
    searchTerms: [...hvdcTerms, 'trip', 'converter trip', 'forced outage', 'loss of infeed', 'dimensioning incident', 'frequency event', 'utfall', 'feil', 'dimensjonerende feil', 'frekvens'],
  }),
  gridCommandCapability({
    id: gridResetHvdcTripCommandKind,
    title: 'Reset HVDC trip',
    description: 'Resets the converter protection of a tripped HVDC link: it becomes blocked at 0 MW, and deblock-hvdc returns it to service. Rejected unless the link is tripped.',
    payloadSchema: gridHvdcLinkPayloadSchema,
    risk: 'write',
    searchTerms: [...hvdcTerms, 'reset', 'trip reset', 'protection', 'restoration', 'tilbakestill', 'vern', 'kvitter', 'gjenoppretting'],
  }),
]
