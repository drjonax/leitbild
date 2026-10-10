import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink } from '../../graph/index.ts'
import { carriersAt, downstreamLinks, linkCarrier, routeLinks, upstreamLinks } from '../../graph/index.ts'
import { SUGGESTION_COUNT, letters, matchedWords, normalized, words } from '../name-matching.ts'

// What a mimic draws, resolved from the agent's intent in plant terms. The
// scope comes from the static Plant graph alone (never from live values), so
// the same intent on the same model always draws the same equipment.

export interface MimicIntent {
  readonly from?: ReadonlyArray<string> | undefined
  readonly to?: ReadonlyArray<string> | undefined
  /** What feeds these items and where their outflow goes, by every service they carry unless `services` narrows it. */
  readonly around?: ReadonlyArray<string> | undefined
  readonly services?: ReadonlyArray<string> | undefined
  readonly loops?: ReadonlyArray<string> | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
  /** Links a one-ended or around intent follows; MIMIC_REACH_LINKS unless a display narrows it to fit. */
  readonly reach?: number | undefined
}

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

/** "sgB (Steam Generator B, SG B)". */
export const componentDescription = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  const short = component.metadata?.presentation?.shortLabel
  return `${component.id} (${component.label}${short === undefined ? '' : `, ${short}`})`
}

const loopOf = (graph: CompiledPlantGraph, link: CompiledProcessLink): string | undefined =>
  link.metadata?.loopId
    ?? graph.components[link.fromComponentIndex]!.metadata?.loopId
    ?? graph.components[link.toComponentIndex]!.metadata?.loopId

// The label of one of several alike items, without the letter or number that
// tells them apart: "Safety Bus A" → "Safety Bus".
const groupStem = (label: string): string | undefined => {
  const parts = label.trim().split(/\s+/)
  return parts.length > 1 && /^([A-Za-z]|\d+)$/.test(parts.at(-1)!) ? parts.slice(0, -1).join(' ') : undefined
}

/** Components whose label or short label, without its designator, normalizes to one of these. */
const groupMembers = (graph: CompiledPlantGraph, stems: ReadonlyArray<string>): ReadonlyArray<number> => graph.components
  .filter(component => [component.label, component.metadata?.presentation?.shortLabel]
    .some(label => label !== undefined && stems.includes(normalized(groupStem(label) ?? ''))))
  .map(component => component.index)

type ResolvedName = { readonly components: ReadonlyArray<number>; readonly via: 'id' | 'tag' | 'label' | 'group' }

// What equipment is called: its label, its short label, and its label with
// the designator its short label carries where the label has none ("Motor-
// Driven Auxiliary Feedwater Pump A" for the pump whose short label is
// "MD AFW A"): operators qualify the long name with the letter they know.
const namesOf = (component: CompiledComponent): ReadonlyArray<string> => {
  const label = component.label
  const short = component.metadata?.presentation?.shortLabel
  const designator = short === undefined || groupStem(short) === undefined ? undefined : short.trim().split(/\s+/).at(-1)!
  const qualified = designator === undefined || groupStem(label) !== undefined ? [] : [`${label} ${designator}`]
  return [label, ...(short === undefined ? [] : [short]), ...qualified]
}

