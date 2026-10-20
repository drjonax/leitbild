// Where each edge meets each item across the flow. A symbol's ports take
// distinct grid slots on their face, in the order of what they connect to
// (a port only bars feed, toward where the bars reach from);
// a hub's side face takes the edges at its face; a bar spans the branches it
// connects, so each branch meets it straight; bars sharing a layer stack in
// the order that crosses the fewest pipes.
import type { DiagramProfile } from './diagram.ts'
import type { AxisBox } from './geometry.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import type { Ordering } from './ordering.ts'
import type { SideEntry } from './shapes.ts'

export interface Attachments {
  /** Per node and port index, the slot's cross coordinate (NaN when the port has no face slot). */
  readonly slot: ReadonlyArray<ReadonlyArray<number>>
  /** Per chain and chain position, the cross coordinate where the edge meets that item. */
  readonly pin: ReadonlyArray<ReadonlyArray<number>>
  /** Per bar node, its extent across. */
  readonly span: ReadonlyArray<readonly [number, number] | null>
  /** Per bar node, its row in its layer's stack (0 = most upstream). */
  readonly barRow: ReadonlyArray<number>
}

const MAX_PERMUTED_BARS = 6

/** Order-preserving assignment of targets to slots with the least total offset. */
const assignSlots = (targets: ReadonlyArray<number>, slots: ReadonlyArray<number>): number[] => {
  const m = targets.length
  const k = slots.length
  const cost = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(Infinity))
  for (let j = 0; j <= k; j++) cost[0]![j] = 0
  for (let i = 1; i <= m; i++) {
    for (let j = i; j <= k; j++) {
      cost[i]![j] = Math.min(cost[i]![j - 1]!, cost[i - 1]![j - 1]! + Math.abs(slots[j - 1]! - targets[i - 1]!))
    }
  }
  const chosen = new Array<number>(m)
  for (let i = m, j = k; i > 0; j--) {
    if (cost[i]![j] === cost[i - 1]![j - 1]! + Math.abs(slots[j - 1]! - targets[i - 1]!)) {
      chosen[i - 1] = slots[j - 1]!
      i--
    }
  }
  return chosen
}

const permutations = <T>(values: ReadonlyArray<T>): T[][] =>
  values.length <= 1 ? [[...values]] : values.flatMap((value, i) => permutations([...values.slice(0, i), ...values.slice(i + 1)]).map(rest => [value, ...rest]))

