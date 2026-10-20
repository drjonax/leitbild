import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink } from '../../graph/index.ts'
import type { MimicIntent } from './mimic-model.ts'
import { carriersAt, downstreamLinks, linkCarrier, routeLinks, upstreamLinks } from '../../graph/index.ts'
import { SUGGESTION_COUNT, words } from '../../../../core/model/text-search.ts'
import { groupStem, resolveName, serviceResembles, unconnectedReason } from '../../equipment/names.ts'
import { plantCarriers, plantLoops } from '../../equipment/circuits.ts'

// What a mimic draws, resolved from the agent's intent in plant terms. The
// scope comes from the static Plant graph alone (never from live values), so
// the same intent on the same model always draws the same equipment.

/** Where the drawing stops: links that leave a drawn component for equipment not drawn, grouped by port. */
export interface MimicStub {
  readonly component: number
  readonly port: string
  /** `out`: flow leaves the drawing here; `in`: flow enters it. */
  readonly direction: 'in' | 'out'
  readonly links: ReadonlyArray<number>
  /** The far ends, by component and port. */
  readonly others: ReadonlyArray<{ readonly component: number; readonly port: string }>
}

export interface MimicScope {
  readonly components: ReadonlyArray<number>
  readonly links: ReadonlyArray<number>
  readonly stubs: ReadonlyArray<MimicStub>
  readonly carriers: ReadonlyArray<string>
  /** How each name resolved, for the compose result. */
  readonly names: ReadonlyArray<{ readonly name: string; readonly component: number; readonly via: 'id' | 'tag' | 'label' | 'group' }>
}

export type MimicScopeResult =
  | { readonly ok: true; readonly scope: MimicScope }
  | { readonly ok: false; readonly issues: ReadonlyArray<{ readonly field: string; readonly message: string; readonly didYouMean?: ReadonlyArray<string> }> }

/** Steps down- or upstream a one-ended or around intent follows unless it asks for fewer: enough to show a component's neighbours and theirs. */
export const MIMIC_REACH_LINKS = 3

const shortLabelOf = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  return component.metadata?.presentation?.shortLabel ?? component.label
}

const loopOf = (graph: CompiledPlantGraph, link: CompiledProcessLink): string | undefined =>
  link.metadata?.loopId
    ?? graph.components[link.fromComponentIndex]!.metadata?.loopId
    ?? graph.components[link.toComponentIndex]!.metadata?.loopId

const sorted = (indexes: Iterable<number>): ReadonlyArray<number> => [...new Set(indexes)].sort((left, right) => left - right)

