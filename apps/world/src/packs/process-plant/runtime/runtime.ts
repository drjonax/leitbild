import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { initialComponentValueFor } from './component-behaviors.ts'
import { assertProcessPlantRuntimeInvariants } from './behavior-contract.ts'
import { createReusableBehaviorContext } from './behavior-contract.ts'
import { compileProcessPlantExecutionPlan, runProcessPlantExecutionPhase, runProcessPlantInitialReconciliation, type ProcessPlantExecutionPlan } from './execution-plan.ts'
import { processPlantSolverPhases, type ProcessPlantCommand, type ProcessPlantRuntime, type ProcessPlantRuntimeCheckpoint, type ProcessPlantRuntimeSnapshot, type ProcessPlantTickResult, type ProcessPlantValue } from './model.ts'
import { createProcessPlantVariableTable, type ProcessPlantVariableTable } from './variable-table.ts'
import { compilePwrTransientKernel, evaluatePwrTransientKernel, type PwrTransientDiagnostics, type PwrTransientKernel } from './pwr-transient-kernel.ts'

interface RuntimeClock {
  elapsedMs: number
  remainderMs: number
}

const assertRestoredCheckpointMatchesSystem = (
  system: CompiledProcessPlant,
  restoredCheckpoint: ProcessPlantRuntimeCheckpoint | undefined,
): void => {
  if (!restoredCheckpoint) return
  if (restoredCheckpoint.modelDigest !== system.modelDigest) {
    throw new Error(`restored process plant model ${restoredCheckpoint.modelDigest} does not match Plant model ${system.modelDigest}`)
  }
}

const step = (
  system: CompiledProcessPlant,
  table: ProcessPlantVariableTable,
  plan: ProcessPlantExecutionPlan,
  clock: RuntimeClock,
  context: ReturnType<typeof createReusableBehaviorContext>,
  stepMs: number,
  assertInvariants: boolean,
): void => {
  const dtSeconds = stepMs / 1_000
  table.applyQueuedCommands()
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'updateControlLogic', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'solveFluidFlowComponents', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'solveFluidFlowLinks', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'solveThermalTransfer', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'solveElectrical', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'updateComponentState', dtSeconds })
  runProcessPlantExecutionPhase({ system, plan, context, phase: 'updateProcessLinkState', dtSeconds })
  if (assertInvariants) assertProcessPlantRuntimeInvariants(table)
  clock.elapsedMs += stepMs
}

export const createProcessPlantRuntime = (config: {
  readonly system: CompiledProcessPlant
  readonly restoredCheckpoint?: ProcessPlantRuntimeCheckpoint
  readonly assertInvariants?: boolean
}): ProcessPlantRuntime => {
  const system = config.system
  assertRestoredCheckpointMatchesSystem(system, config.restoredCheckpoint)
  const table = createProcessPlantVariableTable(
    system,
    initialComponentValueFor,
    config.restoredCheckpoint?.values,
    config.restoredCheckpoint?.queuedCommands,
    system.initialState,
  )
  const fixedStepMs = system.graph.timestep.fixedStepMs
  const plan = compileProcessPlantExecutionPlan(system)
  const behaviorContext = createReusableBehaviorContext(table)
  if (!config.restoredCheckpoint) {
    runProcessPlantInitialReconciliation({ system, table, plan })
  }
  const assertInvariants = config.assertInvariants ?? false
  const clock: RuntimeClock = {
    elapsedMs: config.restoredCheckpoint?.elapsedMs ?? 0,
    remainderMs: config.restoredCheckpoint?.remainderMs ?? 0,
  }
  let pwrKernel: PwrTransientKernel | null = null
  let lastPwrTransientDiagnostics: PwrTransientDiagnostics | null = null
  let pwrTransientDiagnosticsDirty = true

  const pwrTransientDiagnostics = (): PwrTransientDiagnostics => {
    pwrKernel ??= compilePwrTransientKernel(system, table)
    if (lastPwrTransientDiagnostics === null || pwrTransientDiagnosticsDirty) {
      lastPwrTransientDiagnostics = evaluatePwrTransientKernel(pwrKernel, table)
      pwrTransientDiagnosticsDirty = false
    }
    return lastPwrTransientDiagnostics
  }

  const snapshot = (): ProcessPlantRuntimeSnapshot => ({
    graphSpecId: String(system.graph.specId),
    variablePaths: system.graph.variables.map(variable => variable.path),
    elapsedMs: clock.elapsedMs,
    remainderMs: clock.remainderMs,
    queuedCommands: table.queuedCommands(),
    variables: table.snapshot(),
  })

  const checkpoint = (): ProcessPlantRuntimeCheckpoint => ({
    modelDigest: system.modelDigest,
    elapsedMs: clock.elapsedMs,
    remainderMs: clock.remainderMs,
    queuedCommands: table.queuedCommands(),
    values: table.snapshotValues(),
  })

  return {
    tick: (elapsedMs: number): ProcessPlantTickResult => {
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error(`process plant tick elapsedMs must be positive, got ${elapsedMs}`)
      clock.remainderMs += elapsedMs
      let simulatedMs = 0
      while (clock.remainderMs >= fixedStepMs) {
        step(system, table, plan, clock, behaviorContext, fixedStepMs, assertInvariants)
        pwrTransientDiagnosticsDirty = true
        clock.remainderMs -= fixedStepMs
        simulatedMs += fixedStepMs
      }
      return {
        elapsedMs,
        simulatedMs,
        phases: processPlantSolverPhases,
      }
    },
    elapsedMs: (): number => clock.elapsedMs,
    advancedMs: (): number => clock.elapsedMs + clock.remainderMs,
    resolveVariableHandle: (path: VariablePath) => table.resolve(path),
    readVariable: (path: VariablePath): ProcessPlantValue => table.read(path),
    readVariableHandle: (handle) => table.readHandle(handle),
    readVariableSnapshot: (path: VariablePath) => table.snapshotVariable(path),
    readVariableSnapshotHandle: (handle) => table.snapshotHandle(handle),
    writeCommand: (command: ProcessPlantCommand): void => {
      table.queueCommand(command)
    },
    pwrTransientDiagnostics,
    snapshot,
    checkpoint,
  }
}
