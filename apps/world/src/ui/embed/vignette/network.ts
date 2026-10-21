// A network topology as drawn (architecture B2), in OpenBridge: the server's
// ELK layout in grid units, one grid unit a row. Lines are connector-diagram
// segments with its crossing gaps and end caps (as the mimic draws pipes);
// buses are obc-bus; switches, converters and sources are obc-switch,
// obc-transformer and obc-source; a line element is a line through its box.
// Names and readings are text. Colour comes only from the bound observations'
// priorities; "on" only from a boolean or a state declared active (ruling Q8).
import type { Segment } from '@oicl/connector-diagram'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import { pipeSegments, stubEndSegment } from '../composed-display/mimic/pipe-segments.ts'
import { VIGNETTE_ROW_PX } from './grid.ts'
import type { TopologyBinding, VignetteSection } from '../../../features/displays/compose/model.ts'
import { activeState, readingLook, toneOf, type AlertTone } from './readout.ts'

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type Point = readonly [number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** About this many pixels a character of the drawing's 12 px text takes; a name longer than its room allows is shortened. */
export const CHAR_PX = 7
/** OpenBridge's device symbol is two grid cells square. */
const SYMBOL_PX = 2 * VIGNETTE_ROW_PX
const BUS_PX = 16

/** The OpenBridge device each node class is drawn as; a class not listed is no device. */
const DEVICES: Readonly<Partial<Record<Topology['nodes'][number]['class'], 'obc-switch' | 'obc-transformer' | 'obc-source'>>> = {
  switch: 'obc-switch', converter: 'obc-transformer', source: 'obc-source',
}

export interface NetworkDrawing {
  readonly width: number
  readonly height: number
  /** A station or other group: a frame with its name (no OpenBridge component draws a group). */
  readonly groups: ReadonlyArray<Box & { readonly id: string; readonly label: string }>
  /** Lines, line elements, and the caps where the drawing stops: connector-diagram segments. */
  readonly segments: ReadonlyArray<Segment>
  readonly buses: ReadonlyArray<Box & { readonly id: string; readonly vertical: boolean; readonly label: string; readonly title: string }>
  /** Each at its symbol's centre (OpenBridge's `point` positioning). */
  readonly devices: ReadonlyArray<{ readonly id: string; readonly element: 'obc-switch' | 'obc-transformer' | 'obc-source'; readonly x: number; readonly y: number; readonly on: boolean; readonly tone: AlertTone | null; readonly title: string }>
  /** Names, with the lead reading on the same row or on the row below the line through a line element. */
  readonly texts: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly name: string; readonly reading: string | null; readonly below: boolean; readonly tone: AlertTone | null; readonly title: string }>
}

/** A name shortened to whole characters that fit its room, ending in "…". */
export const fitName = (name: string, roomPx: number): string => {
  const most = Math.max(1, Math.floor(roomPx / CHAR_PX))
  return name.length <= most ? name : `${name.slice(0, Math.max(1, most - 1))}…`
}

/**
 * A bus's bar: along the one face its edge ends meet (feeders all on one
 * side), across the box between two opposite faces (feeders on both sides),
 * and across the box's middle along its longer side where none or all meet it.
 */
export const barLine = (box: Box, ends: ReadonlyArray<Point>): { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } => {
  const near = ends.filter(([x, y]) => x >= box.x - 1 && x <= box.x + box.width + 1 && y >= box.y - 1 && y <= box.y + box.height + 1)
  const on = (x: number, edge: number): boolean => Math.abs(x - edge) < 1
  const left = near.filter(([x]) => on(x, box.x))
  const right = near.filter(([x]) => on(x, box.x + box.width))
  const top = near.filter(([, y]) => on(y, box.y))
  const bottom = near.filter(([, y]) => on(y, box.y + box.height))
  const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length
  const across = { horizontal: (y: number) => ({ x1: box.x, y1: y, x2: box.x + box.width, y2: y }), vertical: (x: number) => ({ x1: x, y1: box.y, x2: x, y2: box.y + box.height }) }
  const sideways = left.length + right.length === near.length && near.length > 0
  const upright = top.length + bottom.length === near.length && near.length > 0
  if (sideways && (left.length === 0 || right.length === 0)) return across.vertical(left.length > 0 ? box.x : box.x + box.width)
  if (sideways) return across.horizontal(mean(near.map(([, y]) => y)))
  if (upright && (top.length === 0 || bottom.length === 0)) return across.horizontal(top.length > 0 ? box.y : box.y + box.height)
  if (upright) return across.vertical(mean(near.map(([x]) => x)))
  return box.width >= box.height ? across.horizontal(box.y + box.height / 2) : across.vertical(box.x + box.width / 2)
}

