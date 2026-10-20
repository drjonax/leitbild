// The fewest crossings a graph's structure forces on a partition drawing, from the
// graph alone. A partition drawing is what this engine draws: partitions are disjoint
// bands in partition order, a partition's pipes stay in its band, bars are segments
// across the flow, and shared symbols and common nodes lie outside the partitions' bands.
// Two structures force crossings:
//
// Shared points (common nodes, shared symbols) that each reach every partition by paths
// inside that partition, disjoint from each other: the partitions and points contain a
// subdivision of K(p, n), which no drawing shows with fewer than
// Z(p, n) = ⌊p/2⌋⌊(p−1)/2⌋⌊n/2⌋⌊(n−1)/2⌋ crossings (Kleitman, p ≤ 6).
//
// The ladder. Two bars A and B joined through every partition by a rung (a path
// A → v → B inside the partition), and a shared point X with c_L disjoint paths
// from X to partition L's v, apart from the rungs. A bar is a segment, so K(p, n)
// does not hold for it (a pipe crosses a bar once wherever it passes).
// Instead the bars and rungs form a ladder; its rungs stay in their partitions'
// bands, so the ladder does not cross itself, and each region it leaves
// between two neighbouring partitions touches only those partitions' v. X lies outside
// the partitions, in the region that touches only the first and the last partition, so
// each of its paths to every other partition crosses the ladder:
// Σ c_L − c_first − c_last. Where a path Q of shared symbols joins A to B
// besides the rungs (a feed train closing the cycle through the headers),
// either Q crosses the ladder too (one more), or Q divides the outer region
// so that X's part touches only one end partition:
// min(Σ c − max(c_first, c_last), Σ c − c_first − c_last + 1).
// Two partitions already make a ladder: one cycle, whose outer region touches both
// partitions, so X reaches both without crossing it. Q changes that: no shared
// symbol lies between two partitions, so Q either crosses the cycle or runs outside
// it with X and divides that region; the count above gives
// min(c_first, c_last, 1). Z(p, n) is zero below three partitions.
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
  const partitions = model.partitions.length
  // A ladder needs two rungs.
  if (partitions < 2) return 0
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
  const partitionNodes = model.partitions.map((_, partition) => nodes.filter(node => node.partition === partition && node.role !== 'stub').map(node => node.index))
  const shared = nodes.filter(node => node.partition === null)
  const points = shared.filter(node => node.role === 'common' || node.role === 'device').map(node => node.index)
  const bars = shared.filter(node => node.role === 'bar').map(node => node.index)

  // Disjoint paths from v through partition nodes (capacity one each) to sinks with
  // the given capacities. Node i splits into i (in) and count + i (out).
  const count = nodes.length
  const SINK = 2 * count
  const paths = (partition: number, v: number, sinks: ReadonlyMap<number, number>): number => {
    const capacity = new Map<number, Map<number, number>>()
    const set = (from: number, to: number, value: number) => {
      if (!capacity.has(from)) capacity.set(from, new Map())
      capacity.get(from)!.set(to, (capacity.get(from)!.get(to) ?? 0) + value)
    }
    const inside = new Set(partitionNodes[partition]!)
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
  const touches = (shared: number, partition: number): boolean => partitionNodes[partition]!.some(node => links.get(node)?.has(shared) ?? false)

  // A path from bar a to bar b through shared symbols only (not x, no partition, common node or stub).
  const closes = (a: number, b: number, x: number): boolean => {
    const passable = (node: number): boolean => node !== x && nodes[node]!.partition === null && nodes[node]!.role === 'device'
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

  // The ladder: per point X and bar pair, each partition's most paths to X beside its rung.
  let ladder = 0
  for (const x of points) {
    if (!model.partitions.every((_, partition) => touches(x, partition))) continue
    for (const a of bars) {
      for (const b of bars) {
        if (a >= b || !model.partitions.every((_, partition) => touches(a, partition) && touches(b, partition))) continue
        const perPartition = model.partitions.map((_, partition) => Math.max(0, ...partitionNodes[partition]!.map(v => {
          if (paths(partition, v, new Map([[a, 1], [b, 1]])) < 2) return -1
          // Sinks of a gammoid form a matroid: a set holding both bars extends to a largest one.
          return paths(partition, v, new Map([[a, 1], [b, 1], [x, Infinity]])) - 2
        })))
        if (perPartition.some(c => c < 0)) continue
        const total = perPartition.reduce((sum, c) => sum + c, 0)
        const [first, last] = [perPartition[0]!, perPartition.at(-1)!]
        const outer = total - first - last
        ladder = Math.max(ladder, closes(a, b, x) ? Math.min(total - Math.max(first, last), outer + 1) : outer)
      }
    }
  }

  // K(p, n): the largest set of points (at most six) that every partition reaches by disjoint paths from one of its nodes.
  const reaching = points.filter(x => model.partitions.every((_, partition) => touches(x, partition)))
  let complete = 0
  const subsets = (from: number, chosen: number[]): void => {
    if (chosen.length >= 3 && zarankiewicz(chosen.length, partitions) > complete) {
      const sinks = new Map(chosen.map(x => [x, 1]))
      if (model.partitions.every((_, partition) => partitionNodes[partition]!.some(v => paths(partition, v, sinks) === chosen.length))) complete = zarankiewicz(chosen.length, partitions)
    }
    if (chosen.length === 6) return
    for (let next = from; next < reaching.length; next++) subsets(next + 1, [...chosen, reaching[next]!])
  }
  if (partitions >= 3) subsets(0, [])
  return Math.max(ladder, complete)
}
