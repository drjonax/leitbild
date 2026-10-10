import type { CompiledProcessLink } from '../../../graph/index.ts'
import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition, type ComponentInitialReconciliationDefinition } from '../../behavior-contract.ts'
import {
  firstFluidService,
  fluidLinksForService,
  incomingComponentLinks,
  outgoingComponentLinks,
  sumProcessLinkValue,
} from '../../component-link-helpers.ts'
import { optionalParameterNumber, relaxToward } from '../../component-helpers.ts'
import { inventoryBalanceStep } from '../../physics.ts'

const weightedAverageLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let weightedTotal = 0
  let weightTotal = 0
  for (const link of links) {
    const valuePath = processLinkVariablePath(link, localPath)
    if (!context.has(valuePath)) continue
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    const weight = context.has(flowPath) ? Math.max(0, context.readNumber(flowPath)) : 1
    if (weight <= 0) continue
    weightedTotal += context.readNumber(valuePath) * weight
    weightTotal += weight
  }
  return weightTotal <= 0 ? null : weightedTotal / weightTotal
}

const updateHeaderDiagnostics = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { system, component, context } = input
  const incomingCandidates = incomingComponentLinks(system, component)
  const outgoingCandidates = outgoingComponentLinks(system, component)
  const service = firstFluidService([...incomingCandidates, ...outgoingCandidates])
  const incomingLinks = fluidLinksForService(incomingCandidates, service)
  const outgoingLinks = fluidLinksForService(outgoingCandidates, service)
  const inletFlow = sumProcessLinkValue(incomingLinks, 'flowKgPerS', context)
  const outletFlow = sumProcessLinkValue(outgoingLinks, 'flowKgPerS', context)
  const previousMixedTemperature = context.readNumber(componentVariablePath(component, 'mixedTemperatureC'))
  const incomingMixedTemperature = weightedAverageLinkValue(incomingLinks, 'temperatureC', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'temperatureC', context)
    ?? optionalParameterNumber(component, 'initialTemperatureC', 220)
  const mixedTemperature = relaxToward(
    previousMixedTemperature,
    incomingMixedTemperature,
    context.dtSeconds,
    optionalParameterNumber(component, 'mixingTimeConstantS', 1),
  )
  const previousPressure = context.readNumber(componentVariablePath(component, 'pressureNodeMPa'))
  const incomingMixedPressure = weightedAverageLinkValue(incomingLinks, 'pressureMPa', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'pressureMPa', context)
    ?? optionalParameterNumber(component, 'initialPressureMPa', 1)
  const mixedPressure = relaxToward(
    previousPressure,
    incomingMixedPressure,
    context.dtSeconds,
    optionalParameterNumber(component, 'pressureTimeConstantS', 1),
  )
  const density = optionalParameterNumber(component, 'nominalDensityKgPerM3', component.kind === 'steamHeader' ? 35 : 950)
  const maxInventory = optionalParameterNumber(component, 'headerVolumeM3', 1) * density * 1.25
  const inventory = inventoryBalanceStep({
    currentInventory: context.readNumber(componentVariablePath(component, 'inventoryKg')),
    inflowKgPerS: inletFlow,
    outflowKgPerS: outletFlow,
    dtSeconds: context.dtSeconds,
    minInventory: 0,
    maxInventory,
  })
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'mixedTemperatureC'), mixedTemperature)
  context.write(componentVariablePath(component, 'mixedPressureMPa'), mixedPressure)
  context.write(componentVariablePath(component, 'pressureNodeMPa'), mixedPressure)
  context.write(componentVariablePath(component, 'inventoryKg'), inventory)
  context.write(componentVariablePath(component, 'unmetDemandKgPerS'), Math.max(0, outletFlow - inletFlow))
}

const headerDiagnosticsBehavior = (componentKind: 'processHeader' | 'steamHeader'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-mixing-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:pressureMPa', 'outgoing:flowKgPerS', 'mixedTemperatureC', 'pressureNodeMPa', 'inventoryKg'],
  writes: ['inventoryKg', 'inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'mixedTemperatureC', 'mixedPressureMPa', 'pressureNodeMPa', 'unmetDemandKgPerS'],
  update: updateHeaderDiagnostics,
})

// With no time elapsed the header keeps its mixed state and inventory and
// takes its flows from the solved links.
export const headerInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = (['processHeader', 'steamHeader'] as const).map(componentKind => ({
  id: `${componentKind}-initial-mixing-diagnostics`,
  componentKind,
  afterLinks: true,
  reads: headerDiagnosticsBehavior(componentKind).reads,
  writes: headerDiagnosticsBehavior(componentKind).writes,
  reconcile: updateHeaderDiagnostics,
}))

export const headerBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  headerDiagnosticsBehavior('processHeader'),
  headerDiagnosticsBehavior('steamHeader'),
]
