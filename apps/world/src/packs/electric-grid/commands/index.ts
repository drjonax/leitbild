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
  gridReturnGeneratorToServiceCommandKind,
  gridSetGeneratorAvailabilityCommandKind,
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
  gridReturnGeneratorToServiceCommandKind,
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
