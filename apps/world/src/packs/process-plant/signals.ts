import { z } from 'zod'
import type {
  CompiledComponent,
  CompiledPlantGraph,
  ProcessSignalBinding,
  ProcessSignalTagId,
  ProcessVariableCapability,
  ProcessVariableLimits,
  ProcessEquipmentId,
  VariablePath,
} from './graph/index.ts'
import type { ProcessQuantity, ProcessUnit, VariableDiscipline, VariableKind } from './graph/index.ts'
import { processSignalTagIdSchema, variablePathSchema } from './graph/index.ts'
import type { ProcessPlantVariableSnapshot } from './runtime/index.ts'
import { rejectCapabilityTarget } from '../../simulation/capability-rejection.ts'

export const processPlantSignalReferenceSchema = z.object({
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
}).strict().superRefine((reference, ctx) => {
  const referenceCount = Number(reference.path !== undefined) + Number(reference.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process signal reference must define exactly one of path or tagId',
    })
  }
})
export type ProcessPlantSignalReference = z.infer<typeof processPlantSignalReferenceSchema>

export const resolveProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding => {
  if (reference.path !== undefined) {
    const binding = graph.signalBindingByPath.get(reference.path)
    if (!binding) return rejectCapabilityTarget(
      `Process Plant signal path not found: ${reference.path}. Discover exact paths with world.process-plant.signals.search.`,
    )
    return binding
  }
  if (reference.tagId !== undefined) {
    const binding = graph.signalBindingByTagId.get(reference.tagId)
      ?? graph.signalBindingByExternalRef.get(reference.tagId)
    if (!binding) return rejectCapabilityTarget(
      `Process Plant signal tag not found: ${reference.tagId}. Discover exact tags with world.process-plant.signals.search.`,
    )
    return binding
  }
  throw new Error('process signal reference must define path or tagId')
}

export const findProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding | undefined => {
  if (reference.path !== undefined) return graph.signalBindingByPath.get(reference.path)
  if (reference.tagId !== undefined) {
    return graph.signalBindingByTagId.get(reference.tagId)
      ?? graph.signalBindingByExternalRef.get(reference.tagId)
  }
  return undefined
}

/**
 * The component a signal is measured on: the component that owns it, or for a
 * line's signal the equipment the line flows into. Its declared equipmentId is
 * metadata and may name no component.
 */
export const signalMeasuredOn = (
  graph: CompiledPlantGraph,
  owner: ProcessSignalBinding['owner'],
): CompiledComponent =>
  graph.components[owner.type === 'component' ? owner.componentIndex : graph.links[owner.linkIndex]!.toComponentIndex]!

export const resolveProcessPlantSignalPath = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): VariablePath => resolveProcessPlantSignalBinding(graph, reference).path

export interface ProcessPlantSignalView {
  readonly path: VariablePath
  readonly tagId?: ProcessSignalTagId
  readonly equipmentId?: ProcessEquipmentId
  readonly description?: string
  readonly externalRefs?: ReadonlyArray<string>
  readonly capabilities?: ProcessVariableCapability
  readonly limits?: ProcessVariableLimits
  readonly label: string
  readonly kind: VariableKind
  readonly discipline: VariableDiscipline
  readonly quantity: ProcessQuantity
  readonly unit: ProcessUnit
  readonly writable: boolean
  readonly simulatorOnly?: true
  readonly published: boolean
  readonly owner: ProcessSignalBinding['owner']
}

export interface ProcessPlantSignalQuality {
  readonly status: 'good' | 'outside-hard-range'
  readonly reason?: string
}

export const processPlantSignalView = (binding: ProcessSignalBinding): ProcessPlantSignalView => ({
  path: binding.path,
  ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
  ...(binding.equipmentId === undefined ? {} : { equipmentId: binding.equipmentId }),
  ...(binding.description === undefined ? {} : { description: binding.description }),
  ...(binding.externalRefs === undefined ? {} : { externalRefs: binding.externalRefs }),
  ...(binding.capabilities === undefined ? {} : { capabilities: binding.capabilities }),
  ...(binding.limits === undefined ? {} : { limits: binding.limits }),
  label: binding.label,
  kind: binding.kind,
  discipline: binding.discipline,
  quantity: binding.quantity,
  unit: binding.unit,
  writable: binding.writable,
  ...(binding.simulatorOnly === undefined ? {} : { simulatorOnly: binding.simulatorOnly }),
  published: binding.published,
  owner: binding.owner,
})

export const processPlantSignalQuality = (
  variable: ProcessPlantVariableSnapshot,
): ProcessPlantSignalQuality => {
  if (typeof variable.value !== 'number') return { status: 'good' }
  const hardRange = variable.limits?.hardRange
  if (hardRange === undefined) return { status: 'good' }
  if (variable.value < hardRange.min || variable.value > hardRange.max) {
    return {
      status: 'outside-hard-range',
      reason: `${variable.path} value ${variable.value} is outside hard range ${hardRange.min}..${hardRange.max} ${variable.unit}`,
    }
  }
  return { status: 'good' }
}
