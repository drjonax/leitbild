import type { CompiledProcessPlant } from './plant-compiler.ts'
import type { PlantOperations } from './operations/plant-operations.ts'
import type { ProcessPlantProtectionRunner, ProcessPlantRampRunner, ProcessPlantRuntime } from './runtime/index.ts'

export interface ProcessPlantRuntimePerformanceSnapshot {
  readonly wallMs: number
  readonly simulatedMs: number
  readonly realtimeFactor: number
}

export interface ProcessPlantRuntimePerformance {
  readonly record: (sample: {
    readonly wallMs: number
    readonly simulatedMs: number
  }) => void
  readonly snapshot: () => ProcessPlantRuntimePerformanceSnapshot | null
}

export interface ProcessPlantRuntimeInstance {
  readonly plant: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly ramps: ProcessPlantRampRunner
  readonly protection?: ProcessPlantProtectionRunner
  /** What people and AI agents did to it and propose (operations/plant-operations.ts); the Pack runtime keeps one per Plant. */
  readonly operations?: PlantOperations
  readonly performance: ProcessPlantRuntimePerformance
}

export const createProcessPlantRuntimePerformance = (): ProcessPlantRuntimePerformance => {
  let lastSample: ProcessPlantRuntimePerformanceSnapshot | null = null
  return {
    record: (sample): void => {
      const wallMs = Math.max(0, sample.wallMs)
      const simulatedMs = Math.max(0, sample.simulatedMs)
      lastSample = {
        wallMs,
        simulatedMs,
        realtimeFactor: simulatedMs <= 0 ? 0 : simulatedMs / Math.max(0.001, wallMs),
      }
    },
    snapshot: (): ProcessPlantRuntimePerformanceSnapshot | null => lastSample,
  }
}