// A name is a component id, a tag measured on equipment (its owner), or one
// of its names (namesOf), ignoring case, spaces and hyphens ("safety bus A",
// "SG-B"). The plural of what alike items' labels share names all of them
// ("safety buses", "steam generators"). A tag on a pipe names the pipe's end
// that the role points at: what a route starts from, or what it reaches.
const resolveName = (
  graph: CompiledPlantGraph,
  name: string,
  role: 'from' | 'to' | 'around' | 'exclude',
): ResolvedName | { readonly error: string; readonly didYouMean: ReadonlyArray<string> } => {
  const byId = graph.componentIndexById.get(name as never)
  if (byId !== undefined) return { components: [byId], via: 'id' }
  const binding = graph.signalBindingByTagId.get(name as never)
  if (binding !== undefined) {
    if (binding.owner.type === 'component') return { components: [binding.owner.componentIndex], via: 'tag' }
    const link = graph.links[binding.owner.linkIndex]!
    if (role === 'exclude') return { error: `${name} is measured on the pipe ${link.id}; exclude equipment, not a pipe`, didYouMean: [] }
    // A pipe's tag names the end the role points at; around a pipe means around what it feeds.
    return { components: [role === 'from' ? link.fromComponentIndex : link.toComponentIndex], via: 'tag' }
  }
  const wanted = normalized(name)
  const byLabel = graph.components.filter(component => namesOf(component).some(label => normalized(label) === wanted))
  if (byLabel.length === 1) return { components: [byLabel[0]!.index], via: 'label' }
  if (byLabel.length > 1) return { error: `"${name}" names ${byLabel.length} components; name one by its id`, didYouMean: byLabel.slice(0, SUGGESTION_COUNT).map(component => componentDescription(graph, component.index)) }
  const plural = groupMembers(graph, [wanted.replace(/ES$/, ''), wanted.replace(/S$/, '')].filter(stem => stem !== wanted))
  if (plural.length > 1) return { components: plural, via: 'group' }
  const singular = groupMembers(graph, [wanted])
  if (singular.length > 1) return { error: `"${name}" fits ${singular.length} components; name one, or all of them in the plural`, didYouMean: singular.slice(0, SUGGESTION_COUNT).map(index => componentDescription(graph, index)) }
  const bundled = bundledDevices(graph, wanted)
  if (bundled.length > 0) return { error: bundledDeviceMessage(graph, name, bundled, role), didYouMean: [...new Set(bundled.map(entry => componentDescription(graph, entry.host)))].slice(0, SUGGESTION_COUNT) }
  return { error: `unknown equipment "${name}"; name one component per entry: its id, a tag measured on it, its label or its short label`, didYouMean: equipmentSuggestions(graph, name) }
}

/** Equipment by one name, as a mimic resolves it (resolveName): the components it names, or why it names none. */
export const resolveEquipmentName = (graph: CompiledPlantGraph, name: string): ReturnType<typeof resolveName> => resolveName(graph, name, 'around')

// A device the model bundles inside a component (a pressurizer's relief valve)
// has a label of its own but is not a component: it is drawn on its host's
// line, so a name for it is answered with the host and that line's ends.
const bundledDevices = (graph: CompiledPlantGraph, wanted: string): ReadonlyArray<{ readonly host: number; readonly device: string }> =>
  graph.components.flatMap(component => Object.entries(component.metadata?.presentation?.embedded ?? {})
    .filter(([, label]) => normalized(label) === wanted)
    .map(([device]) => ({ host: component.index, device })))

const bundledDeviceMessage = (graph: CompiledPlantGraph, name: string, bundled: ReadonlyArray<{ readonly host: number; readonly device: string }>, role: 'from' | 'to' | 'around' | 'exclude'): string => {
  if (new Set(bundled.map(entry => entry.host)).size > 1) {
    return `"${name}" names devices the model bundles in ${[...new Set(bundled.map(entry => String(graph.components[entry.host]!.id)))].join(', ')}; name the component that holds the one you mean`
  }
  const { host, device } = bundled[0]!
  const component = graph.components[host]!
  const port = component.semantics.embedded.find(candidate => candidate.id === device)?.port
  const hostId = String(component.id)
  const what = `"${name}" is the ${device} the model bundles in ${hostId}${port === undefined ? '' : `, drawn on its ${String(port)} line`}`
  if (role === 'exclude') return `${what}; it cannot be excluded on its own`
  if (port === undefined) return `${what}; name ${hostId} instead`
  const farIds = (indexes: ReadonlyArray<number> | undefined, side: 'from' | 'to') => [...new Set((indexes ?? [])
    .map(index => graph.links[index]!)
    .filter(link => String(side === 'to' ? link.fromPortName : link.toPortName) === String(port))
    .map(link => String(graph.components[side === 'to' ? link.toComponentIndex : link.fromComponentIndex]!.id)))].sort()
  const downstream = farIds(graph.outgoingLinksByComponent[host], 'to')
  const upstream = farIds(graph.incomingLinksByComponent[host], 'from')
  const line = downstream.length > 0 ? `from ${hostId} to ${downstream.join(', ')}` : upstream.length > 0 ? `from ${upstream.join(', ')} to ${hostId}` : undefined
  return `${what}; name ${hostId} instead${line === undefined ? '' : ` (${line} draws that line with it)`}`
}

// Links a mimic can draw: pipes and power. Equipment with none (a spare valve,
// a breaker the model leaves unwired) has nothing to draw.
const unconnectedReason = (graph: CompiledPlantGraph, index: number, carriers: ReadonlyArray<string>): string | undefined => {
  const linked = [...(graph.incomingLinksByComponent[index] ?? []), ...(graph.outgoingLinksByComponent[index] ?? [])].map(link => graph.links[link]!)
  if (linked.some(link => carriers.includes(linkCarrier(link)))) return undefined
  const id = String(graph.components[index]!.id)
  if (linked.length === 0) return `${id} is not connected to any equipment in the Plant model, so it cannot be drawn`
  return `${id} is connected to other equipment only by ${[...new Set(linked.map(link => link.kind))].sort().join(', ')} links, which a mimic does not draw`
}

