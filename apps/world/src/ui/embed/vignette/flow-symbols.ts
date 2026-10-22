// A flow topology as drawn (architecture B3), in OpenBridge: the server's
// diagram-engine layout in grid units, one grid unit a row. Pipes, header bars
// and the caps where the drawing stops are connector-diagram segments; each
// item is the OpenBridge equipment its class and the media of its pipes make
// it (symbolOf): a device on an obc-automation-button at its centre with
// OpenBridge's glyph, a tank, a heat exchanger, a bus, or, for a fluid source
// (the lanes' hub), the registered vessel shape (vessel-symbol.ts).
// Bindings drive what each draws: a level fills a tank or the vessel, running
// and conducting turn a device on (ruling Q8), a position opens a valve and
// inserts the vessel's parts, a flow fills its pipe and points its chevron.
// An item takes OpenBridge's alert frame at the worst priority of its bound
// readings and of the active alerts on its element the sample carries. A
// reading that is missing, bad or stale, or a frozen sample, reads as
// unknown: a static device or tank, a dashed pipe; never as off or empty. One
// outside its declared validity draws as unknown and writes "—".
import type { Segment } from '@oicl/connector-diagram'
import type { Observation } from '../../../core/observation/model.ts'
import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
import type { TopologyBinding, VignetteSection } from '../../../features/displays/compose/model.ts'
import { groupName, itemText } from '../../../features/displays/topology/layout.ts'
import { VIGNETTE_ROW_PX } from './grid.ts'
import { chevronSegment, pipeSegments, pipeValue, stubEndSegment, type PipeLook } from './pipe-segments.ts'
import { stub } from './network.ts'
import { activeState, observedInput, readingLook, toneOf, type AlertTone } from './readout.ts'
import type { VesselDrawing } from './vessel-symbol.ts'

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type NodeView = Topology['nodes'][number]
type Point = readonly [number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type Face = 'top' | 'right' | 'bottom' | 'left'

export type FlowSymbol = 'vessel' | 'tank' | 'exchanger' | 'mover' | 'generator' | 'valve' | 'breaker' | 'transformer' | 'source' | 'bus' | 'header' | 'junction' | 'end'

/** The OpenBridge equipment a node is drawn as, by its class and the media kinds of its drawn pipes; a bar is a bus or a header. */
export const symbolOf = (node: Pick<NodeView, 'class' | 'bindings'>, media: ReadonlyArray<string>, bar: boolean): FlowSymbol => {
  const electric = media.some(kind => kind === 'electric-ac' || kind === 'electric-dc')
  if (bar) return electric ? 'bus' : 'header'
  switch (node.class) {
    case 'source': return electric ? 'source' : 'vessel'
    case 'store': return 'tank'
    case 'transfer': return 'exchanger'
    case 'converter': return electric ? 'transformer' : 'exchanger'
    case 'mover': return electric ? 'generator' : 'mover'
    case 'switch': return electric ? 'breaker' : 'valve'
    // A sink whose flow turns it (a running binding) generates; one that only takes the flow ends the line.
    case 'sink': return node.bindings.some(binding => binding.role === 'running') ? 'generator' : 'end'
    case 'bus': case 'junction': return 'junction'
    case 'boundary': case 'stop': return 'end'
  }
}

/** A device's state: on, off, a position of travel (0 shut, 1 open), or not known. */
export type DeviceState = { readonly kind: 'on' | 'off' | 'unknown' } | { readonly kind: 'position'; readonly fraction: number }

export type Glyph = { readonly tag: `obi-${string}` } | { readonly tag: 'obc-valve-analog-two-way-icon'; readonly value: number }

/** OpenBridge's glyph for a device in a state; none for a breaker whose state is not known (an open glyph would claim one). */
export const glyphOf = (symbol: FlowSymbol, state: DeviceState, vertical: boolean): Glyph | null => {
  const word = state.kind === 'unknown' ? 'static' : state.kind === 'off' || (state.kind === 'position' && state.fraction <= 0) ? 'off' : 'on'
  switch (symbol) {
    case 'mover': return { tag: `obi-pump-${word}-${vertical ? 'vertical' : 'horizontal'}` }
    case 'generator': return { tag: `obi-electric-generator-ac-${word}` }
    case 'valve': return state.kind === 'position' ? { tag: 'obc-valve-analog-two-way-icon', value: Math.round(Math.min(1, Math.max(0, state.fraction)) * 100) } : { tag: 'obi-twoway-digital-static' }
    case 'breaker': return state.kind === 'unknown' ? null : { tag: `obi-switch-01-${word}` }
    case 'transformer': return { tag: word === 'static' ? 'obi-transformer-01' : `obi-transformer-01-${word}` }
    case 'source': return { tag: word === 'static' ? 'obi-sources-01' : `obi-sources-01-${word}` }
    default: return null
  }
}

/** A line of an item's text: its name, its state word (or a group's count), the command it does not follow, a reading. */
export interface FlowLine { readonly text: string; readonly kind: 'name' | 'word' | 'command' | 'reading' }

const DEVICES: ReadonlySet<FlowSymbol> = new Set(['mover', 'generator', 'valve', 'breaker', 'transformer', 'source'])
/** A text line of the stacks the engine kept (flow-sizing.ts). */
export const FLOW_LINE_PX = 16
const passing = (state: DeviceState | undefined): boolean => state?.kind === 'on' || (state?.kind === 'position' && state.fraction > 0)
const shut = (state: DeviceState | undefined): boolean => state?.kind === 'off' || (state?.kind === 'position' && state.fraction <= 0)

export interface FlowDrawing {
  readonly width: number
  readonly height: number
  readonly segments: ReadonlyArray<Segment>
  /** Each at its symbol's centre (OpenBridge's `point` positioning). */
  /** `orientation`: OpenBridge's turn of a vertical symbol (a mover's glyph turns itself). */
  readonly devices: ReadonlyArray<{ readonly id: string; readonly element: string; readonly glyph: Glyph | null; readonly x: number; readonly y: number; readonly on: boolean; readonly unknown: boolean; readonly vertical: boolean; readonly orientation: 'horizontal' | 'verticalRight'; readonly tone: AlertTone | null; readonly title: string }>
  /** A tank's or the vessel's level in percent, null where not known; a vessel's parts each inserted 0..1, null where not known. */
  readonly vessels: ReadonlyArray<Box & { readonly id: string; readonly element: string; readonly kind: 'tank' | 'exchanger' | 'vessel'; readonly level: number | null; readonly unknown: boolean; readonly tone: AlertTone | null; readonly title: string; readonly drawing?: VesselDrawing; readonly parts?: ReadonlyArray<number | null> }>
  readonly buses: ReadonlyArray<Box & { readonly id: string; readonly vertical: boolean; readonly title: string }>
  readonly texts: ReadonlyArray<{ readonly id: string; readonly element: string | null; readonly x: number; readonly y: number; readonly width: number; readonly lines: ReadonlyArray<FlowLine>; readonly tone: AlertTone | null; readonly title: string }>
}

export const flowDrawing = (section: Topology, observations: ReadonlyArray<Observation>, alerts: ReadonlyArray<AlertRow>, frozen: boolean): FlowDrawing => {
  const px = (grid: number): number => grid * VIGNETTE_ROW_PX
  const byId = new Map(section.nodes.map(node => [node.id, node]))
  const viewEdges = new Map(section.edges.map(edge => [edge.id, edge]))
  const observed = new Map(observations.map(observation => [observation.ref, observation]))
  // A reading the drawing can draw from: none while the sample is frozen, or where it is missing, bad, stale, or
  // outside the validity its observable declares (not-applicable).
  const usable = (binding: TopologyBinding): Observation | null => {
    const observation = observed.get(binding.ref)
    return frozen || observation === undefined || observation.value === null || ['bad', 'stale', 'not-applicable'].includes(observation.quality) ? null : observation
  }
  // What its text writes: a reading outside its validity reads "—", one not known "?" (stale included, as the drawing reads it).
  const shownReading = (binding: TopologyBinding): Observation | undefined => {
    const observation = frozen ? undefined : observed.get(binding.ref)
    return observation?.quality === 'stale' ? undefined : observation
  }
  const percent = (binding: TopologyBinding): number | null => {
    const value = usable(binding)?.value
    return typeof value !== 'number' || (binding.unit !== '%' && binding.unit !== '1') ? null : Math.min(100, Math.max(0, binding.unit === '%' ? value : value * 100))
  }
  const stateOf = (node: NodeView): DeviceState => {
    const position = node.bindings.find(binding => binding.role === 'position' || binding.quantity === 'fraction')
    if (position !== undefined) {
      const value = percent(position)
      return value === null ? { kind: 'unknown' } : { kind: 'position', fraction: value / 100 }
    }
    const switching = node.bindings.find(binding => binding.role === 'running' || binding.role === 'conducting')
    const on = switching === undefined ? null : activeState(usable(switching)?.value, switching.states)
    return on === null ? { kind: 'unknown' } : { kind: on ? 'on' : 'off' }
  }
  // Active alerts of the drawn object by the element they are on.
  const alerted = new Map<string, Array<AlertRow['priority']>>()
  for (const row of alerts) {
    const subject = row.alert.subject
    if (row.objectId !== section.objectId || row.state === 'returned-unack' || subject === undefined || !('element' in subject)) continue
    alerted.set(subject.element, [...alerted.get(subject.element) ?? [], row.priority])
  }
  const toneAt = (nodes: ReadonlyArray<NodeView>): AlertTone | null => {
    const tones = nodes.flatMap(node => [...node.bindings.map(binding => toneOf(observed.get(binding.ref)?.priority)), ...(alerted.get(node.element ?? node.id) ?? []).map(priority => toneOf(priority ?? undefined))])
    return (['critical', 'alarm', 'warning', 'caution'] as const).find(level => tones.includes(level)) ?? null
  }

  const boxes = new Map(section.layout.nodes.map(node => [node.id, { x: px(node.x), y: px(node.y), width: px(node.width), height: px(node.height) }]))
  const inside = (box: Box) => (point: Point): boolean => point[0] >= box.x - 1 && point[0] <= box.x + box.width + 1 && point[1] >= box.y - 1 && point[1] <= box.y + box.height + 1
  const edges = section.layout.edges.map(edge => ({
    ...edge,
    view: viewEdges.get(edge.id) ?? viewEdges.get(edge.id.replace(/\.\d+$/, '')),
    points: edge.points.map(([x, y]) => [px(x), px(y)] as const),
    gaps: edge.gaps.map(([x, y]) => [px(x), px(y)] as const),
  }))
  const endsAt = (id: string) => edges.filter(edge => inside(boxes.get(id)!)(edge.points[0]!) || inside(boxes.get(id)!)(edge.points.at(-1)!))
  const thin = (box: Box): boolean => Math.min(box.width, box.height) < VIGNETTE_ROW_PX
  const symbols = new Map(section.layout.nodes.flatMap(node => {
    const view = byId.get(node.id)
    if (view === undefined) return []
    const media = [...new Set(endsAt(node.id).flatMap(edge => (edge.view === undefined ? [] : [edge.view.mediumKind])))]
    return [[node.id, symbolOf(view, media, thin(boxes.get(node.id)!))] as const]
  }))
  const states = new Map([...symbols.keys()].map(id => [id, stateOf(byId.get(id)!)]))

  // A pipe reads its flow where it is bound; else it is open unless a switch at either end reads shut, never emptied by what is not known.
  const lookOf = (edge: (typeof edges)[number]): PipeLook | 'open' => {
    const flow = edge.view?.bindings.find(binding => binding.role === 'flow')
    if (flow !== undefined) {
      const value = usable(flow)?.value
      return typeof value !== 'number' ? 'unknown' : value === 0 ? 'none' : value > 0 ? 'forward' : 'reverse'
    }
    const ends = [edge.points[0]!, edge.points.at(-1)!].map(point => [...boxes].find(([, box]) => inside(box)(point))?.[0])
    return ends.some(id => id !== undefined && ['valve', 'breaker'].includes(symbols.get(id) ?? '') && shut(states.get(id))) ? 'none' : 'open'
  }
  const segments: Segment[] = edges.flatMap(edge => {
    const look = lookOf(edge)
    const size = edge.view?.mediumKind.startsWith('electric') === true ? 'small' : 'medium'
    const value = look === 'open' ? 'open-generic' : pipeValue(look)
    const chevron = look === 'forward' || look === 'reverse' ? chevronSegment(edge.id, edge.points, edge.gaps, value, size, look === 'reverse') : null
    return [...pipeSegments(edge.id, edge.points, edge.gaps, value, size), ...(chevron === null ? [] : [chevron])]
  })

  const drawing: { devices: FlowDrawing['devices'][number][]; vessels: FlowDrawing['vessels'][number][]; buses: FlowDrawing['buses'][number][]; texts: FlowDrawing['texts'][number][] } = { devices: [], vessels: [], buses: [], texts: [] }
  for (const node of section.layout.nodes) {
    const view = byId.get(node.id)
    const symbol = symbols.get(node.id)
    if (view === undefined || symbol === undefined) continue
    const box = boxes.get(node.id)!
    const members = (node.members ?? [node.id]).flatMap(id => byId.get(id) ?? [])
    const tone = toneAt(members)
    const element = view.element ?? view.id
    const name = members.length > 1 ? groupName(members.map(member => member.shortLabel ?? member.label)) : view.shortLabel ?? view.label
    // A group says how many of its members run (or conduct); a lone item its state word in the words its observable
    // declares, or the command it does not follow (the observation's why), and its readings: the lines the layout
    // kept room for, in their order, an empty one left out.
    const counted = members.length > 1 ? members.map(stateOf) : []
    const role = members[0]!.bindings.some(binding => binding.role === 'running') ? 'RUN' : 'ON'
    const readingOf = (binding: TopologyBinding, valueType: 'number' | 'enum') => readingLook(view.label, valueType, binding.states, observedInput({ unit: binding.unit, quantity: binding.quantity, thresholds: [] }, shownReading(binding)))
    const written = itemText(view.bindings)
    const stateBinding = view.bindings.find(binding => binding.ref === written.state)
    const sized: ReadonlyArray<FlowLine> = members.length > 1
      ? [{ text: name, kind: 'name' }, { text: counted.some(state => state.kind === 'unknown') ? `${role} ?/${members.length}` : `${role} ${counted.filter(state => state.kind === 'on').length}/${members.length}`, kind: 'word' }]
      : [
        { text: name, kind: 'name' },
        // The command it does not follow stands in its state word's place, as today's CMD word does; the glyph shows its state.
        ...(written.state === null ? [] : [stateBinding === undefined ? { text: '', kind: 'word' as const }
          : usable(stateBinding)?.why !== undefined ? { text: usable(stateBinding)!.why!, kind: 'command' as const }
            : { text: stateBinding.states === undefined ? '' : readingOf(stateBinding, 'enum').text, kind: 'word' as const }]),
        ...written.readings.map(ref => {
          const look = readingOf(view.bindings.find(entry => entry.ref === ref)!, 'number')
          return { text: look.unit === '' ? look.text : `${look.text} ${look.unit}`, kind: 'reading' as const }
        }),
      ]
    const lines = sized.filter(line => line.text !== '')
    const title = [view.label, ...lines.slice(1).map(line => line.text)].join(' · ')
    if (node.text !== undefined) {
      const shown = sized.slice(0, Math.max(1, node.text.lines)).filter(line => line.text !== '')
      drawing.texts.push({ id: node.id, element: view.class === 'stop' ? null : element, x: px(node.text.x), y: px(node.text.y), width: px(node.text.width), lines: shown, tone, title })
    }
    const state: DeviceState = members.length > 1
      ? counted.some(entry => entry.kind === 'on') ? { kind: 'on' } : counted.some(entry => entry.kind === 'unknown') ? { kind: 'unknown' } : { kind: 'off' }
      : states.get(node.id)!
    const ports = Object.values(node.ports)
    const vertical = ports.some(port => port.face === 'top' || port.face === 'bottom') && !ports.some(port => port.face === 'left' || port.face === 'right')
    if (DEVICES.has(symbol)) {
      const centre = [box.x + box.width / 2, box.y + box.height / 2] as const
      drawing.devices.push({ id: node.id, element, glyph: glyphOf(symbol, state, vertical), x: centre[0], y: centre[1], on: passing(state), unknown: state.kind === 'unknown', vertical, orientation: vertical && symbol !== 'mover' ? 'verticalRight' : 'horizontal', tone, title })
    } else if (symbol === 'tank' || symbol === 'exchanger' || symbol === 'vessel') {
      const level = view.bindings.find(binding => binding.role === 'level')
      const parts = view.bindings.filter(binding => binding.role === 'position').map(binding => { const value = percent(binding); return value === null ? null : value / 100 })
      const nozzles = Object.values(node.ports).map(port => ({ x: px(port.x), y: px(port.y), face: port.face as Face }))
      drawing.vessels.push({
        id: node.id, element, kind: symbol, ...box, level: level === undefined ? null : percent(level), unknown: level !== undefined && percent(level) === null, tone, title,
        ...(symbol === 'vessel' ? { drawing: { span: { x: 0, width: box.width }, nozzles, core: parts.length > 0 ? 'overlap' as const : null }, parts } : {}),
      })
    } else if (symbol === 'bus' || symbol === 'header') {
      const horizontal = box.width >= box.height
      const at = horizontal ? box.y + box.height / 2 : box.x + box.width / 2
      if (symbol === 'header') segments.push({ kind: 'straight', connectionId: node.id, value: 'open-generic', size: 'large', ...(horizontal ? { x1: box.x, y1: at, x2: box.x + box.width, y2: at } : { x1: at, y1: box.y, x2: at, y2: box.y + box.height }) })
      else drawing.buses.push({ id: node.id, vertical: !horizontal, title, ...(horizontal ? { x: box.x, y: at - 8, width: box.width, height: 16 } : { x: at - 8, y: box.y, width: 16, height: box.height }) })
    } else if (symbol === 'junction') {
      // A junction drawn as a box: its lines meet at its centre.
      const centre = [box.x + box.width / 2, box.y + box.height / 2] as const
      for (const edge of endsAt(node.id)) {
        const end = inside(box)(edge.points[0]!) ? edge.points[0]! : edge.points.at(-1)!
        const look = lookOf(edge)
        segments.push(...pipeSegments(`${node.id}:${end.join(',')}`, stub(end, centre, box), [], look === 'open' ? 'open-generic' : pipeValue(look), edge.view?.mediumKind.startsWith('electric') === true ? 'small' : 'medium'))
      }
    } else if (symbol === 'end') {
      // Where the drawing stops, or meets another graph: OpenBridge's end cap on the line that arrives.
      for (const edge of endsAt(node.id)) {
        const out = inside(box)(edge.points.at(-1)!)
        const look = lookOf(edge)
        segments.push(stubEndSegment(`${edge.id}:end`, edge.points, out ? 'out' : 'in', look === 'open' ? 'open-generic' : pipeValue(look), edge.view?.mediumKind.startsWith('electric') === true ? 'small' : 'medium', look === 'forward'))
      }
    }
  }
  return { width: px(section.layout.width), height: px(section.layout.height), segments, ...drawing }
}
