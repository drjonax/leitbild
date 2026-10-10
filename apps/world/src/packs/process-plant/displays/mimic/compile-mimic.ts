import type { CompiledComponent, CompiledPlantGraph, CompiledProcessLink, VariablePath } from '../../graph/index.ts'
import { linkCarrier } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { unitLabel } from '../display-text.ts'
import { framingRules, itemBinding, linkFlowBinding, linkPowerBinding, type MimicItem, type MimicItemBinding } from './bindings.ts'
import { layoutDiagram, type DiagramEdge, type DiagramGraph, type DiagramLayoutResult, type DiagramNode, type DiagramProfile, type PlacedNode } from './layout/index.ts'
import { MIMIC_LAYOUT_VERSION, type CompiledMimic, type MimicDrawnItem, type MimicPipeState } from './mimic-model.ts'
import { embeddedPresentation, presentationFor, type MimicPresentation } from './presentation.ts'
import type { MimicProfile } from './profiles.ts'
import { COUNT_WORDS, itemRows, type MimicRow } from './rows.ts'
import { MIMIC_REACH_LINKS, loneReachedPort, resolveMimicScope, stubText, plantLoops, type MimicIntent, type MimicScope, type MimicStub } from './scope.ts'
import { openBridgeDevice, readoutBlockWidth, smallStateRowWidth, smallValueRowWidth, textWidth, unmeasurable, type OpenBridgeTextStyle } from './text-metrics.ts'

// Intent (or a scope World resolved itself) → items with their bindings → a
// diagram sized in OpenBridge px → the layout engine → a compiled mimic.
// Every step reads the Plant's declared semantics; no step knows the
// reference model. The profile decides how much each item says: readout
// size, valves as markers, parallel equipment as one symbol.

/** The profile a display draws by, and the room it leaves the drawing. */
export interface MimicBudget {
  readonly profile: MimicProfile
  readonly maxWidth: number
  readonly maxHeight: number
}

export interface MimicIssue {
  readonly field: string
  readonly message: string
  readonly didYouMean?: ReadonlyArray<string>
}

export type MimicCompileResult =
  | { readonly ok: true; readonly mimic: CompiledMimic }
  | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> }

/** The HMI rules the layout enforces: the display's profile in the room it leaves. */
const profileFor = (budget: MimicBudget): DiagramProfile => ({ ...budget.profile.layout, maxWidth: budget.maxWidth, maxHeight: budget.maxHeight })

interface PlannedItem {
  readonly id: string
  readonly item: MimicItem
  readonly binding: MimicItemBinding
  readonly presentation: MimicPresentation
  readonly rows: ReadonlyArray<MimicRow>
  readonly marker: boolean
  readonly role: DiagramNode['role']
  readonly rank: string
  readonly lane?: DiagramNode['lane']
  /** The Plant components it stands for: a group's members, or a bundled device's host. */
  readonly components: ReadonlyArray<number>
}

const laneOf = (component: CompiledComponent, orders: ReadonlyMap<string, number>): DiagramNode['lane'] | undefined => {
  const key = component.metadata?.loopId
  return key === undefined || !orders.has(key) ? undefined : { key, order: orders.get(key)! }
}

const valueRowWidth = (unit: string, fractionDigits: number): number =>
  readoutBlockWidth(3, fractionDigits) + (unitLabel(unit) === '' ? 0 : textWidth('unit', unitLabel(unit))) + openBridgeDevice.valueRowPadding

const stateRowWidth = (texts: ReadonlyArray<string>): number =>
  Math.max(...texts.map(text => textWidth('stateRow', text))) + openBridgeDevice.stateRowPadding

/** The texts a row may show, besides its values: what must be measurable. */
const rowWords = (row: MimicRow): ReadonlyArray<string> =>
  row.kind === 'value' ? [] : row.kind === 'position' ? ['POS ?'] : row.texts

// Vessels use our stack of readout blocks (one decimal); devices OpenBridge's
// readout stack at the profile's size: small (11.5 px) or regular (16 px).
const rowSize = (row: MimicRow, device: boolean, readoutSize: MimicProfile['readoutSize']): { readonly width: number; readonly height: number } => {
  if (!device || readoutSize === 'regular') {
    const digits = device ? 0 : 1
    if (row.kind === 'value') return { width: valueRowWidth(row.unit, digits), height: openBridgeDevice.row }
    if (row.kind === 'position') return { width: Math.max(valueRowWidth('fraction', digits), stateRowWidth(['POS ?'])), height: openBridgeDevice.row }
    return { width: stateRowWidth(rowWords(row)), height: openBridgeDevice.row }
  }
  if (row.kind === 'value') return { width: smallValueRowWidth(unitLabel(row.unit)), height: openBridgeDevice.smallValueRow }
  if (row.kind === 'position') return { width: Math.max(smallValueRowWidth('%'), smallStateRowWidth('POS ?')), height: openBridgeDevice.smallValueRow }
  return { width: Math.max(...rowWords(row).map(smallStateRowWidth)), height: openBridgeDevice.smallStateRow }
}

