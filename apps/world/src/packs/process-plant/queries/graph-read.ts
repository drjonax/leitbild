import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { CompiledPlantGraph, CompiledProcessLink, ComponentId } from '../graph/index.ts'
import { downstreamLinks, linkCarrier, upstreamLinks } from '../graph/index.ts'
import { equipmentSuggestions } from '../equipment/items.ts'
import { rejectCapabilityInput } from '../../../simulation/capability-rejection.ts'
import { capabilityTargetNotFound, paginateProcessPlantSearch, processPlantSearchPaginationShape } from './common.ts'

// The compiled graph of a 4-loop PWR is about 0.8 MB of JSON, nearly all of it
// component parameters and variable descriptors; its connections alone are
// about 30 KB, and one pump's own about 1 KB. graph.read therefore answers how
// equipment is connected by default, around named components or paged over the
// whole Plant, and returns the complete compiled graph only when mode full asks.

export const graphReadQuerySchema = z.union([
  z.object({
    plantId: idSchema,
    mode: z.literal('connections').default('connections'),
    componentIds: z.array(idSchema).min(1).optional()
      .describe('Exact component ids from components.search. Omit to page through every link of the Plant.'),
    direction: z.enum(['both', 'upstream', 'downstream']).optional()
      .describe('With componentIds: upstream is what feeds or supplies them, downstream is where their flow or power goes. Default both.'),
    reach: z.number().int().min(1).optional()
      .describe('With componentIds: links to follow from them, the way flow or power travels through each component\'s own circuit. Default 1, their own links.'),
    services: z.array(z.string().trim().min(1)).min(1).optional()
      .describe('Only links of these services (as plants.list names them) or link kinds (such as thermalContact). Default every link.'),
    ...processPlantSearchPaginationShape,
  }).strict(),
  z.object({ plantId: idSchema, mode: z.literal('full') }).strict(),
])

const plantIdSchema = z.string().min(1)

export const graphReadResultSchema = z.union([
  z.object({
    plantId: plantIdSchema,
    mode: z.literal('connections'),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    components: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      label: z.string(),
      shortLabel: z.string().optional(),
      loop: z.string().optional(),
    }).strict()),
    links: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      service: z.string().optional(),
      from: z.string(),
      fromPort: z.string(),
      to: z.string(),
      toPort: z.string(),
      loop: z.string().optional(),
    }).strict()),
    continues: z.array(z.object({
      componentId: z.string(),
      direction: z.enum(['upstream', 'downstream']),
      links: z.number().int().positive(),
      next: z.array(z.string()),
    }).strict()),
  }).strict(),
  z.object({ plantId: plantIdSchema, mode: z.literal('full'), graph: z.record(z.string(), z.json()) }).strict(),
])

type GraphReadQuery = z.infer<typeof graphReadQuerySchema>
type ConnectionsQuery = Extract<GraphReadQuery, { readonly mode: 'connections' }>

const sorted = (indexes: Iterable<number>): ReadonlyArray<number> => [...new Set(indexes)].sort((left, right) => left - right)

const componentView = (graph: CompiledPlantGraph, index: number) => {
  const component = graph.components[index]!
  const shortLabel = component.metadata?.presentation?.shortLabel
  const loop = component.metadata?.loopId
  return {
    id: String(component.id),
    kind: String(component.kind),
    label: component.label,
    ...(shortLabel === undefined ? {} : { shortLabel }),
    ...(loop === undefined ? {} : { loop: String(loop) }),
  }
}

const linkView = (graph: CompiledPlantGraph, link: CompiledProcessLink) => {
  const loop = link.metadata?.loopId
  return {
    id: String(link.id),
    kind: String(link.kind),
    ...(link.service === undefined ? {} : { service: String(link.service) }),
    from: String(graph.components[link.fromComponentIndex]!.id),
    fromPort: String(link.fromPortName),
    to: String(graph.components[link.toComponentIndex]!.id),
    toPort: String(link.toPortName),
    ...(loop === undefined ? {} : { loop: String(loop) }),
  }
}

