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
import { headerPressureBalance, isPressureBalancedHeader } from './header-pressure-balance.ts'

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

/**
 * The highest pressure on the lines into a header whose source stands open:
 * equipment that declares a position (an isolation valve) only while it is
 * open at all; equipment that declares none is always open to it.
 */
const openSourcePressure = (
  system: Parameters<ComponentBehaviorDefinition['update']>[0]['system'],
  links: ReadonlyArray<CompiledProcessLink>,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let highest: number | null = null
  for (const link of links) {
    const pressurePath = processLinkVariablePath(link, 'pressureMPa')
    if (!context.has(pressurePath)) continue
    const position = system.graph.components[link.fromComponentIndex]?.semantics.aspects.find(aspect => aspect.aspect === 'position')?.state
    const open = position === undefined ? true
      : position.reading === 'closedWhileTrue' ? !context.readBoolean(position.path)
        : context.readNumber(position.path) > 0
    if (!open) continue
    highest = Math.max(highest ?? Number.NEGATIVE_INFINITY, context.readNumber(pressurePath))
  }
  return highest
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
  // With nothing flowing through it the header stands at the pressure of what it is open to (a main steam
  // header after a turbine trip, at its steam generators' pressure through the open isolation valves);
  // shut off from every source, its trapped fluid keeps the pressure it has.
  const incomingMixedPressure = weightedAverageLinkValue(incomingLinks, 'pressureMPa', context)
    ?? weightedAverageLinkValue(outgoingLinks, 'pressureMPa', context)
    ?? openSourcePressure(system, incomingLinks, context)
    ?? previousPressure
  // A pressure-balanced header stands at once at the pressure its pumps and branches settle at.
  const mixedPressure = isPressureBalancedHeader(component)
    ? headerPressureBalance(system, component, context).pressureMPa
    : relaxToward(
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
  reads: ['incoming:flowKgPerS', 'incoming:temperatureC', 'incoming:pressureMPa', 'outgoing:flowKgPerS', 'mixedTemperatureC', 'pressureNodeMPa', 'inventoryKg', 'pressure-balanced header branches?', 'incoming source position?'],
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
