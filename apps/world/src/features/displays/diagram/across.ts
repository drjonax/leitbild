// Cross-axis placement. Bands run hubs | shared | lane 0 … lane n | stubs, or
// with hubs on the high side shared | lanes | stubs | hubs, the hubs after
// everything the layers hold.
// Every lane has the same pitch, and a lane's drawing depends only on its own
// content and the bands before lane 0: adding lanes after it moves nothing in
// it. In a lane, the first symbol of every layer sits on the lane's main axis
// (lanes run straight); further symbols pack after it, and a long edge's
// dummies share one column. Layers without lane content (pumps under a
// header) place items at the median of their neighbours.
//
// Spacing: every item has a full reach (including pipes it routes beside
// itself) and a solid reach (symbol, text, frame). Text keeps the text
// clearance from other symbols' frames, so solids keep it between them; a
// pipe only has to stay off everything, so full reaches may touch. The pitch
// is the widest a lane reaches in any one layer, against the next lane in
// that same layer.
import type { DiagramProfile } from './diagram.ts'
import { ceilTo, roundTo } from './geometry.ts'
import type { Attachments } from './attach.ts'
import type { Layering } from './layering.ts'
import type { Model } from './model.ts'
import type { Ordering } from './ordering.ts'

export interface AcrossInput {
  readonly model: Model
  readonly profile: DiagramProfile
  readonly layering: Layering
  readonly ordering: Ordering
  /** Full reach of each item left and right of its anchor (bars: unused). */
  readonly left: ReadonlyArray<number>
  readonly right: ReadonlyArray<number>
  /** Solid reach (symbol, text, frame); −Infinity for a pipe. */
  readonly leftSolid: ReadonlyArray<number>
  readonly rightSolid: ReadonlyArray<number>
  /** Refined: a lane's long edge ordered before every symbol of its layers runs before the lane's axis, and strands keep their order. */
  readonly refine: boolean
  /** Per node: drawn mirrored (a folded return leg). */
  readonly flipped: ReadonlyArray<boolean>
  /** Room bars' labels need, kept where the shared items of lane layers are placed in order (refined). */
  readonly room: ReadonlyArray<LabelRoom>
  /** Net per edge: pipes of one net are one pipe up to their tee. */
  readonly net: ReadonlyArray<number>
}

/** A bar's label needs `after` (an item it attaches) at least `gap` past `before` (a run through the bar's layer). */
export interface LabelRoom {
  readonly before: number
  readonly after: number
  readonly gap: number
}

/** Where a band of items ends: everything, and the solids. */
interface Edge {
  readonly full: number
  readonly solid: number
}

export interface AcrossPlacement {
  /** Anchor per item; bars are placed later, by their attachments. */
  readonly c: ReadonlyArray<number>
  /** Lane i's band starts at `laneStart + i × pitch`. */
  readonly laneStart: number
  readonly pitch: number
  /**
   * Given the attachments, moves one strand that jogs at both ends into an
   * end's column, or one item whose pipe to a bar crosses another bar of its
   * stack out of that bar's span; returns the new anchors, or null when
   * nothing needs or allows a move.
   */
  readonly align: (attached: Attachments) => ReadonlyArray<number> | null
}

const MEDIAN_SWEEPS = 4