export const resolveMimicScope = (graph: CompiledPlantGraph, intent: MimicIntent): MimicScopeResult => {
  const issues: Array<{ readonly field: string; readonly message: string; readonly didYouMean?: ReadonlyArray<string> }> = []
  const names: Array<MimicScope['names'][number]> = []
  /** What the drawing is about: each end or item named, with the components it names. */
  const anchors: Array<{ readonly name: string; readonly components: ReadonlyArray<number> }> = []
  const known = plantCarriers(graph)
  const resolveAll = (field: 'from' | 'to' | 'around' | 'exclude', list: ReadonlyArray<string> | undefined): ReadonlyArray<number> => (list ?? []).flatMap((name, index) => {
    const resolved = resolveName(graph, name, field)
    if ('error' in resolved) {
      issues.push({ field: `${field}.${index}`, message: resolved.error, ...(resolved.didYouMean.length === 0 ? {} : { didYouMean: resolved.didYouMean }) })
      return []
    }
    const unconnected = field === 'exclude' ? [] : resolved.components.flatMap(component => unconnectedReason(graph, component, known) ?? [])
    if (unconnected.length > 0) {
      issues.push({ field: `${field}.${index}`, message: unconnected.join('; ') })
      return []
    }
    for (const component of resolved.components) names.push({ name, component, via: resolved.via })
    if (field !== 'exclude') anchors.push({ name, components: resolved.components })
    return resolved.components
  })
  const from = resolveAll('from', intent.from)
  const to = resolveAll('to', intent.to)
  const around = resolveAll('around', intent.around)
  const excluded = new Set(resolveAll('exclude', intent.exclude))
  if (around.length > 0 && (from.length > 0 || to.length > 0)) {
    issues.push({ field: 'around', message: 'around draws what feeds items and where their outflow goes; give it without from or to' })
  }
  if (intent.reach !== undefined && from.length > 0 && to.length > 0) {
    issues.push({ field: 'reach', message: 'a route draws every link between its ends; reach applies to one end (from or to alone) or around' })
  }

  for (const [index, service] of (intent.services ?? []).entries()) {
    if (known.includes(service)) continue
    const close = known.filter(candidate => serviceResembles(service, candidate))
    issues.push({ field: `services.${index}`, message: `${graph.specId} has no service ${service}; its services are ${known.join(', ')}`, ...(close.length === 0 ? {} : { didYouMean: close.slice(0, SUGGESTION_COUNT) }) })
  }
  const loops = plantLoops(graph)
  const unknownLoops = (intent.loops ?? []).filter(loop => !loops.includes(loop))
  if (unknownLoops.length > 0) issues.push({ field: 'loops', message: `loops ${unknownLoops.join(', ')} do not exist; this Plant has loops ${loops.join(', ')}` })
  if (from.length === 0 && to.length === 0 && around.length === 0 && intent.services === undefined && issues.length === 0) {
    issues.push({ field: '(mimic)', message: 'say what to draw: from and/or to (equipment), around (equipment), or services (with loops)' })
  }
  for (const anchor of [...from, ...to, ...around]) {
    if (excluded.has(anchor)) issues.push({ field: 'exclude', message: `${graph.components[anchor]!.id} is an end of the drawing and cannot be excluded` })
  }
  if (issues.length > 0) return { ok: false, issues }

  // Without services, a route uses what its ends deliver and receive; a one-ended
  // intent must say which service when its end has several.
  const ends = (list: ReadonlyArray<number>) => list.map(index => graph.components[index]!.id).join(', ')
  const delivered = (list: ReadonlyArray<number>) => new Set(list.flatMap(index => carriersAt(graph, index, 'out')).filter(carrier => known.includes(carrier)))
  const received = (list: ReadonlyArray<number>) => new Set(list.flatMap(index => carriersAt(graph, index, 'in')).filter(carrier => known.includes(carrier)))
  const shared = (left: ReadonlySet<string>, right: ReadonlySet<string>) => new Set([...left].filter(carrier => right.has(carrier)))
  const listed = (carriers: ReadonlySet<string>) => [...carriers].sort().join(', ') || 'nothing'
  // What equipment does carry, so a wrong service is corrected in one call.
  const carriedBy = (list: ReadonlyArray<number>) => list.map(index => `${graph.components[index]!.id} carries ${listed(new Set([...delivered([index]), ...received([index])]))}`).join('; ')
  // Around an item, the services of its process: the fluid it carries on both sides, or its power where it carries
  // nothing else (a bus, a diesel). Power beside a process is drawn only where services name it: mixed into the
  // flow it runs as a tree of its own across the process lines (layout audit, Bad 3 and 8); the drawing stops at
  // the item where it joins instead.
  const power = new Set(graph.links.filter(link => link.kind === 'electricalPower').map(linkCarrier))
  const carriedAt = (index: number): ReadonlySet<string> => new Set([...delivered([index]), ...received([index])])
  const processOf = (index: number): ReadonlyArray<string> => {
    const fluid = [...carriedAt(index)].filter(carrier => !power.has(carrier))
    return fluid.length > 0 ? fluid : [...carriedAt(index)]
  }
  const carriers: ReadonlySet<string> = intent.services !== undefined ? new Set(intent.services)
    : around.length > 0 ? new Set(around.flatMap(processOf))
      : from.length > 0 && to.length > 0 ? shared(delivered(from), received(to))
        : from.length > 0 ? delivered(from) : received(to)
  if (intent.services === undefined && around.length === 0 && (from.length === 0 || to.length === 0) && carriers.size > 1) {
    const anchor = from.length > 0 ? from : to
    return { ok: false, issues: [{ field: 'services', message: `${ends(anchor)} ${from.length > 0 ? 'delivers' : 'receives'} ${[...carriers].sort().join(', ')}; add services to say which` }] }
  }

  const passable = (link: CompiledProcessLink): boolean => !excluded.has(link.fromComponentIndex) && !excluded.has(link.toComponentIndex)
  const allowed = new Set(graph.links.filter(link => carriers.has(linkCarrier(link)) && passable(link)).map(link => link.index))
  const subgraph = (indexes: ReadonlySet<number>): ReadonlySet<number> => new Set([...indexes].filter(index => allowed.has(index)))
  const upstreamOf = to.length > 0 && from.length === 0 ? to : around
  const downstreamOf = from.length > 0 && to.length === 0 ? from : around
  const reach = intent.reach ?? MIMIC_REACH_LINKS
  const route = from.length > 0 && to.length > 0
  const upstream = subgraph(route || upstreamOf.length === 0 ? new Set() : upstreamLinks(graph, upstreamOf, carriers, reach))
  const downstream = subgraph(route || downstreamOf.length === 0 ? new Set() : downstreamLinks(graph, downstreamOf, carriers, reach))
  const reached = route ? subgraph(routeLinks(graph, from, to, carriers))
    : upstreamOf.length > 0 || downstreamOf.length > 0 ? new Set([...upstream, ...downstream]) : allowed
  // A reach that stops one step short of where the flow starts or ends (a
  // tank feeding the pumps) draws that end too: one symbol says more than a
  // stub at every pump it feeds. Only along the reach: around a pump, the bus
  // feeding it does not draw every other load it feeds.
  const endsOf = (links: ReadonlySet<number>) => new Set([...links].flatMap(drawn => [graph.links[drawn]!.fromComponentIndex, graph.links[drawn]!.toComponentIndex]))
  const reachedEnds = endsOf(reached)
  const upstreamEnds = endsOf(upstream)
  const downstreamEnds = endsOf(downstream)
  const carried = (indexes: ReadonlyArray<number> | undefined) => (indexes ?? []).filter(other => allowed.has(other))
  const terminalSteps = [...allowed].filter(index => {
    if (reached.has(index)) return false
    const link = graph.links[index]!
    const sourceStep = upstreamEnds.has(link.toComponentIndex) && !reachedEnds.has(link.fromComponentIndex) && carried(graph.incomingLinksByComponent[link.fromComponentIndex]).length === 0
    const sinkStep = downstreamEnds.has(link.fromComponentIndex) && !reachedEnds.has(link.toComponentIndex) && carried(graph.outgoingLinksByComponent[link.toComponentIndex]).length === 0
    return sourceStep || sinkStep
  })
  const selected = new Set([...reached, ...terminalSteps])
  if (selected.size === 0) {
    const reverseCarriers = intent.services !== undefined ? carriers : shared(delivered(to), received(from))
    const reverse = from.length > 0 && to.length > 0 && routeLinks(graph, to, from, reverseCarriers).size > 0
    if (from.length > 0 && to.length > 0 && carriers.size === 0 && !reverse) {
      return { ok: false, issues: [{ field: '(mimic)', message: `${ends(from)} delivers ${listed(delivered(from))} and ${ends(to)} receives ${listed(received(to))}: no service connects them` }] }
    }
    return {
      ok: false,
      issues: [{
        field: '(mimic)',
        message: reverse ? `${ends(to)} feeds ${ends(from)}, not the other way: swap from and to`
          : from.length > 0 && to.length > 0 ? `no ${[...carriers].join(' or ')} route from ${ends(from)} to ${ends(to)} in the Plant model; ${ends(from)} delivers ${listed(delivered(from))} and ${ends(to)} receives ${listed(received(to))}`
            : `nothing ${[...carriers].join(' or ')} connects to ${ends([...from, ...to, ...around])} in the Plant model; ${carriedBy([...from, ...to, ...around])}`,
      }],
    }
  }

  // Loops narrow a drawing to their own links and the shared equipment on routes into or out of them.
  const inLoops = (() => {
    if (intent.loops === undefined) return selected
    const wanted = new Set(intent.loops)
    const own = new Set([...selected].filter(index => {
      const loop = loopOf(graph, graph.links[index]!)
      return loop !== undefined && wanted.has(loop)
    }))
    const shared = new Set([...selected].filter(index => loopOf(graph, graph.links[index]!) === undefined))
    const ends = [...own].map(index => graph.links[index]!)
    const sharedSubset = new Set([...shared, ...own])
    const reachable = new Set([
      ...[...upstreamLinks(graph, ends.map(link => link.fromComponentIndex), carriers)],
      ...[...downstreamLinks(graph, ends.map(link => link.toComponentIndex), carriers)],
    ].filter(index => sharedSubset.has(index)))
    return new Set([...own, ...[...shared].filter(index => reachable.has(index))])
  })()
  if (inLoops.size === 0) {
    const asked = intent.loops ?? []
    const reachedLoops = loops.filter(loop => [...selected].some(index => loopOf(graph, graph.links[index]!) === loop))
    const service = [...carriers].sort().join(' and ')
    const subject = from.length > 0 && to.length > 0 ? `the ${service} route from ${ends(from)} to ${ends(to)}`
      : from.length > 0 ? `the ${service} downstream of ${ends(from)}` : to.length > 0 ? `the ${service} upstream of ${ends(to)}` : service
    return {
      ok: false,
      issues: [{
        field: 'loops',
        message: `${subject} has no equipment in ${asked.length === 1 ? 'loop' : 'loops'} ${asked.join(', ')} and no route into or out of ${asked.length === 1 ? 'it' : 'them'}; ${reachedLoops.length > 0
          ? `it reaches ${reachedLoops.length === 1 ? 'loop' : 'loops'} ${reachedLoops.join(', ')}: name ${reachedLoops.length === 1 ? 'that loop' : 'those'}, or drop "loops"`
          : 'it draws only shared equipment, so drop "loops"'}`,
      }],
    }
  }

  const components = sorted([...inLoops].flatMap(index => [graph.links[index]!.fromComponentIndex, graph.links[index]!.toComponentIndex]))
  const drawn = new Set(components)
  // Loops narrow a drawing, never past what it is about: each equipment named that the services reach stays in
  // it (of alike items named in the plural, at least one), or the intent is refused, never drawn without it.
  const reachedComponents = endsOf(selected)
  const lost = anchors.filter(anchor => anchor.components.some(component => reachedComponents.has(component)) && !anchor.components.some(component => drawn.has(component)))
  if (lost.length > 0) {
    const asked = intent.loops ?? []
    const loopsAt = (component: number): ReadonlyArray<string> => loops.filter(loop => [...selected].some(index => {
      const link = graph.links[index]!
      return (link.fromComponentIndex === component || link.toComponentIndex === component) && loopOf(graph, link) === loop
    }))
    return {
      ok: false,
      issues: lost.map(anchor => {
        const at = [...new Set(anchor.components.flatMap(loopsAt))]
        const what = anchor.components.length === 1 ? ends(anchor.components) : `every one of "${anchor.name}" (${ends(anchor.components)})`
        return {
          field: 'loops',
          message: `${asked.length === 1 ? `loop ${asked[0]} leaves` : `loops ${asked.join(', ')} leave`} out ${what}, which the drawing is about; ${at.length > 0
            ? `${anchor.components.length === 1 ? 'it lies' : 'they lie'} on ${at.length === 1 ? 'loop' : 'loops'} ${at.join(', ')}: name ${at.length === 1 ? 'that loop' : 'one of those'} too, or drop "loops"`
            : 'drop "loops"'}`,
        }
      }),
    }
  }
  // Links among drawn equipment of the drawn services are drawn too (a recirculation line, a cross-tie).
  const links = sorted([...allowed].filter(index => {
    if (inLoops.has(index)) return true
    const link = graph.links[index]!
    return drawn.has(link.fromComponentIndex) && drawn.has(link.toComponentIndex) && (intent.loops === undefined || loopOf(graph, link) === undefined || intent.loops.includes(loopOf(graph, link)!))
  }))
  const drawnLinks = new Set(links)

  // Every other link of a drawn service at a drawn component is where the drawing
  // stops. Narrowed to loops, flow into a shared hub from the other loops is not
  // part of the question; flow leaving the drawing toward them still is.
  const otherLoop = (link: CompiledProcessLink): boolean => intent.loops !== undefined && loopOf(graph, link) !== undefined && !intent.loops.includes(loopOf(graph, link)!)
  const stubs = drawingStops(graph, components, drawnLinks, carriers, otherLoop)
  // Around items, each service left out of the drawing stops it at them (a pump's power supply).
  const leftOut = intent.services === undefined ? new Set(around.flatMap(index => [...carriedAt(index)]).filter(carrier => !carriers.has(carrier))) : new Set<string>()
  const joins = leftOut.size === 0 ? [] : drawingStops(graph, around.filter(index => drawn.has(index)), drawnLinks, leftOut, () => false)
  return { ok: true, scope: { components, links, stubs: [...stubs, ...joins], carriers: [...carriers].sort(), names } }
}

