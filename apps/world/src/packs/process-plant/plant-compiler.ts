import { createHash } from 'node:crypto'
import {
  compilePlantGraph,
  plantGraphSpecSchema,
  processVariableValueSchema,
  type CompiledPlantGraph,
  type ComponentId,
  type PlantGraphSpec,
  type ProcessVariableValue,
  type VariablePath,
} from './graph/index.ts'
import { processPlantComponentRegistry } from './graph/index.ts'
import { assertProcessPlantVariableValueValid } from './runtime/variable-validation.ts'
import { processPlantIcConfigSchema, type ProcessPlantProtectionConfig } from './runtime/ic/control-protection-model.ts'
import { assertProcessPlantIcAnnunciatorEquipmentValid, assertProcessPlantIcOperatingModesValid } from './runtime/ic/control-protection-validation.ts'
import type { ProcessPlantDefinition } from './config.ts'
import {
  resolveProcessPlantAutomation,
  resolveProcessPlantModel,
  resolveProcessPlantOperatingPoint,
} from './plant-definitions.ts'
import { assertPrimaryLoopTopologyValid } from './graph/index.ts'

export interface ProcessPlantInitialVariableValue {
  readonly path: VariablePath
  readonly value: ProcessVariableValue
}

export interface CompiledProcessPlant {
  readonly id: string
  readonly modelRef: string
  readonly operatingPointRef: string
  readonly automationRef: string
  readonly componentLibrary: 'process-plant'
  readonly modelDigest: string
  readonly sourceGraph: PlantGraphSpec
  readonly graph: CompiledPlantGraph
  readonly initialState: ReadonlyArray<ProcessPlantInitialVariableValue>
  readonly automation: ProcessPlantProtectionConfig
}

// A Plant's identity is everything that can change its simulation. How
// operators name equipment (metadata.presentation) cannot, so renaming never
// orphans a persisted Run checkpoint.
const withoutPresentation = <T extends { readonly metadata?: { readonly presentation?: unknown } | undefined }>(item: T): T => {
  if (item.metadata?.presentation === undefined) return item
  const { presentation: _presentation, ...metadata } = item.metadata
  if (Object.keys(metadata).length > 0) return { ...item, metadata }
  const { metadata: _metadata, ...rest } = item
  return rest as T
}

const modelDigestFor = (graph: PlantGraphSpec): string =>
  createHash('sha256').update(JSON.stringify({
    ...graph,
    components: graph.components.map(withoutPresentation),
    connections: graph.connections.map(withoutPresentation),
  })).digest('hex')

const compiledModelCache = new Map<string, CompiledPlantGraph>()
const maxCompiledModelCacheEntries = 32

const compiledGraphFor = (graph: PlantGraphSpec, digest: string): CompiledPlantGraph => {
  const cached = compiledModelCache.get(digest)
  if (cached !== undefined) return cached
  const compiled = compilePlantGraph(graph, processPlantComponentRegistry)
  compiledModelCache.set(digest, compiled)
  if (compiledModelCache.size > maxCompiledModelCacheEntries) {
    const oldest = compiledModelCache.keys().next().value
    if (oldest !== undefined) compiledModelCache.delete(oldest)
  }
  return compiled
}

/**
 * Resolved model input used by Pack-owned model definitions and engineering tools.
 * Scenario authors never supply this shape; authored Plants select catalogued refs.
 */
export interface ResolvedProcessPlantDefinition {
  readonly id: string
  readonly modelRef: string
  readonly operatingPointRef: string
  readonly automationRef: string
  readonly graph: PlantGraphSpec
  readonly parameterOverrides?: Readonly<Record<string, unknown>>
  readonly valueOverrides?: Readonly<Record<string, unknown>>
  readonly automationForGraph: (graph: CompiledPlantGraph) => ProcessPlantProtectionConfig
  readonly validateGraph?: (graph: CompiledPlantGraph) => void
}

const cloneGraphSpec = (input: unknown): PlantGraphSpec =>
  plantGraphSpecSchema.parse(input)

const assertObject = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