/** Components whose id, label, short label or tags match the guessed words best. */
export const equipmentSuggestions = (graph: CompiledPlantGraph, guess: string): ReadonlyArray<string> => {
  const guessed = words(guess)
  if (guessed.length === 0) return []
  const tagsByComponent = new Map<number, string[]>()
  for (const binding of graph.signalBindings) {
    if (binding.tagId === undefined || binding.owner.type !== 'component') continue
    tagsByComponent.set(binding.owner.componentIndex, [...(tagsByComponent.get(binding.owner.componentIndex) ?? []), String(binding.tagId)])
  }
  return graph.components
    .map(component => {
      const keys = [String(component.id), component.label, component.metadata?.presentation?.shortLabel ?? '', ...(tagsByComponent.get(component.index) ?? [])]
      const matched = matchedWords(guessed, [...new Set(keys.flatMap(words))])
      return { component, score: letters(matched) / letters(guessed), substantive: matched.some(word => word.length >= 2) }
    })
    .filter(entry => entry.substantive && entry.score >= 0.5)
    .sort((left, right) => right.score - left.score || String(left.component.id).localeCompare(String(right.component.id)))
    .slice(0, SUGGESTION_COUNT)
    .map(entry => {
      const tags = (tagsByComponent.get(entry.component.index) ?? []).slice(0, 2)
      return `${componentDescription(graph, entry.component.index)}${tags.length === 0 ? '' : `; tags ${tags.join(', ')}`}`
    })
}

/** The carriers of this Plant: its fluid services and its power and signal link kinds. */
export const plantCarriers = (graph: CompiledPlantGraph): ReadonlyArray<string> =>
  [...new Set(graph.links.filter(link => link.kind === 'fluidFlow' || link.kind === 'electricalPower').map(linkCarrier))].sort()

export const plantLoops = (graph: CompiledPlantGraph): ReadonlyArray<string> =>
  [...new Set(graph.components.map(component => component.metadata?.loopId).filter((loop): loop is string => loop !== undefined))]
    .sort((left, right) => {
      const ordinal = (loop: string) => graph.components.find(component => component.metadata?.loopId === loop)?.metadata?.ordinal ?? 0
      return ordinal(left) - ordinal(right) || left.localeCompare(right)
    })

// "AFW" for auxFeedwater: the guess's letters, in order, from the same first letter; or a shared word.
export const serviceResembles = (guess: string, candidate: string): boolean => {
  const letters_ = guess.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = candidate.toLowerCase()
  let at = 0
  for (const letter of target) if (letter === letters_[at]) at += 1
  return (letters_.length >= 2 && letters_[0] === target[0] && at === letters_.length) || matchedWords(words(guess), words(candidate)).length > 0
}

const sorted = (indexes: Iterable<number>): ReadonlyArray<number> => [...new Set(indexes)].sort((left, right) => left - right)

export const resolveMimicScope = (graph: CompiledPlantGraph, intent: MimicIntent): MimicScopeResult => {
  const issues: Array<{ readonly field: string; readonly message: string; readonly didYouMean?: ReadonlyArray<string> }> = []
  const names: Array<MimicScope['names'][number]> = []
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
  // Around an item, every service it carries: its fluid on both sides and its power supply.
  const carriers: ReadonlySet<string> = intent.services !== undefined ? new Set(intent.services)
    : around.length > 0 ? new Set([...delivered(around), ...received(around)])
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
  return { ok: true, scope: { components, links, stubs, carriers: [...carriers].sort(), names } }
}

/**
 * The services items carry, the ones they do their work in first: those on a
 * port circuit their energy role names (a core's coolant), then by how many
 * of their links each takes. What a drawing narrowed to one service starts
 * with, since every service at once may not draw legibly.
 */
