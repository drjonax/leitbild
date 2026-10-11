import { z } from 'zod'
import { idSchema, objectIdSchema } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { evaluateProcessPlantAssessments } from '../assessments.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { validateProcessPlantControlWrite } from '../control-write-validation.ts'
import { evaluateProcessPlantIcCondition, processPlantIcConditionSchema } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { requirePlant } from './common.ts'
import { evaluateProcessPlantProcedureCondition, processPlantProcedureBasisSchema, processPlantProcedureConditionSchema } from '../condition-evidence.ts'

export const procedureConditionEvaluateQuerySchema = z.object({
  targetObjectId: objectIdSchema,
  condition: processPlantProcedureConditionSchema,
  basis: processPlantProcedureBasisSchema,
}).strict()

export const conditionsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  condition: processPlantIcConditionSchema,
}).strict()

export const assessmentsEvaluateQuerySchema = z.object({
  plantId: idSchema,
  /** The critical safety functions to judge, by id; every one the Plant declares when absent. */
  assessmentIds: z.array(z.string().min(1)).min(1).optional(),
}).strict()

export const processPlantControlQueryKinds = [
  'world.process-plant.procedure-condition.evaluate',
  'world.process-plant.conditions.evaluate',
  'world.process-plant.assessments.evaluate',
  'world.process-plant.control.validate',
] as const

export const answerProcessPlantControlQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantControlQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.procedure-condition.evaluate') {
    const payload = procedureConditionEvaluateQuerySchema.parse(config.request.input)
    const plant = requirePlant(config.plants, payload.targetObjectId)
    return { targetObjectId: payload.targetObjectId, ...evaluateProcessPlantProcedureCondition({ plant, condition: payload.condition, basis: payload.basis }) }
  }
  if (config.request.capabilityId === 'world.process-plant.conditions.evaluate') {
    const payload = conditionsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const evaluation = evaluateProcessPlantIcCondition({
      system: system.plant,
      runtime: system.runtime,
      condition: payload.condition,
    })
    return {
      plantId: payload.plantId,
      matches: evaluation.matches,
      signalsRead: evaluation.signalsRead,
    }
  }
  if (config.request.capabilityId === 'world.process-plant.assessments.evaluate') {
    const payload = assessmentsEvaluateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      assessments: evaluateProcessPlantAssessments(system, payload.assessmentIds),
    }
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  return validateProcessPlantControlWrite({
    system: system.plant,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
  })
}
