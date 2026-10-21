// One layout attempt: an orientation and a text detail level, from the
// orientation-free structure (cycles, layers, order) to screen geometry.
import { placeAcross, type LabelRoom } from './across.ts'
import { placeAlong, type LayerExtent } from './along.ts'
import { attach } from './attach.ts'
import { planChannels, trackKey } from './channels.ts'
import type { DiagramProfile, Face, PlacedNode } from './diagram.ts'
import { axisFace, ceilTo, floorTo, screenFace, toScreen, toScreenRect, translateRect, type AxisBox, type AxisFace, type Orientation, type Point, type Rect } from './geometry.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import type { Ordering } from './ordering.ts'
import { chooseTextSide, dress, footprint, keptLines, planSideEntry, shiftBox, type Dressed, type SideEntry, type TextSide } from './shapes.ts'
import type { Structure } from './structure.ts'

export type Detail = DiagramProfile['fit'][number]['detail']
/**
 * Where symbols' text stacks go: right of each symbol where its pipes allow;
 * the same with the labels of partitions' stubs below their ends; below the
 * symbols of partitions; or below every symbol. Below is narrower and taller, and
 * right is the richer drawing.
 */
export type TextPolicy = DiagramProfile['fit'][number]['text']

/** Everything that does not depend on orientation or detail. */
export interface Prepared {
  readonly model: Model
  readonly structure: Structure
  readonly layering: Layering
  readonly ordering: Ordering
  /** Per node: drawn mirrored, its in-ports downstream and out-ports upstream (a folded return leg). */
  readonly flipped: ReadonlyArray<boolean>
  /**
   * A refined arrangement: long edges run before the symbols they are ordered
   * before (across.ts), and a channel's tracks pack at half a grid except
   * between nets that cross there (channels.ts).
   */
  readonly refine: boolean
  readonly pipeFaces: ReadonlyArray<ReadonlySet<AxisFace>>
  /**
   * Per node: a busy flow face grows before its anchor instead of after it,
   * toward the bars that feed it: their ports take the slots on that side,
   * and the bars end before the face's other pipes.
   */
  readonly growLow: ReadonlyArray<boolean>
}

export interface AttemptGeometry {
  readonly orientation: Orientation
  readonly detail: Detail
  readonly policy: TextPolicy
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<PlacedNode>
  readonly paths: ReadonlyArray<ReadonlyArray<Point>>
}

export const prepare = (model: Model, structure: Structure, layering: Layering, ordering: Ordering, flipped: ReadonlyArray<boolean>, refine: boolean): Prepared => {
  const pipeFaces = model.nodes.map(node => {
    const faces = new Set<AxisFace>()
    if (node.role === 'common') {
      if (node.ports.some(port => port.use !== 'unused')) faces.add(ordering.commonSide === 'low' ? '+c' : '-c')
      return faces
    }
    if (node.ports.some(port => port.use === 'target')) faces.add(flipped[node.index] ? '+f' : '-f')
    if (node.ports.some(port => port.use === 'source')) faces.add(flipped[node.index] ? '-f' : '+f')
    return faces
  })
  // A busy face grows before its anchor when the bars feeding it reach mostly from before it: by order in
  // their own layer, else by block.
  const items = layering.items
  const position = new Map(ordering.layers.flatMap(layer => layer.map((item, index) => [item, index] as const)))
  const roleOf = (item: number) => (items[item]!.node === null ? null : model.nodes[items[item]!.node!]!.role)
  const sideOf = (item: number, of: number): number => items[item]!.layer === items[of]!.layer
    ? Math.sign(position.get(item)! - position.get(of)!)
    : Math.sign(ordering.block[item]! - ordering.block[of]!)
  const barNeighbours = new Map<number, number[]>()
  for (const chain of layering.chains) {
    chain.steps.forEach((step, k) => {
      if (step !== 'next') return
      const [a, b] = [chain.items[k]!, chain.items[k + 1]!]
      if (roleOf(a) === 'bar') barNeighbours.set(a, [...(barNeighbours.get(a) ?? []), b])
      if (roleOf(b) === 'bar') barNeighbours.set(b, [...(barNeighbours.get(b) ?? []), a])
    })
  }
  const growLow = model.nodes.map(node => node.role !== 'bar' && node.role !== 'common' && [...barNeighbours.values()]
    .filter(neighbours => neighbours.includes(node.index))
    .flatMap(neighbours => neighbours.filter(other => other !== node.index && roleOf(other) !== 'common'))
    .reduce((sum, other) => sum + sideOf(other, node.index), 0) < 0)
  return { model, structure, layering, ordering, flipped, refine, pipeFaces, growLow }
}