const rowTexts = (row: MimicRow): ReadonlyArray<{ readonly style: OpenBridgeTextStyle; readonly text: string }> =>
  row.kind === 'value' ? [{ style: 'unit', text: unitLabel(row.unit) }] : rowWords(row).map(text => ({ style: 'stateRow' as const, text }))

const isDevice = (presentation: MimicPresentation): boolean => presentation.element === 'device'
const isVessel = (presentation: MimicPresentation): boolean => presentation.element === 'tank' || presentation.element === 'heat-exchanger'
const isValve = (presentation: MimicPresentation): boolean =>
  presentation.element === 'device' && (presentation.icon === 'valve-analog' || presentation.icon === 'valve-digital' || presentation.icon === 'valve-check')

const aspectFor = (presentation: MimicPresentation) =>
  presentation.element === 'device' || presentation.element === 'bar' ? presentation.aspect
    : presentation.element === 'tank' || presentation.element === 'heat-exchanger' ? presentation.aspect
      : null

// A vessel loops return to (the reactor) is a hub: it takes links from two or
// more drawn loops on both sides, or a drawn loop leaves it and returns to it.
// Drawn beside the lanes, each loop's return run reaches its side face.
const isHub = (graph: CompiledPlantGraph, component: CompiledComponent, drawnLinks: ReadonlySet<number>): boolean => {
  const loopsOf = (indexes: ReadonlyArray<number> | undefined, side: 'from' | 'to') => new Set((indexes ?? [])
    .filter(index => drawnLinks.has(index))
    .map(index => graph.components[side === 'from' ? graph.links[index]!.fromComponentIndex : graph.links[index]!.toComponentIndex]!.metadata?.loopId)
    .filter((loop): loop is string => loop !== undefined))
  const returning = loopsOf(graph.incomingLinksByComponent[component.index], 'from')
  const leaving = loopsOf(graph.outgoingLinksByComponent[component.index], 'to')
  return component.metadata?.loopId === undefined
    && ((returning.size >= 2 && leaving.size >= 2) || [...returning].some(loop => leaving.has(loop)))
}

const portDirection = (component: CompiledComponent, port: string): 'in' | 'out' | 'both' => {
  const direction = component.ports[port]?.direction
  return direction === 'bidirectional' ? 'both' : direction === 'out' ? 'out' : 'in'
}

/**
 * "MFW A/B" for MFW A and MFW B: the words their labels share in front, then
 * what tells each apart; labels sharing no leading word are joined whole.
 */
export const groupLabel = (labels: ReadonlyArray<string>): string => {
  const split = labels.map(label => label.split(' '))
  let shared = 0
  while (split.every(words => words.length > shared + 1 && words[shared] === split[0]![shared])) shared += 1
  return shared === 0 ? labels.join('/') : `${split[0]!.slice(0, shared).join(' ')} ${split.map(words => words.slice(shared).join(' ')).join('/')}`
}

interface Planned {
  readonly graph: DiagramGraph
  readonly items: ReadonlyMap<string, PlannedItem>
  /** Per edge, the Plant link it draws and the links of grouped members it stands for too. */
  readonly edgeLinks: ReadonlyMap<string, { readonly link: number; readonly parallel: ReadonlyArray<number> }>
  readonly stubs: ReadonlyMap<string, MimicStub>
  readonly issues: ReadonlyArray<MimicIssue>
}

