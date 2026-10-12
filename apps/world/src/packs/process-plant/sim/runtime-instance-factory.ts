import { createProcessPlantRuntime } from '../runtime/index.ts'
import {
  createProcessPlantRampRunner,
  createProcessPlantProtectionRunner,
} from '../runtime/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { createPlantOperations } from '../operations/plant-operations.ts'
import {
  restoredOperationsFor,
  restoredProtectionSnapshotFor,
  restoredRuntimeCheckpointFor,
  restoredRampSnapshotFor,
  type ProcessPlantRuntimeState,
} from './runtime-state.ts'

export const createProcessPlantRuntimeInstances = (config: {
  readonly compiledPlants: ReadonlyArray<CompiledProcessPlant>
  readonly runtimeState: ProcessPlantRuntimeState | null
}): Map<string, ProcessPlantRuntimeInstance> => new Map(config.compiledPlants.map(plant => [
  plant.id,
  (() => {
    const restoredRuntimeCheckpoint = restoredRuntimeCheckpointFor(config.runtimeState, plant.id)
    const runtime = createProcessPlantRuntime({
      system: plant,
      ...(restoredRuntimeCheckpoint === undefined ? {} : { restoredCheckpoint: restoredRuntimeCheckpoint }),
    })
    const restoredRamps = restoredRampSnapshotFor(config.runtimeState, plant.id)
    const restoredProtectionSnapshot = restoredProtectionSnapshotFor(config.runtimeState, plant.id)
    const ramps = createProcessPlantRampRunner({
      runtime,
      ...(restoredRamps === undefined ? {} : { restoredSnapshot: restoredRamps }),
    })
    // An automatic action's write ends a ramp on the same variable: the ramp no longer reopens a valve a trip shut.
    const protection = createProcessPlantProtectionRunner({
      system: plant,
      protection: plant.automation,
      ...(restoredProtectionSnapshot === undefined ? {} : { restoredSnapshot: restoredProtectionSnapshot }),
      onWrite: path => { ramps.cancel(path) },
    })
    return {
      plant,
      runtime,
      ramps,
      protection,
      operations: createPlantOperations(restoredOperationsFor(config.runtimeState, plant.id)),
      performance: createProcessPlantRuntimePerformance(),
    }
  })(),
]))
