import type { CompiledProcessLink, VariablePath } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, processLinkVariablePath } from '../behavior-contract.ts'
import { clamp } from '../component-helpers.ts'
import { downstreamDemandPathsForLink } from '../topology-cache.ts'
import { headerPressureBalance, isPressureBalancedHeader } from '../behaviors/junction/header-pressure-balance.ts'

export type LinkBehaviorReadContext = {
  readonly has: (path: VariablePath) => boolean
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
}

const processLinkVariableLocalPathCache = new WeakMap<CompiledProcessLink, ReadonlySet<string>>()

const processLinkVariableLocalPaths = (link: CompiledProcessLink): ReadonlySet<string> => {
  const cached = processLinkVariableLocalPathCache.get(link)
  if (cached) return cached
  const prefix = `${String(link.id)}.`
  const paths = new Set<string>()
  for (const variable of link.variables) {
    const fullPath = String(variable.path)
    if (fullPath.startsWith(prefix)) paths.add(fullPath.slice(prefix.length))
  }
  processLinkVariableLocalPathCache.set(link, paths)
  return paths
}

export const hasProcessLinkVariable = (link: CompiledProcessLink, localPath: string): boolean =>
  processLinkVariableLocalPaths(link).has(localPath)

export const serviceMatches = (link: CompiledProcessLink, service: CompiledProcessLink['service']): boolean =>
  service !== undefined && link.service === service

export const componentValveFactorForInboundLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return 1
  const effectivePositionPath = componentVariablePath(toComponent, 'effectivePositionFraction')
  if (context.has(effectivePositionPath)) return clamp(context.readNumber(effectivePositionPath), 0, 1)
  const positionPath = componentVariablePath(toComponent, 'positionFraction')
  return context.has(positionPath) ? clamp(context.readNumber(positionPath), 0, 1) : 1
}

export const componentValveCapacityForInboundLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return Number.POSITIVE_INFINITY
  // A pressure-balanced header's branch takes what the balance gives it, which its valve's coefficient already sets.
  if (isPressureBalancedHeader(system.graph.components[link.fromComponentIndex])) return Number.POSITIVE_INFINITY
  const parameters = toComponent.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return Number.POSITIVE_INFINITY
  const cv = (parameters as Record<string, unknown>).cvKgPerSPerSqrtMPa
  if (cv === undefined) return Number.POSITIVE_INFINITY
  if (typeof cv !== 'number' || !Number.isFinite(cv) || cv < 0) throw new Error(`component ${toComponent.id} parameter cvKgPerSPerSqrtMPa must be nonnegative`)
  const upstreamPressurePath = processLinkVariablePath(link, 'pressureMPa')
  const upstreamPressure = context.has(upstreamPressurePath) ? context.readNumber(upstreamPressurePath) : 0
  return cv * Math.sqrt(Math.max(0, upstreamPressure))
}

export const componentValveAvailabilityForLink = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => componentValveFactorForInboundLink(system, link, context)

export const sumIncomingLinkValue = (
  system: CompiledProcessPlant,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number => {
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
  }
  return total
}

export const incomingLinkValueStats = (
  system: CompiledProcessPlant,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): { readonly matchingLinks: number; readonly valuedLinks: number; readonly total: number } => {
  let matchingLinks = 0
  let valuedLinks = 0
  let total = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    matchingLinks += 1
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    valuedLinks += 1
  }
  return { matchingLinks, valuedLinks, total }
}

export const averageIncomingLinkValue = (
  system: CompiledProcessPlant,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number | null => {
  let total = 0
  let count = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    total += context.readNumber(path)
    count += 1
  }
  return count === 0 ? null : total / count
}

export const flowWeightedIncomingLinkValue = (
  system: CompiledProcessPlant,
  componentIndex: number,
  localPath: string,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  linkMatches: (link: CompiledProcessLink) => boolean,
): number | null => {
  let weightedTotal = 0
  let flowTotal = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !linkMatches(link)) continue
    const valuePath = processLinkVariablePath(link, localPath)
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(valuePath) || !context.has(flowPath)) continue
    const flow = Math.max(0, context.readNumber(flowPath))
    if (flow <= 0) continue
    weightedTotal += context.readNumber(valuePath) * flow
    flowTotal += flow
  }
  return flowTotal <= 0 ? null : weightedTotal / flowTotal
}

const downstreamValveDemandWeight = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number | null => {
  const toComponent = system.graph.components[link.toComponentIndex]
  if (toComponent?.kind !== 'processValve' && toComponent?.kind !== 'steamValve') return null
  const effectivePositionPath = componentVariablePath(toComponent, 'effectivePositionFraction')
  if (context.has(effectivePositionPath)) {
    return clamp(context.readNumber(effectivePositionPath), 0, 1)
  }
  const positionPath = componentVariablePath(toComponent, 'positionFraction')
  if (context.has(positionPath)) {
    return clamp(context.readNumber(positionPath), 0, 1)
  }
  let demandWeight = 0
  let hasDemandSignal = false
  for (const outgoingLinkIndex of system.graph.outgoingLinksByComponent[toComponent.index] ?? []) {
    const outgoingLink = system.graph.links[outgoingLinkIndex]
    if (!outgoingLink || outgoingLink.kind !== 'fluidFlow' || !serviceMatches(outgoingLink, link.service)) continue
    const downstreamComponentValveFactor = componentValveFactorForInboundLink(system, outgoingLink, context)
    if (downstreamComponentValveFactor < 1) hasDemandSignal = true
    demandWeight += downstreamComponentValveFactor
  }
  if (!hasDemandSignal && demandWeight === 0) return null
  return demandWeight
}

