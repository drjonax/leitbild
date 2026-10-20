// What a node occupies: its symbol box, its text stack and its alarm frame.
// Text and frame are screen concepts (a stack sits right of or below its
// symbol, a flap hangs below its frame), so they are built in screen terms
// and mapped to the layout axes of the orientation.
import type { DiagramProfile, Face } from './diagram.ts'
import { axisFace, floorTo, type AxisBox, type AxisFace, type Orientation } from './geometry.ts'
import type { ModelNode } from './model.ts'

/** A symbol's stack sits right of it or below it; a bar's label sits at one of its ends. */
export type TextSide = Face

export interface Dressed {
  readonly box: AxisBox
  readonly text: { readonly box: AxisBox; readonly side: TextSide; readonly lines: number } | null
  readonly frame: AxisBox | null
  /** Everything the node occupies. */
  readonly reserve: AxisBox
}

export const union = (a: AxisBox, b: AxisBox): AxisBox => ({
  f0: Math.min(a.f0, b.f0), f1: Math.max(a.f1, b.f1), c0: Math.min(a.c0, b.c0), c1: Math.max(a.c1, b.c1),
})

/** A footprint around its anchor: centred, with both faces on the grid. */
export const footprint = (along: number, across: number, grid: number): AxisBox => {
  const below = floorTo(along / 2, grid)
  const left = floorTo(across / 2, grid)
  return { f0: -below, f1: along - below, c0: -left, c1: across - left }
}

export const shiftBox = (box: AxisBox, f: number, c: number): AxisBox => ({ f0: box.f0 + f, f1: box.f1 + f, c0: box.c0 + c, c1: box.c1 + c })

/** Lines a detail level keeps: all, or the prefix through the last required line. */
export const keptLines = (node: ModelNode, detail: 'full' | 'required'): number => {
  if (detail === 'full') return node.lines.length
  let last = 0
  node.lines.forEach((line, index) => { if (line.required) last = index + 1 })
  return last
}

/** The first of right and below that carries no pipe. */
export const chooseTextSide = (orientation: Orientation, pipeFaces: ReadonlySet<AxisFace>): 'right' | 'bottom' =>
  pipeFaces.has(axisFace(orientation, 'right')) && !pipeFaces.has(axisFace(orientation, 'bottom')) ? 'bottom' : 'right'

const centredOn = (low: number, high: number, size: number): readonly [number, number] => {
  const middle = (low + high) / 2
  return [middle - size / 2, middle + size / 2]
}

/**
 * Text beside `box` on `side`, `gap` away, centred along that side (screen
 * terms: width runs along x, height along y).
 */
const textBox = (orientation: Orientation, box: AxisBox, side: TextSide, width: number, height: number, gap: number): AxisBox => {
  const face = axisFace(orientation, side)
  // Extent of the text along f and c in this orientation.
  const alongF = orientation === 'leftToRight' ? width : height
  const alongC = orientation === 'leftToRight' ? height : width
  if (face === '+f' || face === '-f') {
    const [c0, c1] = centredOn(box.c0, box.c1, alongC)
    return face === '+f' ? { f0: box.f1 + gap, f1: box.f1 + gap + alongF, c0, c1 } : { f0: box.f0 - gap - alongF, f1: box.f0 - gap, c0, c1 }
  }
  const [f0, f1] = centredOn(box.f0, box.f1, alongF)
  return face === '+c' ? { f0, f1, c0: box.c1 + gap, c1: box.c1 + gap + alongC } : { f0, f1, c0: box.c0 - gap - alongC, c1: box.c0 - gap }
}

/** The alarm frame around the button box, its flap's lines below, widened (centred) for a wide flap label. */
const frameBox = (orientation: Orientation, button: AxisBox, node: ModelNode, profile: DiagramProfile): AxisBox => {
  const m = profile.frameMargin
  const grown = { f0: button.f0 - m, f1: button.f1 + m, c0: button.c0 - m, c1: button.c1 + m }
  const flap = profile.flapHeight * node.flapLines
  const flapped = orientation === 'leftToRight'
    ? { ...grown, c1: grown.c1 + flap }
    : { ...grown, f0: grown.f0 - flap }
  const wanted = node.flapWidth > 0 ? node.flapWidth + profile.flapLabelPadding : 0
  if (orientation === 'leftToRight') {
    if (wanted <= flapped.f1 - flapped.f0) return flapped
    const [f0, f1] = centredOn(flapped.f0, flapped.f1, wanted)
    return { ...flapped, f0, f1 }
  }
  if (wanted <= flapped.c1 - flapped.c0) return flapped
  const [c0, c1] = centredOn(flapped.c0, flapped.c1, wanted)
  return { ...flapped, c0, c1 }
}

export const dress = (args: {
  readonly orientation: Orientation
  readonly profile: DiagramProfile
  readonly node: ModelNode
  readonly box: AxisBox
  readonly lines: number
  readonly side: TextSide
  /** Distance between box and text: none for a symbol, whose stack is part of its button. */
  readonly gap: number
}): Dressed => {
  const { orientation, profile, node, box, lines, side, gap } = args
  const shown = node.lines.slice(0, lines)
  const text = shown.length === 0
    ? null
    : {
      box: textBox(orientation, box, side, Math.max(...shown.map(line => line.width)), shown.reduce((sum, line) => sum + line.height, 0), gap),
      side,
      lines,
    }
  const button = text === null ? box : union(box, text.box)
  const frame = node.frameable ? frameBox(orientation, button, node, profile) : null
  return { box, text, frame, reserve: frame === null ? button : union(button, frame) }
}

/**
 * In vertical flow a stack below a symbol covers its upstream face, so its
 * in-ports enter the left side instead: port j rises in its own column, a
 * grid step further out than port j − 1 and clear of the stack, and turns
 * into the j-th grid slot of the side face counted from upstream. Nested this
 * way the approaches never cross each other.
 */
export interface SideEntry {
  /** Per in-port index: riser column and side slot, relative to the node's anchor. */
  readonly ports: ReadonlyMap<number, { readonly riser: number; readonly slot: number }>
  /** The outermost riser's reach across, relative to the anchor. */
  readonly reach: number
}

/** Null when the side face has fewer grid slots than the node has in-ports. */
export const planSideEntry = (node: ModelNode, box: AxisBox, text: AxisBox | null, profile: DiagramProfile): SideEntry | null => {
  const grid = profile.grid
  const outline = profile.pipe.outline
  const inPorts = node.ports.map((port, index) => ({ port, index })).filter(entry => entry.port.use === 'target')
  const slots: number[] = []
  for (let at = box.f0 + grid; at < box.f1; at += grid) slots.push(at)
  if (inPorts.length > slots.length) return null
  // Clear of the stack by more than half a pipe, and a grid from the symbol so the turn has room.
  const base = floorTo(Math.min(box.c0 - grid, (text?.c0 ?? box.c0) - outline / 2 - 2), grid)
  const ports = new Map(inPorts.map((entry, j) => [entry.index, { riser: base - j * grid, slot: slots[j]! }] as const))
  return { ports, reach: base - Math.max(0, inPorts.length - 1) * grid - outline / 2 - 1 }
}
