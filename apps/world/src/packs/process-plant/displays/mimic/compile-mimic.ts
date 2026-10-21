import type { CompiledPlantGraph, CompiledProcessLink, VariablePath } from '../../graph/index.ts'
import type { TopologyNode } from '../../../../core/observation/topology.ts'
import { linkCarrier } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { readingText, unitLabel } from '../../quantity-text.ts'
import { framingRules, itemBinding, linkPowerBinding, stubWordBinding, type MimicItemBinding, type MimicStubWord } from './bindings.ts'
import { linkFlowBinding } from '../../equipment/link-flow.ts'
import { equipmentItemId, type EquipmentItem } from '../../equipment/items.ts'
import { diagramCandidates, type DiagramCandidates, type DiagramGraph, type DiagramLayoutResult, type DiagramNode, type DiagramRoom, type PlacedNode } from '../../../../features/displays/diagram/index.ts'
import { flowPlan, type FlowItem, type FlowPlan, type FlowRole, type FlowSizing, type FlowStop } from '../../../../features/displays/topology/flow.ts'
import { drawingCache, drawingKey } from '../../../../features/displays/topology/cache.ts'
import { TOPOLOGY_REACH, withLeavesStopped, withParallelSupplies, type ScopedTopology } from '../../../../features/displays/topology/scope.ts'
import { resolveMimicIntent, type MimicIssue } from './intent.ts'
import { MIMIC_LAYOUT_VERSION, type CompiledMimic, type MimicDrawnItem, type MimicIntent, type MimicItemTrend, type MimicPipeState } from './mimic-model.ts'
import { embeddedPresentation, presentationFor, type MimicPresentation } from './presentation.ts'
import type { BadgeReservation, MimicProfile } from './profiles.ts'
import { COUNT_WORDS, flapCount, itemRows, stubWordTexts, WIDER_RANGE, type FlapPart, type MimicRow } from './rows.ts'
import { loneReachedPort, stubText } from './stub-words.ts'
import { plantLoops } from '../../equipment/circuits.ts'
import { fitVessel } from './vessel-fit.ts'
import { openBridgeDevice, QUICK_LOOK_DOT, reactorVesselBottom, readoutBlockWidth, smallStateRowWidth, smallValueRowWidth, textWidth, unmeasurable, type OpenBridgeTextStyle } from './text-metrics.ts'

// Intent (or a scope World resolved itself) → World's topology scope and flow
// drawing, sized here in OpenBridge px with each item's bindings and rows
// (the P1 bridge: FlowSizing) → the layout engine → a compiled mimic. Every
// step reads the Plant's declared semantics; no step knows the reference
// model. The profile decides how much each item says: readout size, valves as
// markers, parallel equipment as one symbol.

/** The profile a display draws by, and the room it leaves the drawing. */
export interface MimicBudget {
  readonly profile: MimicProfile
  readonly maxWidth: number
  readonly maxHeight: number
}

export type MimicCompileResult =
  | { readonly ok: true; readonly mimic: CompiledMimic }
  | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> }

/** What the bridge keeps of a drawn item for the compiled mimic. */
interface PlannedItem {
  readonly item: EquipmentItem
  readonly binding: MimicItemBinding
  readonly presentation: MimicPresentation
  readonly rows: ReadonlyArray<MimicRow>
  /** A device's flap lines under OpenBridge's own (MimicDrawnItem.flapLines). */
  readonly flapLines: ReadonlyArray<FlapPart>
  readonly marker: boolean
  readonly role: FlowRole
  /** The Plant components it stands for: a group's members, or a bundled device's host. */
  readonly components: ReadonlyArray<number>
}

const valueRowWidth = (unit: string, fractionDigits: number, integerDigits = 3): number =>
  readoutBlockWidth(integerDigits, fractionDigits) + (unitLabel(unit) === '' ? 0 : textWidth('unit', unitLabel(unit))) + openBridgeDevice.valueRowPadding

/**
 * A value row that may read its wider instrument says so before the value, in
 * whole units ("WR 24 %"), so it takes no more room than the row's own
 * reading where the item's other rows are as wide (a steam generator's
 * pressure in MPa).
 */
const valueRowSize = (row: Extract<MimicRow, { kind: 'value' }>, own: number, value: (fractionDigits: number) => number): number =>
  (row.letters === undefined ? 0 : textWidth('unit', row.letters) + openBridgeDevice.valueRowGap)
  + (row.wider === undefined ? own : Math.max(own, textWidth('unit', WIDER_RANGE) + openBridgeDevice.valueRowGap + value(0)))

/** A value row with its sparkline on a line under it (MimicRow `sparkline`): no narrower than the sparkline, a line taller. */
const withSparkline = (row: Extract<MimicRow, { kind: 'value' }>, size: { readonly width: number; readonly height: number }): { readonly width: number; readonly height: number } =>
  row.sparkline === undefined ? size : { width: Math.max(size.width, row.sparkline.width), height: size.height + row.sparkline.height + openBridgeDevice.rowSparklineGap }

const stateRowWidth = (texts: ReadonlyArray<string>): number =>
  Math.max(...texts.map(text => textWidth('stateRow', text))) + openBridgeDevice.stateRowPadding

/**
 * What a device's value row may write in words instead of its readout: the
 * ends of its instrument's span ("<0 MW"), and the dash for no reading.
 */
const deviceValueWords = (row: Extract<MimicRow, { kind: 'value' }>): ReadonlyArray<string> =>
  ['—', ...(row.span === undefined ? [] : [readingText(row.span.min, row.unit, null, row.span), readingText(row.span.max, row.unit, null, row.span)])]

