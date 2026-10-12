import type { CompiledPlantGraph } from '../../graph/index.ts'
import { linkCarrier, ratedFlowForLink } from '../../graph/index.ts'
import { pumpDriveSteamPorts } from '../../graph/pump-component-definitions.ts'
import { drawingStops, type MimicScope } from './scope.ts'

// A unit overview draws the Plant's principal circuits, found by following
// its energy rather than by any name. Ring 0 is the closed fluid circuit a
// heat source heats; each further ring is a closed circuit that a transfer
// (a steam generator, an intermediate heat exchanger) moves that heat into.
// A closed circuit is a strongly connected part of the fluid graph whose
// nodes are a component's port circuits, so a steam generator's primary and
// secondary sides are different nodes. Within a circuit, links rated an order
// of magnitude below its largest flow are auxiliary (charging, a residual-heat
// train) and only stub the drawing. Heat handed to once-through flow (a
// condenser's cooling water) stubs it too. Relief valves that discharge
// straight out of the Plant (safety and atmospheric relief valves venting to
// the atmosphere) are left to the detail views: shut in operation, they would
// only widen the overview, and their alarms say when they open. So are the
// valves that only supply a pump's drive turbine with steam (the
// turbine-driven auxiliary feedwater pump's), which also stand shut in
// operation and take the steam out of the Plant.

/** A link rated below this fraction of its circuit's largest rated flow is auxiliary to the circuit. */
export const AUXILIARY_FLOW_FRACTION = 0.1

export interface PrincipalRing {
  /** 0 for the circuits a heat source heats, n + 1 for those a transfer feeds from ring n. */
  readonly ring: number
  readonly carriers: ReadonlyArray<string>
  readonly components: ReadonlyArray<number>
  readonly links: ReadonlyArray<number>
}

export type PrincipalCircuitsResult =
  | {
    readonly ok: true
    readonly rings: ReadonlyArray<PrincipalRing>
    /** Transfers into flow that does not return: drawn as the stubs where heat leaves the overview. */
    readonly onceThrough: ReadonlyArray<{ readonly component: number; readonly circuit: string }>
    readonly scope: MimicScope
  }
  | { readonly ok: false; readonly reason: string }

interface Edge {
  readonly from: number
  readonly to: number
  readonly link: number
}

/** Strongly connected nodes containing `seed`, over the given edges (Tarjan, iterative). */
const componentContaining = (nodeCount: number, edges: ReadonlyArray<Edge>, seed: number): ReadonlySet<number> => {
  const next = Array.from({ length: nodeCount }, () => [] as number[])
  for (const edge of edges) next[edge.from]!.push(edge.to)
  const index = new Array<number>(nodeCount).fill(-1)
  const low = new Array<number>(nodeCount).fill(0)
  const onStack = new Array<boolean>(nodeCount).fill(false)
  const stack: number[] = []
  let counter = 0
  let found: ReadonlySet<number> = new Set([seed])
  const visit = (root: number): void => {
    const work: Array<{ node: number; child: number }> = [{ node: root, child: 0 }]
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = true
    while (work.length > 0) {
      const frame = work.at(-1)!
      const successors = next[frame.node]!
      if (frame.child < successors.length) {
        const successor = successors[frame.child++]!
        if (index[successor] === -1) {
          index[successor] = low[successor] = counter++
          stack.push(successor)
          onStack[successor] = true
          work.push({ node: successor, child: 0 })
        } else if (onStack[successor]) {
          low[frame.node] = Math.min(low[frame.node]!, index[successor]!)
        }
        continue
      }
      work.pop()
      if (work.length > 0) low[work.at(-1)!.node] = Math.min(low[work.at(-1)!.node]!, low[frame.node]!)
      if (low[frame.node] === index[frame.node]) {
        const members = new Set<number>()
        for (;;) {
          const member = stack.pop()!
          onStack[member] = false
          members.add(member)
          if (member === frame.node) break
        }
        if (members.has(seed)) found = members
      }
    }
  }
  visit(seed)
  return found
}