const plan = (plant: CompiledProcessPlant, scope: MimicScope, profile: MimicProfile): Planned => {
  const graph = plant.graph
  const framed = framingRules(plant)
  const issues: MimicIssue[] = []
  const loopOrder = new Map(plantLoops(graph).map((loop, order) => [loop, order]))
  const drawnLinks = new Set(scope.links)

  // Equipment the mimic cannot draw ends the drawing like any other stop.
  const notDrawn = new Set(scope.components.filter(index => presentationFor(graph.components[index]!).element === 'not-drawn'))
  const links = scope.links.filter(index => !notDrawn.has(graph.links[index]!.fromComponentIndex) && !notDrawn.has(graph.links[index]!.toComponentIndex))
  const extraStubs: MimicStub[] = scope.links.flatMap((index): MimicStub[] => {
    const link = graph.links[index]!
    if (notDrawn.has(link.toComponentIndex) && !notDrawn.has(link.fromComponentIndex)) return [{ component: link.fromComponentIndex, port: String(link.fromPortName), direction: 'out' as const, links: [index], others: [{ component: link.toComponentIndex, port: String(link.toPortName) }] }]
    if (notDrawn.has(link.fromComponentIndex) && !notDrawn.has(link.toComponentIndex)) return [{ component: link.toComponentIndex, port: String(link.toPortName), direction: 'in' as const, links: [index], others: [{ component: link.fromComponentIndex, port: String(link.fromPortName) }] }]
    return []
  })
  const farLabel = (component: number): string => graph.components[component]!.metadata?.presentation?.shortLabel ?? graph.components[component]!.label
  const scopeStubs = [...scope.stubs, ...extraStubs]

  const items = new Map<string, PlannedItem>()
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const edgeLinks = new Map<string, { link: number; parallel: number[] }>()
  const stubs = new Map<string, MimicStub>()
  const componentRank = new Map<number, string>()

  const measure = (style: OpenBridgeTextStyle, text: string, owner: string): number => {
    const missing = unmeasurable(style, text)
    if (missing.length > 0) {
      issues.push({ field: '(mimic)', message: `${owner}: "${text}" uses characters the drawing cannot measure (${missing.join('')})` })
      return 0
    }
    return textWidth(style, text)
  }

  const addItem = (planned: PlannedItem, ports: DiagramNode['ports']): void => {
    items.set(planned.id, planned)
    const presentation = planned.presentation
    const vessel = isVessel(presentation) || planned.role === 'hub'
    for (const row of planned.rows) for (const { style, text } of rowTexts(row)) measure(style, text, planned.binding.label)
    const flaps = planned.binding.frames.map(frame => measure('alertLabel', frame.flap, planned.binding.label))
    const tag = measure('tag', planned.binding.label, planned.binding.label)
    nodes.push({
      id: planned.id,
      rank: planned.rank,
      role: planned.role,
      cells: vessel ? { width: 2, height: 4 } : { width: 2, height: 2 },
      portInset: vessel ? openBridgeDevice.vessel.inset : 0,
      ports,
      ...(planned.lane === undefined ? {} : { lane: planned.lane }),
      text: {
        lines: [
          // A marker carries no tag: its place on the circuit names it.
          ...(planned.marker ? [] : [{ width: tag, height: openBridgeDevice.tagLine, required: true }]),
          ...planned.rows.map(row => ({ ...rowSize(row, isDevice(presentation), profile.readoutSize), required: row.required })),
        ],
      },
      frameable: planned.binding.frames.length > 0,
      ...(flaps.length === 0 ? {} : { flapWidth: Math.max(...flaps) }),
    })
  }

  // Ports each drawn component uses, from its drawn links and stubs.
  const usedPorts = new Map<number, Set<string>>()
  const usePort = (component: number, port: string) => usedPorts.set(component, new Set([...(usedPorts.get(component) ?? []), port]))
  for (const index of links) {
    usePort(graph.links[index]!.fromComponentIndex, String(graph.links[index]!.fromPortName))
    usePort(graph.links[index]!.toComponentIndex, String(graph.links[index]!.toPortName))
  }
  // Ports drawn pipes reach, before stubs: a hub a lone pipe reaches at one of its alike ports names it.
  const piped = new Map([...usedPorts].map(([component, ports]) => [component, new Set(ports)]))
  for (const stub of scopeStubs) usePort(stub.component, stub.port)

  const drawn = scope.components.filter(index => !notDrawn.has(index))
  const presentations = new Map(drawn.map(index => [index, presentationFor(graph.components[index]!)]))
  const hubs = new Set(drawn.filter(index => presentations.get(index)!.element !== 'bar' && isHub(graph, graph.components[index]!, drawnLinks)))
  const labelOf = (component: number) => itemBinding(plant, { kind: 'component', component }, aspectFor(presentations.get(component)!), framed).label

  // Parallel equipment the profile groups: same kind, presentation, loop and
  // ports, and on each port the same far ends (alike ports of a header count
  // as one) and the same stops. Members are ordered by label.
  const representative = new Map<number, number>()
  const members = new Map<number, ReadonlyArray<number>>()
  if (profile.parallel === 'grouped') {
    const farKey = (component: number, port: string): string => {
      const far = graph.components[component]!
      return presentations.get(component)?.element === 'bar' ? `${far.index}|${far.ports[port]?.circuit ?? port}` : `${far.index}|${port}`
    }
    const signature = (index: number): string | null => {
      const component = graph.components[index]!
      const presentation = presentations.get(index)!
      const aspect = aspectFor(presentation)
      if (presentation.element === 'bar' || hubs.has(index) || aspect === null || COUNT_WORDS[aspect] === undefined) return null
      const ports = [...(usedPorts.get(index) ?? [])].sort()
      if (component.semantics.embedded.some(device => ports.includes(String(device.port)))) return null
      const sides = ports.map(port => {
        const out = links.filter(link => graph.links[link]!.fromComponentIndex === index && String(graph.links[link]!.fromPortName) === port)
          .map(link => graph.links[link]!).map(link => farKey(link.toComponentIndex, String(link.toPortName)))
        const into = links.filter(link => graph.links[link]!.toComponentIndex === index && String(graph.links[link]!.toPortName) === port)
          .map(link => graph.links[link]!).map(link => farKey(link.fromComponentIndex, String(link.fromPortName)))
        const embeddedFar = links.some(link => {
          const at = graph.links[link]!
          const far = at.fromComponentIndex === index ? graph.components[at.toComponentIndex]! : at.toComponentIndex === index ? graph.components[at.fromComponentIndex]! : null
          const farPort = at.fromComponentIndex === index ? String(at.toPortName) : String(at.fromPortName)
          return far !== null && (at.fromComponentIndex === index || at.toComponentIndex === index) && far.semantics.embedded.some(device => String(device.port) === farPort)
        })
        if (embeddedFar) return null
        const stops = scopeStubs.filter(stub => stub.component === index && stub.port === port)
          .map(stub => `${stub.direction}:${stub.others.map(other => `${other.component}|${other.port}`).join(',')}`)
        return [port, [...new Set(out)].sort(), [...new Set(into)].sort(), stops.sort()]
      })
      if (sides.some(side => side === null)) return null
      return JSON.stringify([component.kind, presentation, component.metadata?.loopId ?? null, sides])
    }
    const bySignature = new Map<string, number[]>()
    for (const index of drawn) {
      const key = signature(index)
      if (key !== null) bySignature.set(key, [...(bySignature.get(key) ?? []), index])
    }
    for (const group of bySignature.values()) {
      if (group.length < 2) continue
      const ordered = [...group].sort((a, b) => labelOf(a).localeCompare(labelOf(b)) || a - b)
      for (const index of ordered) representative.set(index, ordered[0]!)
      members.set(ordered[0]!, ordered)
    }
  }
  const nodeOf = (component: number): string => `c${representative.get(component) ?? component}`

  for (const index of drawn) {
    if ((representative.get(index) ?? index) !== index) continue
    const component = graph.components[index]!
    const presentation = presentations.get(index)!
    const role: DiagramNode['role'] = presentation.element === 'bar' ? 'bar' : hubs.has(index) ? 'hub' : 'device'
    const group = members.get(index) ?? [index]
    const bindings = group.map(member => itemBinding(plant, { kind: 'component', component: member }, aspectFor(presentation), framed))
    // A group's own state is its members' (rows.ts drawnLook); it shows no member's values.
    // A header's ports are only where branches join; its stubs name the rest.
    const reached = group.length === 1 && presentation.element !== 'bar' ? loneReachedPort(graph, component, piped.get(index) ?? new Set(), usedPorts.get(index) ?? new Set()) : null
    const binding: MimicItemBinding = group.length === 1 ? (reached === null ? bindings[0]! : { ...bindings[0]!, label: `${bindings[0]!.label} · ${reached}` }) : {
      item: bindings[0]!.item,
      label: groupLabel(bindings.map(member => member.label)),
      state: null,
      values: [],
      limits: [],
      frames: bindings.flatMap(member => member.frames),
    }
    const marker = profile.valves === 'markers' && isValve(presentation) && group.length === 1
    const ports = [...(usedPorts.get(index) ?? [])].sort()
    const rank = [role, component.kind, component.metadata?.equipmentClass ?? '', component.metadata?.role ?? '', ports.join(','), binding.label].join('|')
    for (const member of group) componentRank.set(member, rank)
    const lane = laneOf(component, loopOrder)
    addItem(
      { id: nodeOf(index), item: { kind: 'component', component: index }, binding, presentation, rows: itemRows(group.length === 1 ? binding : bindings[0]!, presentation, { marker, members: group.length === 1 ? [] : bindings, commands: profile.commands }), marker, role, rank, ...(lane === undefined ? {} : { lane }), components: group },
      ports.map(port => ({ id: port, direction: portDirection(component, port), rank: port })),
    )
  }

  // A drawn link becomes a chain of edges through the devices its host bundles
  // on that port. Links of grouped members that join the same two drawn ends
  // (alike header ports counting as one) are one pipe, drawn as the link of
  // the member first by label, whatever order the Plant lists them in.
  const drawnEnds = new Map<string, string>()
  const linkKey = (index: number): string => {
    const link = graph.links[index]!
    return `${farLabel(link.fromComponentIndex)}|${link.fromPortName}|${farLabel(link.toComponentIndex)}|${link.toPortName}`
  }
  for (const index of [...links].sort((a, b) => linkKey(a).localeCompare(linkKey(b)) || a - b)) {
    const link = graph.links[index]!
    const from = graph.components[link.fromComponentIndex]!
    const to = graph.components[link.toComponentIndex]!
    const endKey = (component: CompiledComponent, port: string) => presentations.get(component.index)?.element === 'bar' ? `${nodeOf(component.index)}|${component.ports[port]?.circuit ?? port}` : `${nodeOf(component.index)}|${port}`
    const ends = `${endKey(from, String(link.fromPortName))}>${endKey(to, String(link.toPortName))}`
    const grouped = representative.has(from.index) || representative.has(to.index)
    const known = grouped ? drawnEnds.get(ends) : undefined
    if (known !== undefined) {
      edgeLinks.get(known)!.parallel.push(index)
      continue
    }
    const devicesOn = (component: CompiledComponent, port: string) => component.semantics.embedded.filter(device => String(device.port) === port)
    const chain: Array<{ readonly node: string; readonly inPort: string; readonly outPort: string }> = [
      { node: nodeOf(from.index), inPort: '', outPort: String(link.fromPortName) },
      ...[...devicesOn(from, String(link.fromPortName)), ...devicesOn(to, String(link.toPortName))].map(device => {
        const host = devicesOn(from, String(link.fromPortName)).includes(device) ? from : to
        const id = `c${host.index}:${device.id}`
        if (!items.has(id)) {
          const presentation = embeddedPresentation(device)
          const binding = itemBinding(plant, { kind: 'device', component: host.index, device: device.id }, 'position', framed)
          const lane = laneOf(host, loopOrder)
          const marker = profile.valves === 'markers' && isValve(presentation)
          addItem(
            { id, item: { kind: 'device', component: host.index, device: device.id }, binding, presentation, rows: itemRows(binding, presentation, { marker, members: [], commands: profile.commands }), marker, role: 'device', rank: `${componentRank.get(host.index)}|${device.id}`, ...(lane === undefined ? {} : { lane }), components: [host.index] },
            [{ id: 'in', direction: 'in', rank: 'in' }, { id: 'out', direction: 'out', rank: 'out' }],
          )
        }
        return { node: id, inPort: 'in', outPort: 'out' }
      }),
      { node: nodeOf(to.index), inPort: String(link.toPortName), outPort: '' },
    ]
    chain.slice(1).forEach((step, at) => {
      const previous = chain[at]!
      const id = `l${index}.${at}`
      edgeLinks.set(id, { link: index, parallel: [] })
      if (at === 0 && grouped) drawnEnds.set(ends, id)
      edges.push({ id, rank: `${linkCarrier(link)}|${componentRank.get(from.index)}|${link.fromPortName}|${componentRank.get(to.index)}|${link.toPortName}|${at}`, from: { node: previous.node, port: previous.outPort }, to: { node: step.node, port: step.inPort } })
    })
  }

  // A grouped member's stops are its group's: one stub for all, carrying every member's links.
  const groupedStubs = scopeStubs.reduce((list, stub) => {
    const owner = representative.get(stub.component) ?? stub.component
    const same = list.find(other => other.component === owner && other.port === stub.port && other.direction === stub.direction)
    if (same === undefined) return [...list, { ...stub, component: owner }]
    return list.map(other => (other === same ? { ...other, links: [...other.links, ...stub.links] } : other))
  }, [] as MimicStub[])
  groupedStubs.forEach((stub, at) => {
    const id = `s${at}`
    const component = graph.components[stub.component]!
    stubs.set(id, stub)
    const text = stubText(graph, stub, profile.stubLabels)
    const lane = laneOf(component, loopOrder)
    nodes.push({
      id,
      rank: `stub|${componentRank.get(stub.component)}|${stub.port}|${stub.direction}`,
      role: 'stub',
      cells: { width: 1, height: 1 },
      portInset: 0,
      ports: [{ id: 'end', direction: stub.direction === 'out' ? 'in' : 'out', rank: 'end' }],
      ...(lane === undefined ? {} : { lane }),
      text: { lines: [{ width: measure('tag', text, text), height: openBridgeDevice.tagLine, required: true }] },
      frameable: false,
    })
    const edge = { id: `${id}.edge`, rank: `stub|${componentRank.get(stub.component)}|${stub.port}|${stub.direction}` }
    edgeLinks.set(edge.id, { link: stub.links[0]!, parallel: stub.links.slice(1) })
    edges.push(stub.direction === 'out'
      ? { ...edge, from: { node: nodeOf(stub.component), port: stub.port }, to: { node: id, port: 'end' } }
      : { ...edge, from: { node: id, port: 'end' }, to: { node: nodeOf(stub.component), port: stub.port } })
  })

  return { graph: { nodes, edges }, items, edgeLinks, stubs, issues }
}

