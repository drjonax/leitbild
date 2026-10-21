import { z } from 'zod'
import { idSchema, matchesLiteralSearch, type IsoTimestamp } from '../../../core/model/index.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import { processQuantitySchema, processSignalTagIdSchema, variableDisciplineSchema } from '../graph/index.ts'
import {
  findProcessPlantSignalBinding,
  processPlantSignalQuality,
  processPlantSignalReferenceSchema,
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
  signalMeasuredOn,
} from '../signals.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { paginateProcessPlantSearch, processPlantSearchPaginationShape, requirePlant } from './common.ts'
import { requestedSignalValueView, resolveRequestedSignalUnit } from './signal-units.ts'

/** The commands issued on these signals and the resets of actuations that held them, at the Run and plant time read at. */
const operationsOn = (config: { readonly simulationTime?: IsoTimestamp }, system: ProcessPlantRuntimeInstance, paths: ReadonlySet<string>) => {
  if (system.operations === undefined) return rejectCapabilityTarget(`Process Plant ${system.plant.id} keeps no operations record`)
  if (config.simulationTime === undefined) throw new Error('signals.read with operations requires the Simulation Run time of the answering runtime')
  return {
    simulationTime: config.simulationTime,
    plantElapsedMs: system.runtime.elapsedMs(),
    log: system.operations.log().filter(record => paths.has(String(record.path))),
    resets: system.operations.resets().filter(record => record.holds.some(path => paths.has(String(path)))),
  }
}

export const signalsResolveQuerySchema = z.object({
  plantId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema).min(1),
}).strict()

export const signalsReadQuerySchema = z.object({
  plantId: idSchema,
  signals: z.array(processPlantSignalReferenceSchema.safeExtend({
    requestedUnit: z.string().trim().min(1).max(128).optional().describe('Optional presentation unit. Raw variable and quality remain unchanged; unsupported conversion returns the actual value/unit with an explicit unavailable reason.'),
  })).min(1),
  operations: z.literal(true).optional().describe('Adds the commands issued on these signals and the resets of actuations that held them, with the Run and plant time read at.'),
}).strict()

export const signalsSearchQuerySchema = z.object({
  detail: z.enum(['summary', 'full']).default('summary').describe('Summary keeps signal identity, meaning, units and writability. Use full or signals.resolve for capabilities, limits, provenance and external references. Filtering always uses all metadata.'),
  plantId: idSchema.optional(),
  text: z.string().min(1).optional(),
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: idSchema.optional(),
  discipline: variableDisciplineSchema.optional(),
  quantity: processQuantitySchema.optional(),
  writable: z.boolean().optional(),
  procedureRelevant: z.boolean().optional(),
  publishedOnly: z.boolean().default(false),
  ...processPlantSearchPaginationShape,
}).strict()

const procedureTagSchema = z.object({
  id: processSignalTagIdSchema,
  description: z.string().min(1).optional(),
  simPath: z.string().min(1).optional(),
  units: z.string().min(1).optional(),
  equipment: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  range: z.array(z.number().finite()).length(2).refine(range => range[0]! <= range[1]!, 'range minimum cannot exceed maximum').optional(),
}).strict()

export const procedureTagsValidateQuerySchema = z.object({
  plantId: idSchema,
  tags: z.array(procedureTagSchema),
}).strict()

export const processPlantSignalQueryKinds = [
  'world.process-plant.signals.resolve',
  'world.process-plant.signals.read',
  'world.process-plant.signals.search',
  'world.process-plant.procedure-tags.validate',
] as const

const normalizedSourceKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[-_.\s]/g, '')

interface ProcessPlantProcedureTagValidation {
  readonly id: string
  readonly status: 'resolved' | 'resolved-with-warnings' | 'missing'
  readonly signal?: ReturnType<typeof processPlantSignalView>
  /** The component id the signal is measured on (signalMeasuredOn); its equipmentId is metadata and may name none. */
  readonly measuredOn?: string
  readonly warnings: ReadonlyArray<string>
}

