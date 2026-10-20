// Order within layers. Blocks are fixed: hubs, shared items, lanes in lane
// order, then lane-less stubs; or, with hubs on the high side, shared items,
// lanes, stubs, then hubs. Barycentre sweeps reorder items only inside their
// block, so lanes always line up and never swap. A lane-less long edge runs in
// the block of the stub it ends at. Refined, a stub of a shared symbol or hub
// stays in the block beside it (a hub's beside the other ends of its port, when
// the port has some), and items of a block then move, alone or with the long
// edges that are all their pipes, while that crosses fewer pipes, counted in
// the order: pipes between neighbouring layers, U-turns of return runs at the
// layer they turn at, hub pipes from the hubs' side, and the nets a hub sends
// through one channel.
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'

/** Which side of the lanes hubs are drawn on: before lane 0 (low) or after the last lane (high). */
export type HubSide = 'low' | 'high'

export interface Blocks {
  readonly hub: number
  readonly shared: number
  readonly lane: (lane: number) => number
  readonly stub: number
}

export const blocksFor = (laneCount: number, hubSide: HubSide): Blocks => hubSide === 'low'
  ? { hub: 0, shared: 1, lane: lane => 2 + lane, stub: 2 + laneCount }
  : { shared: 0, lane: lane => 1 + lane, stub: 1 + laneCount, hub: 2 + laneCount }

export interface Ordering {
  /** Item indices per layer, in cross-axis order. */
  readonly layers: ReadonlyArray<ReadonlyArray<number>>
  readonly block: ReadonlyArray<number>
  readonly blocks: Blocks
  readonly hubSide: HubSide
}

const SWEEPS = 4

export const orderLayers = (model: Model, layering: Layering, hubSide: HubSide, refine: { readonly net: ReadonlyArray<number> } | null = null): Ordering => {
  const laneCount = model.lanes.length
  const blocks = blocksFor(laneCount, hubSide)
  // The node a lane-less stub ends the drawing at: its one neighbour, and whether its pipe shares that port with others.
  const stubOwner = (node: number): { readonly node: number; readonly shared: boolean } | undefined => {
    const edge = model.edges.find(candidate => candidate.from === node || candidate.to === node)
    if (edge === undefined) return undefined
    const [owner, port] = edge.from === node ? [edge.to, edge.toPort] : [edge.from, edge.fromPort]
    const shared = model.edges.some(other => other !== edge && ((other.from === owner && other.fromPort === port) || (other.to === owner && other.toPort === port)))
    return { node: owner, shared }
  }
  const nodeBlock = (node: number, lane: number | null): number => {
    const role = model.nodes[node]!.role
    if (role === 'hub') return blocks.hub
    if (role === 'stub' && lane === null) {
      const owner = refine === null ? undefined : stubOwner(node)
      if (owner === undefined) return blocks.stub
      // Beside its node: a shared symbol's in the shared block, a hub's in the block next to the hub,
      // unless its port leads on elsewhere: then beside that net's other ends, outside the lanes it would straddle.
      if (model.nodes[owner.node]!.role !== 'hub') return blocks.shared
      return hubSide === 'low' || owner.shared ? blocks.shared : blocks.stub
    }
    return lane === null ? blocks.shared : blocks.lane(lane)
  }
  const block = layering.items.map(item => {
    if (item.node !== null) return nodeBlock(item.node, item.lane)
    if (item.lane !== null) return blocks.lane(item.lane)
    // A lane-less pipe runs in the block of the stub it ends at, beside it.
    const chain = layering.chains[item.edge!]!
    const ends = [chain.items[0]!, chain.items.at(-1)!].map(end => layering.items[end]!)
    return ends.some(end => end.node !== null && end.lane === null && model.nodes[end.node]!.role === 'stub' && nodeBlock(end.node, null) === blocks.stub) ? blocks.stub : blocks.shared
  })
  // Structural key: nodes by index, then dummies by edge and layer.
  const compareKey = (a: number, b: number): number => {
    const x = layering.items[a]!
    const y = layering.items[b]!
    if (x.node !== null && y.node !== null) return x.node - y.node
    if (x.node !== null) return -1
    if (y.node !== null) return 1
    return (x.edge! - y.edge!) || (x.layer - y.layer)
  }
  const neighbours = layering.items.map(() => [] as number[])
  for (const chain of layering.chains) {
    chain.steps.forEach((step, k) => {
      if (step !== 'next') return
      const a = chain.items[k]!
      const b = chain.items[k + 1]!
      neighbours[a]!.push(b)
      neighbours[b]!.push(a)
    })
  }
  const layers: number[][] = Array.from({ length: layering.layerCount }, () => [])
  layering.items.forEach((item, index) => layers[item.layer]!.push(index))
  const position = new Array<number>(layering.items.length).fill(0)
  const bary = new Array<number>(layering.items.length).fill(0)
  const sortLayer = (layer: number[]): void => {
    layer.sort((a, b) => (block[a]! - block[b]!) || (bary[a]! - bary[b]!) || compareKey(a, b))
    layer.forEach((item, index) => (position[item] = index))
  }
  for (const layer of layers) sortLayer(layer)
  const sweep = (at: number, from: number): void => {
    const layer = layers[at]!
    for (const item of layer) {
      const adjacent = neighbours[item]!.filter(other => layering.items[other]!.layer === from)
      bary[item] = adjacent.length === 0 ? position[item]! : adjacent.reduce((sum, other) => sum + position[other]!, 0) / adjacent.length
    }
    sortLayer(layer)
  }
  for (let round = 0; round < SWEEPS; round++) {
    for (let at = 1; at < layers.length; at++) sweep(at, at - 1)
    for (let at = layers.length - 2; at >= 0; at--) sweep(at, at + 1)
  }
  if (refine !== null) transpose(model, layering, layers, block, position, hubSide, refine.net)
  return { layers, block, blocks, hubSide }
}

