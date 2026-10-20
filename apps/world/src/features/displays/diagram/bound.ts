// The fewest crossings a graph's structure forces on a lane drawing, from the
// graph alone. A lane drawing is what this engine draws: lanes are disjoint
// bands in lane order, a lane's pipes stay in its band, bars are segments
// across the flow, and shared symbols and hubs lie outside the lanes' bands.
// Two structures force crossings:
//
// Shared points (hubs, shared symbols) that each reach every lane by paths
// inside that lane, disjoint from each other: the lanes and points contain a
// subdivision of K(p, n), which no drawing shows with fewer than
// Z(p, n) = ⌊p/2⌋⌊(p−1)/2⌋⌊n/2⌋⌊(n−1)/2⌋ crossings (Kleitman, p ≤ 6).
//
// The ladder. Two bars A and B joined through every lane by a rung (a path
// A → v → B inside the lane), and a shared point X with c_L disjoint paths
// from X to lane L's v, apart from the rungs. A bar is a segment, so K(p, n)
// does not hold for it (a pipe crosses a bar once wherever it passes).
// Instead the bars and rungs form a ladder; its rungs stay in their lanes'
// bands, so the ladder does not cross itself, and each region it leaves
// between two neighbouring lanes touches only those lanes' v. X lies outside
// the lanes, in the region that touches only the first and the last lane, so
// each of its paths to every other lane crosses the ladder:
// Σ c_L − c_first − c_last. Where a path Q of shared symbols joins A to B
// besides the rungs (a feed train closing the cycle through the headers),
// either Q crosses the ladder too (one more), or Q divides the outer region
// so that X's part touches only one end lane:
// min(Σ c − max(c_first, c_last), Σ c − c_first − c_last + 1).
// Two lanes already make a ladder: one cycle, whose outer region touches both
// lanes, so X reaches both without crossing it. Q changes that: no shared
// symbol lies between two lanes, so Q either crosses the cycle or runs outside
// it with X and divides that region; the count above gives
// min(c_first, c_last, 1). Z(p, n) is zero below three lanes.
//
// The bound is the largest of these. It is a lower bound, not the optimum.

import type { Model } from './model.ts'

/** Max-flow over a small network (Edmonds–Karp). */
const maxFlow = (count: number, capacity: Map<number, Map<number, number>>, source: number, sink: number): number => {
  const residual = new Map([...capacity].map(([from, row]) => [from, new Map(row)]))
  const at = (from: number, to: number): number => residual.get(from)?.get(to) ?? 0
  const add = (from: number, to: number, value: number): void => {
    if (!residual.has(from)) residual.set(from, new Map())
    residual.get(from)!.set(to, at(from, to) + value)
  }
  let total = 0
  for (;;) {
    const previous = new Array<number>(count).fill(-1)
    previous[source] = source
    const queue = [source]
    while (queue.length > 0 && previous[sink] === -1) {
      const node = queue.shift()!
      for (const [next, value] of residual.get(node) ?? []) {
        if (value > 0 && previous[next] === -1) {
          previous[next] = node
          queue.push(next)
        }
      }
    }
    if (previous[sink] === -1) return total
    let push = Infinity
    for (let node = sink; node !== source; node = previous[node]!) push = Math.min(push, at(previous[node]!, node))
    for (let node = sink; node !== source; node = previous[node]!) {
      add(previous[node]!, node, -push)
      add(node, previous[node]!, push)
    }
    total += push
    if (!Number.isFinite(total)) return total
  }
}

export const zarankiewicz = (m: number, n: number): number =>
  Math.floor(m / 2) * Math.floor((m - 1) / 2) * Math.floor(n / 2) * Math.floor((n - 1) / 2)

