import { z } from 'zod'
import { idSchema, objectIdSchema } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { evaluateProcessPlantAssessments } from '../assessments.ts'
import { processPlantControlWritePayloadSchema } from '../commands.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { validateOperatorWrite } from '../operations/command-guard.ts'
import { listedControlsFor, listedResetsFor, proposalPortsFor } from '../operations/instance-ports.ts'
import { reviewProposal } from '../operations/proposals.ts'
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
  'world.process-plant.control.proposals',
  'world.process-plant.controls.list',
] as const

export const controlProposalsQuerySchema = z.object({
  plantId: idSchema,
  /** The proposals to read, by id; every one the Plant holds when absent (its pending ones and the last closed ones). */
  proposalIds: z.array(z.string().min(1)).min(1).max(64).optional(),
}).strict()

export const controlsListQuerySchema = z.object({
  plantId: idSchema,
  /** The drawn items to list, by the id an agent names them by ("pressurizer.blockValve"); every one when absent. */
  items: z.array(z.string().min(1)).min(1).max(64).optional(),
}).strict()

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
  if (config.request.capabilityId === 'world.process-plant.control.proposals') {
    const payload = controlProposalsQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    if (system.operations === undefined) return rejectCapabilityTarget(`Process Plant ${payload.plantId} keeps no operations record`)
    const held = system.operations.book().proposals
    const unknown = (payload.proposalIds ?? []).filter(id => !held.some(proposal => proposal.id === id))
    if (unknown.length > 0) return rejectCapabilityTarget(`No proposal ${unknown.join(', ')} on Process Plant ${payload.plantId}; it holds ${held.map(proposal => proposal.id).join(', ') || 'none'}`)
    // A pending proposal is reviewed as a person or an agent would act on it now.
    const ports = proposalPortsFor(system, undefined)
    return {
      plantId: payload.plantId,
      plantElapsedMs: system.runtime.elapsedMs(),
      proposals: held
        .filter(proposal => payload.proposalIds === undefined || payload.proposalIds.includes(proposal.id))
        .map(proposal => ({ proposal, ...(proposal.status === 'pending' ? { review: reviewProposal(proposal, ports) } : {}) })),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.controls.list') {
    const payload = controlsListQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const items = listedControlsFor(system, payload.items)
    const missing = (payload.items ?? []).filter(id => !items.some(item => item.id === id))
    if (missing.length > 0) return rejectCapabilityTarget(`Process Plant ${payload.plantId} has no item ${missing.join(', ')}: name items by their element ids (component ids, or "<component>.<device>")`)
    return { plantId: payload.plantId, plantElapsedMs: system.runtime.elapsedMs(), items, resets: listedResetsFor(system) }
  }
  const payload = processPlantControlWritePayloadSchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  // As a person's or an AI agent's write: the Run's own writes are not previewed.
  return validateOperatorWrite({
    system: system.plant,
    runtime: system.runtime,
    ...(system.protection === undefined ? {} : { protection: system.protection }),
    payload,
    origin: undefined,
  })
}