export const attach = (input: {
  readonly model: Model
  readonly profile: DiagramProfile
  readonly layering: Layering
  readonly ordering: Ordering
  readonly c: ReadonlyArray<number>
  /** Absolute footprint per node (bars: unused). */
  readonly box: ReadonlyArray<AxisBox>
  /** Nodes whose in-ports enter from the side. */
  readonly entries: ReadonlyArray<SideEntry | null>
}): Attachments => {
  const { model, profile, layering, ordering, c, box, entries } = input
  const sideEntry = (node: number, port: number): { riser: number; slot: number } | undefined => entries[node]?.ports.get(port)
  const grid = profile.grid
  const items = layering.items
  const role = (item: number): string | null => (items[item]!.node === null ? null : model.nodes[items[item]!.node!]!.role)
  const portAt = (chain: number, position: number): number => {
    const edge = model.edges[layering.chains[chain]!.edge]!
    return items[layering.chains[chain]!.items[position]!]!.node === edge.from ? edge.fromPort : edge.toPort
  }
  // A hub's ports face the lanes: its high face beside lane 0, its low face after the last lane.
  const hubFace = (node: number): number => ordering.hubSide === 'low' ? box[node]!.c1 - model.nodes[node]!.portInset : box[node]!.c0 + model.nodes[node]!.portInset

  // Port slots on symbol faces. A port carrying a long edge to another
  // symbol aims at that edge's strand, so the strand runs straight from it
  // (its short edges jog anyway, and a strand from a bar or hub meets that
  // end straight already).
  const slot = model.nodes.map(node => node.ports.map(() => Number.NaN))
  // Where a bar's other attachments are: the bar spans them, so a port it feeds sits on that side of a busy face.
  const barNeighbours = new Map<number, Array<{ readonly chain: number; readonly item: number }>>()
  layering.chains.forEach((chain, index) => chain.steps.forEach((step, k) => {
    if (step !== 'next') return
    for (const [own, other] of [[chain.items[k]!, chain.items[k + 1]!], [chain.items[k + 1]!, chain.items[k]!]] as const) {
      if (role(own) === 'bar' && role(other) !== 'hub') barNeighbours.set(own, [...(barNeighbours.get(own) ?? []), { chain: index, item: other }])
    }
  }))
  const barSide = (bar: number, chain: number): number | null => {
    const others = (barNeighbours.get(bar) ?? []).filter(entry => entry.chain !== chain).map(entry => c[entry.item]!)
    return others.length === 0 ? null : others.reduce((sum, at) => sum + at, 0) / others.length
  }
  const wants = model.nodes.map(node => node.ports.map(() => [] as Array<{ readonly at: number; readonly strand: boolean; readonly turn: boolean; readonly bar: number | null }>))
  layering.chains.forEach((chain, index) => {
    for (const [position, adjacent] of [[0, 1], [chain.items.length - 1, chain.items.length - 2]] as const) {
      const node = items[chain.items[position]!]!.node!
      const other = chain.items[adjacent]!
      const target = role(other) === 'bar' ? c[node]! : role(other) === 'hub' ? hubFace(items[other]!.node!) : c[other]!
      const far = role(chain.items[position === 0 ? chain.items.length - 1 : 0]!)
      const step = chain.steps[position === 0 ? 0 : chain.steps.length - 1]!
      const bar = role(other) === 'bar' ? barSide(other, index) : null
      wants[node]![portAt(index, position)]!.push({ at: target, strand: role(other) === null && far !== 'bar' && far !== 'hub', turn: step !== 'next' && role(other) !== 'hub', bar })
    }
  })
  // Pipes that turn over a face nest: from each side, the farther one turns
  // higher and lands nearer the middle, so its descent stays clear of the
  // nearer one's run. Those from the left take the face's left end, those
  // from the right its right end, and straight pipes the middle.
  const NEST = 1e6
  const nestKey = (node: number, at: number): number => (at < c[node]! ? -NEST + (c[node]! - at) : NEST - (at - c[node]!))
  for (const node of model.nodes) {
    if (node.role === 'bar' || node.role === 'hub') continue
    const footprint = box[node.index]!
    const slots: number[] = []
    for (let at = footprint.c0 + grid; at < footprint.c1; at += grid) slots.push(at)
    for (const use of ['source', 'target'] as const) {
      const ports = node.ports.map((port, index) => ({ port, index }))
        .filter(entry => entry.port.use === use && wants[node.index]![entry.index]!.length > 0 && sideEntry(node.index, entry.index) === undefined)
      if (ports.length === 0) continue
      const target = (index: number): number => {
        const all = wants[node.index]![index]!
        // Beside other ports, a port only bars feed aims where the bars reach from, so they end before its neighbours' pipes.
        const bars = all.map(want => want.bar)
        if (ports.length > 1 && bars.every(bar => bar !== null)) return (bars as number[]).reduce((sum, at) => sum + at, 0) / bars.length
        const strands = all.filter(want => want.strand)
        const list = strands.length > 0 ? strands : all
        return list.reduce((sum, want) => sum + want.at, 0) / list.length
      }
      const turning = (index: number): boolean => wants[node.index]![index]!.every(want => want.turn)
      const key = (index: number): number => (turning(index) ? nestKey(node.index, target(index)) : target(index))
      ports.sort((a, b) => (key(a.index) - key(b.index)) || (a.index - b.index))
      if (ports.length > slots.length) throw new Error(`node ${node.id} needs ${ports.length} slots on one face and has ${slots.length}`)
      // Turning pipes keep their nested order at the face's ends; straight ones aim at what they connect.
      const aims = ports.map(entry => (turning(entry.index) ? (key(entry.index) < 0 ? footprint.c0 : footprint.c1) : target(entry.index)))
      assignSlots(aims, slots).forEach((value, i) => (slot[node.index]![ports[i]!.index] = value))
    }
  }

  // Pins of everything but bars, then bars meet their neighbours straight.
  const pin = layering.chains.map((chain, index) => chain.items.map((item, position) => {
    const r = role(item)
    if (r === null) return c[item]!
    if (r === 'bar') return Number.NaN
    if (r === 'hub') return hubFace(items[item]!.node!)
    const node = items[item]!.node!
    const entry = sideEntry(node, portAt(index, position))
    return entry === undefined ? slot[node]![portAt(index, position)]! : c[node]! + entry.riser
  }))
  const attachments = model.nodes.map(() => [] as number[])
  layering.chains.forEach((chain, index) => {
    chain.items.forEach((item, position) => {
      if (role(item) !== 'bar') return
      const neighbour = position === 0 ? 1 : position - 1
      const value = pin[index]![neighbour]!
      if (Number.isNaN(value)) return
      pin[index]![position] = value
      attachments[items[item]!.node!]!.push(value)
    })
  })
  // A bar feeding a bar meets it at the first bar's middle.
  layering.chains.forEach((chain, index) => {
    if (chain.items.length !== 2 || role(chain.items[0]!) !== 'bar' || role(chain.items[1]!) !== 'bar') return
    const [a, b] = [items[chain.items[0]!]!.node!, items[chain.items[1]!]!.node!]
    const list = attachments[a]!.length > 0 ? attachments[a]! : attachments[b]!
    if (list.length === 0) throw new Error(`bars ${model.nodes[a]!.id} and ${model.nodes[b]!.id} connect only to each other`)
    const middle = Math.round((Math.min(...list) + Math.max(...list)) / 2 / grid) * grid
    pin[index]![0] = middle
    pin[index]![1] = middle
    attachments[a]!.push(middle)
    attachments[b]!.push(middle)
  })
  const span = model.nodes.map(node => {
    if (node.role !== 'bar') return null
    const list = attachments[node.index]!
    if (list.length === 0) throw new Error(`bar ${node.id} connects nothing`)
    return [Math.min(...list) - grid / 2, Math.max(...list) + grid / 2] as const
  })

  // Stack bars that share a layer: count runs that must pass another bar's span.
  const barRow = model.nodes.map(() => 0)
  const barsByLayer = new Map<number, number[]>()
  for (const node of model.nodes) {
    if (node.role === 'bar') barsByLayer.set(items[node.index]!.layer, [...(barsByLayer.get(items[node.index]!.layer) ?? []), node.index])
  }
  for (const layer of [...barsByLayer.keys()].sort((a, b) => a - b)) {
    const bars = barsByLayer.get(layer)!.sort((a, b) => a - b)
    if (bars.length < 2) continue
    const runs = bars.map(bar => layering.chains.flatMap((chain, index) => chain.items.flatMap((item, position) => {
      if (item !== bar) return []
      const neighbour = chain.items[position === 0 ? 1 : position - 1]!
      return [{ c: pin[index]![position]!, below: items[neighbour]!.layer < layer }]
    })))
    const cost = (order: ReadonlyArray<number>): number => order.reduce((total, bar, row) => {
      const own = runs[bars.indexOf(bar)]!
      return total + own.filter(run => order.some((other, otherRow) => {
        if (other === bar || (run.below ? otherRow > row : otherRow < row)) return false
        const [low, high] = span[other]!
        return run.c > low && run.c < high
      })).length
    }, 0)
    const candidates = bars.length <= MAX_PERMUTED_BARS ? permutations(bars) : [bars]
    let best = candidates[0]!
    let bestCost = cost(best)
    for (const candidate of candidates.slice(1)) {
      const value = cost(candidate)
      if (value < bestCost) {
        best = candidate
        bestCost = value
      }
    }
    best.forEach((bar, row) => (barRow[bar] = row))
  }
  return { slot, pin, span, barRow }
}