export const principalCircuits = (graph: CompiledPlantGraph): PrincipalCircuitsResult => {
  const keys = new Map<string, number>()
  const nodeOf = (component: number, circuit: string): number => {
    const key = `${component}|${circuit}`
    const existing = keys.get(key)
    if (existing !== undefined) return existing
    keys.set(key, keys.size)
    return keys.size - 1
  }
  // A port without a declared circuit belongs to the component's one through-flow node.
  const portOf = (component: number, port: string) => graph.components[component]!.ports[port]
  const fluid = graph.links.filter(link => link.kind === 'fluidFlow')
  const edges: Edge[] = fluid.flatMap(link => {
    const from = nodeOf(link.fromComponentIndex, portOf(link.fromComponentIndex, String(link.fromPortName))?.circuit ?? '')
    const to = nodeOf(link.toComponentIndex, portOf(link.toComponentIndex, String(link.toPortName))?.circuit ?? '')
    // A bidirectional port (a pressurizer's surge line) passes flow both ways.
    const both = portOf(link.fromComponentIndex, String(link.fromPortName))?.direction === 'bidirectional'
      || portOf(link.toComponentIndex, String(link.toPortName))?.direction === 'bidirectional'
    return both ? [{ from, to, link: link.index }, { from: to, to: from, link: link.index }] : [{ from, to, link: link.index }]
  })
  const rating = new Map(fluid.map(link => [link.index, ratedFlowForLink(graph, link)]))

  // The closed circuit through a node, without its auxiliary links; null when the node's flow does not return.
  const closedCircuitAt = (seed: number): { readonly nodes: ReadonlySet<number>; readonly edges: ReadonlyArray<Edge> } | null => {
    let usable: ReadonlyArray<Edge> = edges
    for (;;) {
      const nodes = componentContaining(keys.size, usable, seed)
      const inside = usable.filter(edge => nodes.has(edge.from) && nodes.has(edge.to))
      if (inside.length === 0) return null
      const largest = Math.max(0, ...inside.map(edge => rating.get(edge.link) ?? 0))
      const kept = inside.filter(edge => {
        const rated = rating.get(edge.link)
        return rated === null || rated === undefined || rated >= AUXILIARY_FLOW_FRACTION * largest
      })
      if (kept.length === inside.length) return { nodes, edges: inside }
      usable = kept
    }
  }

  const sources = graph.components.flatMap(component => component.semantics.energy
    .flatMap(role => (role.role === 'source' ? [nodeOf(component.index, role.circuit)] : [])))
  if (sources.length === 0) return { ok: false, reason: `${graph.specId} declares no heat source, so it has no energy path to draw` }

  const placed = new Map<number, number>()
  const rings: Array<{ ring: number; nodes: Set<number>; links: Set<number> }> = []
  const onceThrough: Array<{ component: number; circuit: string }> = []
  const nodeKey = [...keys].reduce((all, [key, node]) => all.set(node, key), new Map<number, string>())
  const place = (ring: number, circuit: { readonly nodes: ReadonlySet<number>; readonly edges: ReadonlyArray<Edge> }): void => {
    const entry = rings.find(existing => existing.ring === ring) ?? (() => {
      const created = { ring, nodes: new Set<number>(), links: new Set<number>() }
      rings.push(created)
      return created
    })()
    for (const node of circuit.nodes) {
      placed.set(node, ring)
      entry.nodes.add(node)
    }
    for (const edge of circuit.edges) entry.links.add(edge.link)
  }
  for (const source of sources) {
    if (placed.has(source)) continue
    const circuit = closedCircuitAt(source)
    if (circuit !== null) place(0, circuit)
  }
  if (rings.length === 0) return { ok: false, reason: `no heat source of ${graph.specId} lies on a closed fluid circuit, so it has no circulating energy path to draw` }

  for (let ring = 0; ring < rings.length + 1; ring++) {
    const current = rings.find(entry => entry.ring === ring)
    if (current === undefined) break
    for (const node of [...current.nodes].sort((a, b) => a - b)) {
      const [componentText, circuit] = nodeKey.get(node)!.split('|') as [string, string]
      const component = Number(componentText)
      for (const role of graph.components[component]!.semantics.energy) {
        if (role.role !== 'transfer' || role.from !== circuit) continue
        const target = nodeOf(component, role.to)
        if (placed.has(target)) continue
        const fed = closedCircuitAt(target)
        if (fed === null) onceThrough.push({ component, circuit: role.to })
        else place(ring + 1, fed)
      }
    }
  }

  const sorted = (values: Iterable<number>): ReadonlyArray<number> => [...new Set(values)].sort((a, b) => a - b)
  const componentsOf = (nodes: Iterable<number>): ReadonlyArray<number> => sorted([...nodes].map(node => Number(nodeKey.get(node)!.split('|')[0])))
  const carriersOf = (links: Iterable<number>): ReadonlyArray<string> => [...new Set([...links].map(link => linkCarrier(graph.links[link]!)))].sort()
  const ordered = [...rings].sort((a, b) => a.ring - b.ring)
  const components = sorted(ordered.flatMap(entry => componentsOf(entry.nodes)))
  const links = sorted(ordered.flatMap(entry => [...entry.links]))
  // The drawing stops at every other fluid link of its equipment: where auxiliary and safety services join or leave it.
  const fluidCarriers = new Set(fluid.map(linkCarrier))
  // A relief valve vents out of the Plant when everything it discharges into takes the flow no further.
  const ventsOutOfPlant = (component: number): boolean => graph.components[component]!.semantics.function === 'relieving'
    && (graph.outgoingLinksByComponent[component] ?? []).every(index => (graph.outgoingLinksByComponent[graph.links[index]!.toComponentIndex] ?? []).length === 0)
  // A valve whose every outlet is a pump's drive steam inlet supplies that pump's turbine only.
  const suppliesDriveTurbine = (component: number): boolean => {
    const outlets = graph.outgoingLinksByComponent[component] ?? []
    return outlets.length > 0 && outlets.every(index => String(graph.links[index]!.toPortName) === pumpDriveSteamPorts.inlet)
  }
  const stubs = drawingStops(graph, components, new Set(links), fluidCarriers, () => false)
    .filter(stub => !stub.others.every(other => ventsOutOfPlant(other.component) || suppliesDriveTurbine(other.component)))
  return {
    ok: true,
    rings: ordered.map(entry => ({ ring: entry.ring, carriers: carriersOf(entry.links), components: componentsOf(entry.nodes), links: sorted(entry.links) })),
    onceThrough,
    scope: { components, links, stubs, carriers: carriersOf(links), names: [] },
  }
}