const pipeState = (graph: CompiledPlantGraph, link: CompiledProcessLink, parallel: ReadonlyArray<number>): MimicPipeState =>
  link.kind === 'electricalPower'
    ? { kind: 'power', energizedPath: linkPowerBinding(graph, link.index).energizedPath }
    : { kind: 'fluid', flow: linkFlowBinding(graph, link.index), parallel: parallel.map(index => linkFlowBinding(graph, index)) }

const statePaths = (state: MimicPipeState): ReadonlyArray<VariablePath> =>
  state.kind === 'fluid' ? [state.flow.flowPath, ...state.parallel.map(flow => flow.flowPath)] : state.energizedPath === null ? [] : [state.energizedPath]

const orientationOf = (node: PlacedNode): 'horizontal' | 'vertical' =>
  Object.values(node.ports).some(port => port.face === 'left' || port.face === 'right') ? 'horizontal' : 'vertical'

const rowPaths = (row: MimicRow): ReadonlyArray<VariablePath> => {
  if (row.kind === 'value') return [row.path as VariablePath]
  if (row.kind !== 'count') return []
  return row.members.flatMap(member => [
    ...(member.state?.state === undefined ? [] : [member.state.state.path]),
    ...(member.state?.command === undefined ? [] : [member.state.command]),
    ...(member.state?.throughput === undefined ? [] : [member.state.throughput.path]),
  ])
}