/**
 * A drawing's parallel supplies: where its flow ends, at a port of equipment
 * no drawn line leaves (the core's cold leg C, a steam generator's feed
 * inlet), every other line into that port from equipment that feeds it once
 * through (a safety injection accumulator, an auxiliary feed valve), not as
 * part of a loop through it (a reactor coolant pump). Null where there are
 * none. `drawn` draws each from the equipment its line branches from (the
 * auxiliary feed header), through the valves in series on it, and stops the
 * drawing at what feeds that; `stubbed` only stops the drawing at the port,
 * naming them.
 */
export const withParallelSupplies = (graph: CompiledPlantGraph, scope: MimicScope, style: 'drawn' | 'stubbed'): MimicScope | null => {
  const drawnLinks = new Set(scope.links)
  const fluid = graph.links.filter(link => link.kind === 'fluidFlow')
  const fluidCarriers = new Set(fluid.map(linkCarrier))
  const ends = scope.components.filter(component => !(graph.outgoingLinksByComponent[component] ?? []).some(index => drawnLinks.has(index) && graph.links[index]!.kind === 'fluidFlow'))
  const supplies = ends.flatMap(end => {
    const ports = new Set((graph.incomingLinksByComponent[end] ?? []).filter(index => drawnLinks.has(index) && graph.links[index]!.kind === 'fluidFlow').map(index => String(graph.links[index]!.toPortName)))
    if (ports.size === 0) return []
    const looping = new Set([...downstreamLinks(graph, [end], fluidCarriers)].map(index => graph.links[index]!.toComponentIndex))
    return (graph.incomingLinksByComponent[end] ?? []).map(index => graph.links[index]!)
      .filter(link => link.kind === 'fluidFlow' && !drawnLinks.has(link.index) && ports.has(String(link.toPortName)) && !looping.has(link.fromComponentIndex))
  })
  if (supplies.length === 0) return null
  const carriers = new Set(supplies.map(linkCarrier))
  if (style === 'stubbed') {
    const supplied = new Set(supplies.map(link => link.index))
    const stops = drawingStops(graph, [...new Set(supplies.map(link => link.toComponentIndex))], drawnLinks, carriers, link => !supplied.has(link.index))
    return { ...scope, stubs: [...scope.stubs, ...stops] }
  }
  // Upstream through what only passes the flow on (one line in, one out), to where the supply's line branches.
  const lines = supplies.flatMap(supply => {
    const line = [supply]
    for (let step = 0; step < MIMIC_REACH_LINKS; step += 1) {
      const source = line.at(-1)!.fromComponentIndex
      const into = (graph.incomingLinksByComponent[source] ?? []).map(index => graph.links[index]!).filter(link => linkCarrier(link) === linkCarrier(supply))
      const out = (graph.outgoingLinksByComponent[source] ?? []).map(index => graph.links[index]!).filter(link => linkCarrier(link) === linkCarrier(supply))
      if (into.length !== 1 || out.length !== 1) break
      line.push(into[0]!)
    }
    return line
  })
  const added = sorted(lines.map(link => link.fromComponentIndex)).filter(component => !scope.components.includes(component))
  const links = sorted([...scope.links, ...lines.map(link => link.index)])
  const components = sorted([...scope.components, ...added])
  const stops = drawingStops(graph, added, new Set(links), carriers, () => false)
  return { ...scope, components, links, stubs: [...scope.stubs, ...stops], carriers: [...new Set([...scope.carriers, ...carriers])].sort() }
}