/** The words a position row shows where the valve stands at an end, or its position is not known. */
const POSITION_WORDS = ['POS ?', 'SHUT', 'OPEN']

/** The texts a row may show, besides its values: what must be measurable. */
const rowWords = (row: MimicRow): ReadonlyArray<string> =>
  row.kind === 'value' ? (row.digits === undefined ? [] : deviceValueWords(row)) : row.kind === 'position' ? POSITION_WORDS : row.texts

// Vessels use our stack of readout blocks (one decimal); devices OpenBridge's
// readout stack at the profile's size: small (11.5 px) or regular (16 px).
const rowSize = (row: MimicRow, device: boolean, readoutSize: MimicProfile['readoutSize']): { readonly width: number; readonly height: number } => {
  // A vessel's alarm, range and shutdown rows are written like its tag.
  if (row.kind === 'alarm' || ((row.kind === 'shutdown' || row.kind === 'range') && !device)) return { width: Math.max(...row.texts.map(text => textWidth('tag', text))), height: openBridgeDevice.tagLine }
  if (!device || readoutSize === 'regular') {
    const digits = device ? 0 : 1
    // A device writes a value as a whole number of its declared digits, or in words at an end of its span.
    if (row.kind === 'value' && row.digits !== undefined) return { width: Math.max(valueRowWidth(row.unit, 0, row.digits), stateRowWidth(deviceValueWords(row))), height: openBridgeDevice.row }
    if (row.kind === 'value') return withSparkline(row, { width: valueRowSize(row, valueRowWidth(row.unit, digits), fraction => valueRowWidth(row.unit, fraction)), height: openBridgeDevice.row })
    if (row.kind === 'position') return { width: Math.max(valueRowWidth('fraction', digits), stateRowWidth(POSITION_WORDS)), height: openBridgeDevice.row }
    return { width: stateRowWidth(rowWords(row)), height: openBridgeDevice.row }
  }
  if (row.kind === 'value' && row.digits !== undefined) return { width: Math.max(smallValueRowWidth(unitLabel(row.unit), row.digits), ...deviceValueWords(row).map(smallStateRowWidth)), height: openBridgeDevice.smallValueRow }
  if (row.kind === 'value') return { width: valueRowSize(row, smallValueRowWidth(unitLabel(row.unit)), () => smallValueRowWidth(unitLabel(row.unit))), height: openBridgeDevice.smallValueRow }
  if (row.kind === 'position') return { width: Math.max(smallValueRowWidth('%'), ...POSITION_WORDS.map(smallStateRowWidth)), height: openBridgeDevice.smallValueRow }
  return { width: Math.max(...rowWords(row).map(smallStateRowWidth)), height: openBridgeDevice.smallStateRow }
}

const rowTexts = (row: MimicRow): ReadonlyArray<{ readonly style: OpenBridgeTextStyle; readonly text: string }> =>
  row.kind === 'alarm' ? row.texts.map(text => ({ style: 'tag' as const, text }))
    : row.kind === 'shutdown' || row.kind === 'range' ? row.texts.flatMap(text => [{ style: 'tag' as const, text }, { style: 'stateRow' as const, text }])
    : row.kind === 'value' ? [{ style: 'unit', text: unitLabel(row.unit) }, ...(row.wider === undefined ? [] : [{ style: 'unit' as const, text: WIDER_RANGE }]), ...(row.letters === undefined ? [] : [{ style: 'unit' as const, text: row.letters }]), ...rowWords(row).map(text => ({ style: 'stateRow' as const, text }))]
    : rowWords(row).map(text => ({ style: 'stateRow' as const, text }))

const isDevice = (presentation: MimicPresentation): boolean => presentation.element === 'device'
const isVessel = (presentation: MimicPresentation): boolean => presentation.element === 'tank' || presentation.element === 'heat-exchanger' || presentation.element === 'vessel'
const isValve = (presentation: MimicPresentation): boolean =>
  presentation.element === 'device' && (presentation.icon === 'valve-analog' || presentation.icon === 'valve-digital' || presentation.icon === 'valve-check')

const aspectFor = (presentation: MimicPresentation) =>
  presentation.element === 'device' || presentation.element === 'bar' ? presentation.aspect
    : presentation.element === 'tank' || presentation.element === 'heat-exchanger' || presentation.element === 'vessel' ? presentation.aspect
      : null

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

/**
 * How a framed item's flap is reserved: its width, and where it says the
 * flap's action when that does not fit whole and how many other alarms are
 * active. A vessel says both on rows of its stack, in the room beside its
 * body, so its flap takes no more width than what it watches wherever its
 * stack may go (the reactor core's "PWR HI-HI", then "RX TRIP"). A device,
 * with no such room, says them on lines under its flap; its frame widens
 * for its whole flap by up to a grid step beyond its symbol and stack, and
 * only a flap wider still puts its action on a line of its own.
 */