const validateProcedureTags = (
  system: ProcessPlantRuntimeInstance,
  tags: ReadonlyArray<z.infer<typeof procedureTagSchema>>,
): ReadonlyArray<ProcessPlantProcedureTagValidation> => tags.map(tag => {
  const binding = findProcessPlantSignalBinding(system.plant.graph, { tagId: tag.id })
  if (binding === undefined) return { id: tag.id, status: 'missing', warnings: [] }

  const signal = processPlantSignalView(binding)
  const externalRefs = signal.externalRefs ?? []
  const unitResolution = tag.units === undefined ? undefined : resolveRequestedSignalUnit(signal, tag.units)
  const warnings = [
    ...(tag.simPath !== undefined && tag.simPath !== signal.path && !externalRefs.includes(tag.simPath)
      ? [`sim-path ${tag.simPath} does not match process path ${signal.path}`]
      : []),
    ...(unitResolution?.status === 'unavailable'
      ? [unitResolution.reason]
      : []),
    ...(tag.equipment !== undefined && signal.equipmentId !== undefined
      && normalizedSourceKey(tag.equipment) !== normalizedSourceKey(signal.equipmentId)
      ? [`equipment ${tag.equipment} does not match process equipment ${signal.equipmentId}`]
      : []),
    ...(tag.equipment !== undefined && signal.equipmentId === undefined
      ? [`equipment ${tag.equipment} cannot be verified because the signal declares no equipment identity`]
      : []),
    ...(tag.range !== undefined
      ? signal.limits?.hardRange === undefined
        ? ['Declared procedure range cannot be verified: the signal has no explicit hard range; this does not establish a calibrated instrument span.']
        : tag.units !== undefined && tag.units !== signal.unit
          ? [`Declared procedure range in ${tag.units} cannot be compared to native hard range in ${signal.unit} without an explicit range conversion.`]
          : tag.range[0] !== signal.limits.hardRange.min || tag.range[1] !== signal.limits.hardRange.max
            ? [`Declared procedure range ${tag.range.join('..')} does not match signal hard range ${signal.limits.hardRange.min}..${signal.limits.hardRange.max} ${signal.unit}; hard range is not a calibrated instrument span.`]
            : []
      : []),
  ]
  return {
    id: tag.id,
    status: warnings.length === 0 ? 'resolved' : 'resolved-with-warnings',
    signal,
    measuredOn: String(signalMeasuredOn(system.plant.graph, binding.owner).id),
    warnings,
  }
})

const matchesSignalSearch = (
  binding: ReturnType<typeof processPlantSignalView>,
  config: z.infer<typeof signalsSearchQuerySchema>,
): boolean => {
  if (config.publishedOnly && binding.published !== true) return false
  if (config.discipline !== undefined && binding.discipline !== config.discipline) return false
  if (config.quantity !== undefined && binding.quantity !== config.quantity) return false
  if (config.writable !== undefined && binding.writable !== config.writable) return false
  if (config.procedureRelevant !== undefined && binding.capabilities?.procedureRelevant !== config.procedureRelevant) return false
  if (config.tagId !== undefined && binding.tagId !== config.tagId) return false
  if (config.equipmentId !== undefined && binding.equipmentId !== config.equipmentId) return false
  return matchesLiteralSearch(config.text, [
    binding.path,
    binding.tagId,
    binding.equipmentId,
    binding.label,
    binding.description,
    binding.kind,
    binding.discipline,
    binding.quantity,
    binding.unit,
    ...(binding.externalRefs ?? []),
  ])
}

export const answerProcessPlantSignalQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  /** The Run time the Plants stand at; a read with its operations names it. */
  readonly simulationTime?: IsoTimestamp
}): unknown | undefined => {
  if (!processPlantSignalQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.procedure-tags.validate') {
    const payload = procedureTagsValidateQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      tags: validateProcedureTags(system, payload.tags),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.signals.resolve') {
    const payload = signalsResolveQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return {
      plantId: payload.plantId,
      signals: payload.signals.map(signal => processPlantSignalView(resolveProcessPlantSignalBinding(system.plant.graph, signal))),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.signals.read') {
    const payload = signalsReadQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    const bindings = payload.signals.map(signal => resolveProcessPlantSignalBinding(system.plant.graph, signal))
    return {
      plantId: payload.plantId,
      ...(payload.operations === undefined ? {} : { operations: operationsOn(config, system, new Set(bindings.map(binding => String(binding.path)))) }),
      signals: payload.signals.map((signal, index) => {
        const binding = bindings[index]!
        const variable = system.runtime.readVariableSnapshot(binding.path)
        return {
          signal: processPlantSignalView(binding),
          variable,
          quality: processPlantSignalQuality(variable),
          ...(signal.requestedUnit === undefined ? {} : {
            valueView: requestedSignalValueView({ unit: binding.unit, quantity: binding.quantity, value: variable.value }, signal.requestedUnit),
          }),
        }
      }),
    }
  }
  const payload = signalsSearchQuerySchema.parse(config.request.input)
  const plants = payload.plantId === undefined
    ? [...config.plants.values()]
    : [requirePlant(config.plants, payload.plantId)]
  const matches = plants.flatMap(system => system.plant.graph.signalBindings
    .map(processPlantSignalView)
    .filter(binding => matchesSignalSearch(binding, payload))
    .map(signal => ({ plantId: system.plant.id, signal })))
  const page = paginateProcessPlantSearch(matches, payload.offset, payload.limit)
  return {
    total: page.total, offset: page.offset, returned: page.returned, hasMore: page.hasMore,
    signals: payload.detail === 'full' ? page.items : page.items.map(({ plantId, signal }) => {
      const { capabilities, limits, owner, externalRefs, ...summary } = signal
      return { plantId, signal: summary }
    }),
  }
}