const itemIdOf = (graph: CompiledPlantGraph, item: MimicItem): string =>
  item.kind === 'component' ? String(graph.components[item.component]!.id) : `${graph.components[item.component]!.id}.${item.device}`

const assemble = (plant: CompiledProcessPlant, intent: MimicIntent | null, profile: MimicProfile, scope: MimicScope, planned: Planned, layout: Extract<DiagramLayoutResult, { ok: true }>): CompiledMimic => {
  const graph = plant.graph
  const placed = new Map(layout.nodes.map(node => [node.id, node]))
  const items: MimicDrawnItem[] = [...planned.items.values()].map(item => {
    const node = placed.get(item.id)!
    // A stack's first line is the tag, except on a marker; the rows that fit follow it.
    const tagLines = item.marker ? 0 : 1
    return {
      id: item.id,
      binding: item.binding,
      presentation: item.presentation,
      box: { x: node.x, y: node.y, width: node.width, height: node.height },
      orientation: orientationOf(node),
      text: node.text,
      frame: node.frame,
      rows: item.rows.slice(0, Math.max(0, (node.text?.lines ?? tagLines) - tagLines)),
      marker: item.marker,
      components: item.components.map(component => String(graph.components[component]!.id)),
    }
  })
  const linkOf = (edgeId: string) => planned.edgeLinks.get(edgeId)!
  const pipes = layout.edges.filter(edge => !edge.id.startsWith('s')).map(edge => {
    const { link: index, parallel } = linkOf(edge.id)
    const link = graph.links[index]!
    return { id: edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: edge.points, gaps: edge.gaps, state: pipeState(graph, link, parallel) }
  })
  const stubEdges = new Map(layout.edges.filter(edge => edge.id.startsWith('s')).map(edge => [edge.id.slice(0, edge.id.indexOf('.')), edge]))
  const stubs = [...planned.stubs].map(([id, stub]) => {
    const edge = stubEdges.get(id)!
    const node = placed.get(id)!
    const end = node.ports.end!
    return {
      id,
      direction: stub.direction,
      end: { x: end.x, y: end.y, face: end.face },
      text: stubText(graph, stub, profile.stubLabels),
      textBox: node.text,
      states: stub.links.map(index => pipeState(graph, graph.links[index]!, [])),
      edge,
    }
  })
  // A stub's pipe is drawn with the other pipes, styled by its first link (a grouped stub's links share one port).
  const stubPipes = stubs.map(stub => {
    const { link: index, parallel } = linkOf(stub.edge.id)
    const link = graph.links[index]!
    return { id: stub.edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: stub.edge.points, gaps: stub.edge.gaps, state: pipeState(graph, link, parallel) }
  })
  const paths = [...new Set([
    ...items.flatMap(item => {
      const state = item.binding.state
      return [
        ...(state?.state === undefined ? [] : [state.state.path]),
        ...(state?.command === undefined ? [] : [state.command]),
        ...(state?.throughput === undefined ? [] : [state.throughput.path]),
        ...item.rows.flatMap(rowPaths),
      ]
    }),
    ...pipes.flatMap(pipe => statePaths(pipe.state)),
    ...stubs.flatMap(stub => stub.states.flatMap(statePaths)),
  ])]
  const equipment = items.flatMap(item => {
    const count = item.rows.find((row): row is Extract<MimicRow, { kind: 'count' }> => row.kind === 'count')
    const bindings = count === undefined ? [item.binding] : count.members
    return bindings.map(binding => ({ id: itemIdOf(graph, binding.item), label: binding.label }))
  })
  return {
    intent,
    profile: profile.id,
    layoutVersion: MIMIC_LAYOUT_VERSION,
    width: layout.width,
    height: layout.height,
    readoutSize: profile.readoutSize,
    minScale: profile.minScale,
    crossings: { count: layout.crossings, forced: layout.forcedCrossings },
    items,
    pipes: [...pipes, ...stubPipes],
    stubs: stubs.map(({ edge: _edge, ...stub }) => stub),
    zones: layout.zones.map(zone => ({ ...zone, label: `Loop ${zone.lane}` })),
    paths,
    summary: {
      equipment,
      stops: stubs.map(stub => `${graph.components[planned.stubs.get(stub.id)!.component]!.metadata?.presentation?.shortLabel ?? graph.components[planned.stubs.get(stub.id)!.component]!.id} ${stub.text}`),
      carriers: scope.carriers,
      unverifiedFlows: [...new Set(pipes.filter(pipe => pipe.state.kind === 'fluid' && pipe.state.flow.fidelity === 'unverified').map(pipe => pipe.linkId))],
      unmeasuredStates: items.filter(item => item.binding.state?.aspect === 'position' && item.binding.state.state === undefined).map(item => item.binding.label),
    },
    hash: `${MIMIC_LAYOUT_VERSION}:${layout.hash}`,
  }
}