const flapPlan = (
  planned: Pick<PlannedItem, 'binding' | 'presentation' | 'rows' | 'role'>,
  vessel: boolean,
  tag: number,
  measure: (style: OpenBridgeTextStyle, text: string, owner: string) => number,
  badges: BadgeReservation,
): { readonly width: number; readonly rows: ReadonlyArray<MimicRow>; readonly lines: ReadonlyArray<FlapPart> } => {
  const frames = planned.binding.frames
  if (frames.length === 0) return { width: 0, rows: [], lines: [] }
  const owner = planned.binding.label
  const label = (text: string): number => measure('alertLabel', text, owner) + openBridgeDevice.flapLabelInset
  // A chat column reserves no more than each flap's watched part: its flap carries the action and count where they fit (flapTexts).
  if (badges === 'fitted') return { width: Math.max(...frames.map(frame => label(frame.watches))) - openBridgeDevice.flapLabelInset, rows: [], lines: [] }
  const stack = Math.max(tag, ...planned.rows.map(row => rowSize(row, isDevice(planned.presentation), 'regular').width))
  const symbol = 2 * OPENBRIDGE_GRID
  // A vessel's frame is as narrow as its stack set below it; a device's as wide as its stack beside its symbol.
  const button = (vessel ? Math.max(symbol, stack) : symbol + stack) + 2 * FRAME_MARGIN
  const whole = Math.max(...frames.map(frame => label(frame.flap)))
  const wraps = whole > button + (vessel ? 0 : OPENBRIDGE_GRID)
  const parts: ReadonlyArray<FlapPart> = [...(wraps ? ['action' as const] : []), ...(frames.length > 1 ? ['count' as const] : [])]
  const texts = (part: FlapPart): ReadonlyArray<string> => part === 'action'
    ? [...new Set(frames.flatMap(frame => (frame.action === undefined ? [] : [frame.action])))]
    : frames.slice(1).map((_, index) => flapCount(index + 1))
  const flapWidth = Math.max(...(wraps ? frames.map(frame => label(frame.watches)) : [whole]), ...(vessel ? [] : parts.flatMap(texts).map(label))) - openBridgeDevice.flapLabelInset
  return vessel
    ? { width: flapWidth, rows: parts.map(part => ({ kind: 'alarm' as const, part, texts: texts(part), required: true as const })), lines: [] }
    : { width: flapWidth, rows: [], lines: parts }
}

// OpenBridge's grid and the margin its frame keeps around a button (profiles.ts).
const OPENBRIDGE_GRID = 24
const FRAME_MARGIN = 1

/** A drawing's sizing with the measuring issues it met. */
interface Sizing {
  readonly sizing: FlowSizing<PlannedItem>
  readonly issues: ReadonlyArray<MimicIssue>
}

/**
 * How the old renderer sizes and words World's flow drawing of the Plant
 * (FlowSizing): what the mimic does not draw, which relief lines vent out of
 * the Plant, bars, which valves take their loop's lane, which equipment the
 * profile groups, the devices a component bundles on a port, each item's
 * binding, rows and flap, measured in OpenBridge px.
 */