/** An orthogonal path from an edge end on a box's face to a point inside it: straight in, then along. */
export const stub = (end: Point, to: Point, box: Box): ReadonlyArray<Point> => {
  const sideways = Math.abs(end[0] - box.x) < 1 || Math.abs(end[0] - (box.x + box.width)) < 1
  if ((sideways && end[1] === to[1]) || (!sideways && end[0] === to[0])) return [end, to]
  return sideways ? [end, [to[0], end[1]], to] : [end, [end[0], to[1]], to]
}

/** STAND-IN until p2-core's c5d2b6cad (bindings carry their observable's states) reaches the integration branch. */
const statesOf = (binding: TopologyBinding): Observable['states'] => (binding as TopologyBinding & Partial<Pick<Observable, 'states'>>).states

const READING_ROLES: ReadonlyArray<TopologyBinding['role']> = ['loading', 'flow', 'level', 'value']

export const networkDrawing = (section: Topology, observations: ReadonlyArray<Observation>): NetworkDrawing => {
  const px = (grid: number): number => grid * VIGNETTE_ROW_PX
  const byId = new Map(section.nodes.map(node => [node.id, node]))
  const groupLabels = new Map(section.groups.map(group => [group.id, group.label]))
  const read = (binding: TopologyBinding): Observation | undefined => observations.find(observation => observation.ref === binding.ref)
  const conducting = (id: string): boolean | null => {
    const binding = byId.get(id)?.bindings.find(entry => entry.role === 'conducting')
    return binding === undefined ? null : activeState(read(binding)?.value, statesOf(binding))
  }
  const edges = section.layout.edges.map(edge => ({ ...edge, points: edge.points.map(([x, y]) => [px(x), px(y)] as const), gaps: edge.gaps.map(([x, y]) => [px(x), px(y)] as const) }))
  const ends = edges.flatMap(edge => [edge.points[0]!, edge.points.at(-1)!])
  const at = (box: Box) => (point: Point): boolean => point[0] >= box.x - 1 && point[0] <= box.x + box.width + 1 && point[1] >= box.y - 1 && point[1] <= box.y + box.height + 1
  const boxes = new Map(section.layout.nodes.map(node => [node.id, { x: px(node.x), y: px(node.y), width: px(node.width), height: px(node.height) }]))
  const nodeAt = (point: Point): string | undefined => [...boxes].find(([, box]) => at(box)(point))?.[0]
  // A line goes empty where a node at either end reads off; else it is drawn as an open line.
  const lineValue = (points: ReadonlyArray<Point>) => [nodeAt(points[0]!), nodeAt(points.at(-1)!)].some(id => id !== undefined && conducting(id) === false) ? 'empty' : 'open-generic'
  const segments: Segment[] = edges.flatMap(edge => pipeSegments(edge.id, edge.points, edge.gaps, lineValue(edge.points), 'small'))
  const drawing: { buses: NetworkDrawing['buses'][number][]; devices: NetworkDrawing['devices'][number][]; texts: NetworkDrawing['texts'][number][] } = { buses: [], devices: [], texts: [] }
  for (const [id, box] of boxes) {
    const node = byId.get(id)
    if (node === undefined) continue
    const bound = node.bindings.map(binding => ({ binding, observation: read(binding) }))
    const tones = bound.map(entry => toneOf(entry.observation?.priority)).filter(tone => tone !== null)
    const tone = (['critical', 'alarm', 'warning', 'caution'] as const).find(level => tones.includes(level)) ?? null
    const lead = READING_ROLES.flatMap(role => bound.filter(entry => entry.binding.role === role && typeof entry.observation?.value === 'number'))[0]
    const look = lead === undefined ? null : readingLook(node.label, 'number', undefined, { value: lead.observation!.value, unit: lead.binding.unit, thresholds: [] })
    const reading = look === null ? null : `${look.text}${look.unit === '' ? '' : ` ${look.unit}`}`
    const name = node.shortLabel ?? node.label
    const here = ends.filter(at(box))
    const text = (x: number, y: number, width: number, shown: 'name' | 'beside' | 'below') => drawing.texts.push({
      id, x, y, width, name: fitName(name, shown === 'beside' && reading !== null ? width - (reading.length + 3) * CHAR_PX : width),
      reading: shown === 'name' ? null : reading, below: shown === 'below', tone, title: `${node.label}${reading === null ? '' : ` · ${reading}`}`,
    })
    const element = DEVICES[node.class]
    if (node.class === 'bus') {
      const line = barLine(box, here)
      const vertical = line.x1 === line.x2
      const length = vertical ? line.y2 - line.y1 : line.x2 - line.x1
      // The bar carries its name where it fits and no alert does (obc-bus has no alert state); else the name is text beside it.
      const inBar = tone === null && fitName(name, length - 8) === name
      drawing.buses.push({ id, vertical, label: inBar ? name : '', title: node.label, x: vertical ? line.x1 - BUS_PX / 2 : line.x1, y: vertical ? line.y1 : line.y1 - BUS_PX / 2, width: vertical ? BUS_PX : length, height: vertical ? length : BUS_PX })
      if (!inBar) text(box.x, box.y, box.width - (vertical ? BUS_PX : 0), 'name')
    } else if (element !== undefined) {
      const centre = [box.x + box.width / 2, box.y + SYMBOL_PX / 2] as const
      segments.push(...here.flatMap(end => pipeSegments(`${id}:${end.join(',')}`, stub(end, centre, box), [], lineValue([end, end]), 'small')))
      drawing.devices.push({ id, element, x: centre[0], y: centre[1], on: conducting(id) === true, tone, title: `${node.label}${reading === null ? '' : ` · ${reading}`}` })
      text(box.x, box.y + SYMBOL_PX, box.width, 'beside')
    } else if (node.class === 'stop' || node.class === 'boundary') {
      // Where the drawing stops, or meets another graph: OpenBridge's end cap on the line that arrives.
      for (const edge of edges) {
        const into = at(box)(edge.points.at(-1)!) ? 'out' : at(box)(edge.points[0]!) ? 'in' : null
        if (into !== null) segments.push(stubEndSegment(`${edge.id}:end`, edge.points, into, lineValue(edge.points), 'small', false))
      }
      text(box.x + 6, box.y, box.width - 6, 'beside')
    } else if (node.class !== 'junction') {
      // A line element (a branch): one line through its box from end to end, its name above and its reading below.
      const centre = [box.x + box.width / 2, here.length > 0 ? here.reduce((sum, end) => sum + end[1], 0) / here.length : box.y + box.height / 2] as const
      segments.push(...here.flatMap(end => pipeSegments(`${id}:${end.join(',')}`, stub(end, centre, box), [], conducting(id) === false ? 'empty' : 'open-generic', 'small')))
      text(box.x, box.y, box.width, 'below')
    }
  }
  return {
    width: px(section.layout.width),
    height: px(section.layout.height),
    groups: section.layout.groups.map(group => ({ id: group.id, x: px(group.x), y: px(group.y), width: px(group.width), height: px(group.height), label: fitName(groupLabels.get(group.id) ?? group.id, px(group.width) - 8) })),
    segments,
    ...drawing,
  }
}