export const forcedCrossings = (model: Model): number => {
  const lanes = model.lanes.length
  // A ladder needs two rungs.
  if (lanes < 2) return 0
  const nodes = model.nodes
  // Undirected multigraph without stubs: crossings do not care which way flow runs.
  const links = new Map<number, Map<number, number>>()
  for (const edge of model.edges) {
    if (nodes[edge.from]!.role === 'stub' || nodes[edge.to]!.role === 'stub') continue
    for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      if (!links.has(a)) links.set(a, new Map())
      links.get(a)!.set(b, (links.get(a)!.get(b) ?? 0) + 1)
    }
  }
  const laneNodes = model.lanes.map((_, lane) => nodes.filter(node => node.lane === lane && node.role !== 'stub').map(node => node.index))
  const shared = nodes.filter(node => node.lane === null)
  const points = shared.filter(node => node.role === 'hub' || node.role === 'device').map(node => node.index)
  const bars = shared.filter(node => node.role === 'bar').map(node => node.index)

  // Disjoint paths from v through lane nodes (capacity one each) to sinks with
  // the given capacities. Node i splits into i (in) and count + i (out).
  const count = nodes.length
  const SINK = 2 * count
  const paths = (lane: number, v: number, sinks: ReadonlyMap<number, number>): number => {
    const capacity = new Map<number, Map<number, number>>()
    const set = (from: number, to: number, value: number) => {
      if (!capacity.has(from)) capacity.set(from, new Map())
      capacity.get(from)!.set(to, (capacity.get(from)!.get(to) ?? 0) + value)
    }
    const inside = new Set(laneNodes[lane]!)
    for (const node of inside) set(node, count + node, node === v ? Infinity : 1)
    for (const node of inside) {
      for (const [other, multiplicity] of links.get(node) ?? []) {
        if (inside.has(other)) set(count + node, other, multiplicity)
        else if (sinks.has(other)) set(count + node, other, multiplicity)
      }
    }
    for (const [sink, value] of sinks) set(sink, SINK, value)
    return maxFlow(2 * count + 1, capacity, v, SINK)
  }
  const touches = (shared: number, lane: number): boolean => laneNodes[lane]!.some(node => links.get(node)?.has(shared) ?? false)

  // A path from bar a to bar b through shared symbols only (not x, no lane, hub or stub).
  const closes = (a: number, b: number, x: number): boolean => {
    const passable = (node: number): boolean => node !== x && nodes[node]!.lane === null && nodes[node]!.role === 'device'
    const seen = new Set<number>()
    const queue = [...(links.get(a)?.keys() ?? [])].filter(passable)
    while (queue.length > 0) {
      const node = queue.shift()!
      if (seen.has(node)) continue
      seen.add(node)
      for (const next of links.get(node)?.keys() ?? []) {
        if (next === b) return true
        if (passable(next) && !seen.has(next)) queue.push(next)
      }
    }
    return false
  }

  // The ladder: per point X and bar pair, each lane's most paths to X beside its rung.
  let ladder = 0
  for (const x of points) {
    if (!model.lanes.every((_, lane) => touches(x, lane))) continue
    for (const a of bars) {
      for (const b of bars) {
        if (a >= b || !model.lanes.every((_, lane) => touches(a, lane) && touches(b, lane))) continue
        const perLane = model.lanes.map((_, lane) => Math.max(0, ...laneNodes[lane]!.map(v => {
          if (paths(lane, v, new Map([[a, 1], [b, 1]])) < 2) return -1
          // Sinks of a gammoid form a matroid: a set holding both bars extends to a largest one.
          return paths(lane, v, new Map([[a, 1], [b, 1], [x, Infinity]])) - 2
        })))
        if (perLane.some(c => c < 0)) continue
        const total = perLane.reduce((sum, c) => sum + c, 0)
        const [first, last] = [perLane[0]!, perLane.at(-1)!]
        const outer = total - first - last
        ladder = Math.max(ladder, closes(a, b, x) ? Math.min(total - Math.max(first, last), outer + 1) : outer)
      }
    }
  }

  // K(p, n): the largest set of points (at most six) that every lane reaches by disjoint paths from one of its nodes.
  const reaching = points.filter(x => model.lanes.every((_, lane) => touches(x, lane)))
  let complete = 0
  const subsets = (from: number, chosen: number[]): void => {
    if (chosen.length >= 3 && zarankiewicz(chosen.length, lanes) > complete) {
      const sinks = new Map(chosen.map(x => [x, 1]))
      if (model.lanes.every((_, lane) => laneNodes[lane]!.some(v => paths(lane, v, sinks) === chosen.length))) complete = zarankiewicz(chosen.length, lanes)
    }
    if (chosen.length === 6) return
    for (let next = from; next < reaching.length; next++) subsets(next + 1, [...chosen, reaching[next]!])
  }
  if (lanes >= 3) subsets(0, [])
  return Math.max(ladder, complete)
}
