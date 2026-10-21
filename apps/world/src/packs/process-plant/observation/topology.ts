import type { ObjectId } from '../../../core/model/index.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { words } from '../../../core/model/text-search.ts'
import type { CompiledComponent, CompiledPlantGraph } from '../graph/index.ts'
import { linkCarrier } from '../graph/index.ts'
import { plantCarriers, plantLoops } from '../equipment/circuits.ts'

// The Plant as World's `flow` topology (plan v3.1 §2.9, architecture A5):
// equipment as nodes with the ports its pipes and cables join, each port's
// circuit (the ports flow passes between inside the node) and the services
// it carries; every pipe and cable a drawing can show as an edge of its
// service, with its loop where it has its own. Media are the services, so a
// drawing narrows by them; groups are the loops, laned in their order. Nodes
// and edges keep the model's order, which every drawing's order follows.

const classOf = (component: CompiledComponent): TopologyGraph['nodes'][number]['class'] => {
  const energy = component.semantics.energy.map(role => role.role)
  if (energy.includes('source')) return 'source'
  if (energy.includes('transfer')) return 'transfer'
  if (energy.includes('sink')) return 'sink'
  const aspects = component.semantics.aspects.map(aspect => aspect.aspect)
  return aspects.includes('level') ? 'store' : aspects.includes('position') ? 'switch' : aspects.includes('running') ? 'mover' : aspects.includes('energized') ? 'bus' : 'junction'
}

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

const graphs = new WeakMap<CompiledPlantGraph, TopologyGraph>()

/** A Plant graph's flow topology, built once per compiled graph, as the object it is named by and at the revision given (a Plant's model digest). */
export const plantTopology = (objectId: ObjectId, graph: CompiledPlantGraph, revision: string): TopologyGraph => {
  const known = graphs.get(graph)
  if (known !== undefined && known.objectId === objectId && known.revision === revision) return known
  const carriers = new Set(plantCarriers(graph))
  const links = graph.links.filter(link => carriers.has(linkCarrier(link)))
  const portMedia = new Map<string, Set<string>>()
  for (const link of links) {
    for (const key of [`${link.fromComponentIndex}|${link.fromPortName}`, `${link.toComponentIndex}|${link.toPortName}`]) portMedia.set(key, new Set([...(portMedia.get(key) ?? []), linkCarrier(link)]))
  }
  const topology: TopologyGraph = {
    objectId,
    revision,
    family: 'flow',
    media: [...carriers].map(carrier => ({
      id: carrier,
      label: capitalized(words(carrier).join(' ')).slice(0, 40),
      kind: links.some(link => linkCarrier(link) === carrier && link.kind === 'electricalPower') ? 'electric-ac' as const
        : links.some(link => linkCarrier(link) === carrier && link.nominalFluid === 'steam') ? 'steam' as const : 'fluid' as const,
    })),
    groups: plantLoops(graph).map((loop, order) => ({ id: loop, label: `Loop ${loop}`, kind: 'loop', lane: { key: loop, order } })),
    nodes: graph.components.flatMap(component => {
      const ports = Object.entries(component.ports).flatMap(([name, port]) => {
        const media = portMedia.get(`${component.index}|${name}`)
        return media === undefined ? [] : [{
          id: name, rank: name, media: [...media].sort(), direction: port.direction === 'bidirectional' ? 'both' as const : port.direction === 'out' ? 'out' as const : 'in' as const,
          ...(port.circuit === undefined ? {} : { circuit: port.circuit }),
        }]
      })
      const shortLabel = component.metadata?.presentation?.shortLabel
      return ports.length === 0 ? [] : [{
        id: String(component.id), element: String(component.id), class: classOf(component), kind: component.kind, label: component.label,
        ...(shortLabel === undefined ? {} : { shortLabel }),
        rank: [component.kind, component.metadata?.equipmentClass ?? '', component.metadata?.role ?? ''].join('|'),
        ...(component.metadata?.loopId === undefined ? {} : { group: component.metadata.loopId }),
        ports, bindings: [],
      }]
    }),
    edges: links.map(link => ({
      id: String(link.id), rank: `${linkCarrier(link)}|${link.id}`, medium: linkCarrier(link), directed: true, bindings: [],
      from: { node: String(graph.components[link.fromComponentIndex]!.id), port: String(link.fromPortName) },
      to: { node: String(graph.components[link.toComponentIndex]!.id), port: String(link.toPortName) },
      ...(link.metadata?.loopId === undefined ? {} : { group: link.metadata.loopId }),
    })),
    boundaries: [],
  }
  graphs.set(graph, topology)
  return topology
}