const applyComponentParameterOverlays = (
  graph: PlantGraphSpec,
  overlays: Record<string, unknown> | undefined,
): PlantGraphSpec => {
  if (overlays === undefined) return graph
  const overlayEntries = Object.entries(overlays)
  const componentIds = new Set(graph.components.map(component => component.id))
  for (const [componentId, overlay] of overlayEntries) {
    if (!componentIds.has(componentId as ComponentId)) throw new Error(`process plant parameter override references unknown component: ${componentId}`)
    assertObject(overlay, `process plant parameter override for component ${componentId}`)
  }
  return {
    ...graph,
    components: graph.components.map(component => {
      const overlay = overlays[component.id]
      if (overlay === undefined) return component
      return {
        ...component,
        parameters: {
          ...assertObject(component.parameters, `component ${component.id} parameters`),
          ...assertObject(overlay, `process plant parameter override for component ${component.id}`),
        },
      }
    }),
  }
}

const parseInitialState = (
  input: Record<string, unknown> | undefined,
): ReadonlyArray<ProcessPlantInitialVariableValue> => {
  if (input === undefined) return []
  return Object.entries(input).map(([path, value]) => ({
    path: path as VariablePath,
    value: processVariableValueSchema.parse(value),
  }))
}

const assertInitialStateTargetsDeclaredVariables = (
  graph: CompiledPlantGraph,
  initialState: ReadonlyArray<ProcessPlantInitialVariableValue>,
): void => {
  const variableByPath = new Map(graph.variables.map(variable => [variable.path, variable]))
  for (const initial of initialState) {
    const variable = variableByPath.get(initial.path)
    if (!variable) throw new Error(`process plant initialState references unknown variable: ${initial.path}`)
    try {
      assertProcessPlantVariableValueValid(variable, initial.value)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(message.replace(`process plant variable ${initial.path}`, `process plant initialState for ${initial.path}`))
    }
  }
}

export const compileResolvedProcessPlant = (
  definition: ResolvedProcessPlantDefinition,
): CompiledProcessPlant => {
  const graph = applyComponentParameterOverlays(
    cloneGraphSpec(definition.graph),
    definition.parameterOverrides as Record<string, unknown> | undefined,
  )
  const modelDigest = modelDigestFor(graph)
  const compiledGraph = compiledGraphFor(graph, modelDigest)
  definition.validateGraph?.(compiledGraph)
  const initialState = parseInitialState(definition.valueOverrides as Record<string, unknown> | undefined)
  assertInitialStateTargetsDeclaredVariables(compiledGraph, initialState)
  // Validated once here, so every reader sees declared operating modes, annunciator systems and their references whole.
  const automation = processPlantIcConfigSchema.parse(definition.automationForGraph(compiledGraph))
  assertProcessPlantIcOperatingModesValid(compiledGraph, automation.operatingModes)
  assertProcessPlantIcAnnunciatorEquipmentValid(compiledGraph, automation.rules)
  return {
    id: definition.id,
    modelRef: definition.modelRef,
    operatingPointRef: definition.operatingPointRef,
    automationRef: definition.automationRef,
    componentLibrary: 'process-plant',
    modelDigest,
    sourceGraph: graph,
    graph: compiledGraph,
    initialState,
    automation,
  }
}

export const compileProcessPlant = (
  definition: ProcessPlantDefinition,
): CompiledProcessPlant => {
  const graph = resolveProcessPlantModel(definition.model)
  const operatingPoint = resolveProcessPlantOperatingPoint(
    definition.operatingPoint,
    definition.model.ref,
    graph,
  )
  return compileResolvedProcessPlant({
    id: definition.id,
    modelRef: definition.model.ref,
    operatingPointRef: definition.operatingPoint.ref,
    automationRef: definition.automation.ref,
    graph,
    parameterOverrides: operatingPoint.parameterOverrides,
    valueOverrides: operatingPoint.valueOverrides,
    automationForGraph: graph => resolveProcessPlantAutomation(
      definition.automation,
      definition.model.ref,
      graph,
    ),
    validateGraph: assertPrimaryLoopTopologyValid,
  })
}

export const compileProcessPlants = (
  definitions: ReadonlyArray<ProcessPlantDefinition>,
): ReadonlyArray<CompiledProcessPlant> => {
  const plants = definitions.map(compileProcessPlant)
  const ids = new Set<string>()
  for (const plant of plants) {
    if (ids.has(plant.id)) throw new Error(`duplicate process plant id: ${plant.id}`)
    ids.add(plant.id)
  }
  return plants
}
