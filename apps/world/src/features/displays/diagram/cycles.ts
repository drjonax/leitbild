// Cycle breaking: the Eades–Lin–Smyth greedy feedback arc set. Edges that run
// against the resulting node sequence are reversed for layering and drawn as
// return runs. When no source or sink is left, a hub goes first: loops are
// drawn leaving the hub and returning to it, which is the classic loop drawing.
import { layerNodes } from './layering.ts'
import type { Model } from './model.ts'

/** Per edge, whether it is reversed (a return run). */
export const breakCycles = (model: Model): ReadonlyArray<boolean> => {
  const count = model.nodes.length
  const remaining = new Array<boolean>(count).fill(true)
  const outDegree = new Array<number>(count).fill(0)
  const inDegree = new Array<number>(count).fill(0)
  const outgoing = model.nodes.map(() => [] as number[])
  const incoming = model.nodes.map(() => [] as number[])
  for (const edge of model.edges) {
    outDegree[edge.from]!++
    inDegree[edge.to]!++
    outgoing[edge.from]!.push(edge.to)
    incoming[edge.to]!.push(edge.from)
  }
  const remove = (node: number): void => {
    remaining[node] = false
    for (const to of outgoing[node]!) inDegree[to]!--
    for (const from of incoming[node]!) outDegree[from]!--
  }
  const head: number[] = []
  const tail: number[] = []
  let left = count
  while (left > 0) {
    let changed = true
    while (changed) {
      changed = false
      for (let node = 0; node < count; node++) {
        if (remaining[node] && outDegree[node] === 0) {
          tail.push(node)
          remove(node)
          left--
          changed = true
        }
      }
      for (let node = 0; node < count; node++) {
        if (remaining[node] && inDegree[node] === 0) {
          head.push(node)
          remove(node)
          left--
          changed = true
        }
      }
    }
    if (left === 0) break
    let best = -1
    let bestHub = false
    let bestDelta = -Infinity
    for (let node = 0; node < count; node++) {
      if (!remaining[node]) continue
      const hub = model.nodes[node]!.role === 'hub'
      const delta = outDegree[node]! - inDegree[node]!
      if (best < 0 || (hub && !bestHub) || (hub === bestHub && delta > bestDelta)) {
        best = node
        bestHub = hub
        bestDelta = delta
      }
    }
    head.push(best)
    remove(best)
    left--
  }
  const position = new Array<number>(count)
  ;[...head, ...tail.reverse()].forEach((node, index) => (position[node] = index))
  return model.edges.map(edge => position[edge.from]! > position[edge.to]!)
}

/**
 * A cycle's return leg drawn against the flow. Where a cycle returns to its
 * start through shared symbols only (a feed train back to its header), the
 * drawing is as long as the whole cycle. Folding it in two halves the length:
 * the leg's symbols are drawn mirrored (flow enters their downstream face and
 * leaves their upstream one) in the layers the rest of the cycle already
 * spans, so its pipes run straight against the flow and the cycle turns once,
 * where the leg begins.
 *
 * The leg grows upstream from the source of a return edge through shared
 * symbols whose every outflow stays in the leg, and keeps the symbols
 * downstream of a cut layer; of the cuts whose leg fits between the cycle's
 * start and the turn, the one with the fewest turning edges (then the
 * shortest drawing) wins.
 *
 * Folded beside its turn, the leg's head (a leg symbol the rest of the cycle
 * feeds) is drawn in the layer of what feeds it, beside it: the pipe turns
 * over into the head's mirrored upstream face, so the cycle is only as long
 * as its forward part. A leg symbol's stubs are mirrored with it. Of the
 * cuts, the one whose layers come out fewest (then the fewest turning
 * edges) wins: a leg deeper than the layers below its turn lifts its head.
 */
export interface Fold {
  /** Per edge: reversed for layering (the leg's edges, its turns and its return). */
  readonly reversed: ReadonlyArray<boolean>
  /** Per node: drawn mirrored. */
  readonly flipped: ReadonlyArray<boolean>
  /** Per edge: part of a fold, so a bar at its end takes it from either side without turning. */
  readonly folded: ReadonlyArray<boolean>
  /** Per edge: its ends may share a layer, joined by a turn over both (an edge into a head drawn beside its turn). */
  readonly flat: ReadonlyArray<boolean>
}

/** Where a folded leg turns: at the end of the cycle's forward part, or beside it. */
export type FoldPlace = 'turn' | 'beside'