const mimicSizing = (plant: CompiledProcessPlant, profile: MimicProfile, badges: BadgeReservation): Sizing => {
  const graph = plant.graph
  const framed = framingRules(plant)
  const issues: MimicIssue[] = []
  const indexOf = (node: TopologyNode): number => graph.componentIndexById.get(node.id as never)!
  const presentations = new Map<string, MimicPresentation>()
  const presentationOf = (node: TopologyNode): MimicPresentation => {
    const known = presentations.get(node.id)
    if (known !== undefined) return known
    const made = presentationFor(graph.components[indexOf(node)]!)
    presentations.set(node.id, made)
    return made
  }
  const linkIndex = new Map(graph.links.map(link => [String(link.id), link.index]))
  const measure = (style: OpenBridgeTextStyle, text: string, owner: string): number => {
    const missing = unmeasurable(style, text)
    if (missing.length > 0) {
      issues.push({ field: '(mimic)', message: `${owner}: "${text}" uses characters the drawing cannot measure (${missing.join('')})` })
      return 0
    }
    return textWidth(style, text)
  }
  // A reactor vessel is as wide as its profile draws it. As a hub it keeps room past its nozzles for its head above
  // them and its bottom, and where it heats, its core region, below them (MimicVesselDrawing); one a pipe enters at
  // an end is as tall as all of them.
  const footprintOf = (planned: PlannedItem): Pick<DiagramNode, 'cells' | 'portInset' | 'ends'> => {
    if (planned.presentation.element === 'vessel') {
      const head = profile.vessel.head
      const bottom = reactorVesselBottom(coreOf(graph, planned, profile) ?? 'overlap')
      return planned.role === 'hub'
        ? { cells: { width: profile.vessel.cells, height: 4 }, portInset: 0, ends: { top: head, bottom } }
        : { cells: { width: profile.vessel.cells, height: Math.ceil((head + bottom + OPENBRIDGE_GRID) / OPENBRIDGE_GRID) }, portInset: 0 }
    }
    return isVessel(planned.presentation) || planned.role === 'hub'
      ? { cells: { width: 2, height: 4 }, portInset: openBridgeDevice.vessel.inset }
      : { cells: { width: 2, height: 2 }, portInset: 0 }
  }
  // An item with its flap: a frame's flap names its most severe active alarm whole, what it watches and what the
  // I&C does there, and the item counts its other alarms ("+2 alarms"): no drawing drops the action or leaves a count
  // unexplained (HMI review of run 23: "LO-LO +2" on a detail, "LO-LO · AFW START +2" on the overview).
  const sized = (unflapped: Omit<PlannedItem, 'flapLines'>) => {
    const presentation = unflapped.presentation
    const vessel = isVessel(presentation) || unflapped.role === 'hub'
    // An interactive drawing's tag line also holds the item's detail dot.
    const tag = measure('tag', unflapped.binding.label, unflapped.binding.label) + (profile.quickLooks ? QUICK_LOOK_DOT.gap + QUICK_LOOK_DOT.size : 0)
    const flap = flapPlan(unflapped, vessel, tag, measure, badges)
    const planned: PlannedItem = { ...unflapped, rows: [...unflapped.rows, ...flap.rows], flapLines: flap.lines }
    for (const row of planned.rows) for (const { style, text } of rowTexts(row)) measure(style, text, planned.binding.label)
    return {
      label: planned.binding.label,
      keep: planned,
      node: {
        ...footprintOf(planned),
        text: {
          lines: [
            // Every item carries its tag, a marker too: a valve's place on a loop does not say which valve it is
            // (run 22 QA: unlabelled feed regulating and main steam isolation valves on the overview).
            { width: tag, height: openBridgeDevice.tagLine, required: true },
            ...planned.rows.map(row => ({ ...rowSize(row, isDevice(presentation), profile.readoutSize), required: row.required })),
          ],
        },
        frameable: planned.binding.frames.length > 0,
        ...(planned.binding.frames.length === 0 ? {} : { flapWidth: flap.width, flapLines: 1 + flap.lines.length }),
      },
    }
  }
  const componentItem = (item: FlowItem) => {
    const index = indexOf(item.node)
    const component = graph.components[index]!
    const presentation = presentationOf(item.node)
    const group = item.members.map(indexOf)
    const bindings = group.map(member => itemBinding(plant, { kind: 'component', component: member }, aspectFor(presentation), framed))
    // A group's own state is its members' (rows.ts drawnLook); it shows no member's values. A hub a lone pipe enters
    // at one of its alike ports ("cold leg C" of the core's four) is that pipe's destination: its label names the
    // port and it writes none of its own values, so no value reads as the port's ("Core · cold leg C" beside the
    // core's 339 °C read as the cold leg's temperature).
    const reached = group.length === 1 && presentation.element !== 'bar' ? loneReachedPort(graph, component, item.piped, new Set(item.ports)) : null
    const binding: MimicItemBinding = group.length === 1
      ? (reached === null ? bindings[0]! : { ...bindings[0]!, label: `${bindings[0]!.label} · ${reached}`, values: [], ranges: [] })
      : { item: bindings[0]!.item, label: groupLabel(bindings.map(member => member.label)), state: null, values: [], ranges: [], shutdown: [], limits: [], frames: bindings.flatMap(member => member.frames) }
    const marker = profile.valves === 'markers' && isValve(presentation) && group.length === 1
    const rows = itemRows(group.length === 1 ? binding : bindings[0]!, presentation, { marker, members: group.length === 1 ? [] : bindings, commands: profile.commands, offSpan: profile.offSpan })
    return sized({ item: { kind: 'component', component: index }, binding, presentation, rows: withSparklines(rows, presentation, profile), marker, role: item.role, components: group })
  }
  const deviceItem = (item: FlowItem) => {
    const host = indexOf(item.node)
    const device = graph.components[host]!.semantics.embedded.find(candidate => candidate.id === item.device)!
    const presentation = embeddedPresentation(device)
    const binding = itemBinding(plant, { kind: 'device', component: host, device: device.id }, 'position', framed)
    const marker = profile.valves === 'markers' && isValve(presentation)
    return sized({ item: { kind: 'device', component: host, device: device.id }, binding, presentation, rows: itemRows(binding, presentation, { marker, members: [], commands: profile.commands, offSpan: profile.offSpan }), marker, role: 'device', components: [host] })
  }
  const sizing: FlowSizing<PlannedItem> = {
    key: profile.id,
    // Equipment the mimic cannot draw ends the drawing like any other stop.
    visible: node => presentationOf(node).element !== 'not-drawn',
    // A relief valve venting out of the Plant (into equipment not drawn that takes the flow no further, the atmosphere) ends the drawing itself.
    silent: edge => {
      const link = graph.links[linkIndex.get(edge.id)!]!
      return graph.components[link.fromComponentIndex]!.semantics.function === 'relieving' && (graph.outgoingLinksByComponent[link.toComponentIndex] ?? []).length === 0
    },
    bar: node => presentationOf(node).element === 'bar',
    // A valve the model gives no loop is drawn in a loop's lane where everything it is piped to in this drawing
    // belongs to that one loop (a steam generator's safety valve); read from the drawing alone, never written to the model.
    infersLane: node => isValve(presentationOf(node)),
    ...(profile.parallel !== 'grouped' ? {} : {
      // Parallel equipment the profile groups: same kind and presentation, whose state words count members.
      groupKey: (node: TopologyNode) => {
        const presentation = presentationOf(node)
        const aspect = aspectFor(presentation)
        return aspect === null || COUNT_WORDS[aspect] === undefined ? null : JSON.stringify([node.kind, presentation])
      },
    }),
    chain: (node, port) => graph.components[indexOf(node)]!.semantics.embedded.filter(device => String(device.port) === port).map(device => device.id),
    itemId: (node, device) => (device === undefined ? `c${indexOf(node)}` : `c${indexOf(node)}:${device}`),
    edgeId: edge => `l${linkIndex.get(edge.id)!}`,
    label: node => itemBinding(plant, { kind: 'component', component: indexOf(node) }, aspectFor(presentationOf(node)), framed).label,
    item: item => (item.device === undefined ? componentItem(item) : deviceItem(item)),
    // A power line's far end says under its name whether the equipment it names is live ("from UAT", "LIVE"), its room kept for the longest word.
    stop: stop => {
      const word = stubWordOf(graph, stop)
      const text = stubText(graph, stop, profile.stubLabels)
      return { lines: [
        { width: measure('tag', text, text), height: openBridgeDevice.tagLine, required: true },
        ...(word === null ? [] : [{ width: Math.max(...stubWordTexts(word).map(shown => measure('tag', shown, text))), height: openBridgeDevice.tagLine, required: true }]),
      ] }
    },
  }
  return { sizing, issues }
}