const outgoingDemandWeight = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const target = system.graph.components[link.toComponentIndex]
  if (target?.kind === 'centrifugalPump') {
    const nominal = Number((target.parameters as Record<string, unknown>).nominalFlowKgPerS)
    return Math.max(0, context.readNumber(componentVariablePath(target, 'flowKgPerS'))) / nominal
  }
  return downstreamValveDemandWeight(system, link, context) ?? 1
}

export const outgoingDemandWeightTotal = (
  system: CompiledProcessPlant,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: LinkBehaviorReadContext,
): number => {
  let total = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !serviceMatches(link, service)) continue
    total += outgoingDemandWeight(system, link, context)
  }
  return total
}

export const distributeFlowFromComponent = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
  availableFlowKgPerS: number,
): number => {
  // A pressure-balanced header shares what its pumps deliver as its branches take it at its pressure.
  const fromComponent = system.graph.components[link.fromComponentIndex]
  if (isPressureBalancedHeader(fromComponent)) {
    const branchFlows = headerPressureBalance(system, fromComponent, context).branchFlowKgPerS
    const totalBranchFlow = [...branchFlows.values()].reduce((total, flow) => total + flow, 0)
    return totalBranchFlow <= 0 ? 0 : availableFlowKgPerS * (branchFlows.get(link.index) ?? 0) / totalBranchFlow
  }
  const totalDemandWeight = outgoingDemandWeightTotal(system, link.fromComponentIndex, link.service, context)
  if (totalDemandWeight <= 0) return 0
  return availableFlowKgPerS * outgoingDemandWeight(system, link, context) / totalDemandWeight
}

export const downstreamServiceDemandFraction = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const downstreamPaths = downstreamDemandPathsForLink(system, link)
  if (downstreamPaths.length === 0) return 1
  let liveDemandWeight = 0
  for (const path of downstreamPaths) {
    let pathWeight = 1
    for (const pathLink of path) {
      pathWeight *= componentValveAvailabilityForLink(system, pathLink, context)
      if (pathWeight <= 0) break
    }
    liveDemandWeight += pathWeight
  }
  return clamp(liveDemandWeight / downstreamPaths.length, 0, 1)
}

export const passiveFlowFromIncomingService = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const service = link.service
  const matchingService = (candidate: CompiledProcessLink): boolean => candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const incomingFlow = sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, matchingService)
  return distributeFlowFromComponent(system, link, context, incomingFlow)
}

export interface ComponentFlowBalance {
  readonly componentId: string
  readonly service: string
  readonly inflowKgPerS: number
  readonly outflowKgPerS: number
  readonly residualKgPerS: number
}

export const componentFlowBalanceForService = (
  system: CompiledProcessPlant,
  componentIndex: number,
  service: CompiledProcessLink['service'],
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
): ComponentFlowBalance => {
  const component = system.graph.components[componentIndex]
  if (!component) throw new Error(`process plant flow balance references missing component index: ${componentIndex}`)
  if (service === undefined) throw new Error(`process plant flow balance for component ${component.id} requires a service`)
  const matchesService = (candidate: CompiledProcessLink): boolean =>
    candidate.kind === 'fluidFlow' && serviceMatches(candidate, service)
  const inflowKgPerS = sumIncomingLinkValue(system, componentIndex, 'flowKgPerS', context, matchesService)
  let outflowKgPerS = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[componentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || !matchesService(link)) continue
    const path = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(path)) continue
    outflowKgPerS += context.readNumber(path)
  }
  return {
    componentId: String(component.id),
    service: String(service),
    inflowKgPerS,
    outflowKgPerS,
    residualKgPerS: inflowKgPerS - outflowKgPerS,
  }
}

export const sourceLimitedPumpFlow = (
  system: CompiledProcessPlant,
  link: CompiledProcessLink,
  context: Pick<LinkBehaviorReadContext, 'has' | 'readNumber'>,
  pumpFlow: number,
): number => {
  const incomingFlow = incomingLinkValueStats(
    system,
    link.fromComponentIndex,
    'flowKgPerS',
    context,
    candidate => candidate.kind === 'fluidFlow' && serviceMatches(candidate, link.service),
  )
  if (incomingFlow.matchingLinks === 0) return pumpFlow
  if (incomingFlow.valuedLinks === 0) return 0
  return Math.min(pumpFlow, incomingFlow.total)
}
