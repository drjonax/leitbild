import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { gridCommandCapability } from './capability.ts'

export const gridAlarmLifecycleCommandKind = 'world.electric-grid.alarm.lifecycle'

// Shelving is always time-limited (IEC 62682 / ISA-18.2 practice); 24 h is a Leitbild choice of limit.
const maximumShelveSeconds = 86_400

export const gridAlarmLifecyclePayloadSchema = z.object({
  alarmIds: z.array(z.string().min(1)).min(1).max(100).describe('Alarm ids from world.electric-grid.alarms.list; every listed alarm must change.'),
  action: z.enum(['acknowledge', 'shelve', 'unshelve']),
  shelveSeconds: z.number().finite().positive().max(maximumShelveSeconds).optional().describe('Shelving duration; required for shelve and only for shelve.'),
  reason: z.string().min(1).max(500).optional(),
}).strict()

export const gridAlarmCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridAlarmLifecycleCommandKind,
    title: 'Alarm lifecycle',
    description: 'Acknowledges, shelves (time-limited; shelving also acknowledges and silences raise and clear events) or unshelves Grid alarms. Lifecycle only: it never changes the network, and an acknowledged alarm stays active until its condition clears. Rejected, changing nothing, when an alarm is unknown or already in the requested state.',
    payloadSchema: gridAlarmLifecyclePayloadSchema,
    risk: 'write',
    searchTerms: ['alarm', 'acknowledge', 'ack', 'shelve', 'unshelve', 'silence', 'alarm flood', 'annunciator', 'alarm management', 'alarm', 'kvitter', 'kvittering', 'sperr', 'alarmhåndtering'],
  }),
]