/** Where a reactor vessel's core region stands (MimicVesselDrawing): as its profile draws it where it is the energy's source; null for any other. */
const coreOf = (graph: CompiledPlantGraph, item: Pick<PlannedItem, 'item' | 'presentation'>, profile: MimicProfile): 'band' | 'overlap' | null =>
  item.presentation.element === 'vessel' && item.item.kind === 'component' && graph.components[item.item.component]!.semantics.energy.some(role => role.role === 'source')
    ? profile.vessel.core
    : null

/** A reactor vessel's value rows each carry a sparkline where its profile shows trends (MimicRow `sparkline`). */
const withSparklines = (rows: ReadonlyArray<MimicRow>, presentation: MimicPresentation, profile: MimicProfile): ReadonlyArray<MimicRow> =>
  !profile.trends || profile.sparklines === null || presentation.element !== 'vessel' ? rows : rows.map(row => (row.kind === 'value' ? { ...row, sparkline: profile.sparklines! } : row))

/**
 * What an item draws of its reading over time where its profile shows trends
 * (MimicItemTrend): a tank its level as its fill's trace; a heat exchanger
 * the level its row reads, where that row is drawn.
 */
const trendOf = (item: Pick<MimicDrawnItem, 'binding' | 'presentation' | 'rows'>, profile: MimicProfile): MimicItemTrend | null => {
  const state = item.binding.state
  if (!profile.trends || state?.aspect !== 'level' || state.state === undefined) return null
  if (item.presentation.element === 'tank') return { kind: 'fill', path: state.state.path }
  if (item.presentation.element !== 'heat-exchanger') return null
  const row = item.rows.findIndex(candidate => candidate.kind === 'value' && candidate.path === state.state!.path)
  return row < 0 ? null : { kind: 'strip', row }
}

/** The readings an item's trends draw over time: its trend's, and its sparkline rows' with their wider instruments. */
const trendPathsOf = (item: Pick<MimicDrawnItem, 'rows' | 'trend'>): ReadonlyArray<VariablePath> => [
  ...(item.trend?.kind === 'fill' ? [item.trend.path] : item.trend?.kind === 'strip' ? rowPaths(item.rows[item.trend.row]!) : []),
  ...item.rows.flatMap(row => (row.kind === 'value' && row.sparkline !== undefined ? rowPaths(row) : [])),
]

/** A power stub's word, about the far ends it names (stubWordBinding); null where its lines carry fluid. */
const linkIndexes = new WeakMap<CompiledPlantGraph, ReadonlyMap<string, number>>()
/** A topology edge's Plant link: the edge's id is the link's. */
const linkOf = (graph: CompiledPlantGraph, edge: string): CompiledProcessLink => {
  const known = linkIndexes.get(graph) ?? new Map(graph.links.map(link => [String(link.id), link.index]))
  linkIndexes.set(graph, known)
  return graph.links[known.get(edge)!]!
}

const stubWordOf = (graph: CompiledPlantGraph, stop: FlowStop): MimicStubWord | null => {
  const links = stop.edges.map(edge => linkOf(graph, edge).index)
  return linkCarrier(graph.links[links[0]!]!) !== 'electricalPower' ? null : stubWordBinding(graph, stop.others.map(other => graph.componentIndexById.get(other.node as never)!), links)
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
  if (row.kind === 'value') return [row.path as VariablePath, ...(row.wider === undefined ? [] : [row.wider.path as VariablePath])]
  if (row.kind === 'shutdown') return row.part === 'word' ? [row.flag.path, ...row.flag.demands.map(demand => demand.path)] : []
  if (row.kind === 'range') return row.chain.steps.flatMap(step => [step.path, ...(step.meaningful === undefined ? [] : [step.meaningful]), ...(step.widerWhile === undefined ? [] : [step.widerWhile])])
  if (row.kind !== 'count') return []
  return row.members.flatMap(member => [
    ...(member.state?.state === undefined ? [] : [member.state.state.path]),
    ...(member.state?.command === undefined ? [] : [member.state.command]),
    ...(member.state?.throughput === undefined ? [] : [member.state.throughput.path]),
  ])
}

