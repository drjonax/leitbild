import type { ObjectId } from '../../../core/model/index.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { words } from '../../../core/model/text-search.ts'
import type { CompiledComponent, CompiledPlantGraph, ComponentId, StateAspect, VariablePath } from '../graph/index.ts'
import { linkCarrier } from '../graph/index.ts'
import { plantCarriers, plantLoops, principalCircuits } from '../equipment/circuits.ts'
import { electricalExternalPortId } from '../electrical-ports.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { operatedStateRoles } from './derived.ts'

// The Plant as World's `flow` topology (plan v3.1 §2.9, architecture A5):
// equipment as nodes with the ports its pipes and cables join, each port's
// circuit (the ports flow passes between inside the node) and the services
// it carries; every pipe and cable a drawing can show as an edge of its
// service, with its loop where it has its own. Media are the services, so a
// drawing narrows by them; groups are the loops, laned in their order. Nodes
// and edges keep the model's order, which every drawing's order follows.
// Bindings read the signals the Plant publishes, so a drawing shows live
// state: a store's level, a mover running, a breaker's contacts or a supply
// live (conducting), what passes a header, a valve's position and the values
// its kind reads first (value); a pipe's flow, a cable live. A grid source
// with an external port is the boundary a Scenario connection joins. The
// overview is the principal circuits (equipment/circuits.ts), as the unit
// overview has always drawn them; World adds where the drawing stops.

const classOf = (component: CompiledComponent): TopologyGraph['nodes'][number]['class'] => {
  const energy = component.semantics.energy.map(role => role.role)
  if (energy.includes('source')) return 'source'
  if (energy.includes('transfer')) return 'transfer'
  if (energy.includes('sink')) return 'sink'
  const aspects = component.semantics.aspects.map(aspect => aspect.aspect)
  return aspects.includes('level') ? 'store' : aspects.includes('position') ? 'switch' : aspects.includes('running') ? 'mover' : aspects.includes('energized') ? 'bus' : 'junction'
}

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

type Bindings = TopologyGraph['nodes'][number]['bindings']
/** The roles whose signal the Plant publishes, each role and signal once. */
const bound = (objectId: ObjectId, graph: CompiledPlantGraph, roles: ReadonlyArray<readonly [Bindings[number]['role'], VariablePath | undefined]>): Bindings =>
  roles.flatMap(([role, path], index) => path === undefined || graph.signalBindingByPath.get(path)?.published !== true
    || roles.slice(0, index).some(([other, at]) => other === role && at === path) ? [] : [{ role, ref: `${objectId}#${path}` }])

const nodeBindings = (objectId: ObjectId, graph: CompiledPlantGraph, component: CompiledComponent): Bindings => {
  const state = (aspect: StateAspect) => component.semantics.aspects.find(candidate => candidate.aspect === aspect)?.state
  const [position, running, energized] = [state('position'), state('running'), state('energized')]
  return bound(objectId, graph, [
    ['level', state('level')?.path],
    ['running', running?.reading === 'true' ? running.path : undefined],
    ['conducting', position?.reading === 'closedWhileTrue' ? position.path : position === undefined && energized?.reading === 'true' ? energized.path : undefined],
    ['flow', state('throughput')?.path],
    ['value', position?.reading === 'value' ? position.path : undefined],
    ...component.semantics.keyValues.map(path => ['value', path] as const),
  ])
}

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
        ports, bindings: nodeBindings(objectId, graph, component),
      }]
    }),
    edges: links.map(link => ({
      id: String(link.id), rank: `${linkCarrier(link)}|${link.id}`, medium: linkCarrier(link), directed: true,
      bindings: bound(objectId, graph, [['flow', link.variables.find(variable => String(variable.path) === `${link.id}.flowKgPerS`)?.path], ['conducting', link.variables.find(variable => String(variable.path) === `${link.id}.energized`)?.path]]),
      from: { node: String(graph.components[link.fromComponentIndex]!.id), port: String(link.fromPortName) },
      to: { node: String(graph.components[link.toComponentIndex]!.id), port: String(link.toPortName) },
      ...(link.metadata?.loopId === undefined ? {} : { group: link.metadata.loopId }),
    })),
    boundaries: [],
  }
  const principal = principalCircuits(graph)
  const withBoundaries: TopologyGraph = {
    ...topology,
    boundaries: topology.nodes.flatMap(node => {
      const externalPortId = electricalExternalPortId(graph.components[graph.componentIndexById.get(node.id as ComponentId)!]!)
      return externalPortId === undefined ? [] : node.ports.map(port => ({ node: node.id, port: port.id, externalPortId }))
    }),
    ...(!principal.ok ? {} : { overview: { nodes: principal.components.map(index => String(graph.components[index]!.id)), edges: principal.links.map(index => String(graph.links[index]!.id)) } }),
  }
  graphs.set(graph, withBoundaries)
  return withBoundaries
}

const served = new WeakMap<CompiledProcessPlant, TopologyGraph>()

/**
 * The topology the Plant serves World: its graph's, with each item a person
 * operates bound to its state observable (derived.ts) where no published
 * signal says it runs or conducts (a breaker's contacts, a condensate pump).
 */
export const servedPlantTopology = (objectId: ObjectId, plant: CompiledProcessPlant): TopologyGraph => {
  const known = served.get(plant)
  if (known !== undefined && known.objectId === objectId) return known
  const topology = plantTopology(objectId, plant.graph, plant.modelDigest)
  const roles = operatedStateRoles(plant)
  const bound: TopologyGraph = { ...topology, nodes: topology.nodes.map(node => {
    const state = roles.get(node.id)
    return state === undefined || node.bindings.some(binding => binding.role === state.role) ? node : { ...node, bindings: [...node.bindings, { role: state.role, ref: `${objectId}#${state.path}` }] }
  }) }
  served.set(plant, bound)
  return bound
}
