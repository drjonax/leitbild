import type { SimulationCapability } from '../../../simulation/protocol.ts'
import {
  gridClearDerateCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridOpenBranchCommandKind,
  gridBranchCommandCapabilities,
} from './branch.ts'
import {
  gridDispatchGeneratorCommandKind,
  gridGeneratorCommandCapabilities,
  gridResetGeneratorTripCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridStartGeneratorCommandKind,
  gridStopGeneratorCommandKind,
  gridTripGeneratorCommandKind,
} from './generator.ts'
import {
  gridLoadCommandCapabilities,
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridShedLoadCommandKind,
} from './load.ts'

export const electricGridCommandKinds = [
  gridDispatchGeneratorCommandKind,
  gridTripGeneratorCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
  gridResetGeneratorTripCommandKind,
  gridStartGeneratorCommandKind,
  gridStopGeneratorCommandKind,
  gridOpenBranchCommandKind,
  gridCloseBranchCommandKind,
  gridDerateBranchCommandKind,
  gridClearDerateCommandKind,
  gridShedLoadCommandKind,
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
] as const

export const electricGridCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  ...gridGeneratorCommandCapabilities,
  ...gridBranchCommandCapabilities,
  ...gridLoadCommandCapabilities,
]

/** Commands that disconnect generation or supply at once; operator surfaces confirm them first. */
export const electricGridDestructiveCommandKinds: ReadonlySet<string> = new Set(
  electricGridCommandCapabilities.filter(capability => capability.risk === 'destructive').map(capability => capability.id),
)
