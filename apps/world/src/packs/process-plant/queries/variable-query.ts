import { z } from 'zod'
import { idSchema, matchesLiteralSearch } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import type { VariablePath } from '../graph/index.ts'
import { processQuantitySchema, variableDisciplineSchema, variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantVariableSnapshot } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { isInjectedFault } from '../signals.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { capabilityTargetNotFound, paginateProcessPlantSearch, processPlantSearchPaginationShape, requirePlant } from './common.ts'

export const variablesReadQuerySchema = z.object({
  plantId: idSchema,
  paths: z.array(variablePathSchema).min(1),
}).strict()

export const variablesSearchQuerySchema = z.object({
  plantId: idSchema.optional(),
  text: z.string().min(1).optional(),
  discipline: variableDisciplineSchema.optional(),
  quantity: processQuantitySchema.optional(),
  publishedOnly: z.boolean().default(false),
  ...processPlantSearchPaginationShape,
}).strict()

export const processPlantVariableQueryKinds = [
  'world.process-plant.variables.read',
  'world.process-plant.variables.search',
] as const

const snapshotsFor = (
  system: ProcessPlantRuntimeInstance,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<ProcessPlantVariableSnapshot> => paths.map(path => {
  const binding = system.plant.graph.signalBindingByPath.get(path)
  if (binding !== undefined && isInjectedFault(binding)) {
    return rejectCapabilityTarget(binding.faultTruth === true
      ? `${path} is the model's truth about an injected fault, not a reading: no person or AI agent reads it`
      : `${path} is a fault the scenario injects, not a reading: no person or AI agent reads it`)
  }
  try {
    return system.runtime.readVariableSnapshot(path)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('unknown process plant variable:')) {
      return capabilityTargetNotFound(
        `Process Plant variable not found: ${path}. Discover exact paths with world.process-plant.variables.search.`,
      )
    }
    throw error
  }
})

const matchesSearch = (
  variable: ProcessPlantVariableSnapshot,
  config: z.infer<typeof variablesSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && !variable.published) return false
  if (config.discipline !== undefined && variable.discipline !== config.discipline) return false
  if (config.quantity !== undefined && variable.quantity !== config.quantity) return false
  return matchesLiteralSearch(config.text, [
    variable.path,
    variable.label,
    variable.quantity,
    variable.unit,
    variable.tagId,
    variable.equipmentId,
    variable.description,
  ])
}

export const answerProcessPlantVariableQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantVariableQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.variables.read') {
    const payload = variablesReadQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return { variables: snapshotsFor(system, payload.paths) }
  }
  const payload = variablesSearchQuerySchema.parse(config.request.input)
  const plants = payload.plantId === undefined
    ? [...config.plants.values()]
    : [requirePlant(config.plants, payload.plantId)]
  const matches = plants.flatMap(system => system.runtime.snapshot().variables
    .filter(variable => !isInjectedFault(system.plant.graph.signalBindingByPath.get(variable.path) ?? {}) && matchesSearch(variable, payload))
    .map(variable => ({ plantId: system.plant.id, variable })))
  const page = paginateProcessPlantSearch(matches, payload.offset, payload.limit)
  return { total: page.total, offset: page.offset, returned: page.returned, hasMore: page.hasMore, variables: page.items }
}
