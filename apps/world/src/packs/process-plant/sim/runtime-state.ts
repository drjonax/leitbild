import { z } from 'zod'
import {
  processVariableValueSchema,
  variablePathSchema,
} from '../graph/index.ts'
import {
  processPlantRampSnapshotSchema,
  processPlantProtectionSnapshotSchema,
  type ProcessPlantRuntimeCheckpoint,
  type ProcessPlantRampSnapshot,
  type ProcessPlantProtectionSnapshot,
} from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import type { OffsiteIsolation } from './offsite-isolation.ts'
import { plantOperationsStateSchema, type PlantOperationsState } from '../operations/plant-operations.ts'

const processPlantRuntimeCheckpointSchema = z.object({
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  elapsedMs: z.number().finite().nonnegative(),
  remainderMs: z.number().finite().nonnegative(),
  queuedCommands: z.array(z.object({
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  })),
  values: z.array(processVariableValueSchema),
})

export const processPlantRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  plants: z.array(z.object({
    plantId: z.string().min(1),
    runtime: processPlantRuntimeCheckpointSchema,
    ramps: processPlantRampSnapshotSchema,
    protection: processPlantProtectionSnapshotSchema.optional(),
    // Connected ports a plant-side fault has isolated from their Grid (offsite-isolation.ts); none when absent.
    offsiteIsolations: z.array(z.object({ portId: z.string().min(1), cause: z.string().min(1) })).optional(),
    // What people and AI agents did and propose (operations/plant-operations.ts); none when absent.
    operations: plantOperationsStateSchema.optional(),
  })),
})

export interface ProcessPlantRuntimeState {
  readonly schemaVersion: 1
  readonly plants: ReadonlyArray<{
    readonly plantId: string
    readonly runtime: ProcessPlantRuntimeCheckpoint
    readonly ramps: ProcessPlantRampSnapshot
    readonly protection?: ProcessPlantProtectionSnapshot
    readonly offsiteIsolations?: ReadonlyArray<OffsiteIsolation>
    readonly operations?: PlantOperationsState
  }>
}

export const runtimeStateForProcessPlants = (
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
  offsiteIsolations: ReadonlyMap<string, ReadonlyArray<OffsiteIsolation>>,
): ProcessPlantRuntimeState => ({
  schemaVersion: 1,
  plants: [...plants.values()].map(({ plant, runtime, ramps, protection, operations }) => {
    const isolations = offsiteIsolations.get(plant.id) ?? []
    const operated = operations?.snapshot()
    return {
      plantId: plant.id,
      runtime: runtime.checkpoint(),
      ramps: ramps.snapshot(),
      ...(protection === undefined ? {} : { protection: protection.snapshot() }),
      ...(isolations.length === 0 ? {} : { offsiteIsolations: isolations.map(isolation => ({ ...isolation })) }),
      ...(operated === undefined ? {} : { operations: operated }),
    }
  }),
})

const restoredPlantFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
) => runtimeState?.plants.find(plant => plant.plantId === plantId)

export const restoredRuntimeCheckpointFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantRuntimeCheckpoint | undefined => restoredPlantFor(runtimeState, plantId)?.runtime

export const restoredRampSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantRampSnapshot | undefined => restoredPlantFor(runtimeState, plantId)?.ramps

export const restoredProtectionSnapshotFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ProcessPlantProtectionSnapshot | undefined => restoredPlantFor(runtimeState, plantId)?.protection

export const restoredOperationsFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): PlantOperationsState | undefined => restoredPlantFor(runtimeState, plantId)?.operations

export const restoredOffsiteIsolationsFor = (
  runtimeState: ProcessPlantRuntimeState | null,
  plantId: string,
): ReadonlyArray<OffsiteIsolation> => restoredPlantFor(runtimeState, plantId)?.offsiteIsolations ?? []
