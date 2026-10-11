import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { gridCommandCapability } from './capability.ts'

export const gridRestoreLfddStageCommandKind = 'world.electric-grid.restore-lfdd-stage'
export const gridRearmLfddStageCommandKind = 'world.electric-grid.rearm-lfdd-stage'

export const gridLfddStagePayloadSchema = z.object({
  islandId: z.string().min(1).describe('Stable island id from world.electric-grid.islands.list or the Grid projection.'),
  stageId: z.string().min(1).describe('LFDD stage id of the Grid Automation, for example stage-1.'),
}).strict()

const lfddTerms = ['LFDD', 'UFLS', 'under-frequency load shedding', 'load shedding', 'frequency', 'restoration', 'lastfrakobling', 'frekvensavlastning', 'underfrekvens', 'frekvens', 'gjenoppretting']

export const gridFrequencyCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridRestoreLfddStageCommandKind,
    title: 'Restore LFDD stage',
    description: 'Reconnects the feeders an operated under-frequency load-shedding (LFDD) stage disconnected in one island; the reconnected demand is served again. The stage stays disarmed until re-armed, so step-wise restoration cannot re-trip it. Rejected unless the stage is operated.',
    payloadSchema: gridLfddStagePayloadSchema,
    risk: 'write',
    searchTerms: [...lfddTerms, 'reconnect', 'load pick-up', 'innkobling'],
  }),
  gridCommandCapability({
    id: gridRearmLfddStageCommandKind,
    title: 'Re-arm LFDD stage',
    description: 'Re-arms a restored LFDD stage in one island so it operates again on under-frequency. Rejected unless the stage is disarmed.',
    payloadSchema: gridLfddStagePayloadSchema,
    risk: 'write',
    searchTerms: [...lfddTerms, 're-arm', 'arm', 'reset', 'tilbakestilling'],
  }),
]
