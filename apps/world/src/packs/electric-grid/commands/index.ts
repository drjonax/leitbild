import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { gridAlarmCommandCapabilities, gridAlarmLifecycleCommandKind } from './alarm.ts'
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
import { gridFrequencyCommandCapabilities, gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from './frequency.ts'
import { gridHvdcCommandCapabilities, gridHvdcCommandKinds } from './hvdc.ts'
import {
  gridLoadCommandCapabilities,
  gridRestoreLoadCommandKind,
  gridSetEvChargingDemandCommandKind,
  gridShedLoadCommandKind,
} from './load.ts'
import { gridProtectionCommandCapabilities, gridResetBranchProtectionCommandKind } from './protection.ts'

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
  gridRestoreLfddStageCommandKind,
  gridRearmLfddStageCommandKind,
  gridResetBranchProtectionCommandKind,
  gridAlarmLifecycleCommandKind,
  ...gridHvdcCommandKinds,
] as const

export const electricGridCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  ...gridGeneratorCommandCapabilities,
  ...gridBranchCommandCapabilities,
  ...gridLoadCommandCapabilities,
  ...gridFrequencyCommandCapabilities,
  ...gridProtectionCommandCapabilities,
  ...gridAlarmCommandCapabilities,
  ...gridHvdcCommandCapabilities,
]

/** Commands that disconnect generation or supply at once; operator surfaces confirm them first. */
export const electricGridDestructiveCommandKinds: ReadonlySet<string> = new Set(
  electricGridCommandCapabilities.filter(capability => capability.risk === 'destructive').map(capability => capability.id),
)