export const foldReturns = (model: Model, reversed: ReadonlyArray<boolean>, layer: ReadonlyArray<number>, place: FoldPlace = 'turn'): Fold | null => {
  const outgoing = model.nodes.map(() => [] as number[])
  const incoming = model.nodes.map(() => [] as number[])
  for (const edge of model.edges) {
    outgoing[edge.from]!.push(edge.index)
    incoming[edge.to]!.push(edge.index)
  }
  const sharedDevice = (node: number): boolean => model.nodes[node]!.role === 'device' && model.nodes[node]!.lane === null
  const isStub = (node: number): boolean => model.nodes[node]!.role === 'stub'
  const nextReversed = [...reversed]
  const flipped = model.nodes.map(() => false)
  const folded = model.edges.map(() => false)
  const flat = model.edges.map(() => false)
  const beside = place === 'beside'
  let any = false
  for (const back of model.edges) {
    if (!reversed[back.index] || !sharedDevice(back.from) || flipped[back.from]) continue
    const start = back.to
    if (layer[back.from]! - layer[start]! < 3) continue
    // Every shared symbol whose outflow stays in the leg, upstream from the return.
    const leg = new Set<number>()
    const joins = (node: number): boolean => sharedDevice(node) && !flipped[node]
      && outgoing[node]!.every(edge => leg.has(model.edges[edge]!.to) || model.edges[edge]!.to === start || isStub(model.edges[edge]!.to))
    const queue = [back.from]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (leg.has(node) || !joins(node)) continue
      leg.add(node)
      for (const edge of incoming[node]!) queue.push(model.edges[edge]!.from)
    }
    if (leg.size === 0) continue
    // Cuts: the leg keeps its members beyond a layer, so a cut never splits it against the flow.
    const cuts = [...new Set([...leg].map(node => layer[node]!))].sort((a, b) => a - b).map(at => at - 1)
    const candidates = cuts.flatMap(cut => {
      const kept = new Set([...leg].filter(node => layer[node]! > cut))
      // A leg member's stubs go with it; every other edge into the leg turns.
      const turns = model.edges.filter(edge => kept.has(edge.to) && !kept.has(edge.from) && !isStub(edge.from))
      if (turns.length === 0 || turns.some(edge => edge.from === start)) return []
      // Leg depth from the start, against the flow; it must fit below every turn's source.
      const depth = new Map<number, number>()
      const depthOf = (node: number, seen: ReadonlySet<number>): number => {
        const known = depth.get(node)
        if (known !== undefined) return known
        const value = 1 + Math.max(0, ...outgoing[node]!.map(edge => model.edges[edge]!.to).filter(to => kept.has(to) && !seen.has(to)).map(to => depthOf(to, new Set([...seen, node]))))
        depth.set(node, value)
        return value
      }
      const fits = beside || turns.every(edge => layer[edge.from]! >= layer[start]! + depthOf(edge.to, new Set()) + 1)
      if (!fits) return []
      const turnNets = new Set(turns.map(edge => `${edge.from}:${edge.fromPort}`)).size
      // Beside its turn, what enters a head (its turns and stubs) runs on with the flow and turns over into it.
      const heads = new Set(turns.map(edge => edge.to))
      const besideHead = (edge: Model['edges'][number]): boolean => beside && heads.has(edge.to) && !kept.has(edge.from)
      const folding = model.edges.filter(edge => {
        const inside = kept.has(edge.from) && (kept.has(edge.to) || edge.to === start || isStub(edge.to))
        const stubbed = kept.has(edge.to) && isStub(edge.from)
        return inside || stubbed || turns.includes(edge)
      })
      const trialReversed = [...nextReversed]
      const trialFlat = [...flat]
      for (const edge of folding) {
        trialReversed[edge.index] = !besideHead(edge)
        trialFlat[edge.index] = besideHead(edge)
      }
      const closes = !acyclic(model, trialReversed)
      if (beside && closes) return []
      const length = beside ? Math.max(0, ...layerNodes(model, trialReversed, false, trialFlat)) : 0
      return [{ kept, folding, turnNets, span: Math.max(...turns.map(edge => layer[edge.from]!)), length, closes, reversed: trialReversed, flat: trialFlat }]
    })
    const best = candidates.sort((a, b) => beside ? (a.length - b.length) || (a.turnNets - b.turnNets) || (a.span - b.span) : (a.turnNets - b.turnNets) || (a.span - b.span))[0]
    // A turn that reaches the cycle's start again by another way would close a cycle: that leg is not folded.
    if (best === undefined || best.closes) continue
    any = true
    for (const node of best.kept) flipped[node] = true
    // Beside its turn, a leg symbol's stubs are mirrored with it, so their pipes run straight (stubs feeding a head turn over into it).
    if (beside) for (const edge of best.folding) {
      if (best.flat[edge.index]) continue
      if (isStub(edge.from)) flipped[edge.from] = true
      if (isStub(edge.to)) flipped[edge.to] = true
    }
    for (const edge of best.folding) {
      nextReversed[edge.index] = best.reversed[edge.index]!
      folded[edge.index] = true
      flat[edge.index] = best.flat[edge.index]!
    }
  }
  return any ? { reversed: nextReversed, flipped, folded, flat } : null
}

const acyclic = (model: Model, reversed: ReadonlyArray<boolean>): boolean => {
  const waiting = model.nodes.map(() => 0)
  const next = model.nodes.map(() => [] as number[])
  for (const edge of model.edges) {
    const [from, to] = reversed[edge.index] ? [edge.to, edge.from] : [edge.from, edge.to]
    next[from]!.push(to)
    waiting[to]!++
  }
  const ready = model.nodes.filter(node => waiting[node.index] === 0).map(node => node.index)
  let seen = 0
  while (ready.length > 0) {
    const node = ready.pop()!
    seen++
    for (const to of next[node]!) if (--waiting[to]! === 0) ready.push(to)
  }
  return seen === model.nodes.length
}