/**
 * A drawing with its leaves stopped where they join: equipment whose one link
 * of the drawn services brings it flow from drawn equipment (in a drawing of
 * electrical power, the pumps and loads a bus feeds) becomes part of a stub
 * on what feeds it ("to AFW pump, CHG pump, CS pump A and 6 more"), unless
 * the intent names it. Null where there are none. What compose tries when the drawing as asked
 * does not stay legible: the leaves carry nothing further, so naming them
 * loses no path.
 */
export const withLeavesStubbed = (graph: CompiledPlantGraph, scope: MimicScope): MimicScope | null => {
  const named = new Set(scope.names.map(entry => entry.component))
  const carriers = new Set(scope.carriers)
  // Links of the drawn services only: in a drawing of electrical power a pump is a load, whatever it pumps.
  const linksOf = (component: number): ReadonlyArray<number> => [...(graph.incomingLinksByComponent[component] ?? []), ...(graph.outgoingLinksByComponent[component] ?? [])]
    .filter(index => carriers.has(linkCarrier(graph.links[index]!)))
  const drawnLinks = new Set(scope.links)
  const leaves = scope.components.filter(component => {
    if (named.has(component)) return false
    const links = linksOf(component)
    if (links.length !== 1 || !drawnLinks.has(links[0]!)) return false
    // Only what the drawn flow ends in: a source (a diesel) is where the flow comes from and stays drawn.
    const link = graph.links[links[0]!]!
    return link.toComponentIndex === component && scope.components.includes(link.fromComponentIndex)
  })
  if (leaves.length === 0) return null
  const removed = new Set(leaves)
  const leafLinks = new Set(leaves.flatMap(linksOf))
  const parents = sorted([...leafLinks].map(index => graph.links[index]!).map(link => removed.has(link.fromComponentIndex) ? link.toComponentIndex : link.fromComponentIndex))
  const components = scope.components.filter(component => !removed.has(component))
  const links = scope.links.filter(index => !leafLinks.has(index))
  const parentSet = new Set(parents)
  const stops = drawingStops(graph, parents, new Set(links), carriers, () => false)
  return { ...scope, components, links, stubs: [...scope.stubs.filter(stub => !parentSet.has(stub.component)), ...stops] }
}

