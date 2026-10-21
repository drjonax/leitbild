import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink } from './model.ts'

// Where flow and power can go in a Plant: along links in their nominal
// direction, and through a component only between ports of one circuit (into
// a steam generator's primary side and out of it, never across to its
// secondary side; never through a pump's power supply). Routes come from the
// static graph alone, so the same question always gives the same equipment.

/** What a link carries: its fluid service, or its connection kind for power and signals. */
export const linkCarrier = (link: CompiledProcessLink): string => link.service === undefined ? link.kind : String(link.service)

const leavesBy = (component: CompiledComponent, portName: string): boolean => {
  const direction = component.ports[portName]?.direction
  return direction === 'out' || direction === 'bidirectional'
}

const entersBy = (component: CompiledComponent, portName: string): boolean => {
  const direction = component.ports[portName]?.direction
  return direction === 'in' || direction === 'bidirectional'
}

const sameCircuit = (component: CompiledComponent, portA: string, portB: string): boolean => {
  const circuit = component.ports[portA]?.circuit
  return circuit !== undefined && circuit === component.ports[portB]?.circuit
}

/** Links flow can take after `link`: out of its target by a port in the circuit it entered, on an allowed carrier. */
export const nextLinks = (graph: CompiledPlantGraph, link: CompiledProcessLink, carriers: ReadonlySet<string>): ReadonlyArray<CompiledProcessLink> => {
  const target = graph.components[link.toComponentIndex]!
  return (graph.outgoingLinksByComponent[target.index] ?? [])
    .map(index => graph.links[index]!)
    .filter(next => carriers.has(linkCarrier(next)) && leavesBy(target, String(next.fromPortName)) && sameCircuit(target, String(link.toPortName), String(next.fromPortName)))
}

/** Links flow can have come from before `link`: into its source by a port in the circuit it leaves. */
export const previousLinks = (graph: CompiledPlantGraph, link: CompiledProcessLink, carriers: ReadonlySet<string>): ReadonlyArray<CompiledProcessLink> => {
  const source = graph.components[link.fromComponentIndex]!
  return (graph.incomingLinksByComponent[source.index] ?? [])
    .map(index => graph.links[index]!)
    .filter(previous => carriers.has(linkCarrier(previous)) && entersBy(source, String(previous.toPortName)) && sameCircuit(source, String(link.fromPortName), String(previous.toPortName)))
}

const linksOf = (graph: CompiledPlantGraph, indexes: ReadonlyArray<number> | undefined, carriers: ReadonlySet<string>): ReadonlyArray<CompiledProcessLink> =>
  (indexes ?? []).map(index => graph.links[index]!).filter(link => carriers.has(linkCarrier(link)))

/** Links reached from `start` by stepping with `step`, at most `depth` links deep (unbounded when undefined). */
const reach = (
  start: ReadonlyArray<CompiledProcessLink>,
  step: (link: CompiledProcessLink) => ReadonlyArray<CompiledProcessLink>,
  depth?: number,
): ReadonlySet<number> => {
  const seen = new Set(start.map(link => link.index))
  let frontier = [...start]
  for (let level = 1; frontier.length > 0 && (depth === undefined || level < depth); level += 1) {
    const next: CompiledProcessLink[] = []
    for (const link of frontier) {
      for (const candidate of step(link)) {
        if (seen.has(candidate.index)) continue
        seen.add(candidate.index)
        next.push(candidate)
      }
    }
    frontier = next
  }
  return seen
}

/** Links leaving the components, followed downstream; at most `depth` links when given. */
export const downstreamLinks = (graph: CompiledPlantGraph, from: ReadonlyArray<number>, carriers: ReadonlySet<string>, depth?: number): ReadonlySet<number> =>
  reach(from.flatMap(index => linksOf(graph, graph.outgoingLinksByComponent[index], carriers)), link => nextLinks(graph, link, carriers), depth)

/** Links entering the components, followed upstream; at most `depth` links when given. */
export const upstreamLinks = (graph: CompiledPlantGraph, to: ReadonlyArray<number>, carriers: ReadonlySet<string>, depth?: number): ReadonlySet<number> =>
  reach(to.flatMap(index => linksOf(graph, graph.incomingLinksByComponent[index], carriers)), link => previousLinks(graph, link, carriers), depth)

/** The carriers a component's links use on one side (what it receives, or what it delivers). */
export const carriersAt = (graph: CompiledPlantGraph, componentIndex: number, side: 'in' | 'out'): ReadonlyArray<string> =>
  [...new Set((side === 'in' ? graph.incomingLinksByComponent[componentIndex] : graph.outgoingLinksByComponent[componentIndex])!
    .map(index => linkCarrier(graph.links[index]!)))].sort()
