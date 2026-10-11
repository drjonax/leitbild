import type { ProcessPlantIcOperatingMode } from '../runtime/index.ts'
import { all, atPowerThresholdMw, comparison } from './reference-ic-helpers.ts'

// The reference PWR's operating modes, after the standard technical
// specifications' modes 1 to 5 (refuelling is not modelled), declared once in
// the order that decides between them: the Plant is in the first that holds.
// The model solves no reactivity margin, so the reactor counts as able to be
// critical while both trip breakers read closed; once either opens, the mode
// follows the average coolant temperature. Rules name these by id; displays
// name them by their technical-specification numbers where room is short.

/** 350 °F: hot standby at or above it. */
const hotStandbyMinimumTavgC = 176.7
/** 200 °F: cold shutdown at or below it. */
const coldShutdownMaximumTavgC = 93.3

const tripBreakersClosed = [
  comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', true),
  comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', true),
]

export const referenceOperatingModes = [
  { id: 'powerOperation', label: 'Power operation', shortLabel: '1', condition: all([...tripBreakersClosed, comparison({ path: 'core.powerMw' }, '>', atPowerThresholdMw)]) },
  { id: 'startup', label: 'Startup', shortLabel: '2', condition: all(tripBreakersClosed) },
  { id: 'hotStandby', label: 'Hot standby', shortLabel: '3', condition: comparison({ tagId: 'TAVG' }, '>=', hotStandbyMinimumTavgC) },
  { id: 'hotShutdown', label: 'Hot shutdown', shortLabel: '4', condition: comparison({ tagId: 'TAVG' }, '>', coldShutdownMaximumTavgC) },
  { id: 'coldShutdown', label: 'Cold shutdown', shortLabel: '5', condition: comparison({ tagId: 'TAVG' }, '<=', coldShutdownMaximumTavgC) },
] as const satisfies ReadonlyArray<ProcessPlantIcOperatingMode>

export type ReferenceOperatingModeId = (typeof referenceOperatingModes)[number]['id']