// Each orientation the layout tries reports its own size; the closest fit says how far off the drawing is.
const closestSize = (reasons: Extract<DiagramLayoutResult, { ok: false }>['reasons'], budget: MimicBudget) => {
  const overflow = (reason: { readonly width: number; readonly height: number }) => Math.max(reason.width / budget.maxWidth, reason.height / budget.maxHeight)
  const sizes = reasons.filter(reason => reason.kind === 'size')
  return sizes.length === 0 ? undefined : sizes.reduce((best, reason) => overflow(reason) < overflow(best) ? reason : best)
}

const layoutReasons = (result: Extract<DiagramLayoutResult, { ok: false }>, budget: MimicBudget): string => result.reasons.filter(reason => reason.kind !== 'size' || reason === closestSize(result.reasons, budget)).map(reason => {
  if (reason.kind === 'density') {
    const what = { symbols: 'symbols', symbolsPerLane: 'symbols in one loop', sharedSymbols: 'shared symbols outside the loops', lanes: 'loops', crossings: 'crossing pipes', crossingsOverBound: 'crossing pipes', bendsPerEdge: 'bends in one pipe' }[reason.limit]
    return `${reason.count} ${what} (at most ${reason.max} stay legible at a glance)`
  }
  if (reason.kind === 'size') return `the drawing needs ${reason.width} × ${reason.height} px, and this display leaves ${budget.maxWidth} × ${budget.maxHeight}`
  return `the layout could not be verified (${reason.violations.slice(0, 2).map(violation => `${violation.rule}: ${violation.detail}`).join('; ')})`
}).filter((reason, index, all) => all.indexOf(reason) === index).join('; ')

