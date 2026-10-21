// A network topology as drawn (architecture B2): the server's ELK layout in
// grid units, one grid unit a row. Buses are bars, switches small squares,
// every other node a box with its name and its lead bound reading; a stop
// names where the drawing ends. Edges keep a gap where another crosses them.
// Colour comes only from the bound observations' priorities.
import type { Observation } from '../../../core/observation/model.ts'
import { VIGNETTE_ROW_PX } from './grid.ts'
import type { VignetteSection } from './model.ts'
import { readingLook, toneOf, type AlertTone } from './readout.ts'

type Topology = Extract<VignetteSection, { kind: 'topology' }>
type Binding = Topology['nodes'][number]['bindings'][number]
type Point = readonly [number, number]

/** About this many pixels a character of the drawing's 12 px text takes; a name longer than its box allows is shortened. */
export const CHAR_PX = 7
/** Half the gap an edge leaves where another crosses it. */
const GAP_PX = 4

export interface DrawnNode {
  readonly id: string
  readonly shape: 'bar' | 'switch' | 'box' | 'stop'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly name: string
  readonly title: string
  /** The node's lead bound reading, on the line under its name: "512 MW". */
  readonly reading: string | null
  readonly tone: AlertTone | null
  /** A conducting binding that reads false: drawn dashed; null where it reads nothing. */
  readonly conducting: boolean | null
}

export interface NetworkDrawing {
  readonly width: number
  readonly height: number
  readonly groups: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly label: string }>
  readonly edges: ReadonlyArray<{ readonly id: string; readonly path: string }>
  readonly nodes: ReadonlyArray<DrawnNode>
}

/** A name shortened to whole characters that fit its room, ending in "…". */
export const fitName = (name: string, roomPx: number): string => {
  const most = Math.max(1, Math.floor(roomPx / CHAR_PX))
  return name.length <= most ? name : `${name.slice(0, Math.max(1, most - 1))}…`
}

/** An orthogonal polyline as a path, broken around each gap that lies on one of its segments. */
export const gappedPath = (points: ReadonlyArray<Point>, gaps: ReadonlyArray<Point>, half = GAP_PX): string => {
  const commands: string[] = []
  points.forEach((point, index) => {
    if (index === 0) { commands.push(`M${point[0]} ${point[1]}`); return }
    const from = points[index - 1]!
    const length = Math.hypot(point[0] - from[0], point[1] - from[1])
    const along = (gap: Point): number => Math.hypot(gap[0] - from[0], gap[1] - from[1])
    const onSegment = (gap: Point): boolean => Math.abs(along(gap) + Math.hypot(point[0] - gap[0], point[1] - gap[1]) - length) < 1e-6 && along(gap) > half && length - along(gap) > half
    for (const gap of gaps.filter(onSegment).sort((left, right) => along(left) - along(right))) {
      const ux = (point[0] - from[0]) / length
      const uy = (point[1] - from[1]) / length
      commands.push(`L${gap[0] - ux * half} ${gap[1] - uy * half}`, `M${gap[0] + ux * half} ${gap[1] + uy * half}`)
    }
    commands.push(`L${point[0]} ${point[1]}`)
  })
  return commands.join(' ')
}

const READING_ROLES: ReadonlyArray<Binding['role']> = ['loading', 'flow', 'level', 'value', 'running']

/** The observation a binding reads, if the sample holds it. */
const read = (binding: Binding, observations: ReadonlyArray<Observation>): Observation | undefined => observations.find(observation => observation.ref === binding.ref)

export const networkDrawing = (section: Topology, observations: ReadonlyArray<Observation>): NetworkDrawing => {
  const px = (grid: number): number => grid * VIGNETTE_ROW_PX
  const byId = new Map(section.nodes.map(node => [node.id, node]))
  const groups = new Map(section.groups.map(group => [group.id, group.label]))
  return {
    width: px(section.layout.width),
    height: px(section.layout.height),
    groups: section.layout.groups.map(group => ({ id: group.id, x: px(group.x), y: px(group.y), width: px(group.width), height: px(group.height), label: fitName(groups.get(group.id) ?? group.id, px(group.width) - 8) })),
    edges: section.layout.edges.map(edge => ({ id: edge.id, path: gappedPath(edge.points.map(([x, y]) => [px(x), px(y)] as const), edge.gaps.map(([x, y]) => [px(x), px(y)] as const)) })),
    nodes: section.layout.nodes.flatMap(box => {
      const node = byId.get(box.id)
      if (node === undefined) return []
      const bound = node.bindings.map(binding => ({ binding, observation: read(binding, observations) }))
      const conducting = bound.find(entry => entry.binding.role === 'conducting')?.observation?.value
      const lead = READING_ROLES.flatMap(role => bound.filter(entry => entry.binding.role === role && typeof entry.observation?.value === 'number'))[0]
      const reading = lead === undefined ? null : readingLook(node.label, 'number', undefined, { value: lead.observation!.value, unit: lead.binding.unit, thresholds: [] })
      const worst = bound.map(entry => toneOf(entry.observation?.priority)).filter(tone => tone !== null)
      const shape = node.class === 'stop' ? 'stop' : node.class === 'bus' ? 'bar' : node.class === 'switch' ? 'switch' : 'box'
      const width = px(box.width)
      return [{
        id: node.id,
        shape,
        x: px(box.x),
        y: px(box.y),
        width,
        height: px(box.height),
        name: fitName(node.shortLabel ?? node.label, width - 6),
        title: node.label,
        reading: reading === null ? null : `${reading.text}${reading.unit === '' ? '' : ` ${reading.unit}`}`,
        tone: (['critical', 'alarm', 'warning', 'caution'] as const).find(tone => worst.includes(tone)) ?? null,
        conducting: typeof conducting === 'boolean' ? conducting : null,
      }]
    }),
  }
}
