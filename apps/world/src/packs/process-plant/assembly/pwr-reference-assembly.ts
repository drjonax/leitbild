import { z } from 'zod'
import {
  plantGraphSpecSchema,
  type ComponentInstanceSpec,
  type ConnectionSpec,
  type PlantGraphSpec,
  type ProcessGraphMetadata,
  type VariablePath,
} from '../graph/index.ts'
import { pwrReferenceTemplate } from '../specs/pwr-reference-template.ts'

const availableLoopIds = ['A', 'B', 'C', 'D', 'E', 'F'] as const
type LoopId = typeof availableLoopIds[number]

export const pwrReferenceParametersSchema = z.object({
  loopCount: z.number().int().min(2).max(availableLoopIds.length),
  title: z.string().min(1).optional(),
}).strict()

const loopComponentIdPattern = /^(?:sg|rcp|feedwaterControlValve|auxFeedwaterValve|mainSteamIsolationValve|steamGeneratorReliefValve|auxFeedwaterTurbineSteamValve|safetyAccumulator|deltaTChannel)([A-F])$/u

const loopIdForComponent = (component: Pick<ComponentInstanceSpec, 'id'>): LoopId | null => {
  const match = loopComponentIdPattern.exec(String(component.id))
  return (match?.[1] as LoopId | undefined) ?? null
}

const componentIdFromPortRef = (ref: string): string => {
  const separatorIndex = ref.lastIndexOf('.')
  return separatorIndex < 0 ? ref : ref.slice(0, separatorIndex)
}

const loopIdFromConnectionId = (id: string): LoopId | null => {
  for (const loopId of availableLoopIds) {
    const lower = loopId.toLowerCase()
    if (
      id.includes(`hot-leg-${lower}`)
      || id.includes(`cold-leg-${lower}`)
      || id.endsWith(`-sg-${lower}`)
      || id.includes(`-sg-${lower}-`)
      || id.endsWith(`-rcp${loopId}`)
    ) return loopId
  }
  return null
}

const componentLoops = (
  components: ReadonlyArray<ComponentInstanceSpec>,
): ReadonlyMap<string, LoopId> => new Map(components.flatMap(component => {
  const loopId = loopIdForComponent(component)
  return loopId === null ? [] : [[String(component.id), loopId] as const]
}))

const loopIdForConnection = (
  connection: Pick<ConnectionSpec, 'id' | 'from' | 'to'>,
  loopByComponentId: ReadonlyMap<string, LoopId>,
): LoopId | null =>
  loopByComponentId.get(componentIdFromPortRef(String(connection.from)))
  ?? loopByComponentId.get(componentIdFromPortRef(String(connection.to)))
  ?? loopIdFromConnectionId(String(connection.id))

const loopMetadata = (
  loopIds: ReadonlyArray<LoopId>,
  loopId: LoopId,
  metadata: ProcessGraphMetadata | undefined,
): ProcessGraphMetadata => ({
  ...metadata,
  groupId: 'primary-loop',
  loopId,
  ordinal: loopIds.indexOf(loopId),
})

const componentMetadata = (
  loopIds: ReadonlyArray<LoopId>,
  component: ComponentInstanceSpec,
  loopId: LoopId,
): ProcessGraphMetadata => {
  const base = loopMetadata(loopIds, loopId, component.metadata)
  if (component.kind === 'steamGenerator') return { ...base, role: 'heat-sink', equipmentClass: 'steam-generator' }
  if (component.kind === 'centrifugalPump') return { ...base, role: 'primary-pump', equipmentClass: 'reactor-coolant-pump' }
  if (component.kind === 'steamValve' && String(component.id).startsWith('steamGeneratorReliefValve')) {
    return { ...base, role: 'steam-relief', equipmentClass: 'steam-generator-relief-valve' }
  }
  // A loop's steam line supplies the turbine-driven auxiliary feedwater pump's turbine through it.
  if (component.kind === 'steamValve' && String(component.id).startsWith('auxFeedwaterTurbineSteamValve')) {
    return { ...base, role: 'turbine-afw-steam-supply', equipmentClass: 'turbine-afw-steam-supply-valve' }
  }
  if (component.kind === 'steamValve') return { ...base, role: 'steam-isolation', equipmentClass: 'main-steam-isolation-valve' }
  if (component.kind === 'accumulator') return { ...base, role: 'safety-injection-source', equipmentClass: 'accumulator' }
  if (component.kind === 'processValve' && String(component.id).startsWith('feedwaterControlValve')) {
    return { ...base, role: 'feedwater-control', equipmentClass: 'feedwater-control-valve' }
  }
  if (component.kind === 'processValve') return { ...base, role: 'loop-control-valve', equipmentClass: 'process-valve' }
  return base
}