type Attempted = MimicCompileResult | { readonly ok: false; readonly layout: Extract<DiagramLayoutResult, { ok: false }> }

/** The diagram a scope is drawn from under a profile, before layout: what the engine sees (for verifying a drawing independently). */
export const planMimicDiagram = (plant: CompiledProcessPlant, scope: MimicScope, profile: MimicProfile): { readonly ok: true; readonly graph: DiagramGraph } | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> } => {
  const planned = plan(plant, scope, profile)
  return planned.issues.length > 0 ? { ok: false, issues: planned.issues } : { ok: true, graph: planned.graph }
}

const compileScope = (plant: CompiledProcessPlant, intent: MimicIntent | null, scope: MimicScope, budget: MimicBudget): Attempted => {
  const planned = plan(plant, scope, budget.profile)
  if (planned.issues.length > 0) return { ok: false, issues: planned.issues }
  // A scope of equipment the mimic has no symbol for draws nothing; the engine is never handed an empty diagram.
  if (planned.graph.nodes.length === 0) {
    const reasons = scope.components.map(index => presentationFor(plant.graph.components[index]!)).flatMap(presentation => presentation.element === 'not-drawn' ? [presentation.reason] : [])
    return { ok: false, issues: [{ field: '(mimic)', message: `nothing in this scope has a mimic symbol (${[...new Set(reasons)].join('; ')}); name other equipment or services` }] }
  }
  const layout = layoutDiagram(planned.graph, profileFor(budget))
  if (!layout.ok) return { ok: false, layout }
  return { ok: true, mimic: assemble(plant, intent, budget.profile, scope, planned, layout) }
}