/**
 * A scope narrowed to some services, with a stop at the given items for
 * every other service they carry, so what the drawing leaves out still shows
 * where it joins.
 */
export const withOtherServicesStopped = (graph: CompiledPlantGraph, scope: MimicScope, items: ReadonlyArray<number>, services: ReadonlyArray<string>): MimicScope => {
  const others = new Set(services.filter(service => !scope.carriers.includes(service)))
  const stops = drawingStops(graph, items.filter(item => scope.components.includes(item)), new Set(scope.links), others, () => false)
  return { ...scope, stubs: [...scope.stubs, ...stops] }
}

/**
 * Where a drawing of these components and links stops: every other link of
 * the given carriers at a drawn component, one stub per port circuit and
 * direction. Flow into the drawing that `ignoreIncoming` names is left out.
 */
export const drawingStops = (
  graph: CompiledPlantGraph,
  components: ReadonlyArray<number>,
  drawnLinks: ReadonlySet<number>,
  carriers: ReadonlySet<string>,
  ignoreIncoming: (link: CompiledProcessLink) => boolean,
): ReadonlyArray<MimicStub> => {
  const drawn = new Set(components)
  const stubsByKey = new Map<string, { component: number; port: string; direction: 'in' | 'out'; links: number[]; others: Array<{ component: number; port: string }> }>()
  for (const component of components) {
    for (const [direction, indexes] of [['out', graph.outgoingLinksByComponent[component]], ['in', graph.incomingLinksByComponent[component]]] as const) {
      for (const index of indexes ?? []) {
        const link = graph.links[index]!
        if (drawnLinks.has(index) || !carriers.has(linkCarrier(link))) continue
        if (direction === 'in' && ignoreIncoming(link)) continue
        // A link with both ends drawn but left out stops where it leaves, not where it arrives.
        if (direction === 'in' && drawn.has(link.fromComponentIndex)) continue
        const port = String(direction === 'out' ? link.fromPortName : link.toPortName)
        // Alike ports of one circuit (a header's outlets) stop the drawing once, naming every far end.
        const circuit = graph.components[component]!.ports[port]?.circuit
        const key = `${component}|${circuit ?? port}|${direction}`
        const stub = stubsByKey.get(key) ?? { component, port, direction, links: [], others: [] }
        stub.links.push(index)
        stub.others.push(direction === 'out' ? { component: link.toComponentIndex, port: String(link.toPortName) } : { component: link.fromComponentIndex, port: String(link.fromPortName) })
        stubsByKey.set(key, stub)
      }
    }
  }
  // A stop over alike ports sits at the first of them by name and names its far ends by label, then port:
  // never by the order the Plant happens to list its equipment in.
  const farLabel = (other: { readonly component: number }): string => shortLabelOf(graph, other.component)
  return [...stubsByKey.values()]
    .map(stub => ({
      ...stub,
      port: stub.links.map(index => String(stub.direction === 'out' ? graph.links[index]!.fromPortName : graph.links[index]!.toPortName)).sort()[0]!,
      links: sorted(stub.links),
      others: [...stub.others].sort((left, right) => farLabel(left).localeCompare(farLabel(right)) || left.port.localeCompare(right.port) || left.component - right.component),
    }))
    .sort((left, right) => left.component - right.component || left.port.localeCompare(right.port) || left.direction.localeCompare(right.direction))
}
