import type { CompiledComponent, CompiledPlantGraph } from '../graph/index.ts'
import { SUGGESTION_COUNT, normalized } from '../../../core/model/text-search.ts'
import { componentDescription, equipmentSuggestions } from './items.ts'

// Equipment as people name it in a drawing's intent: by its id, a tag
// measured on it, its label or short label, or alike items in the plural; a
// device the model bundles inside a component is answered with its host. The
// words of every refusal are the Plant's (plan v3.1: name resolution stays
// with the Plant until the swap).

// The label of one of several alike items, without the letter or number that
// tells them apart: "Safety Bus A" → "Safety Bus".
export const groupStem = (label: string): string | undefined => {
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
export const resolveName = (
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