const compileWithin = (plant: CompiledProcessPlant, intent: MimicIntent, budget: MimicBudget): Attempted => {
  const resolved = resolveMimicScope(plant.graph, intent)
  if (!resolved.ok) return { ok: false, issues: resolved.issues }
  return compileScope(plant, intent, resolved.scope, budget)
}

// Narrower intents that draw part of the same question; each is compiled, and only those that fit are offered.
const narrower = (plant: CompiledProcessPlant, intent: MimicIntent): ReadonlyArray<MimicIntent> => {
  const resolved = resolveMimicScope(plant.graph, intent)
  if (!resolved.ok) return []
  const drawnLoops = plantLoops(plant.graph).filter(loop => resolved.scope.components.some(index => plant.graph.components[index]!.metadata?.loopId === loop))
  const loopSets = intent.loops === undefined && drawnLoops.length > 1
    ? [drawnLoops.slice(0, 2), ...drawnLoops.map(loop => [loop])]
    : intent.loops !== undefined && intent.loops.length > 1 ? intent.loops.map(loop => [loop]) : []
  const serviceSets = (intent.services ?? []).length > 1 ? intent.services!.map(service => [service]) : []
  // A drawing from one end or around its items can stop closer to them; around, that keeps it centred on what was asked about.
  const oneEnded = (intent.from === undefined) !== (intent.to === undefined) || intent.around !== undefined
  const reaches = oneEnded ? Array.from({ length: (intent.reach ?? MIMIC_REACH_LINKS) - 1 }, (_, step) => (intent.reach ?? MIMIC_REACH_LINKS) - 1 - step).map(reach => ({ ...intent, reach })) : []
  const narrowed = [
    ...loopSets.map(loops => ({ ...intent, loops })),
    ...serviceSets.map(services => ({ ...intent, services })),
  ]
  return intent.around !== undefined ? [...reaches, ...narrowed] : [...narrowed, ...reaches]
}

const describeChange = (from: MimicIntent, to: MimicIntent): string =>
  to.reach !== from.reach ? `"reach":${to.reach}` : to.loops !== from.loops ? `"loops":${JSON.stringify(to.loops)}` : `"services":${JSON.stringify(to.services)}`

/** The agent's path: an intent resolved to a scope, drawn by the budget's profile, or refused with narrower intents that fit. */
export const compileMimic = (plant: CompiledProcessPlant, intent: MimicIntent, budget: MimicBudget): MimicCompileResult => {
  const result = compileWithin(plant, intent, budget)
  if (result.ok || 'issues' in result) return result as MimicCompileResult
  const fixes = narrower(plant, intent)
    .filter(candidate => compileWithin(plant, candidate, budget).ok)
    .slice(0, 3)
    .map(candidate => describeChange(intent, candidate))
  return {
    ok: false,
    issues: [{ field: '(mimic)', message: `${layoutReasons(result.layout, budget)}; ${fixes.length === 0 ? 'name fewer loops, one service, or a route between two items' : `it fits with ${fixes.join(', or ')}`}` }],
  }
}

/**
 * World's own path: a scope it resolved itself (the unit overview's principal
 * circuits), drawn by the budget's profile, or refused with why it does not
 * fit. The drawing's identity carries no intent.
 */
export const compileMimicScope = (plant: CompiledProcessPlant, scope: MimicScope, budget: MimicBudget): MimicCompileResult => {
  const result = compileScope(plant, null, scope, budget)
  if (result.ok || 'issues' in result) return result as MimicCompileResult
  return { ok: false, issues: [{ field: '(mimic)', message: layoutReasons(result.layout, budget) }] }
}