const assemble = (plant: CompiledProcessPlant, intent: MimicIntent | null, profile: MimicProfile, scoped: ScopedTopology, planned: FlowPlan<PlannedItem>, layout: Extract<DiagramLayoutResult, { ok: true }>): CompiledMimic => {
  const graph = plant.graph
  const placed = new Map(layout.nodes.map(node => [node.id, node]))
  const kept = [...planned.items].map(([id, entry]) => ({ id, ...entry.keep }))
  // A reactor vessel stands in its box as a vessel does (vessel-fit.ts); a pipe reaching its box beside it continues to it.
  const vesselFits = new Map(kept.filter(item => item.presentation.element === 'vessel').map(item => {
    const node = placed.get(item.id)!
    return [item.id, fitVessel({ x: node.x, y: node.y, width: node.width, height: node.height }, Object.values(node.ports), node.text?.side ?? null)] as const
  }))
  const routes = [...vesselFits.values()].flatMap(fit => fit.routes)
  const continued = (point: readonly [number, number]) => routes.find(route => Math.abs(route.from.x - point[0]) < 0.5 && Math.abs(route.from.y - point[1]) < 0.5)
  const toVessels = (points: ReadonlyArray<readonly [number, number]>): ReadonlyArray<readonly [number, number]> => {
    const first = continued(points[0]!)
    const last = continued(points.at(-1)!)
    return [...(first === undefined ? [] : [...first.points].reverse()), ...points, ...(last === undefined ? [] : last.points)]
  }
  const items: MimicDrawnItem[] = kept.map(item => {
    const node = placed.get(item.id)!
    // A stack's first line is the tag; the rows that fit follow it.
    const rows = item.rows.slice(0, Math.max(0, (node.text?.lines ?? 1) - 1))
    const trend = trendOf({ ...item, rows }, profile)
    const fit = vesselFits.get(item.id)
    return {
      id: item.id,
      binding: item.binding,
      presentation: item.presentation,
      box: { x: node.x, y: node.y, width: node.width, height: node.height },
      orientation: orientationOf(node),
      text: node.text,
      frame: node.frame,
      rows,
      flapLines: item.flapLines,
      marker: item.marker,
      components: item.components.map(component => String(graph.components[component]!.id)),
      ...(fit === undefined ? {} : { vessel: { core: coreOf(graph, item, profile), span: fit.span, nozzles: fit.nozzles } }),
      ...(trend === null ? {} : { trend }),
    }
  })
  const drawnOf = (edgeId: string) => {
    const { edge, parallel } = planned.edges.get(edgeId)!
    return { link: linkOf(graph, edge), parallel: parallel.map(other => linkOf(graph, other).index) }
  }
  const pipes = layout.edges.filter(edge => !edge.id.startsWith('s')).map(edge => {
    const { link, parallel } = drawnOf(edge.id)
    return { id: edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: toVessels(edge.points), gaps: edge.gaps, state: pipeState(graph, link, parallel) }
  })
  const stubEdges = new Map(layout.edges.filter(edge => edge.id.startsWith('s')).map(edge => [edge.id.slice(0, edge.id.indexOf('.')), edge]))
  const stubs = [...planned.stops].map(([id, stub]) => {
    const edge = stubEdges.get(id)!
    const node = placed.get(id)!
    const end = node.ports.end!
    return {
      id,
      direction: stub.direction,
      end: { x: end.x, y: end.y, face: end.face },
      text: stubText(graph, stub, profile.stubLabels),
      textBox: node.text,
      states: stub.edges.map(edge => pipeState(graph, linkOf(graph, edge), [])),
      word: stubWordOf(graph, stub),
      edge,
    }
  })
  // A stub's pipe is drawn with the other pipes, styled by its first link (a grouped stub's links share one port).
  const stubPipes = stubs.map(stub => {
    const { link, parallel } = drawnOf(stub.edge.id)
    return { id: stub.edge.id, linkId: String(link.id), carrier: linkCarrier(link), points: toVessels(stub.edge.points), gaps: stub.edge.gaps, state: pipeState(graph, link, parallel) }
  })
  const paths = [...new Set([
    ...items.flatMap(item => {
      const state = item.binding.state
      return [
        ...(state?.state === undefined ? [] : [state.state.path]),
        ...(state?.command === undefined ? [] : [state.command]),
        ...(state?.throughput === undefined ? [] : [state.throughput.path]),
        ...item.rows.flatMap(rowPaths),
        // A reactor vessel draws its insertion's parts in its core region; a tank marks its program where its level is off it.
        ...(item.vessel === undefined ? [] : (item.binding.insertion?.groups ?? []).flat().map(part => part.path)),
        ...(item.presentation.element === 'tank' && item.binding.program !== undefined ? [item.binding.program] : []),
      ]
    }),
    ...pipes.flatMap(pipe => statePaths(pipe.state)),
    ...stubs.flatMap(stub => stub.states.flatMap(statePaths)),
    ...stubs.flatMap(stub => stub.word === null ? [] : stub.word.kind === 'equipment' ? stub.word.energized : stub.word.lines),
  ])]
  const equipment = items.flatMap(item => {
    const count = item.rows.find((row): row is Extract<MimicRow, { kind: 'count' }> => row.kind === 'count')
    const bindings = count === undefined ? [item.binding] : count.members
    return bindings.map(binding => ({ id: equipmentItemId(graph, binding.item), label: binding.label }))
  })
  return {
    intent,
    profile: profile.id,
    layoutVersion: MIMIC_LAYOUT_VERSION,
    width: layout.width,
    height: layout.height,
    readoutSize: profile.readoutSize,
    minScale: profile.minScale,
    crossings: layout.crossings,
    items,
    pipes: [...pipes, ...stubPipes],
    stubs: stubs.map(({ edge: _edge, ...stub }) => stub),
    paths,
    trendPaths: [...new Set(items.flatMap(trendPathsOf))],
    summary: {
      equipment,
      stops: stubs.map(stub => `${planned.stops.get(stub.id)!.node.shortLabel ?? planned.stops.get(stub.id)!.node.id} ${stub.text}`),
      carriers: scoped.media,
      unverifiedFlows: [...new Set(pipes.filter(pipe => pipe.state.kind === 'fluid' && pipe.state.flow.fidelity === 'unverified').map(pipe => pipe.linkId))],
      unmeasuredStates: items.filter(item => item.binding.state?.aspect === 'position' && item.binding.state.state === undefined).map(item => item.binding.label),
    },
    hash: `${MIMIC_LAYOUT_VERSION}:${layout.hash}`,
  }
}

