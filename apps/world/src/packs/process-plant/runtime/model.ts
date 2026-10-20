import type { ProcessEquipmentId, ProcessQuantity, ProcessSignalTagId, ProcessUnit, ProcessVariableCapability, ProcessVariableLimits, ProcessVariableValue, VariableDiscipline, VariableKind, VariablePath } from '../graph/index.ts'
import type { PwrTransientDiagnostics } from './pwr-transient-kernel.ts'
import type { ProcessPlantVariableHandle } from './variable-table.ts'

export type ProcessPlantValue = ProcessVariableValue

export const processPlantSolverPhases = [
  'applyCommands',
  'updateControlLogic',
  'solveFluidFlowComponents',
  'solveFluidFlowLinks',
  'solveThermalTransfer',
  'solveElectrical',
  'updateComponentState',
  'updateProcessLinkState',
] as const
export type ProcessPlantSolverPhase = typeof processPlantSolverPhases[number]

export interface ProcessPlantCommand {
  readonly type: 'setVariable'
  readonly path: VariablePath
  readonly value: ProcessPlantValue
}

export interface ProcessPlantVariableSnapshot {
  readonly path: VariablePath
  readonly label: string
  readonly value: ProcessPlantValue
  readonly canonicalValue: ProcessPlantValue
  readonly quantity: ProcessQuantity
  readonly unit: ProcessUnit
  readonly discipline: VariableDiscipline
  readonly kind: VariableKind
  readonly writable: boolean
  readonly published: boolean
  readonly tagId?: ProcessSignalTagId
  readonly equipmentId?: ProcessEquipmentId
  readonly description?: string
  readonly externalRefs?: ReadonlyArray<string>
  readonly capabilities?: ProcessVariableCapability
  readonly limits?: ProcessVariableLimits
}

export interface ProcessPlantTickResult {
  readonly elapsedMs: number
  readonly simulatedMs: number
  readonly phases: ReadonlyArray<ProcessPlantSolverPhase>
}

export interface ProcessPlantRuntimeSnapshot {
  readonly graphSpecId: string
  readonly variablePaths: ReadonlyArray<VariablePath>
  readonly elapsedMs: number
  readonly remainderMs: number
  readonly queuedCommands: ReadonlyArray<ProcessPlantCommand>
  readonly variables: ReadonlyArray<ProcessPlantVariableSnapshot>
}

export interface ProcessPlantRuntimeCheckpoint {
  readonly modelDigest: string
  readonly elapsedMs: number
  readonly remainderMs: number
  readonly queuedCommands: ReadonlyArray<ProcessPlantCommand>
  readonly values: ReadonlyArray<ProcessPlantValue>
}

export interface ProcessPlantRuntime {
  readonly tick: (elapsedMs: number) => ProcessPlantTickResult
  readonly elapsedMs: () => number
  /** Plant time ticked in all: the stepped elapsedMs and the remainder short of a step, so Run time minus it is fixed. */
  readonly advancedMs: () => number
  readonly resolveVariableHandle: (path: VariablePath) => ProcessPlantVariableHandle
  readonly readVariable: (path: VariablePath) => ProcessPlantValue
  readonly readVariableHandle: (handle: ProcessPlantVariableHandle) => ProcessPlantValue
  readonly readVariableSnapshot: (path: VariablePath) => ProcessPlantVariableSnapshot
  readonly readVariableSnapshotHandle: (handle: ProcessPlantVariableHandle) => ProcessPlantVariableSnapshot
  readonly writeCommand: (command: ProcessPlantCommand) => void
  readonly pwrTransientDiagnostics: () => PwrTransientDiagnostics
  readonly snapshot: () => ProcessPlantRuntimeSnapshot
  readonly checkpoint: () => ProcessPlantRuntimeCheckpoint
}