export const itemServices = (graph: CompiledPlantGraph, items: ReadonlyArray<number>): ReadonlyArray<string> => {
  const known = new Set(plantCarriers(graph))
  const tally = new Map<string, { links: number; energy: boolean }>()
  for (const item of items) {
    const component = graph.components[item]!
    const circuits = new Set(component.semantics.energy.flatMap(role => role.role === 'transfer' ? [role.from, role.to] : [role.circuit]))
    for (const [side, indexes] of [['from', graph.outgoingLinksByComponent[item]], ['to', graph.incomingLinksByComponent[item]]] as const) {
      for (const index of indexes ?? []) {
        const link = graph.links[index]!
        const carrier = linkCarrier(link)
        if (!known.has(carrier)) continue
        const circuit = component.ports[String(side === 'from' ? link.fromPortName : link.toPortName)]?.circuit
        const entry = tally.get(carrier) ?? { links: 0, energy: false }
        tally.set(carrier, { links: entry.links + 1, energy: entry.energy || (circuit !== undefined && circuits.has(circuit)) })
      }
    }
  }
  return [...tally].sort(([leftName, left], [rightName, right]) => Number(right.energy) - Number(left.energy) || right.links - left.links || leftName.localeCompare(rightName)).map(([name]) => name)
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

const STUB_NAMES = 3

/** "cold leg A" for a port named coldLegA. */
export const portName = (port: string): string => words(port).map(word => word.length === 1 ? word.toUpperCase() : word).join(' ')

// Ports are named only where a component has several alike: connected, of the
// same circuit and direction (the core's four cold legs; a 4-loop Plant leaves
// its cold legs E and F unconnected).
const alikePorts = (graph: CompiledPlantGraph, component: CompiledComponent, port: string): ReadonlyArray<string> => {
  const first = component.ports[port]
  const connected = (name: string) => graph.links.some(link =>
    (link.fromComponentIndex === component.index && String(link.fromPortName) === name) || (link.toComponentIndex === component.index && String(link.toPortName) === name))
  return Object.entries(component.ports)
    .filter(([name, other]) => other.circuit !== undefined && other.circuit === first?.circuit && other.direction === first.direction && connected(name))
    .map(([name]) => name)
}

/**
 * The one port a lone pipe reaches on a hub of alike ports where nothing is
 * drawn at the others ("cold leg C" of the core's four), so the display can
 * say where the pipe enters. Null otherwise: a port with no alike, alike ports all
 * piped or stubbed (a stub names its own), or several reached, where the
 * equipment drawn on them tells them apart (SG A, RCP A).
 */
export const loneReachedPort = (graph: CompiledPlantGraph, component: CompiledComponent, piped: ReadonlySet<string>, shown: ReadonlySet<string>): string | null => {
  const named = [...piped].filter(port => {
    const alike = alikePorts(graph, component, port)
    return alike.length > 1 && alike.some(other => !shown.has(other))
  })
  return named.length === 1 ? portName(named[0]!) : null
}

/**
 * What a stub says of its far ends. `names` lists them: "to SG A, SG C, SG D",
 * "to Core cold leg A, cold leg B" where one far component has several such
 * ports. `groups` names alike far ends once by the label they share without
 * their designator, with how many: "from ACC ×4, CHG ×2, SI header"; a lone
 * far end keeps its full name ("from AFW valve A"). A list of names too long
 * to read is grouped too, and what still does not fit is counted ("and 2 more").
 */
export const stubText = (graph: CompiledPlantGraph, stub: MimicStub, style: 'names' | 'groups' = 'names'): string => {
  const byComponent = new Map<number, string[]>()
  for (const other of stub.others) byComponent.set(other.component, [...(byComponent.get(other.component) ?? []), other.port])
  const parts = [...byComponent].map(([component, ports]) => {
    const label = shortLabelOf(graph, component)
    return { label, named: alikePorts(graph, graph.components[component]!, ports[0]!).length > 1 ? `${label} ${ports.map(portName).join(', ')}` : label }
  })
  const verb = stub.direction === 'out' ? 'to' : 'from'
  const listed = (names: ReadonlyArray<string>): string => {
    const named = names.slice(0, names.length > STUB_NAMES + 1 ? STUB_NAMES : STUB_NAMES + 1)
    const more = names.length - named.length
    return `${verb} ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  }
  if (parts.length === 1) return `${verb} ${parts[0]!.named}`
  if (style === 'names' && parts.length <= STUB_NAMES + 1) return listed(parts.map(part => part.named))
  const groups = new Map<string, number>()
  for (const part of parts) {
    const key = groupStem(part.label) ?? part.label
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return listed([...groups].map(([key, count]) => (count > 1 ? `${key} ×${count}` : parts.find(part => (groupStem(part.label) ?? part.label) === key)!.label)))
}