export const runAttempt = (prepared: Prepared, profile: DiagramProfile, orientation: Orientation, detail: Detail, policy: TextPolicy): AttemptGeometry => {
  const { model, structure, layering, ordering } = prepared
  const grid = profile.grid
  const outline = profile.pipe.outline
  const items = layering.items
  const nodeCount = model.nodes.length
  const kept = model.nodes.map(node => keptLines(node, detail))
  // Screen footprints in the flow axes; flow faces run across. A face of n
  // grid steps has n − 1 interior grid points, so a busy face grows.
  const alongCells = (node: Model['nodes'][number]): number => (orientation === 'leftToRight' ? node.width : node.height)
  const footprintOf = (node: Model['nodes'][number], sideEntry: boolean): AxisBox => {
    const own = orientation === 'leftToRight' ? node.height : node.width
    const ports = (['source', 'target'] as const).filter(use => !(sideEntry && use === 'target')).map(use => node.ports.filter(port => port.use === use).length)
    const across = node.role === 'common' ? own : Math.max(own, Math.ceil(((Math.max(0, ...ports) + 1) * grid) / profile.cell))
    const box = footprint(alongCells(node) * profile.cell, across * profile.cell, grid)
    if (across === own || !prepared.growLow[node.index]) return box
    // Grown toward the bars that feed it: the symbol's own footprint keeps its place on the anchor.
    const c1 = footprint(alongCells(node) * profile.cell, own * profile.cell, grid).c1
    return { ...box, c0: c1 - across * profile.cell, c1 }
  }
  const dressAt = (node: number, box: AxisBox, side: TextSide): Dressed =>
    dress({ orientation, profile, node: model.nodes[node]!, box, lines: kept[node]!, side, gap: model.nodes[node]!.role === 'bar' ? outline : 0 })
  // Text side per node. A stack below a symbol whose lower face takes pipes
  // (vertical flow) sends its in-ports to the side; without room there the
  // symbol keeps its stack on the right.
  const side: TextSide[] = []
  const entries: Array<SideEntry | null> = []
  const shape: Array<AxisBox | null> = []
  for (const node of model.nodes) {
    if (node.role === 'bar') {
      side.push(screenFace(orientation, '+c'))
      entries.push(null)
      shape.push(null)
      continue
    }
    const bottom = axisFace(orientation, 'bottom')
    // Refined, a common node's label goes on its downstream end, which no pipe reaches: beside the common node it would widen the partitions' band.
    if (prepared.refine && node.role === 'common') {
      side.push(screenFace(orientation, '+f'))
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const fallback = chooseTextSide(orientation, prepared.pipeFaces[node.index]!)
    // A partition's stub's label goes below its end where no pipe leaves that way: the partitions narrower, and only a line taller.
    // Stubs beside the partitions keep theirs at the right, where it widens nothing a partition repeats.
    if (policy === 'stubsBelow' && node.role === 'stub' && node.partition !== null && !prepared.pipeFaces[node.index]!.has(bottom)) {
      side.push('bottom')
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const below = (node.role === 'device' || node.role === 'stub') && (policy === 'allBelow' || (policy === 'partitionsBelow' && node.partition !== null))
    if (!below || !prepared.pipeFaces[node.index]!.has(bottom)) {
      side.push(below ? 'bottom' : fallback)
      entries.push(null)
      shape.push(footprintOf(node, false))
      continue
    }
    const box = footprintOf(node, true)
    const entry = bottom === '-f' && !prepared.flipped[node.index] ? planSideEntry(node, box, dressAt(node.index, box, 'bottom').text?.box ?? null, profile) : null
    side.push(entry === null ? fallback : 'bottom')
    entries.push(entry)
    shape.push(entry === null ? footprintOf(node, false) : box)
  }
  const dressNode = (node: number, box: AxisBox): Dressed => dressAt(node, box, side[node]!)
  const relative = model.nodes.map(node => {
    const own = shape[node.index]
    return own === null || own === undefined ? null : dressNode(node.index, own)
  })
  // A pipe reserves its half width and a pixel, so nothing touches it; it has no solid reach.
  const reachOf = (item: number, key: 'c0' | 'c1', withRisers: boolean): number => {
    const node = items[item]!.node
    if (node === null) return withRisers ? outline / 2 + 1 : -Infinity
    const own = relative[node]
    if (own === null || own === undefined) return 0
    const value = key === 'c0' ? -own.reserve.c0 : own.reserve.c1
    const entry = entries[node]
    return withRisers && key === 'c0' && entry !== null && entry !== undefined ? Math.max(value, -entry.reach) : value
  }
  const left = items.map((_, item) => reachOf(item, 'c0', true))
  const right = items.map((_, item) => reachOf(item, 'c1', true))
  const leftSolid = items.map((_, item) => reachOf(item, 'c0', false))
  const rightSolid = items.map((_, item) => reachOf(item, 'c1', false))

  // Across, attachments, channels and along, then each bar's label end; once more with room kept for the
  // labels that found neither end free, where the shared items before a bar's span can give it.
  const place = (room: ReadonlyArray<LabelRoom>) => {
    const across = placeAcross({ model, profile, layering, ordering, left, right, leftSolid, rightSolid, refine: prepared.refine, flipped: prepared.flipped, room, net: structure.net })
    const attachAt = (anchors: ReadonlyArray<number>) => attach({
      model, profile, layering, ordering, c: anchors, entries,
      box: model.nodes.map(node => (shape[node.index] === null ? { f0: 0, f1: 0, c0: 0, c1: 0 } : shiftBox(shape[node.index]!, 0, anchors[node.index]!))),
    })
    // Strands line up with the ports their ends were given, until none can move.
    let c = across.c
    let attached = attachAt(c)
    for (let next = across.align(attached); next !== null; next = across.align(attached)) {
      c = next
      attached = attachAt(c)
    }
    const plan = planChannels({ model, profile, layering, structure, pin: attached.pin, tighten: prepared.refine })

    // Bars: a line `outline` thick, rows a grid apart.
    const barLine = (node: number): AxisBox => ({ f0: -outline / 2, f1: outline / 2, c0: attached.span[node]![0], c1: attached.span[node]![1] })
    const extents: LayerExtent[] = Array.from({ length: layering.layerCount }, () => ({ lowReserve: 0, highReserve: 0, lowFace: 0, highFace: 0 }))
    for (const node of model.nodes) {
      if (node.role === 'common') continue
      const layer = items[node.index]!.layer
      const current = extents[layer]!
      if (node.role === 'bar') {
        const row = attached.barRow[node.index]! * grid
        const reserve = dressNode(node.index, barLine(node.index)).reserve
        extents[layer] = {
          lowReserve: Math.max(current.lowReserve, -(row + reserve.f0)),
          highReserve: Math.max(current.highReserve, row + reserve.f1),
          lowFace: current.lowFace,
          highFace: Math.max(current.highFace, row),
        }
        continue
      }
      const reserve = relative[node.index]!.reserve
      extents[layer] = {
        lowReserve: Math.max(current.lowReserve, -reserve.f0),
        highReserve: Math.max(current.highReserve, reserve.f1),
        lowFace: Math.max(current.lowFace, -shape[node.index]!.f0),
        highFace: Math.max(current.highFace, shape[node.index]!.f1),
      }
    }
    const along = placeAlong(profile, extents, plan)
    const trackF = (channel: number, net: number): number => along.firstTrack[channel]! + plan.offset[channel]![plan.track.get(trackKey(channel, net))!]!

    // Common nodes grow along their side face to cover their tracks.
    const commonPorts = model.nodes.map(() => new Map<number, Set<number>>())
    layering.chains.forEach((chain, index) => chain.steps.forEach((_, k) => {
      for (const position of [k, k + 1]) {
        const item = chain.items[position]!
        if (item >= nodeCount || model.nodes[item]!.role !== 'common') continue
        const edge = model.edges[chain.edge]!
        const port = item === edge.from ? edge.fromPort : edge.toPort
        const tracks = commonPorts[item]!.get(port) ?? new Set<number>()
        const jog = plan.jog[index]![k]!
        tracks.add(trackF(jog.channel, jog.net))
        commonPorts[item]!.set(port, tracks)
      }
    }))
    const box: AxisBox[] = model.nodes.map(node => {
      const layer = items[node.index]!.layer
      if (node.role === 'bar') return shiftBox(barLine(node.index), along.axis[layer]! + attached.barRow[node.index]! * grid, 0)
      const placed = shiftBox(shape[node.index]!, along.axis[layer]!, c[node.index]!)
      if (node.role !== 'common') return placed
      const tracks = [...commonPorts[node.index]!.values()].flatMap(set => [...set])
      if (tracks.length === 0) return placed
      const low = Math.min(...tracks)
      const high = Math.max(...tracks)
      const size = alongCells(node) * profile.cell
      // Flowing up the screen, its ports face sideways: its top on screen is its high end along the flow.
      const ends = orientation === 'bottomToTop' ? node.ends : null
      const f0 = floorTo(Math.min(low - Math.max(grid, ends?.bottom ?? 0), (low + high) / 2 - size / 2), grid)
      const f1 = Math.max(f0 + size, ceilTo(high + Math.max(grid, ends?.top ?? 0), grid))
      return { f0, f1, c0: placed.c0, c1: placed.c1 }
    })
    commonPorts.forEach((ports, node) => ports.forEach((tracks, port) => {
      if (tracks.size > 1) throw new Error(`common ${model.nodes[node]!.id} port ${model.nodes[node]!.ports[port]!.id} would need two places on its face; split its edges over separate ports`)
    }))
    // A bar's label goes to the first end no vertical run passes: runs through
    // its layer (dummies), and runs to the other bars of its stack that cross
    // its row. It keeps clear of the common nodes beside the layers and of the frames of
    // the bars stacked with it (a bar's frame spans its whole line, as wide as
    // its label), both ways. Either end reserves the same room along the flow,
    // so the end is chosen once everything is placed.
    const apart = (a: AxisBox | null | undefined, b: AxisBox | null | undefined): boolean => a === null || a === undefined || b === null || b === undefined
      || a.f1 + profile.textClearance <= b.f0 || b.f1 + profile.textClearance <= a.f0 || a.c1 + profile.textClearance <= b.c0 || b.c1 + profile.textClearance <= a.c0
    const overlaps = (a: AxisBox, b: AxisBox): boolean => a.f0 < b.f1 && b.f0 < a.f1 && a.c0 < b.c1 && b.c0 < a.c1
    const commonsDressed = model.nodes.filter(node => node.role === 'common').map(node => dressNode(node.index, box[node.index]!))
    const barSide = new Map<number, TextSide>()
    const sideOf = (node: number): TextSide => barSide.get(node) ?? side[node]!
    const blocked: LabelRoom[] = []
    for (const bar of model.nodes.filter(node => node.role === 'bar')) {
      const layer = items[bar.index]!.layer
      const row = attached.barRow[bar.index]!
      const dummies = items.flatMap((item, index) => (item.node === null && item.layer === layer ? [index] : []))
      const columns = dummies.map(item => c[item]!)
      const attachments: Array<{ readonly item: number; readonly pin: number }> = []
      layering.chains.forEach((chain, index) => chain.items.forEach((item, position) => {
        if (item === bar.index) attachments.push({ item: chain.items[position === 0 ? 1 : position - 1]!, pin: attached.pin[index]![position]! })
        if (item === bar.index || item >= nodeCount || model.nodes[item]!.role !== 'bar' || items[item]!.layer !== layer) return
        const neighbour = chain.items[position === 0 ? 1 : position - 1]!
        const otherRow = attached.barRow[item]!
        if (items[neighbour]!.layer < layer ? row < otherRow : row > otherRow) columns.push(attached.pin[index]![position]!)
      }))
      const stacked = model.nodes.filter(other => other.role === 'bar' && other.index !== bar.index && items[other.index]!.layer === layer)
      const label = (end: AxisFace) => dress({ orientation, profile, node: bar, box: box[bar.index]!, lines: kept[bar.index]!, side: screenFace(orientation, end), gap: outline })
      const free = (end: AxisFace): boolean => {
        const own = label(end)
        const text = own.text
        if (text === null) return true
        const [low, high] = [text.box.c0 - outline / 2, text.box.c1 + outline / 2]
        const clearOfBars = stacked.every(other => {
          const beside = dress({ orientation, profile, node: other, box: box[other.index]!, lines: kept[other.index]!, side: sideOf(other.index), gap: outline })
          return !overlaps(text.box, box[other.index]!) && apart(text.box, beside.frame) && apart(beside.text?.box, own.frame)
        })
        const clearOfCommons = commonsDressed.every(common => !overlaps(text.box, common.box) && (common.text === null || !overlaps(text.box, common.text.box)) && apart(text.box, common.frame) && apart(common.text?.box, own.frame))
        return clearOfBars && clearOfCommons && columns.every(column => column <= low || column >= high)
      }
      const high = free('+c')
      const low = !high && free('-c')
      barSide.set(bar.index, screenFace(orientation, high || !low ? '+c' : '-c'))
      if (high || low) continue
      // Neither end: the label needs room before the bar's first attachment, past the run before it in its layer.
      const first = attachments.reduce((a, b) => (b.pin < a.pin ? b : a))
      const before = dummies.filter(item => c[item]! < attached.span[bar.index]![0]).sort((a, b) => c[b]! - c[a]!)[0]
      const text = label('-c').text
      if (before === undefined || text === null) continue
      blocked.push({ before, after: first.item, gap: ceilTo((c[first.item]! - first.pin) + grid / 2 + outline + (text.box.c1 - text.box.c0) + outline / 2 + 1, grid) })
    }
    return { attached, plan, along, trackF, commonPorts, box, barSide, blocked }
  }
  const first = place([])
  const second = first.blocked.length === 0 ? null : place(first.blocked)
  const { attached, plan, along, trackF, commonPorts, box, barSide } = second !== null && second.blocked.length < first.blocked.length ? second : first
  for (const [bar, end] of barSide) side[bar] = end
  const dressed = model.nodes.map(node => dressNode(node.index, box[node.index]!))

  // Polylines in the abstract axes. An approach runs from the item outward to
  // where it meets its channel: one point, or a side entry's turn and riser.
  const approach = (chain: number, position: number, face: 'in' | 'out' | 'pass', track: number): Point[] => {
    const item = layering.chains[chain]!.items[position]!
    const pinC = attached.pin[chain]![position]!
    if (item >= nodeCount) return [[along.axis[items[item]!.layer]!, pinC]]
    const node = model.nodes[item]!
    if (node.role === 'bar') return [[box[item]!.f0 + outline / 2, pinC]]
    if (node.role === 'common') return [[track, pinC]]
    if (face === 'out') return [[box[item]!.f1 - node.portInset, pinC]]
    const edge = model.edges[layering.chains[chain]!.edge]!
    const entry = entries[item]?.ports.get(item === edge.from ? edge.fromPort : edge.toPort)
    if (entry === undefined) return [[box[item]!.f0 + node.portInset, pinC]]
    const slotF = along.axis[items[item]!.layer]! + entry.slot
    return [[slotF, box[item]!.c0 + node.portInset], [slotF, pinC]]
  }
  const paths: Point[][] = layering.chains.map((chain, index) => {
    const points: Point[] = []
    chain.steps.forEach((step, k) => {
      const jog = plan.jog[index]![k]!
      const track = jog === null ? Number.NaN : trackF(jog.channel, jog.net)
      // A turn over two items of one layer leaves the first from its downstream face (a flat edge).
      const a = approach(index, k, step === 'turnBelow' ? 'in' : step === 'turnAbove' && k > 0 ? 'pass' : 'out', track)
      const b = approach(index, k + 1, step === 'turnAbove' ? 'out' : step === 'turnBelow' ? 'pass' : 'in', track).reverse()
      points.push(...a)
      if (jog !== null) points.push([track, a.at(-1)![1]], [track, b[0]![1]])
      points.push(...b)
    })
    const clean: Point[] = []
    for (const point of points) {
      const last = clean.at(-1)
      if (last !== undefined && last[0] === point[0] && last[1] === point[1]) continue
      if (clean.length >= 2) {
        const before = clean.at(-2)!
        if ((before[0] === last![0] && last![0] === point[0]) || (before[1] === last![1] && last![1] === point[1])) clean.pop()
      }
      clean.push(point)
    }
    return chain.reversed ? clean.reverse() : clean
  })

  // Ports, in the abstract axes, with their faces.
  const ports = model.nodes.map(node => {
    const list: Array<{ id: string; point: Point; face: AxisFace }> = []
    node.ports.forEach((port, index) => {
      if (port.use === 'unused') return
      if (node.role === 'common') {
        const tracks = commonPorts[node.index]!.get(index)
        const low = ordering.commonSide === 'low'
        if (tracks !== undefined) list.push({ id: port.id, point: [[...tracks][0]!, low ? box[node.index]!.c1 - node.portInset : box[node.index]!.c0 + node.portInset], face: low ? '+c' : '-c' })
        return
      }
      if (node.role === 'bar') {
        const middle = (box[node.index]!.c0 + box[node.index]!.c1) / 2
        list.push({ id: port.id, point: [(box[node.index]!.f0 + box[node.index]!.f1) / 2, middle], face: port.use === 'target' ? '-f' : '+f' })
        return
      }
      const entry = entries[node.index]?.ports.get(index)
      if (entry !== undefined) {
        list.push({ id: port.id, point: [along.axis[items[node.index]!.layer]! + entry.slot, box[node.index]!.c0 + node.portInset], face: '-c' })
        return
      }
      const slot = attached.slot[node.index]![index]!
      list.push((port.use === 'target') !== prepared.flipped[node.index]
        ? { id: port.id, point: [box[node.index]!.f0 + node.portInset, slot], face: '-f' }
        : { id: port.id, point: [box[node.index]!.f1 - node.portInset, slot], face: '+f' })
    })
    return list
  })

  // To screen, then translate by whole grid steps so the drawing starts at the origin.
  const rect = (b: AxisBox): Rect => toScreenRect(orientation, b)
  const screenPaths = paths.map(path => path.map(([f, cc]) => toScreen(orientation, f, cc)))
  const extentRects: Rect[] = [
    ...dressed.flatMap(d => [rect(d.box), ...(d.text === null ? [] : [rect(d.text.box)]), ...(d.frame === null ? [] : [rect(d.frame)])]),
    ...screenPaths.flatMap(path => path.map(([x, y]) => ({ x: x - outline / 2, y: y - outline / 2, width: outline, height: outline }))),
  ]
  const minX = Math.min(...extentRects.map(r => r.x))
  const minY = Math.min(...extentRects.map(r => r.y))
  const dx = -floorTo(minX, grid)
  const dy = -floorTo(minY, grid)
  const width = Math.ceil(Math.max(...extentRects.map(r => r.x + r.width)) + dx - 1e-6)
  const height = Math.ceil(Math.max(...extentRects.map(r => r.y + r.height)) + dy - 1e-6)
  const move = (point: Point): readonly [number, number] => [point[0] + dx, point[1] + dy]
  const nodes: PlacedNode[] = model.nodes.map(node => {
    const d = dressed[node.index]!
    const r = translateRect(rect(d.box), dx, dy)
    const portRecord: Record<string, { x: number; y: number; face: Face }> = {}
    for (const entry of ports[node.index]!) {
      const [x, y] = move(toScreen(orientation, entry.point[0], entry.point[1]))
      portRecord[entry.id] = { x, y, face: screenFace(orientation, entry.face) }
    }
    const text = d.text === null ? null : { ...translateRect(rect(d.text.box), dx, dy), side: d.text.side, lines: d.text.lines }
    return { id: node.id, x: r.x, y: r.y, width: r.width, height: r.height, ports: portRecord, text, frame: d.frame === null ? null : translateRect(rect(d.frame), dx, dy) }
  })
  return { orientation, detail, policy, width, height, nodes, paths: screenPaths.map(path => path.map(move)) }
}