// Each orientation the layout tries reports its own size; the closest fit says how far off the drawing is.
const closestSize = (reasons: Extract<DiagramLayoutResult, { ok: false }>['reasons'], room: DiagramRoom) => {
  const overflow = (reason: { readonly width: number; readonly height: number }) => Math.max(reason.width / room.maxWidth, reason.height / room.maxHeight)
  const sizes = reasons.filter(reason => reason.kind === 'size')
  return sizes.length === 0 ? undefined : sizes.reduce((best, reason) => overflow(reason) < overflow(best) ? reason : best)
}

const layoutReasons = (result: Extract<DiagramLayoutResult, { ok: false }>, room: DiagramRoom): string => result.reasons.filter(reason => reason.kind !== 'size' || reason === closestSize(result.reasons, room)).map(reason => {
  if (reason.kind === 'density') {
    const what = { symbols: 'symbols', symbolsPerPartition: 'symbols in one loop', sharedSymbols: 'shared symbols outside the loops', partitions: 'loops', crossings: 'crossing pipes', bendsPerEdge: 'bends in one pipe' }[reason.limit]
    return `${reason.count} ${what} (at most ${reason.max} stay legible at a glance)`
  }
  if (reason.kind === 'size') return `the drawing needs ${reason.width} × ${reason.height} px, and this display leaves ${room.maxWidth} × ${room.maxHeight}`
  return `the layout could not be verified (${reason.violations.slice(0, 2).map(violation => `${violation.rule}: ${violation.detail}`).join('; ')})`
}).filter((reason, index, all) => all.indexOf(reason) === index).join('; ')

type Attempted = MimicCompileResult | { readonly ok: false; readonly layout: Extract<DiagramLayoutResult, { ok: false }> }

/** The diagram a scope is drawn from under a profile and its roomiest badge reservation, before layout: what the engine sees (for verifying a drawing independently). */
export const planMimicDiagram = (plant: CompiledProcessPlant, scoped: ScopedTopology, profile: MimicProfile): { readonly ok: true; readonly graph: DiagramGraph } | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> } => {
  const { sizing, issues } = mimicSizing(plant, profile, profile.badges[0]!)
  const planned = flowPlan(scoped, sizing)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, graph: planned.graph }
}

/**
 * A scope planned under a profile, for each badge reservation it allows with
 * the candidate drawings of its diagram (diagramCandidates): drawn for any
 * room without planning or laying it out again. Reservations are planned,
 * and rungs laid out, only as a room first needs them.
 */
interface ScopeDrawing {
  /** The roomiest badge reservation that fits the room, the drawing carrying `intent` as its identity. */
  readonly draw: (intent: MimicIntent | null, room: DiagramRoom) => Attempted
  /** The least room height it draws in at a width; null where it draws at no height there. */
  readonly leastHeight: (maxWidth: number) => number | null
}

const planScope = (plant: CompiledProcessPlant, scoped: ScopedTopology, profile: MimicProfile): ScopeDrawing => {
  const reservations: Array<{ readonly planned: FlowPlan<PlannedItem>; readonly candidates: DiagramCandidates } | { readonly issues: ReadonlyArray<MimicIssue> }> = []
  // A scope of equipment the mimic has no symbol for draws nothing; the engine is never handed an empty diagram.
  const notDrawable = (): ReadonlyArray<MimicIssue> => {
    const reasons = scoped.nodes.map(node => presentationFor(plant.graph.components[plant.graph.componentIndexById.get(node as never)!]!)).flatMap(presentation => presentation.element === 'not-drawn' ? [presentation.reason] : [])
    return [{ field: '(mimic)', message: `nothing in this scope has a mimic symbol (${[...new Set(reasons)].join('; ')}); name other equipment or services` }]
  }
  const reservation = (index: number) => {
    const known = reservations[index]
    if (known !== undefined) return known
    const { sizing, issues } = mimicSizing(plant, profile, profile.badges[index]!)
    const planned = flowPlan(scoped, sizing)
    const entry = issues.length > 0 ? { issues }
      : planned.graph.nodes.length === 0 ? { issues: notDrawable() }
        : { planned, candidates: diagramCandidates(planned.graph, profile.layout) }
    reservations[index] = entry
    return entry
  }
  const draw = (intent: MimicIntent | null, room: DiagramRoom): Attempted => {
    // Each badge reservation the profile allows, the roomiest first, until the drawing fits.
    let attempted: Attempted | undefined
    for (const index of profile.badges.keys()) {
      const entry = reservation(index)
      if ('issues' in entry) return { ok: false, issues: entry.issues }
      const layout = entry.candidates.layout(room)
      if (layout.ok) return { ok: true, mimic: assemble(plant, intent, profile, scoped, entry.planned, layout) }
      attempted = { ok: false, layout }
    }
    return attempted!
  }
  const leastHeight = (maxWidth: number): number | null => {
    let least: number | null = null
    for (const index of profile.badges.keys()) {
      const entry = reservation(index)
      if ('issues' in entry) break
      const height = entry.candidates.leastHeight(maxWidth)
      if (height !== null) least = least === null ? height : Math.min(least, height)
    }
    return least
  }
  return { draw, leastHeight }
}

/** Scopes drawn per Plant and profile, the one drawn longest ago evicted first: an overview, the details opened from it, chat's retries. */
const SCOPE_DRAWINGS = 96
const scopeDrawings = new WeakMap<CompiledProcessPlant, ReturnType<typeof drawingCache<ScopeDrawing>>>()

