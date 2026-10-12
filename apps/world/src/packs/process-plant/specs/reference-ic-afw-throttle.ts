import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { minimumFeedFlowKgPerS } from './reference-ic-safety-functions.ts'

// Operators throttle actuated auxiliary feedwater (ES-0.1) with the actuation
// still standing; they do not shut a line with it. Each actuation that opens
// the auxiliary feedwater control valves declares how far: no lower than
// 20 % open, where each steam generator's line stays open and, with every
// valve there, the pumps the actuation runs still deliver more than the
// FR-H.1 minimum total feed (about 33 kg/s on the reference plant after a
// trip, against 27.8 kg/s; a test holds the model to it).
export const auxiliaryFeedwaterThrottleFloor: NonNullable<ProcessPlantIcRule['throttleFloor']> = {
  value: 0.2,
  basis: `keeps every steam generator's auxiliary feedwater line open, and with every line there total feed stays above the FR-H.1 minimum of ${minimumFeedFlowKgPerS} kg/s (440 gpm, ERG F-0.3)`,
}
