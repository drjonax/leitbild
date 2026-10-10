import type { ProcessPlantIcOperatingMode } from '../runtime/index.ts'
import { all, atPowerThresholdMw, comparison } from './reference-ic-helpers.ts'

// The reference PWR's operating modes, after the standard technical
// specifications' modes 1 to 5 (refuelling is not modelled), declared once in
// the order that decides between them: the Plant is in the first that holds.
// The model solves no reactivity margin, so the reactor counts as able to be
// critical while both trip breakers read closed; once either opens, the mode
// follows the average coolant temperature. Rules name these by id.

/** 350 °F: hot standby at or above it. */
const hotStandbyMinimumTavgC = 176.7
/** 200 °F: cold shutdown at or below it. */
const coldShutdownMaximumTavgC = 93.3

const tripBreakersClosed = [
  comparison({ tagId: 'TRIP-BKR-A-POS' }, '==', true),
  comparison({ tagId: 'TRIP-BKR-B-POS' }, '==', true),
]

export const referenceOperatingModes = [
  { id: 'powerOperation', label: 'Power operation', condition: all([...tripBreakersClosed, comparison({ path: 'core.powerMw' }, '>', atPowerThresholdMw)]) },
  { id: 'startup', label: 'Startup', condition: all(tripBreakersClosed) },
  { id: 'hotStandby', label: 'Hot standby', condition: comparison({ tagId: 'TAVG' }, '>=', hotStandbyMinimumTavgC) },
  { id: 'hotShutdown', label: 'Hot shutdown', condition: comparison({ tagId: 'TAVG' }, '>', coldShutdownMaximumTavgC) },
  { id: 'coldShutdown', label: 'Cold shutdown', condition: comparison({ tagId: 'TAVG' }, '<=', coldShutdownMaximumTavgC) },
] as const satisfies ReadonlyArray<ProcessPlantIcOperatingMode>

export type ReferenceOperatingModeId = (typeof referenceOperatingModes)[number]['id']