const MAX_TRANSPOSE_ROUNDS = 12
const LOW_SIDE = -1
const HIGH_SIDE = -2

/** Pieces of pipe in the gap between layer g and g + 1, as the order sees them. */
type GapPiece =
  /** Between an item of the layer below the gap (`low`) and one above it (`high`); a hub's side stands in for the hub (`hub`). */
  | { readonly kind: 'span'; readonly low: number; readonly high: number; readonly net: number; readonly hub?: number }
  /** A U-turn at the layer below the gap (`low`) or above it (`high`), between two of its items. */
  | { readonly kind: 'turn'; readonly side: 'low' | 'high'; readonly p: number; readonly q: number; readonly net: number }

const transpose = (model: Model, layering: Layering, layers: number[][], block: ReadonlyArray<number>, position: number[], hubSide: HubSide, net: ReadonlyArray<number>): void => {
  const items = layering.items
  const role = (item: number) => (items[item]!.node === null ? null : model.nodes[items[item]!.node!]!.role)
  const isHub = (item: number): boolean => role(item) === 'hub'
  const isBar = (item: number): boolean => role(item) === 'bar'
  const side = hubSide === 'low' ? LOW_SIDE : HIGH_SIDE
  const gapCount = Math.max(0, layering.layerCount - 1)
  const gaps: GapPiece[][] = Array.from({ length: gapCount }, () => [])
  for (const chain of layering.chains) {
    const pipe = net[chain.edge]!
    chain.steps.forEach((step, k) => {
      const a = chain.items[k]!
      const b = chain.items[k + 1]!
      if (step === 'next') {
        // A hub reaches an item from its side, through the gap before the item.
        if (isHub(a)) { const g = items[b]!.layer - 1; if (g >= 0) gaps[g]!.push({ kind: 'span', low: side, high: b, net: pipe, hub: a }); return }
        if (isHub(b)) { const g = items[a]!.layer; if (g < gapCount) gaps[g]!.push({ kind: 'span', low: a, high: side, net: pipe, hub: b }); return }
        const g = items[a]!.layer
        if (items[b]!.layer === g + 1 && g < gapCount) gaps[g]!.push({ kind: 'span', low: a, high: b, net: pipe })
        return
      }
      const layer = items[a]!.layer
      if (step === 'turnAbove' && layer < gapCount) gaps[layer]!.push({ kind: 'turn', side: 'low', p: a, q: b, net: pipe })
      if (step === 'turnBelow' && layer >= 1) gaps[layer - 1]!.push({ kind: 'turn', side: 'high', p: a, q: b, net: pipe })
    })
  }
  const touches = (piece: GapPiece, item: number): boolean => piece.kind === 'span' ? piece.low === item || piece.high === item : piece.p === item || piece.q === item
  const at = (item: number): number => (item === LOW_SIDE ? -1e9 : item === HIGH_SIDE ? 1e9 : position[item]!)
  const between = (x: number, p: number, q: number): boolean => x > Math.min(p, q) && x < Math.max(p, q)
  const cross = (x: GapPiece, y: GapPiece): number => {
    if (x.net === y.net) return 0
    if (x.kind === 'span' && y.kind === 'span') return (at(x.low) - at(y.low)) * (at(x.high) - at(y.high)) < 0 ? 1 : 0
    if (x.kind === 'turn' && y.kind === 'turn') {
      if (x.side !== y.side) return 0
      const [p, q, r, t] = [at(x.p), at(x.q), at(y.p), at(y.q)]
      return between(r, p, q) !== between(t, p, q) && r !== p && r !== q && t !== p && t !== q ? 1 : 0
    }
    const turn = (x.kind === 'turn' ? x : y) as Extract<GapPiece, { kind: 'turn' }>
    const span = (x.kind === 'span' ? x : y) as Extract<GapPiece, { kind: 'span' }>
    return between(at(turn.side === 'low' ? span.low : span.high), at(turn.p), at(turn.q)) ? 1 : 0
  }
  // Nets meeting one symbol through different ports: one net's far ends on both sides of another's cross it.
  // Per gap and symbol (the end of the gap it is at), the far ends of each net.
  const meetings = gaps.map(pieces => {
    const byNode = new Map<string, Map<number, number[]>>()
    for (const piece of pieces) {
      if (piece.kind !== 'span') continue
      for (const [near, far, end] of [[piece.low, piece.high, 'low'], [piece.high, piece.low, 'high']] as const) {
        if (near < 0 || far < 0 || items[near]!.node === null || isBar(near)) continue
        const key = `${end}:${near}`
        const nets = byNode.get(key) ?? new Map<number, number[]>()
        nets.set(piece.net, [...(nets.get(piece.net) ?? []), far])
        byNode.set(key, nets)
      }
    }
    return [...byNode.values()].filter(nets => nets.size > 1).map(nets => [...nets.values()])
  })
  // Nets a hub sends through one gap run on tracks from its side face to their farthest end. Of two, the
  // one on the track nearer the far ends' layer has its risers cross the other's track where they lie
  // within it; the channel takes the cheaper order. Per gap, hub and direction, the far ends of each net.
  const hubMeetings = gaps.map(pieces => {
    const byHub = new Map<string, Map<number, number[]>>()
    for (const piece of pieces) {
      if (piece.kind !== 'span' || piece.hub === undefined) continue
      const outgoing = piece.low === side
      const key = `${piece.hub}:${outgoing ? 'out' : 'in'}`
      const nets = byHub.get(key) ?? new Map<number, number[]>()
      nets.set(piece.net, [...(nets.get(piece.net) ?? []), outgoing ? piece.high : piece.low])
      byHub.set(key, nets)
    }
    return [...byHub.values()].filter(nets => nets.size > 1).map(nets => [...nets.values()])
  })
  const within = (far: number, others: ReadonlyArray<number>): boolean => hubSide === 'low' ? at(far) < Math.max(...others.map(at)) : at(far) > Math.min(...others.map(at))
  const hubStraddles = (groups: ReadonlyArray<ReadonlyArray<number>>): number => {
    let total = 0
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        total += Math.min(groups[i]!.filter(far => within(far, groups[j]!)).length, groups[j]!.filter(far => within(far, groups[i]!)).length)
      }
    }
    return total
  }
  const straddles = (groups: ReadonlyArray<ReadonlyArray<number>>): number => {
    const spans = groups.map(fars => [Math.min(...fars.map(at)), Math.max(...fars.map(at))] as const)
    let total = 0
    for (let i = 0; i < spans.length; i++) {
      for (let j = 0; j < spans.length; j++) {
        if (i !== j && spans[i]![0] < spans[j]![0] && spans[j]![1] < spans[i]![1]) total++
      }
    }
    return total
  }
  // A bar spans what it connects on both sides; a pipe passing its layer crosses it where it passes inside that span,
  // judged on either side by where the pipe and the bar's attachments are in that layer's order.
  const bars = layering.items.map((_, item) => item).filter(isBar).map(bar => {
    const layer = items[bar]!.layer
    const attached: number[] = []
    const passing: Array<{ readonly low: number | null; readonly high: number | null }> = []
    for (const chain of layering.chains) {
      chain.steps.forEach((step, k) => {
        if (step !== 'next') return
        const [a, b] = [chain.items[k]!, chain.items[k + 1]!]
        if (a === bar && !isHub(b)) attached.push(b)
        if (b === bar && !isHub(a)) attached.push(a)
      })
      chain.items.forEach((item, k) => {
        if (items[item]!.node !== null || items[item]!.layer !== layer || k === 0 || k === chain.items.length - 1) return
        if (chain.steps[k - 1] !== 'next' || chain.steps[k] !== 'next') return
        const before = chain.items[k - 1]!
        const after = chain.items[k + 1]!
        passing.push({ low: items[before]!.layer === layer - 1 && !isHub(before) ? before : null, high: items[after]!.layer === layer + 1 && !isHub(after) ? after : null })
      })
    }
    return { layer, low: attached.filter(item => items[item]!.layer === layer - 1), high: attached.filter(item => items[item]!.layer === layer + 1), passing }
  })
  // Where a pipe passes a bar, on each side: before, inside or after the bar's attachments there.
  const relation = (ends: ReadonlyArray<number>, item: number | null): 'before' | 'inside' | 'after' | null => {
    if (item === null || ends.length === 0) return null
    const value = at(item)
    const low = Math.min(...ends.map(at))
    const high = Math.max(...ends.map(at))
    return value < low ? 'before' : value > high ? 'after' : ends.length >= 2 ? 'inside' : 'before'
  }
  // It crosses when inside on either side, or before on one side and after on the other (the bar spans both sides).
  const barCount = (bar: (typeof bars)[number]): number => bar.passing.filter(pass => {
    const low = relation(bar.low, pass.low)
    const high = relation(bar.high, pass.high)
    return low === 'inside' || high === 'inside' || (low !== null && high !== null && low !== high)
  }).length

  // Moving one item within its layer keeps every other pair's order, so only pairs with a piece at the item change.
  const near = (item: number): number[] => {
    const layer = items[item]!.layer
    return [layer - 1, layer].filter(g => g >= 0 && g < gapCount)
  }
  const barsNear = (item: number) => bars.filter(bar => Math.abs(bar.layer - items[item]!.layer) === 1)
  const local = (item: number): number => {
    let total = 0
    for (const g of near(item)) {
      const pieces = gaps[g]!
      for (let i = 0; i < pieces.length; i++) {
        if (!touches(pieces[i]!, item)) continue
        for (let j = 0; j < pieces.length; j++) {
          if (i === j || (touches(pieces[j]!, item) && j < i)) continue
          total += cross(pieces[i]!, pieces[j]!)
        }
      }
      for (const groups of meetings[g]!) if (groups.some(fars => fars.includes(item))) total += straddles(groups)
      for (const groups of hubMeetings[g]!) if (groups.some(fars => fars.includes(item))) total += hubStraddles(groups)
    }
    for (const bar of barsNear(item)) total += barCount(bar)
    return total
  }
  const total = (): number => gaps.reduce((sum, pieces, g) => {
    let count = 0
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) count += cross(pieces[i]!, pieces[j]!)
    return sum + count + meetings[g]!.reduce((all, groups) => all + straddles(groups), 0) + hubMeetings[g]!.reduce((all, groups) => all + hubStraddles(groups), 0)
  }, 0) + bars.reduce((sum, bar) => sum + barCount(bar), 0)

  const runOf = (layer: ReadonlyArray<number>, item: number): readonly [number, number] => {
    let low = layer.indexOf(item)
    let high = low
    while (low > 0 && block[layer[low - 1]!] === block[item]) low--
    while (high + 1 < layer.length && block[layer[high + 1]!] === block[item]) high++
    return [low, high]
  }
  const moveTo = (item: number, to: number): void => {
    const layer = layers[items[item]!.layer]!
    layer.splice(layer.indexOf(item), 1)
    layer.splice(to, 0, item)
    layer.forEach((member, index) => (position[member] = index))
  }
  // A long edge's dummies move together, and so does a symbol with the stubs where its pipes leave the
  // drawing: to the front or the back of their block in every layer they are in.
  const stubsOf = (item: number): number[] => (items[item]!.node === null ? [] : layering.chains
    .filter(chain => chain.items[0] === item || chain.items.at(-1) === item)
    .map(chain => (chain.items[0] === item ? chain.items.at(-1)! : chain.items[0]!))
    .filter(other => role(other) === 'stub'))
  // A long edge's dummies move with an end that has no other pipe (a stub, or a symbol only it reaches), when they share its block.
  const degree = model.nodes.map(node => model.edges.filter(edge => edge.from === node.index || edge.to === node.index).length)
  const units = [
    ...layering.chains.map(chain => {
      const dummies = chain.items.filter(item => items[item]!.node === null)
      const loose = (end: number): boolean => dummies.length > 0 && role(end) !== 'hub' && role(end) !== 'bar'
        && degree[items[end]!.node!] === 1 && dummies.every(item => block[item] === block[end])
      const [start, end] = [chain.items[0]!, chain.items.at(-1)!]
      return [...(loose(start) ? [start] : []), ...dummies, ...(loose(end) ? [end] : [])]
    }).filter(unit => unit.length >= 2),
    ...layering.items.map((_, item) => item).filter(item => role(item) !== null && role(item) !== 'stub' && role(item) !== 'hub' && role(item) !== 'bar' && stubsOf(item).length > 0)
      .map(item => [item, ...stubsOf(item)]),
  ]
  const strandMoves = (): boolean => {
    let improved = false
    for (const dummies of units) {
      // Restored whole: moving a unit's items back one by one does not undo moves within one layer.
      const touched = [...new Set(dummies.map(item => items[item]!.layer))]
      const before = touched.map(layer => [...layers[layer]!])
      const restore = (): void => touched.forEach((layer, k) => {
        layers[layer]!.splice(0, layers[layer]!.length, ...before[k]!)
        layers[layer]!.forEach((member, index) => (position[member] = index))
      })
      let best = total()
      let kept: 'front' | 'back' | null = null
      // A unit keeps its own order at either end: to the front, its last item moves first.
      const move = (end: 'front' | 'back'): void => {
        for (const item of end === 'front' ? [...dummies].reverse() : dummies) {
          const [low, high] = runOf(layers[items[item]!.layer]!, item)
          moveTo(item, end === 'front' ? low : high)
        }
      }
      for (const end of ['front', 'back'] as const) {
        move(end)
        const cost = total()
        if (cost < best) {
          best = cost
          kept = end
        }
        restore()
      }
      if (kept === null) continue
      move(kept)
      improved = true
    }
    return improved
  }
  // Sifting: each item tries every place in its block's run and keeps the one that crosses least.
  const sift = (): boolean => {
    let improved = false
    for (const layer of layers) {
      for (const item of [...layer]) {
        const from = layer.indexOf(item)
        const [low, high] = runOf(layer, item)
        if (low === high) continue
        let best = from
        let bestCost = local(item)
        for (let to = low; to <= high; to++) {
          if (to === from) continue
          moveTo(item, to)
          const cost = local(item)
          if (cost < bestCost) {
            best = to
            bestCost = cost
          }
        }
        moveTo(item, best)
        if (best !== from) improved = true
      }
    }
    return improved
  }
  for (let round = 0; round < MAX_TRANSPOSE_ROUNDS; round++) {
    const moved = strandMoves()
    if (!sift() && !moved) return
  }
}
