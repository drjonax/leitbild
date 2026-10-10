import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import { parameterNumber } from '../component-helpers.ts'
import { componentValveAvailabilityForLink, type LinkBehaviorReadContext } from './link-flow-helpers.ts'
import { mainSteamTopologyForSystem, type ProcessLinkPath } from '../topology-cache.ts'
import { processPlantServices } from '../service-profiles.ts'

const turbineSteamDemandKgPerS = (
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => {
  const demandPath = componentVariablePath(turbine, 'steamDemandKgPerS')
  if (context.has(demandPath)) return context.readNumber(demandPath)
  return context.readNumber(componentVariablePath(turbine, 'loadFraction')) * parameterNumber(turbine, 'nominalSteamFlowKgPerS')
}

const pathAvailability = (
  system: CompiledProcessPlant,
  paths: ReadonlyArray<ProcessLinkPath>,
  context: LinkBehaviorReadContext,
): number => {
  let best = 0
  for (const path of paths) {
    let availability = 1
    for (const link of path) {
      availability *= componentValveAvailabilityForLink(system, link, context)
      if (availability <= 0) break
    }
    best = Math.max(best, availability)
  }
  return best
}

const sourceAvailabilityToTurbine = (
  system: CompiledProcessPlant,
  sourceLink: CompiledProcessLink,
  turbine: CompiledComponent,
  context: LinkBehaviorReadContext,
): number => {
  const topology = mainSteamTopologyForSystem(system)
  const paths = topology.pathSets.find(pathSet => pathSet.sourceLink.index === sourceLink.index && pathSet.turbine.index === turbine.index)?.paths
  if (!paths || paths.length === 0) return 0
  return componentValveAvailabilityForLink(system, sourceLink, context)
    * pathAvailability(system, paths, context)
}

export const topologyAwareMainSteamDemandForSourceLink = (
  system: CompiledProcessPlant,
  sourceLink: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  let demand = 0
  const topology = mainSteamTopologyForSystem(system)
  for (const turbine of topology.turbines) {
    const sourceAvailability = sourceAvailabilityToTurbine(system, sourceLink, turbine, context)
    if (sourceAvailability <= 0) continue
    let totalAvailability = 0
    for (const candidateSource of topology.sourceLinks) {
      totalAvailability += sourceAvailabilityToTurbine(system, candidateSource, turbine, context)
    }
    if (totalAvailability <= 0) continue
    demand += turbineSteamDemandKgPerS(turbine, context) * sourceAvailability / totalAvailability
  }
  return demand
}

const isSteamReleaseValve = (component: CompiledComponent | undefined): boolean => {
  if (component?.kind !== 'steamValve') return false
  const mode = (component.parameters as Record<string, unknown>).valveMode
  return mode === 'relief' || mode === 'safety' || mode === 'bypass'
}

// Where relieved steam ends: the condenser (steam dumps), the atmosphere (safety
// and atmospheric relief valves) or containment (a break inside it).
const isSteamReleaseTerminal = (component: CompiledComponent | undefined): boolean =>
  component?.kind === 'containmentVolume' || component?.kind === 'condenserSink' || component?.kind === 'atmosphereBoundary'

const matchingSteamReleaseService = (
  link: CompiledProcessLink,
  hasReleaseValve: boolean,
): boolean => {
  if (link.service === processPlantServices.mainSteam) return true
  return hasReleaseValve && link.service === processPlantServices.exhaustSteam
}

const collectReleasePaths = (
  system: CompiledProcessPlant,
  fromComponentIndex: number,
  visited: ReadonlySet<number>,
  hasReleaseValve: boolean,
): ReadonlyArray<ProcessLinkPath> => {
  if (visited.has(fromComponentIndex)) return []
  const component = system.graph.components[fromComponentIndex]
  if (hasReleaseValve && isSteamReleaseTerminal(component)) return [[]]

  const nextVisited = new Set(visited)
  nextVisited.add(fromComponentIndex)
  const paths: ProcessLinkPath[] = []
  for (const linkIndex of system.graph.outgoingLinksByComponent[fromComponentIndex] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow' || !matchingSteamReleaseService(link, hasReleaseValve)) continue
    const toComponent = system.graph.components[link.toComponentIndex]
    const nextHasReleaseValve = hasReleaseValve || isSteamReleaseValve(toComponent)
    for (const downstreamPath of collectReleasePaths(system, link.toComponentIndex, nextVisited, nextHasReleaseValve)) {
      paths.push([link, ...downstreamPath])
    }
  }
  return paths
}

export const topologyAwareMainSteamReleaseAvailabilityForSourceLink = (
  system: CompiledProcessPlant,
  sourceLink: CompiledProcessLink,
  context: LinkBehaviorReadContext,
): number => {
  const paths = collectReleasePaths(system, sourceLink.toComponentIndex, new Set(), false)
  if (paths.length === 0) return 0
  return componentValveAvailabilityForLink(system, sourceLink, context) * pathAvailability(system, paths, context)
}