const sharedComponentMetadata = (component: ComponentInstanceSpec): ProcessGraphMetadata | undefined => {
  const id = String(component.id)
  if (id.startsWith('mainFeedwaterPump')) return { ...component.metadata, role: 'main-feedwater-pump', equipmentClass: 'feedwater-pump' }
  if (id === 'offsiteGrid') return { ...component.metadata, role: 'offsite-power-source', equipmentClass: 'electrical-grid' }
  // The safety buses' and the unit buses' supply breakers both bring offsite power to a bus.
  if (id.startsWith('offsiteBreaker') || id.startsWith('unitBusBreaker')) return { ...component.metadata, role: 'offsite-power-breaker', equipmentClass: 'electrical-breaker' }
  if (id === 'pressurizer') return { ...component.metadata, role: 'pressure-control', equipmentClass: 'pressurizer' }
  if (id === 'turbineStopValve') return { ...component.metadata, role: 'turbine-stop', equipmentClass: 'steam-valve' }
  if (id === 'turbine') return { ...component.metadata, role: 'turbine-generator', equipmentClass: 'steam-turbine' }
  return component.metadata
}

const sharedLoopParameters = (
  component: ComponentInstanceSpec,
  loopIds: ReadonlyArray<LoopId>,
): ComponentInstanceSpec => {
  const parameters = component.parameters && typeof component.parameters === 'object' && !Array.isArray(component.parameters)
    ? component.parameters as Record<string, unknown>
    : {}
  if (component.id === 'core') {
    return { ...component, parameters: { ...parameters, primaryLoopIds: loopIds } }
  }
  if (
    component.id === 'feedwaterHeader'
    || component.id === 'mainSteamHeader'
    || component.id === 'auxFeedwaterHeader'
    || component.id === 'safetyInjectionHeader'
  ) {
    return { ...component, parameters: { ...parameters, portIds: loopIds } }
  }
  return component
}

const loopIdForVariablePath = (
  path: VariablePath,
  loopByComponentId: ReadonlyMap<string, LoopId>,
  loopByConnectionId: ReadonlyMap<string, LoopId>,
): LoopId | null => {
  const ownerId = String(path).slice(0, String(path).indexOf('.'))
  return loopByComponentId.get(ownerId) ?? loopByConnectionId.get(ownerId) ?? null
}

export const assemblePwrReferencePlantGraph = (input: unknown): PlantGraphSpec => {
  const parameters = pwrReferenceParametersSchema.parse(input)
  const selectedLoopIds = availableLoopIds.slice(0, parameters.loopCount)
  const selectedLoopSet = new Set<LoopId>(selectedLoopIds)
  const source = structuredClone(pwrReferenceTemplate) as PlantGraphSpec
  const coreParameters = source.components.find(component => component.kind === 'reactorCore')?.parameters as Record<string, unknown> | undefined
  if (!coreParameters) throw new Error('PWR template has no reactor core')
  const primaryFlowPerLoop = Number(coreParameters.nominalPrimaryFlowKgPerS) / selectedLoopIds.length
  const loopByComponentId = componentLoops(source.components)
  const loopByConnectionId = new Map<string, LoopId>(source.connections.flatMap(connection => {
    const loopId = loopIdForConnection(connection, loopByComponentId)
    return loopId === null ? [] : [[String(connection.id), loopId] as const]
  }))

  const components = source.components
    .filter(component => {
      const loopId = loopByComponentId.get(String(component.id))
      return loopId === undefined || selectedLoopSet.has(loopId)
    })
    .map(component => {
      const loopId = loopByComponentId.get(String(component.id))
      const withSharedParameters = sharedLoopParameters(component, selectedLoopIds)
      return loopId === undefined
        ? { ...withSharedParameters, metadata: sharedComponentMetadata(withSharedParameters) }
        : {
            ...withSharedParameters,
            metadata: componentMetadata(selectedLoopIds, withSharedParameters, loopId),
          }
    })

  const connections = source.connections
    .filter(connection => {
      const loopId = loopByConnectionId.get(String(connection.id))
      return loopId === undefined || selectedLoopSet.has(loopId)
    })
    .map(connection => {
      const loopId = loopByConnectionId.get(String(connection.id))
      const sized = connection.service === 'primaryCoolant' && connection.physical?.nominalFlowKgPerS !== undefined
        ? { ...connection, physical: { ...connection.physical, nominalFlowKgPerS: primaryFlowPerLoop } }
        : connection
      return loopId === undefined
        ? sized
        : { ...sized, metadata: loopMetadata(selectedLoopIds, loopId, connection.metadata) }
    })

  const publishedVariables = source.publishedVariables.filter(path => {
    const loopId = loopIdForVariablePath(path, loopByComponentId, loopByConnectionId)
    return loopId === null || selectedLoopSet.has(loopId)
  })

  return plantGraphSpecSchema.parse({
    ...source,
    id: `process-plant.pwr.reference.${selectedLoopIds.length}-loop`,
    title: parameters.title ?? `Reference PWR ${selectedLoopIds.length}-loop plant`,
    components,
    connections,
    publishedVariables,
  })
}
