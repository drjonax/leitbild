import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink } from './model.ts'

export type PrimaryLoopId = string & { readonly __brand: 'PrimaryLoopId' }

const componentParameters = (component: CompiledComponent): Record<string, unknown> => {
  if (!component.parameters || typeof component.parameters !== 'object' || Array.isArray(component.parameters)) {
    throw new Error(`component ${component.id} parameters are not an object`)
  }
  return component.parameters as Record<string, unknown>
}

export const primaryLoopIdForPump = (component: CompiledComponent): PrimaryLoopId | null => {
  if (component.kind !== 'centrifugalPump') return null
  const value = componentParameters(component).primaryLoopId
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length === 0) throw new Error(`component ${component.id} primaryLoopId must be a non-empty string`)
  return value as PrimaryLoopId
}

const hotLegLoopId = (portName: string): PrimaryLoopId | null => {
  if (!portName.startsWith('hotLeg')) return null
  const value = portName.slice('hotLeg'.length)
  return value.length === 0 ? null : value as PrimaryLoopId
}

const primaryLoopPumpCache = new WeakMap<CompiledPlantGraph, ReadonlyMap<PrimaryLoopId, CompiledComponent>>()

const primaryLoopPumpsById = (graph: CompiledPlantGraph): ReadonlyMap<PrimaryLoopId, CompiledComponent> => {
  const cached = primaryLoopPumpCache.get(graph)
  if (cached !== undefined) return cached
  const pumps = new Map<PrimaryLoopId, CompiledComponent>()
  for (const component of graph.components) {
    const loopId = primaryLoopIdForPump(component)
    if (loopId === null) continue
    if (pumps.has(loopId)) throw new Error(`primary loop ${loopId} has multiple loop pumps`)
    pumps.set(loopId, component)
  }
  primaryLoopPumpCache.set(graph, pumps)
  return pumps
}

const primaryLoopPumpListCache = new WeakMap<CompiledPlantGraph, ReadonlyArray<CompiledComponent>>()

/** Every primary loop's pump, in component order. */
export const primaryLoopPumps = (graph: CompiledPlantGraph): ReadonlyArray<CompiledComponent> => {
  const cached = primaryLoopPumpListCache.get(graph)
  if (cached !== undefined) return cached
  const pumps = [...primaryLoopPumpsById(graph).values()]
  primaryLoopPumpListCache.set(graph, pumps)
  return pumps
}

export const primaryLoopIdForLink = (
  graph: CompiledPlantGraph,
  link: CompiledProcessLink,
): PrimaryLoopId | null => {
  if (link.service !== 'primaryCoolant') return null
  const fromComponent = graph.components[link.fromComponentIndex]
  const toComponent = graph.components[link.toComponentIndex]
  if (!fromComponent || !toComponent) throw new Error(`process link ${link.id} references missing component`)

  const fromPumpLoopId = primaryLoopIdForPump(fromComponent)
  if (fromPumpLoopId !== null) return fromPumpLoopId
  const toPumpLoopId = primaryLoopIdForPump(toComponent)
  if (toPumpLoopId !== null) return toPumpLoopId
  if (fromComponent.kind === 'reactorCore' && toComponent.kind === 'steamGenerator') return hotLegLoopId(String(link.fromPortName))
  return null
}

export const primaryLoopPumpForLink = (
  graph: CompiledPlantGraph,
  link: CompiledProcessLink,
): CompiledComponent | null => {
  const loopId = primaryLoopIdForLink(graph, link)
  if (loopId === null) return null
  return primaryLoopPumpsById(graph).get(loopId) ?? null
}

const linkMatches = (
  graph: CompiledPlantGraph,
  loopId: PrimaryLoopId,
  predicate: (link: CompiledProcessLink) => boolean,
): ReadonlyArray<CompiledProcessLink> =>
  graph.links.filter(link => primaryLoopIdForLink(graph, link) === loopId && predicate(link))

export const assertPrimaryLoopTopologyValid = (graph: CompiledPlantGraph): void => {
  const loopsById = primaryLoopPumpsById(graph)

  for (const [loopId, pump] of loopsById.entries()) {
    const pumpIncoming = linkMatches(
      graph,
      loopId,
      link => link.toComponentIndex === pump.index && link.kind === 'fluidFlow' && link.service === 'primaryCoolant',
    )
    if (pumpIncoming.length !== 1) throw new Error(`primary loop ${loopId} must have exactly one primaryCoolant inlet to pump ${pump.id}`)

    const pumpOutgoing = linkMatches(
      graph,
      loopId,
      link => link.fromComponentIndex === pump.index && link.kind === 'fluidFlow' && link.service === 'primaryCoolant',
    )
    if (pumpOutgoing.length !== 1) throw new Error(`primary loop ${loopId} must have exactly one primaryCoolant outlet from pump ${pump.id}`)

    const hotLeg = linkMatches(
      graph,
      loopId,
      link =>
        graph.components[link.fromComponentIndex]?.kind === 'reactorCore'
        && graph.components[link.toComponentIndex]?.kind === 'steamGenerator'
        && String(link.fromPortName) === `hotLeg${loopId}`,
    )
    if (hotLeg.length !== 1) throw new Error(`primary loop ${loopId} must have exactly one core hotLeg${loopId} primaryCoolant outlet`)

    const coldLeg = linkMatches(
      graph,
      loopId,
      link =>
        graph.components[link.fromComponentIndex]?.id === pump.id
        && graph.components[link.toComponentIndex]?.kind === 'reactorCore'
        && String(link.toPortName) === `coldLeg${loopId}`,
    )
    if (coldLeg.length !== 1) throw new Error(`primary loop ${loopId} must have exactly one core coldLeg${loopId} primaryCoolant inlet`)
  }
}
