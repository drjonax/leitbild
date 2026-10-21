import type { CompiledComponent, CompiledPlantGraph } from '../../graph/index.ts'
import { words } from '../../../../core/model/text-search.ts'
import { groupStem } from '../../equipment/names.ts'
import type { ScopedStub } from '../../../../features/displays/topology/scope.ts'

// What the old mimic writes where a drawing stops and where a lone pipe
// enters a hub: the Plant's words for its ports and far ends, until the swap
// hands stop words to World's renderer.

const shortLabelOf = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  return component.metadata?.presentation?.shortLabel ?? component.label
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
export const stubText = (graph: CompiledPlantGraph, stub: Pick<ScopedStub, 'direction' | 'others'>, style: 'names' | 'groups' = 'names'): string => {
  const byComponent = new Map<number, string[]>()
  for (const other of stub.others) {
    const component = graph.componentIndexById.get(other.node as never)!
    byComponent.set(component, [...(byComponent.get(component) ?? []), other.port])
  }
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