/** A scope's drawing under a profile, planned and laid out once whatever rooms it is drawn for. */
const scopeDrawing = (plant: CompiledProcessPlant, scoped: ScopedTopology, profile: MimicProfile): ScopeDrawing => {
  const drawings = scopeDrawings.get(plant) ?? drawingCache<ScopeDrawing>(SCOPE_DRAWINGS)
  scopeDrawings.set(plant, drawings)
  return drawings.get(drawingKey(scoped, profile.id), () => planScope(plant, scoped, profile))
}

const compileScope = (plant: CompiledProcessPlant, intent: MimicIntent | null, scoped: ScopedTopology, budget: MimicBudget): Attempted =>
  scopeDrawing(plant, scoped, budget.profile).draw(intent, budget)

/**
 * An intent drawn with its parallel supplies (withParallelSupplies), the most
 * of them that stays legible in the budget: drawn, else stopping the drawing
 * at the port they join, else as asked; so a line-up shows a source that
 * feeds what it ends at wherever there is room (evaluation run 23: safety
 * injection to loop C without accumulator C). The auxiliary feed beside the
 * main feed to all four steam generators draws legibly neither way. Where
 * the drawing as asked is still too much to read, its leaves are named on a
 * stub instead (withLeavesStopped).
 */
const compileWithin = (plant: CompiledProcessPlant, intent: MimicIntent, budget: MimicBudget): Attempted => {
  const resolved = resolveMimicIntent(plant, intent)
  if (!resolved.ok) return { ok: false, issues: resolved.issues }
  const scopes = [withParallelSupplies(resolved.scoped, 'drawn'), withParallelSupplies(resolved.scoped, 'stopped')]
    .filter((scoped): scoped is ScopedTopology => scoped !== null)
  for (const scoped of scopes) {
    const supplied = compileScope(plant, intent, scoped, budget)
    if (supplied.ok) return supplied
  }
  const asked = compileScope(plant, intent, resolved.scoped, budget)
  if (asked.ok || 'issues' in asked) return asked
  // Too much to read at a glance: leaves that carry nothing further are named on a stub instead (evaluation run 24: both safety buses with their sequenced loads).
  const leaner = withLeavesStopped(resolved.scoped)
  if (leaner === null) return asked
  const stubbed = compileScope(plant, intent, leaner, budget)
  return stubbed.ok ? stubbed : asked
}

// Narrower intents that draw part of the same question; each is compiled, and only those that fit are offered.
// None leaves out what the question is about: a loop set keeps the loop of each item named (of alike items
// named in the plural, one), as the scope requires of every intent.
const narrower = (plant: CompiledProcessPlant, intent: MimicIntent): ReadonlyArray<MimicIntent> => {
  const resolved = resolveMimicIntent(plant, intent)
  if (!resolved.ok) return []
  const loopOf = new Map(resolved.scoped.graph.nodes.map(node => [node.id, node.group]))
  const named = [...(intent.from ?? []), ...(intent.to ?? []), ...(intent.around ?? [])]
    .map(name => resolved.names.filter(entry => entry.name === name).flatMap(entry => loopOf.get(entry.node) ?? []))
  const keepsNamed = (loops: ReadonlyArray<string>): boolean => named.every(theirs => theirs.length === 0 || theirs.some(loop => loops.includes(loop)))
  const drawnLoops = plantLoops(plant.graph).filter(loop => resolved.scoped.nodes.some(node => loopOf.get(node) === loop))
  const loopSets = (intent.loops === undefined && drawnLoops.length > 1
    ? [drawnLoops.slice(0, 2), ...drawnLoops.map(loop => [loop])]
    : intent.loops !== undefined && intent.loops.length > 1 ? intent.loops.map(loop => [loop]) : []).filter(keepsNamed)
  const serviceSets = (intent.services ?? []).length > 1 ? intent.services!.map(service => [service]) : []
  // A drawing from one end or around its items can stop closer to them; around, that keeps it centred on what was asked about.
  const oneEnded = (intent.from === undefined) !== (intent.to === undefined) || intent.around !== undefined
  const reaches = oneEnded ? Array.from({ length: (intent.reach ?? TOPOLOGY_REACH) - 1 }, (_, step) => (intent.reach ?? TOPOLOGY_REACH) - 1 - step).map(reach => ({ ...intent, reach })) : []
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
 * circuits, the surroundings of equipment opened from it), drawn by a
 * profile for any room the display leaves it, or refused with why it does
 * not fit there; and the least height it draws in at a width. The drawing's
 * identity carries no intent.
 */
export interface MimicScopeDrawing {
  readonly draw: (room: DiagramRoom) => MimicCompileResult
  readonly leastHeight: (maxWidth: number) => number | null
}

export const mimicScopeDrawing = (plant: CompiledProcessPlant, scoped: ScopedTopology, profile: MimicProfile): MimicScopeDrawing => {
  const drawing = scopeDrawing(plant, scoped, profile)
  const draw = (room: DiagramRoom): MimicCompileResult => {
    const result = drawing.draw(null, room)
    if (result.ok || 'issues' in result) return result as MimicCompileResult
    return { ok: false, issues: [{ field: '(mimic)', message: layoutReasons(result.layout, room) }] }
  }
  return { draw, leastHeight: drawing.leastHeight }
}

/** World's own path for one room (mimicScopeDrawing). */
export const compileMimicScope = (plant: CompiledProcessPlant, scoped: ScopedTopology, budget: MimicBudget): MimicCompileResult =>
  mimicScopeDrawing(plant, scoped, budget.profile).draw(budget)