export const placeAcross = (input: AcrossInput): AcrossPlacement => {
  const { model, profile, layering, ordering, left, right, leftSolid, rightSolid, refine, flipped, room, net } = input
  const grid = profile.grid
  const laneCount = model.lanes.length
  const items = layering.items
  const c = new Array<number>(items.length).fill(Number.NaN)
  const { hub: HUB_BLOCK, shared: SHARED_BLOCK, lane: laneBlock, stub: STUB_BLOCK } = ordering.blocks
  const high = ordering.hubSide === 'high'
  const isDummy = (item: number): boolean => items[item]!.node === null
  const isBar = (item: number): boolean => items[item]!.node !== null && model.nodes[items[item]!.node!]!.role === 'bar'
  /** A symbol or stub: what a strand must line up with to jog only once. */
  const isPlain = (item: number): boolean => !isDummy(item) && !isBar(item) && ordering.block[item] !== HUB_BLOCK
  const clear = profile.textClearance
  const need = (rightFull: number, rightHard: number, leftFull: number, leftHard: number): number => Math.max(rightFull + leftFull, rightHard + leftHard + clear)
  const separation = (a: number, b: number): number => ceilTo(need(right[a]!, rightSolid[a]!, left[b]!, leftSolid[b]!), grid)
  const edgeOf = (run: ReadonlyArray<number>, start: Edge): Edge => ({
    full: Math.max(start.full, ...run.map(item => c[item]! + right[item]!)),
    solid: Math.max(start.solid, ...run.map(item => c[item]! + rightSolid[item]!)),
  })
  /** Packs items after `start`; returns where they end. */
  const pack = (run: ReadonlyArray<number>, start: Edge): Edge => {
    let previous = -1
    for (const item of run) {
      c[item] = previous < 0 ? ceilTo(need(start.full, start.solid, left[item]!, leftSolid[item]!), grid) : c[previous]! + separation(previous, item)
      previous = item
    }
    return edgeOf(run, start)
  }
  const origin: Edge = { full: 0, solid: -Infinity }

  const inBlock = (layer: ReadonlyArray<number>, block: number): number[] => layer.filter(item => ordering.block[item] === block && !isBar(item))
  const hasLaneContent = (layer: ReadonlyArray<number>): boolean => layer.some(item => ordering.block[item]! >= laneBlock(0) && ordering.block[item]! < STUB_BLOCK)

  const hubs = ordering.layers.flatMap(layer => inBlock(layer, HUB_BLOCK)).sort((a, b) => items[a]!.node! - items[b]!.node!)
  const hubBandEnd = high ? origin : pack(hubs, origin)
  const laneLayers = ordering.layers.filter(hasLaneContent)
  // Shared items of lane layers pack after the hub band; then each shared
  // strand (a long lane-less edge's dummies) takes one column through all its
  // layers, after what each of them already holds, so it runs straight. A
  // strand between two symbols lines up with the first of them already placed
  // when that column lies past what its layers hold, so the edge jogs only at
  // its other end.
  const sharedRuns = ordering.layers.map(layer => (hasLaneContent(layer) ? inBlock(layer, SHARED_BLOCK).filter(item => !isDummy(item)) : []))
  const strandsOf = (block: number): Map<number, number[]> => {
    const strands = new Map<number, number[]>()
    items.forEach((item, index) => {
      if (isDummy(index) && ordering.block[index] === block) strands.set(item.edge!, [...(strands.get(item.edge!) ?? []), index])
    })
    return strands
  }
  const sharedStrands = strandsOf(SHARED_BLOCK)
  // Shared strands a lane layer places are fixed: free layers keep their column.
  const fixedColumn = new Map<number, number>()
  // Refined, the shared items of lane layers keep their order: each strand is one column through its
  // layers, packed with the symbols by the longest path over each layer's order, from the hub band.
  // Neighbouring strands of one net are one pipe up to where they part: they keep no order or distance
  // among themselves, and what follows them clears them all. A strand whose order disagrees between its
  // layers would cross another there: it goes after its layers' items, as unordered. Then, nearest the
  // hubs first, a strand lines up with a shared symbol at one of its ends where that puts it in line,
  // widens nothing and keeps the strands lined up before it in line, so the edge jogs only at its other end.
  const placeSharedInOrder = (): void => {
    const lists = ordering.layers.map(layer => (hasLaneContent(layer) ? inBlock(layer, SHARED_BLOCK) : []))
    const unitOf = (item: number): number => (isDummy(item) ? -1 - items[item]!.edge! : item)
    const membersOf = (): Map<number, number[]> => {
      const members = new Map<number, number[]>()
      lists.forEach(list => list.forEach(item => members.set(unitOf(item), [...(members.get(unitOf(item)) ?? []), item])))
      return members
    }
    const kin = (a: number, b: number): boolean => isDummy(a) && isDummy(b) && net[items[a]!.edge!] === net[items[b]!.edge!]
    // What an item must clear in its layer: the group before its own (a run of kin strands, or one item).
    const before = (item: number): number[] => {
      const list = lists[items[item]!.layer]!
      let start = list.indexOf(item)
      while (start > 0 && kin(list[start - 1]!, item)) start--
      if (start === 0) return []
      const last = list[start - 1]!
      let first = start - 1
      while (first > 0 && kin(list[first - 1]!, last)) first--
      return list.slice(first, start)
    }
    // Units in an order every layer agrees with, nearest the hubs first; or the strand that blocks one.
    const sequenceOf = (members: ReadonlyMap<number, ReadonlyArray<number>>): { readonly sequence: number[] } | { readonly blocking: number } => {
      const done = new Set<number>()
      const sequence: number[] = []
      const meanIndex = (unit: number): number => members.get(unit)!.reduce((sum, item) => sum + lists[items[item]!.layer]!.indexOf(item), 0) / members.get(unit)!.length
      const ready = (unit: number): boolean => members.get(unit)!.every(item => before(item).every(other => done.has(unitOf(other))))
      while (sequence.length < members.size) {
        const waiting = [...members.keys()].filter(unit => !done.has(unit))
        const next = waiting.filter(ready).sort((a, b) => (meanIndex(a) - meanIndex(b)) || (a - b))[0]
        if (next === undefined) {
          // Only a unit in several layers can close a cycle: a strand.
          const blocking = waiting.filter(unit => unit < 0).sort((a, b) => b - a)[0]
          if (blocking === undefined) throw new Error('shared items of lane layers cannot be ordered')
          return { blocking }
        }
        done.add(next)
        sequence.push(next)
      }
      return { sequence }
    }
    let members = membersOf()
    let ordered = sequenceOf(members)
    while ('blocking' in ordered) {
      for (const item of members.get(ordered.blocking)!) {
        const list = lists[items[item]!.layer]!
        list.splice(list.indexOf(item), 1)
        list.push(item)
      }
      members = membersOf()
      ordered = sequenceOf(members)
    }
    const { sequence } = ordered
    const floorAt = (item: number): number => ceilTo(need(hubBandEnd.full, hubBandEnd.solid, left[item]!, leftSolid[item]!), grid)
    const compact = (lining: ReadonlyMap<number, number>): Map<number, number> => {
      const at = new Map<number, number>()
      for (const unit of sequence) {
        const value = Math.max(...members.get(unit)!.flatMap(item => {
          const previous = before(item)
          return previous.length === 0 ? [floorAt(item)] : previous.map(other => at.get(unitOf(other))! + separation(other, item))
        }))
        // A label's room counts where the run before it is already placed.
        const labels = room.filter(entry => unitOf(entry.after) === unit && at.has(unitOf(entry.before))).map(entry => at.get(unitOf(entry.before))! + entry.gap)
        at.set(unit, Math.max(value, lining.get(unit) ?? -Infinity, ...labels))
      }
      return at
    }
    const bandOf = (at: ReadonlyMap<number, number>): Edge => lists.flat().reduce((edge, item) => ({
      full: Math.max(edge.full, at.get(unitOf(item))! + right[item]!),
      solid: Math.max(edge.solid, at.get(unitOf(item))! + rightSolid[item]!),
    }), hubBandEnd)
    const packed = compact(new Map())
    const band = bandOf(packed)
    const lining = new Map<number, number>()
    const lined = new Map<number, number>()
    let current = packed
    for (const unit of sequence.filter(unit => unit < 0)) {
      const chain = layering.chains[-1 - unit]!
      if (!chain.steps.every(step => step === 'next')) continue
      for (const end of [chain.items[0]!, chain.items.at(-1)!].filter(item => isPlain(item) && current.has(item))) {
        const target = current.get(end)!
        if (target <= current.get(unit)!) continue
        lining.set(unit, target)
        const trial = compact(lining)
        const wider = bandOf(trial)
        if (trial.get(unit) === trial.get(end) && wider.full <= band.full && wider.solid <= band.solid && [...lined].every(([other, symbol]) => trial.get(symbol) === trial.get(other))) {
          lined.set(unit, end)
          current = trial
          break
        }
        lining.delete(unit)
      }
    }
    for (const [unit, value] of compact(lining)) {
      if (unit >= 0) c[unit] = value
      else {
        for (const item of sharedStrands.get(-1 - unit)!) {
          c[item] = value
          fixedColumn.set(item, value)
        }
      }
    }
    lists.forEach((list, layer) => sharedRuns[layer]!.splice(0, sharedRuns[layer]!.length, ...list))
  }
  if (refine) placeSharedInOrder()
  else {
    sharedRuns.forEach(run => pack(run, hubBandEnd))
    for (const edge of [...sharedStrands.keys()].sort((a, b) => a - b)) {
      const strand = sharedStrands.get(edge)!
      const inLaneLayers = strand.filter(item => hasLaneContent(ordering.layers[items[item]!.layer]!))
      if (inLaneLayers.length === 0) continue
      const chain = layering.chains[edge]!
      const ends = [chain.items[0]!, chain.items.at(-1)!]
      const lined = chain.steps.every(step => step === 'next') && ends.every(isPlain) ? ends.map(item => c[item]!).find(Number.isFinite) : undefined
      const at = Math.max(lined ?? -Infinity, ...inLaneLayers.map(item => {
        const run = sharedRuns[items[item]!.layer]!
        const last = run.at(-1)
        return last === undefined ? ceilTo(need(hubBandEnd.full, hubBandEnd.solid, left[item]!, leftSolid[item]!), grid) : c[last]! + separation(last, item)
      }))
      for (const item of strand) {
        c[item] = at
        fixedColumn.set(item, at)
      }
      for (const item of inLaneLayers) sharedRuns[items[item]!.layer]!.push(item)
    }
  }
  const sharedEnds = sharedRuns.map(run => edgeOf(run, hubBandEnd))
  const sharedEnd: Edge = { full: Math.max(hubBandEnd.full, ...sharedEnds.map(edge => edge.full)), solid: Math.max(hubBandEnd.solid, ...sharedEnds.map(edge => edge.solid)) }

  // Each lane relative to its own main axis (0).
  const relative = new Array<number>(items.length).fill(Number.NaN)
  const lanes = model.lanes.map((_, lane) => {
    const cells = ordering.layers.map(layer => inBlock(layer, laneBlock(lane)))
    const placed = cells.map(() => [] as number[])
    const axisTaken = cells.map(() => false)
    const after = (layer: number, item: number): number => {
      const last = placed[layer]!.at(-1)
      return last === undefined ? -Infinity : relative[last]! + separation(last, item)
    }
    cells.forEach((cell, layer) => {
      for (const item of cell.filter(member => !isDummy(member))) {
        relative[item] = placed[layer]!.length === 0 ? 0 : after(layer, item)
        if (relative[item] === 0) axisTaken[layer] = true
        placed[layer]!.push(item)
      }
    })
    const strands = new Map<number, number[]>()
    cells.forEach(cell => cell.filter(isDummy).forEach(item => {
      const edge = items[item]!.edge!
      strands.set(edge, [...(strands.get(edge) ?? []), item])
    }))
    // Refined: a strand ordered before every symbol of the layers it shares with them runs before the axis.
    const rank = (item: number): number => cells[items[item]!.layer]!.indexOf(item)
    const leads = (item: number): boolean => {
      const cell = cells[items[item]!.layer]!
      const first = cell.findIndex(member => !isDummy(member))
      return first < 0 || cell.indexOf(item) < first
    }
    const strandKeys = [...strands.keys()].sort((a, b) => a - b)
    const ahead = refine ? strandKeys.filter(edge => strands.get(edge)!.some(item => cells[items[item]!.layer]!.some(member => !isDummy(member))) && strands.get(edge)!.every(leads)) : []
    const behind = strandKeys.filter(edge => !ahead.includes(edge))
    const meanRank = (edge: number): number => strands.get(edge)!.reduce((sum, item) => sum + rank(item), 0) / strands.get(edge)!.length
    if (refine) behind.sort((a, b) => (meanRank(a) - meanRank(b)) || (a - b))
    for (const edge of behind) {
      const strand = strands.get(edge)!
      const onAxis = strand.every(item => !axisTaken[items[item]!.layer])
      const wanted = Math.max(...strand.map(item => after(items[item]!.layer, item)))
      const at = onAxis ? 0 : Number.isFinite(wanted) ? wanted : 0
      for (const item of strand) {
        relative[item] = at
        if (at === 0) axisTaken[items[item]!.layer] = true
        placed[items[item]!.layer]!.push(item)
      }
    }
    // Before the axis, nearest strand first: each clears what its layers already hold on that side.
    const lowest = (layer: number): number | undefined => placed[layer]!.reduce<number | undefined>((low, item) => (low === undefined || relative[item]! < relative[low]! ? item : low), undefined)
    for (const edge of [...ahead].sort((a, b) => (meanRank(b) - meanRank(a)) || (a - b))) {
      const strand = strands.get(edge)!
      const at = Math.min(...strand.map(item => {
        const low = lowest(items[item]!.layer)
        return low === undefined ? 0 : relative[low]! - separation(item, low)
      }))
      for (const item of strand) {
        relative[item] = at
        placed[items[item]!.layer]!.push(item)
      }
    }
    // Per layer: how far the lane reaches, fully and with solids.
    return placed.map(list => (list.length === 0 ? null : {
      low: Math.min(...list.map(item => relative[item]! - left[item]!)),
      high: Math.max(...list.map(item => relative[item]! + right[item]!)),
      lowSolid: Math.min(...list.map(item => relative[item]! - leftSolid[item]!)),
      highSolid: Math.max(...list.map(item => relative[item]! + rightSolid[item]!)),
    }))
  })
  const reach = (lane: number, which: 'low' | 'high' | 'lowSolid' | 'highSolid'): number => {
    const values = lanes[lane]!.filter(entry => entry !== null).map(entry => entry![which])
    return which === 'low' || which === 'lowSolid' ? Math.min(0, ...values) : Math.max(0, ...values)
  }
  const pairs: number[] = []
  for (let lane = 0; lane < laneCount; lane++) {
    const next = lanes[lane + 1] === undefined ? lane : lane + 1
    lanes[lane]!.forEach((here, layer) => {
      const there = lanes[next]![layer]
      if (here === null || there === null || there === undefined) return
      pairs.push(need(here.high, here.highSolid, -there.low, -there.lowSolid))
    })
  }
  const pitch = ceilTo(Math.max(grid, ...pairs), grid)
  const firstAxis = laneCount === 0 ? 0 : ceilTo(need(sharedEnd.full, sharedEnd.solid, -reach(0, 'low'), -reach(0, 'lowSolid')), grid)
  items.forEach((item, index) => {
    if (item.lane !== null && ordering.block[index] === laneBlock(item.lane)) c[index] = firstAxis + item.lane * pitch + relative[index]!
  })
  const bandLow = Math.min(0, ...model.lanes.map((_, lane) => reach(lane, 'low')))
  const lastAxis = firstAxis + (laneCount - 1) * pitch
  const lanesEnd: Edge = laneCount === 0 ? sharedEnd : { full: lastAxis + reach(laneCount - 1, 'high'), solid: lastAxis + reach(laneCount - 1, 'highSolid') }
  for (const layer of laneLayers) pack(inBlock(layer, STUB_BLOCK), lanesEnd)

  // Layers without lane content: medians of neighbours, order kept. A long
  // edge's dummies there form a strand that runs in one column. Between two
  // symbols it lines up with one of them (its source, by preference), so the
  // edge jogs once; a bar meets a strand straight and a hub reaches it along
  // its track, so a strand from or to either needs only its one column.
  const free = ordering.layers.map(layer => (hasLaneContent(layer) ? [] : layer.filter(item => ordering.block[item] !== HUB_BLOCK && !isBar(item))))
    .filter(run => run.length > 0)
  const lowerBound = hubs.length > 0 && !high ? hubBandEnd : null
  for (const run of free) pack(run, lowerBound ?? origin)
  for (const [item, at] of fixedColumn) c[item] = at
  const neighbours = items.map(() => [] as number[])
  for (const chain of layering.chains) {
    chain.steps.forEach((step, k) => {
      if (step !== 'next') return
      neighbours[chain.items[k]!]!.push(chain.items[k + 1]!)
      neighbours[chain.items[k + 1]!]!.push(chain.items[k]!)
    })
  }
  // Free strands: shared dummies of a chain that runs layer to layer, none of them fixed by a lane layer.
  // Refined, a return run that turns at one end counts too: it runs straight from its other end.
  const turnsAt = (edge: number): 'start' | 'end' | null => {
    const steps = layering.chains[edge]!.steps
    if (!refine || steps.length < 2) return null
    if (steps.at(-1) === 'turnAbove' && steps.slice(0, -1).every(step => step === 'next')) return 'end'
    if (steps[0] === 'turnBelow' && steps.slice(1).every(step => step === 'next')) return 'start'
    return null
  }
  const strands = [...sharedStrands].filter(([edge, strand]) => strand.every(item => !fixedColumn.has(item)) && (layering.chains[edge]!.steps.every(step => step === 'next') || turnsAt(edge) !== null))
    .map(([edge, strand]) => {
      const chain = layering.chains[edge]!
      const [start, end] = [chain.items[0]!, chain.items.at(-1)!]
      // It follows the end that stays put (one a lane layer placed) or, both free, its source.
      const settled = (item: number): boolean => !free.some(run => run.includes(item))
      const turn = turnsAt(edge)
      const leader = turn === 'end' ? (isPlain(start) ? start : null)
        : turn === 'start' ? (isPlain(end) ? end : null)
          : !isPlain(start) || !isPlain(end) ? null : settled(end) && !settled(start) ? end : start
      return { edge, strand, start, end, leader, turn }
    })
  const leaderOf = new Map(strands.flatMap(entry => entry.strand.map(item => [item, entry.leader] as const)))
  const neighbourPositions = (item: number): number[] => {
    const own = items[item]!.layer
    const positions: number[] = []
    for (const other of neighbours[item]!) {
      if (ordering.block[other] === HUB_BLOCK) continue
      if (!isBar(other)) {
        if (Number.isFinite(c[other]!)) positions.push(c[other]!)
        continue
      }
      // Through a bar: align with what the bar feeds on its far side.
      for (const far of neighbours[other]!) {
        if (far !== item && items[far]!.layer !== own && !isBar(far) && ordering.block[far] !== HUB_BLOCK && Number.isFinite(c[far]!)) positions.push(c[far]!)
      }
    }
    return positions.sort((a, b) => a - b)
  }
  const median = (positions: ReadonlyArray<number>): number => (positions[Math.floor((positions.length - 1) / 2)]! + positions[Math.ceil((positions.length - 1) / 2)]!) / 2
  const forbidden = (item: number): Set<number> => {
    // A run through a stack of bars must not share a column with another bar's branch on the far side.
    const own = items[item]!.layer
    const result = new Set<number>()
    for (const direction of [1, -1]) {
      const barLayer = ordering.layers[own + direction]
      if (barLayer === undefined) continue
      const bars = barLayer.filter(isBar)
      if (bars.length < 2) continue
      for (const bar of bars) {
        if (neighbours[item]!.includes(bar)) continue
        for (const far of neighbours[bar]!) {
          if (items[far]!.layer === own + 2 * direction && Number.isFinite(c[far]!)) result.add(c[far]!)
        }
      }
    }
    return result
  }
  // Refined, a folded leg's symbols and stubs, drawn where no lane reaches, keep within the edge the lanes' layers start at: a leg never widens the drawing.
  const legItem = (item: number): boolean => refine && items[item]!.node !== null && flipped[items[item]!.node!]!
  const floorOf = (item: number): number => {
    const bound = lowerBound ?? (legItem(item) ? origin : null)
    return bound === null ? -Infinity : ceilTo(need(bound.full, bound.solid, left[item]!, leftSolid[item]!), grid)
  }
  // Who decides where a pool of touching items sits: fixed strands, then free strands, then the rest.
  const priority = (item: number): number => (fixedColumn.has(item) ? 2 : (leaderOf.get(item) ?? null) !== null ? 1 : 0)
  const placeMedian = (run: ReadonlyArray<number>): void => {
    const want = run.map(item => {
      const pinned = fixedColumn.get(item)
      if (pinned !== undefined) return pinned
      const leader = leaderOf.get(item)
      if (leader !== undefined && leader !== null && Number.isFinite(c[leader]!)) return c[leader]!
      const positions = neighbourPositions(item)
      return positions.length === 0 ? c[item]! : median(positions)
    })
    const offsets = run.map(() => 0)
    for (let i = 1; i < run.length; i++) offsets[i] = offsets[i - 1]! + separation(run[i - 1]!, run[i]!)
    // Isotonic regression (pool adjacent violators) of want − offset keeps order
    // and separation; a pool sits where its highest-priority members want it.
    const pools: Array<{ priority: number; sum: number; count: number; size: number }> = []
    run.forEach((item, i) => {
      pools.push({ priority: priority(item), sum: want[i]! - offsets[i]!, count: 1, size: 1 })
      while (pools.length > 1 && pools.at(-2)!.sum / pools.at(-2)!.count > pools.at(-1)!.sum / pools.at(-1)!.count) {
        const top = pools.pop()!
        const below = pools.at(-1)!
        const merged = below.priority === top.priority ? { priority: below.priority, sum: below.sum + top.sum, count: below.count + top.count }
          : below.priority > top.priority ? below : top
        pools[pools.length - 1] = { priority: merged.priority, sum: merged.sum, count: merged.count, size: below.size + top.size }
      }
    })
    const floor = floorOf(run[0]!)
    let i = 0
    for (const pool of pools) {
      // A leg member anywhere in the pool holds the pool off the edge.
      const legs = run.slice(i, i + pool.size).flatMap((item, k) => (legItem(item) ? [floorOf(item) - offsets[i + k]!] : []))
      const value = Math.max(roundTo(pool.sum / pool.count, grid), floor, ...legs)
      for (let k = 0; k < pool.size; k++, i++) c[run[i]!] = value + offsets[i]!
    }
    for (let k = 0; k < run.length; k++) {
      if (k > 0) c[run[k]!] = Math.max(c[run[k]!]!, c[run[k - 1]!]! + separation(run[k - 1]!, run[k]!))
      const blocked = forbidden(run[k]!)
      while (blocked.has(c[run[k]!]!)) c[run[k]!]! += grid
    }
  }
  for (let round = 0; round < MEDIAN_SWEEPS; round++) {
    for (const run of free) placeMedian(run)
    for (const run of [...free].reverse()) placeMedian(run)
  }

  // Once ports have their slots, a strand that still jogs at both ends (or
  // breaks its column) moves whole into the column of an end's port. The
  // items beside it in each layer it passes make room, keeping their order
  // and spacing; strands a lane layer fixed, the hub band and the columns a
  // bar stack forbids stay as they are. Of the ends that can be reached, the
  // one that moves the least wins.
  const runOf = new Map(free.flatMap(run => run.map((item, index) => [item, { run, index }] as const)))
  const makeRoom = (strand: ReadonlyArray<number>, at: number): Map<number, number> | null => {
    const moves = new Map<number, number>()
    for (const item of strand) {
      const { run, index } = runOf.get(item)!
      if (at < floorOf(item) || forbidden(item).has(at)) return null
      moves.set(item, at)
      for (const direction of [1, -1] as const) {
        let previous = item
        for (let k = index + direction; k >= 0 && k < run.length; k += direction) {
          const other = run[k]!
          const [low, high] = direction === 1 ? [previous, other] : [other, previous]
          const gap = separation(low, high)
          let wanted = direction === 1 ? Math.max(c[other]!, moves.get(previous)! + gap) : Math.min(c[other]!, moves.get(previous)! - gap)
          if (wanted === c[other]) break
          const blocked = forbidden(other)
          while (blocked.has(wanted)) wanted += direction * grid
          if (fixedColumn.has(other) || wanted < floorOf(other)) return null
          moves.set(other, wanted)
          previous = other
        }
      }
    }
    return moves
  }
  // Hubs on the high side go after everything else, in every layer; what
  // connects only to them, alone in its layer (a stub feeding the core), sits
  // just before them, beside the hub it ends at.
  const freeItems = new Set(free.flat())
  const satellites = high ? items.map((_, index) => index).filter(index => !isDummy(index) && freeItems.has(index)
    && neighbours[index]!.length > 0 && neighbours[index]!.every(other => ordering.block[other] === HUB_BLOCK)
    && ordering.layers[items[index]!.layer]!.every(other => other === index || ordering.block[other] === HUB_BLOCK)) : []
  const placeHighHubs = (): void => {
    if (!high || hubs.length === 0) return
    const others = items.map((_, index) => index).filter(index => ordering.block[index] !== HUB_BLOCK && !isBar(index) && !satellites.includes(index) && Number.isFinite(c[index]!))
    // Outside the last lane's band too, which is drawn as its zone.
    const lanesBand = laneCount === 0 ? -Infinity : firstAxis + bandLow + laneCount * pitch
    pack(hubs, {
      full: Math.max(0, lanesBand, ...others.map(index => c[index]! + right[index]!)),
      solid: Math.max(-Infinity, ...others.map(index => c[index]! + rightSolid[index]!)),
    })
    // A satellite's layer holds nothing else, so it needs room only beside its hub.
    let next = hubs[0]!
    for (const satellite of [...satellites].reverse()) {
      c[satellite] = c[next]! - separation(satellite, next)
      next = satellite
    }
  }
  placeHighHubs()

  // A folded leg's symbol whose pipe to a strand or to a symbol a lane layer
  // placed jogs moves once into line with it, when its layer has room: the
  // nearest such line wins. Stubs follow their symbol, not the other way.
  const symbols = [...freeItems].filter(item => legItem(item) && isPlain(item) && model.nodes[items[item]!.node!]!.role !== 'stub' && !fixedColumn.has(item)).sort((a, b) => a - b)
  const lined = new Set<number>()
  const lineUp = (pins: ReadonlyArray<ReadonlyArray<number>>): boolean => {
    for (const symbol of symbols) {
      if (lined.has(symbol)) continue
      const offsets = layering.chains.flatMap((chain, index) => {
        const ends = [[0, 1], [chain.items.length - 1, chain.items.length - 2]] as const
        return ends.flatMap(([position, adjacent]) => {
          if (chain.items[position] !== symbol || chain.steps[position === 0 ? 0 : chain.steps.length - 1] !== 'next') return []
          const other = chain.items[adjacent]!
          const steady = isDummy(other) ? fixedColumn.has(other) || (leaderOf.get(other) ?? null) !== null : isPlain(other) && !freeItems.has(other)
          const delta = pins[index]![adjacent]! - pins[index]![position]!
          return steady && delta !== 0 && Number.isFinite(delta) ? [delta] : []
        })
      }).sort((a, b) => (Math.abs(a) - Math.abs(b)) || (a - b))
      lined.add(symbol)
      for (const delta of offsets) {
        const moves = makeRoom([symbol], c[symbol]! + delta)
        if (moves === null) continue
        for (const [item, value] of moves) c[item] = value
        return true
      }
    }
    return false
  }
  // A symbol or stub of a free layer whose pipe to a bar passes another bar of the stack inside its span
  // crosses it: it moves out of that span once, the nearer way its layer has room for that clears every
  // bar its pipe passes, within what the drawing already spans across (a crossing is not traded for
  // size). The bars' rows come from the attachments, so this waits for them.
  const bars = items.map((_, index) => index).filter(isBar)
  const stacked = bars.filter(bar => bars.some(other => other !== bar && items[other]!.layer === items[bar]!.layer))
  const escaped = new Set<number>()
  const escape = (attached: Attachments): boolean => {
    const placed = items.map((_, index) => index).filter(index => Number.isFinite(c[index]!) && !isBar(index))
    const low = Math.min(...placed.map(index => c[index]! - left[index]!))
    const high = Math.max(...placed.map(index => c[index]! + right[index]!))
    for (const bar of stacked) {
      const layer = items[bar]!.layer
      const stack = stacked.filter(other => other !== bar && items[other]!.layer === layer)
      for (const [index, chain] of layering.chains.entries()) {
        const position = chain.items.indexOf(bar)
        if (position < 0) continue
        const k = position === 0 ? 1 : position - 1
        const other = chain.items[k]!
        if (escaped.has(other) || !freeItems.has(other) || !isPlain(other)) continue
        const pin = attached.pin[index]![k]!
        const upstream = items[other]!.layer < layer
        const passed = stack.filter(y => (upstream ? attached.barRow[y]! < attached.barRow[bar]! : attached.barRow[y]! > attached.barRow[bar]!))
        const within = (at: number): boolean => passed.some(y => at > attached.span[y]![0] && at < attached.span[y]![1])
        if (!within(pin)) continue
        escaped.add(other)
        const crossed = passed.filter(y => pin > attached.span[y]![0] && pin < attached.span[y]![1])
        const targets = [Math.min(...crossed.map(y => attached.span[y]![0])) - grid / 2, Math.max(...crossed.map(y => attached.span[y]![1])) + grid / 2]
          .filter(at => !within(at))
          .sort((a, b) => (Math.abs(a - pin) - Math.abs(b - pin)) || (a - b))
        for (const at of targets) {
          const moves = makeRoom([other], c[other]! + at - pin)
          if (moves === null || [...moves].some(([item, value]) => value - left[item]! < low || value + right[item]! > high)) continue
          for (const [item, value] of moves) c[item] = value
          return true
        }
      }
    }
    return false
  }
  let budget = 2 * strands.length + symbols.length + stacked.length
  const align = (attached: Attachments): ReadonlyArray<number> | null => {
    if (budget <= 0) return null
    const pins = attached.pin
    if (lineUp(pins) || escape(attached)) {
      budget--
      placeHighHubs()
      return [...c]
    }
    for (const { strand, start, end, edge, turn } of strands) {
      // A turning end is met from beside, not in its column.
      const positions = [0, layering.chains[edge]!.items.length - 1].filter(position => isPlain(position === 0 ? start : end) && !(turn === 'end' && position > 0) && !(turn === 'start' && position === 0))
      const endPins = positions.map(position => pins[edge]![position]!)
      const columns = [...new Set(strand.map(item => c[item]!))]
      if (columns.length === 1 && (positions.length < 2 || endPins.includes(columns[0]!))) continue
      let best: { moves: Map<number, number>; cost: number } | null = null
      for (const at of new Set([...endPins, ...(positions.length < 2 ? columns : [])])) {
        const moves = makeRoom(strand, at)
        if (moves === null) continue
        const cost = [...moves].reduce((sum, [item, value]) => sum + Math.abs(value - c[item]!), 0)
        if (best === null || cost < best.cost) best = { moves, cost }
      }
      if (best === null) continue
      for (const [item, value] of best.moves) c[item] = value
      budget--
      placeHighHubs()
      return [...c]
    }
    return null
  }
  return { c: [...c], laneStart: firstAxis + bandLow, pitch, align }
}