// Where a scoped read stops: the links one more step of reach would add,
// at the component they continue from, with the components they lead to.
const continuations = (
  graph: CompiledPlantGraph,
  beyond: ReadonlyArray<number>,
  direction: 'upstream' | 'downstream',
) => {
  const byComponent = new Map<number, number[]>()
  for (const index of beyond) {
    const link = graph.links[index]!
    const at = direction === 'downstream' ? link.fromComponentIndex : link.toComponentIndex
    byComponent.set(at, [...(byComponent.get(at) ?? []), index])
  }
  return [...byComponent]
    .sort(([left], [right]) => left - right)
    .map(([at, links]) => ({
      componentId: String(graph.components[at]!.id),
      direction,
      links: links.length,
      next: [...new Set(links.map(index => {
        const link = graph.links[index]!
        return String(graph.components[direction === 'downstream' ? link.toComponentIndex : link.fromComponentIndex]!.id)
      }))].sort(),
    }))
}

const connectionsView = (plantId: string, graph: CompiledPlantGraph, input: ConnectionsQuery): unknown => {
  const known = [...new Set(graph.links.map(linkCarrier))].sort()
  const missing = (input.componentIds ?? []).filter(id => !graph.componentIndexById.has(id as ComponentId))
  const issues = [
    ...missing.map(id => {
      const suggestions = equipmentSuggestions(graph, id)
      return `no component ${id}${suggestions.length === 0 ? '' : `; did you mean ${suggestions.join(' or ')}`}`
    }),
    ...(input.services ?? []).filter(service => !known.includes(service))
      .map(service => `${graph.specId} has no service or link kind ${service}; it has ${known.join(', ')}`),
    ...(input.componentIds === undefined && input.direction !== undefined ? ['direction applies only with componentIds'] : []),
    ...(input.componentIds === undefined && input.reach !== undefined ? ['reach applies only with componentIds'] : []),
  ]
  if (issues.length > 0) {
    const message = `Plant graph read rejected (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}):\n${issues.map(issue => `- ${issue}`).join('\n')}${missing.length === 0 ? '' : '\nDiscover exact component ids with world.process-plant.components.search.'}`
    return issues.length === missing.length ? capabilityTargetNotFound(message) : rejectCapabilityInput(message)
  }

  const carriers = new Set(input.services ?? known)
  const starts = (input.componentIds ?? []).map(id => graph.componentIndexById.get(id as ComponentId)!)
  const scoped = input.componentIds !== undefined
  const direction = input.direction ?? 'both'
  const reach = input.reach ?? 1
  const followed = (side: 'upstream' | 'downstream', depth: number): ReadonlySet<number> => {
    if (!scoped || (direction !== 'both' && direction !== side)) return new Set()
    return side === 'upstream' ? upstreamLinks(graph, starts, carriers, depth) : downstreamLinks(graph, starts, carriers, depth)
  }
  const selected = scoped
    ? sorted([...followed('upstream', reach), ...followed('downstream', reach)])
    : graph.links.filter(link => carriers.has(linkCarrier(link))).map(link => link.index)
  const included = new Set(selected)
  // In a closed circuit both directions can reach the same next link; it continues once.
  const upstreamBeyond = [...followed('upstream', reach + 1)].filter(index => !included.has(index))
  const downstreamBeyond = [...followed('downstream', reach + 1)].filter(index => !included.has(index) && !upstreamBeyond.includes(index))

  const { items, ...page } = paginateProcessPlantSearch(selected, input.offset, input.limit)
  const ends = items.flatMap(index => [graph.links[index]!.fromComponentIndex, graph.links[index]!.toComponentIndex])
  return {
    plantId,
    mode: 'connections',
    ...page,
    components: sorted([...starts, ...ends]).map(index => componentView(graph, index)),
    links: items.map(index => linkView(graph, graph.links[index]!)),
    continues: [...continuations(graph, upstreamBeyond, 'upstream'), ...continuations(graph, downstreamBeyond, 'downstream')],
  }
}

const fullGraphView = (graph: CompiledPlantGraph): unknown => ({
  specId: graph.specId,
  title: graph.title,
  timestep: graph.timestep,
  components: graph.components,
  links: graph.links,
  linksByKind: graph.linksByKind,
  variables: graph.variables,
})

export const graphReadView = (plantId: string, graph: CompiledPlantGraph, input: GraphReadQuery): unknown =>
  input.mode === 'full'
    ? { plantId, mode: 'full', graph: fullGraphView(graph) }
    : connectionsView(plantId, graph, input)
