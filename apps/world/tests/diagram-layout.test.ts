import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  diagramCandidates,
  layoutDiagram,
  verifyDiagram,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramLayoutResult,
  type DiagramNode,
  type DiagramProfile,
  type DiagramRoom,
  type DiagramText,
} from '../src/features/displays/diagram/index.ts'
import { buildModel } from '../src/features/displays/diagram/model.ts'
import { costsInReferences } from './cpu-cost.ts'
import { forcedCrossings } from './diagram-crossing-bound.ts'

// Synthetic, Plant-agnostic fixtures: the engine sees only structure.

type Line = DiagramText['lines'][number]
const tag = (width: number): Line => ({ width, height: 16, required: true })
const row = (width: number, required = false): Line => ({ width, height: 20, required })
const PARTITIONS = ['A', 'B', 'C', 'D', 'E', 'F']

interface NodeOptions {
  readonly partition?: number
  readonly cells?: readonly [number, number]
  readonly inset?: number
  readonly lines?: ReadonlyArray<Line>
  readonly frameable?: boolean
  readonly flapWidth?: number
}

const node = (id: string, role: DiagramNode['role'], rank: string, ports: Record<string, 'in' | 'out'>, options: NodeOptions = {}): DiagramNode => ({
  id,
  rank,
  role,
  cells: { width: options.cells?.[0] ?? 2, height: options.cells?.[1] ?? 2 },
  portInset: options.inset ?? 0,
  ports: Object.entries(ports).map(([port, direction]) => ({ id: port, direction, rank: port })),
  ...(options.partition === undefined ? {} : { partition: { key: `partition-${PARTITIONS[options.partition]}`, order: options.partition } }),
  text: { lines: options.lines ?? [] },
  frameable: options.frameable ?? false,
  ...(options.flapWidth === undefined ? {} : { flapWidth: options.flapWidth }),
})
const edge = (id: string, rank: string, from: string, to: string): DiagramEdge => {
  const [fromNode, fromPort] = from.split(':') as [string, string]
  const [toNode, toPort] = to.split(':') as [string, string]
  return { id, rank, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }
}
const pump = (id: string, rank: string, partition?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(partition === undefined ? {} : { partition }), lines: [tag(44), row(40)], frameable: true, flapWidth: 52 })
const valve = (id: string, rank: string, partition?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(partition === undefined ? {} : { partition }), lines: [tag(48), row(44)], frameable: true, flapWidth: 40 })
const vessel = (id: string, rank: string, ports: Record<string, 'in' | 'out'>, partition?: number): DiagramNode =>
  node(id, 'device', rank, ports, { ...(partition === undefined ? {} : { partition }), cells: [2, 4], inset: 5, lines: [tag(40), row(52, true)], frameable: true, flapWidth: 44 })

const chain = (): DiagramGraph => ({
  nodes: [
    node('source', 'stub', 'a.source', { out: 'out' }, { cells: [2, 1], lines: [tag(72)] }),
    pump('pump', 'b.pump'),
    valve('valve', 'c.valve'),
    vessel('tank', 'd.tank', { in: 'in' }),
  ],
  edges: [
    edge('e1', 'line', 'source:out', 'pump:in'),
    edge('e2', 'line', 'pump:out', 'valve:in'),
    edge('e3', 'line', 'valve:out', 'tank:in'),
  ],
})

const headerFanOut = (partitions: number): DiagramGraph => ({
  nodes: [
    pump('pump-1', 'pump.1'),
    pump('pump-2', 'pump.2'),
    node('header', 'bar', 'header', { in: 'in', out: 'out' }, { lines: [tag(56)] }),
    ...Array.from({ length: partitions }, (_, partition) => [valve(`valve-${partition}`, 'valve', partition), vessel(`vessel-${partition}`, 'vessel', { in: 'in' }, partition)]).flat(),
  ],
  edges: [
    edge('p1', 'feed', 'pump-1:out', 'header:in'),
    edge('p2', 'feed', 'pump-2:out', 'header:in'),
    ...Array.from({ length: partitions }, (_, partition) => [
      edge(`b-${partition}`, 'branch', 'header:out', `valve-${partition}:in`),
      edge(`l-${partition}`, 'line', `valve-${partition}:out`, `vessel-${partition}:in`),
    ]).flat(),
  ],
})

/** The classic loop drawing: every partition leaves the common node and returns to it. */
const commonLoops = (partitions: number): DiagramGraph => ({
  nodes: [
    node('common', 'common', 'common', Object.fromEntries(Array.from({ length: partitions }, (_, partition) => [[`out-${PARTITIONS[partition]}`, 'out'], [`in-${PARTITIONS[partition]}`, 'in']]).flat()), { cells: [2, 4], inset: 5, lines: [tag(36)] }),
    ...Array.from({ length: partitions }, (_, partition) => [vessel(`vessel-${partition}`, 'vessel', { in: 'in', out: 'out' }, partition), pump(`pump-${partition}`, 'pump', partition)]).flat(),
  ],
  edges: Array.from({ length: partitions }, (_, partition) => [
    edge(`hot-${partition}`, 'hot', `common:out-${PARTITIONS[partition]}`, `vessel-${partition}:in`),
    edge(`mid-${partition}`, 'mid', `vessel-${partition}:out`, `pump-${partition}:in`),
    edge(`cold-${partition}`, 'cold', `pump-${partition}:out`, `common:in-${PARTITIONS[partition]}`),
  ]).flat(),
})

/** Two headers (feed and auxiliary feed) feeding the same partition vessels. */
const combined = (partitions: number): DiagramGraph => ({
  nodes: [
    pump('feed-pump-1', 'feed.pump.1'),
    pump('feed-pump-2', 'feed.pump.2'),
    pump('aux-pump-1', 'aux.pump.1'),
    pump('aux-pump-2', 'aux.pump.2'),
    node('feed-header', 'bar', 'feed.header', { in: 'in', out: 'out' }, { lines: [tag(64)] }),
    node('aux-header', 'bar', 'aux.header', { in: 'in', out: 'out' }, { lines: [tag(60)] }),
    ...Array.from({ length: partitions }, (_, partition) => [
      valve(`feed-valve-${partition}`, 'feed.valve', partition),
      valve(`aux-valve-${partition}`, 'aux.valve', partition),
      vessel(`vessel-${partition}`, 'vessel', { feed: 'in', aux: 'in', steam: 'out' }, partition),
      node(`steam-${partition}`, 'stub', 'steam', { in: 'in' }, { partition, cells: [2, 1], lines: [tag(64)] }),
    ]).flat(),
  ],
  edges: [
    edge('fp1', 'feed', 'feed-pump-1:out', 'feed-header:in'),
    edge('fp2', 'feed', 'feed-pump-2:out', 'feed-header:in'),
    edge('ap1', 'aux', 'aux-pump-1:out', 'aux-header:in'),
    edge('ap2', 'aux', 'aux-pump-2:out', 'aux-header:in'),
    ...Array.from({ length: partitions }, (_, partition) => [
      edge(`fb-${partition}`, 'branch', 'feed-header:out', `feed-valve-${partition}:in`),
      edge(`fl-${partition}`, 'line', `feed-valve-${partition}:out`, `vessel-${partition}:feed`),
      edge(`ab-${partition}`, 'branch', 'aux-header:out', `aux-valve-${partition}:in`),
      edge(`al-${partition}`, 'line', `aux-valve-${partition}:out`, `vessel-${partition}:aux`),
      edge(`st-${partition}`, 'steam', `vessel-${partition}:steam`, `steam-${partition}:in`),
    ]).flat(),
  ],
})

// OpenBridge on its 24 px grid, and a room so generous every fixture fits.
type Drawn = DiagramProfile & DiagramRoom
const profile: Drawn = {
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5, trackGap: 4 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: 21,
  flapLabelPadding: 28,
  maxWidth: 1600,
  maxHeight: 1000,
  limits: { symbols: 40, symbolsPerPartition: 4, sharedSymbols: 8, partitions: 6, crossings: 12, bendsPerEdge: 3 },
  fit: [
    { detail: 'full', text: 'right' }, { detail: 'full', text: 'partitionsBelow' }, { detail: 'full', text: 'allBelow' },
    { detail: 'required', text: 'right' }, { detail: 'required', text: 'partitionsBelow' }, { detail: 'required', text: 'allBelow' },
  ],
}

const draw = (graph: DiagramGraph, using: Drawn): DiagramLayoutResult => layoutDiagram(graph, using, using)
const accepted = (graph: DiagramGraph, using: Drawn = profile): Extract<DiagramLayoutResult, { ok: true }> => {
  const result = draw(graph, using)
  if (!result.ok) throw new Error(`layout refused: ${JSON.stringify(result.reasons)}`)
  return result
}
const crossings = (result: Extract<DiagramLayoutResult, { ok: true }>): number => result.edges.reduce((sum, routed) => sum + routed.gaps.length, 0)

// Deterministic shuffles and renames.
const random = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const shuffle = <T>(values: ReadonlyArray<T>, next: () => number): T[] => {
  const copy = [...values]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}
const scramble = (graph: DiagramGraph, seed: number): DiagramGraph => {
  const next = random(seed)
  const fresh = (prefix: string): string => `${prefix}${Math.floor(next() * 1e9).toString(36)}`
  const nodeIds = new Map(graph.nodes.map(n => [n.id, fresh('n')]))
  const portIds = new Map(graph.nodes.flatMap(n => n.ports.map(p => [`${n.id}:${p.id}`, fresh('p')] as const)))
  const partitionKeys = new Map(graph.nodes.flatMap(n => (n.partition === undefined ? [] : [[n.partition.key, fresh('z')] as const])))
  return {
    nodes: shuffle(graph.nodes, next).map(n => ({
      ...n,
      id: nodeIds.get(n.id)!,
      ports: shuffle(n.ports, next).map(p => ({ ...p, id: portIds.get(`${n.id}:${p.id}`)! })),
      ...(n.partition === undefined ? {} : { partition: { key: partitionKeys.get(n.partition.key)!, order: n.partition.order } }),
    })),
    edges: shuffle(graph.edges, next).map(e => ({
      ...e,
      id: fresh('e'),
      from: { node: nodeIds.get(e.from.node)!, port: portIds.get(`${e.from.node}:${e.from.port}`)! },
      to: { node: nodeIds.get(e.to.node)!, port: portIds.get(`${e.to.node}:${e.to.port}`)! },
    })),
  }
}

const fixtures: ReadonlyArray<readonly [string, DiagramGraph]> = [
  ['chain', chain()],
  ...[2, 3, 4, 6].flatMap(partitions => [
    [`header fan-out, ${partitions} partitions`, headerFanOut(partitions)] as const,
    [`common loops, ${partitions} partitions`, commonLoops(partitions)] as const,
    [`combined headers, ${partitions} partitions`, combined(partitions)] as const,
  ]),
]

describe('diagram layout engine', () => {
  for (const [name, graph] of fixtures) {
    test(`${name}: accepted, verified clean, deterministic and id-free`, () => {
      const result = accepted(graph)
      expect(verifyDiagram(graph, profile, result)).toEqual([])
      for (let run = 0; run < 50; run++) expect(draw(graph, profile)).toMatchObject({ ok: true, hash: result.hash })
      for (const seed of [1, 2, 3]) expect(accepted(scramble(graph, seed)).hash).toBe(result.hash)
    })
  }

  test('a chain draws straight, with no bends', () => {
    const result = accepted(chain())
    for (const routed of result.edges) expect(routed.points).toHaveLength(2)
  })

  test('a header spans its branches and every branch meets it straight', () => {
    const result = accepted(headerFanOut(4))
    expect(crossings(result)).toBe(0)
    for (const routed of result.edges) expect(routed.points).toHaveLength(2)
  })

  test('loop drawings have no crossings at any partition count', () => {
    for (const partitions of [2, 3, 4, 6]) expect(crossings(accepted(commonLoops(partitions)))).toBe(0)
  })

  test('the combined drawing gaps every crossing on the vertical pipe', () => {
    const result = accepted(combined(4))
    expect(crossings(result)).toBeGreaterThan(0)
    for (const routed of result.edges) {
      for (const [x, y] of routed.gaps) {
        const onVertical = routed.points.slice(1).some((b, i) => {
          const a = routed.points[i]!
          return a[0] === x && b[0] === x && Math.min(a[1], b[1]) < y && y < Math.max(a[1], b[1])
        })
        expect(onVertical).toBe(true)
      }
    }
  })

  test('adding partitions leaves partition 0 of a loop drawing where it was', () => {
    // A box too short for partitions stacked vertically, so flow runs bottom to top.
    const wide = { ...profile, maxWidth: 2400, maxHeight: 520 }
    const partition0 = (result: Extract<DiagramLayoutResult, { ok: true }>) => ({
      nodes: result.nodes.filter(n => n.id === 'vessel-0' || n.id === 'pump-0'),
      edges: result.edges.filter(e => e.id.endsWith('-0')),
    })
    const base = accepted(commonLoops(4), wide)
    const common = base.nodes.find(n => n.id === 'common')!
    const pump0 = base.nodes.find(n => n.id === 'pump-0')!
    const vessel0 = base.nodes.find(n => n.id === 'vessel-0')!
    expect(common.x).toBeLessThan(vessel0.x)
    expect(pump0.y).toBeLessThan(vessel0.y)
    for (const partitions of [5, 6]) expect(partition0(accepted(commonLoops(partitions), wide))).toEqual(partition0(base))
  })

  test('symbols snap to the grid and ports sit on grid lines', () => {
    const result = accepted(combined(3))
    for (const placed of result.nodes) {
      if (placed.id.includes('header')) continue
      expect(placed.x % 24).toBe(0)
      expect(placed.y % 24).toBe(0)
      for (const port of Object.values(placed.ports)) expect((port.face === 'left' || port.face === 'right' ? port.y : port.x) % 24).toBe(0)
    }
  })

  test('a frameable node reserves its flap below, wide enough for its label', () => {
    const result = accepted(chain())
    const placed = result.nodes.find(n => n.id === 'pump')!
    const frame = placed.frame!
    const text = placed.text!
    const button = { top: Math.min(placed.y, text.y), bottom: Math.max(placed.y + placed.height, text.y + text.height) }
    expect(frame.y + frame.height).toBe(button.bottom + 1 + 21)
    expect(frame.y).toBe(button.top - 1)
    expect(frame.width).toBeGreaterThanOrEqual(52 + 28)
    // A flap of two lines (its alarm's action or a count of the others under it) reserves both.
    const graph = chain()
    const twoLines = accepted({ ...graph, nodes: graph.nodes.map(entry => entry.id === 'pump' ? { ...entry, flapLines: 2 } : entry) }).nodes.find(n => n.id === 'pump')!
    expect(twoLines.frame!.y + twoLines.frame!.height).toBe(button.bottom + 1 + 2 * 21)
  })

  test('a drawing too wide with text right of its symbols fits with text below them', () => {
    const budget = { ...profile, maxWidth: 600, maxHeight: 624 }
    const graph = commonLoops(4)
    const roomy = accepted(graph)
    expect(roomy.width).toBeGreaterThan(600)
    for (const placed of roomy.nodes.filter(n => /^(vessel|pump)-/.test(n.id))) expect(placed.text!.side).toBe('right')
    const result = accepted(graph, budget)
    expect(result.width).toBeLessThanOrEqual(600)
    for (const placed of result.nodes.filter(n => /^(vessel|pump)-/.test(n.id))) {
      expect(placed.text!.side).toBe('bottom')
      // The stack covers the symbol's lower face, so its inlet enters the side.
      expect(placed.ports['in']!.face).toBe('left')
    }
    expect(verifyDiagram(graph, budget, result)).toEqual([])
    expect(crossings(result)).toBe(0)
    for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), budget).hash).toBe(result.hash)
    // Partition symbols go below first; the shared pumps under a header keep their text right.
    const fanOut = accepted(headerFanOut(6), budget)
    expect(fanOut.width).toBeLessThanOrEqual(600)
    expect(fanOut.nodes.find(n => n.id === 'valve-0')!.text!.side).toBe('bottom')
    expect(fanOut.nodes.find(n => n.id === 'pump-1')!.text!.side).toBe('right')
    expect(verifyDiagram(headerFanOut(6), budget, fanOut)).toEqual([])
  })

  test("a graph's candidates answer every room as a layout for that room alone does, and say the least height at each width", () => {
    for (const graph of [commonLoops(4), headerFanOut(6), combined(3)]) {
      const candidates = diagramCandidates(graph, profile)
      const rooms = [300, 450, 600, 800, 1200].flatMap(maxWidth => [200, 400, 624, 900].map(maxHeight => ({ maxWidth, maxHeight })))
      for (const room of rooms) {
        const answered = candidates.layout(room)
        expect(answered).toEqual(layoutDiagram(graph, profile, room))
        // A room draws exactly when it is at least as tall as the least height at its width.
        const least = candidates.leastHeight(room.maxWidth)
        expect(answered.ok).toBe(least !== null && least <= room.maxHeight)
        if (least !== null) expect(candidates.layout({ maxWidth: room.maxWidth, maxHeight: least }).ok).toBe(true)
      }
    }
  })

  test('when the full text does not fit, optional trailing lines go, and the result says how many show', () => {
    // Left to right the stacks sit below their symbols, so dropping a line saves height.
    const result = accepted(chain(), { ...profile, maxWidth: 470, maxHeight: 150 })
    expect(result.nodes.find(n => n.id === 'pump')!.text!.lines).toBe(1)
    expect(result.nodes.find(n => n.id === 'tank')!.text!.lines).toBe(2)
    expect(accepted(chain()).nodes.find(n => n.id === 'pump')!.text!.lines).toBe(2)
  })

  test('the verifier finds tampered geometry', () => {
    const graph = commonLoops(2)
    const result = accepted(graph)
    const rules = (tampered: typeof result): string[] => [...new Set(verifyDiagram(graph, profile, tampered).map(v => v.rule))]
    const vessel = result.nodes.find(n => n.id === 'vessel-0')!
    const other = result.nodes.find(n => n.id === 'vessel-1')!
    const withNode = (id: string, change: (n: typeof vessel) => typeof vessel): typeof result => ({ ...result, nodes: result.nodes.map(n => (n.id === id ? change(n) : n)) })
    const withEdge = (id: string, points: Array<readonly [number, number]>): typeof result => ({ ...result, edges: result.edges.map(e => (e.id === id ? { ...e, points } : e)) })
    expect(rules(withNode('pump-0', n => ({ ...n, x: vessel.x, y: vessel.y })))).toContain('overlap')
    expect(rules(withNode('pump-0', n => ({ ...n, x: n.x + 5 })))).toContain('pitch')
    expect(rules(withNode('pump-0', n => ({ ...n, x: -48 })))).toContain('outsideBox')
    const frame = other.frame!
    expect(rules(withNode('pump-0', n => ({ ...n, text: { ...n.text!, x: frame.x + frame.width + 3, y: frame.y } })))).toContain('textClearance')
    const mid = result.edges.find(e => e.id === 'mid-0')!.points
    expect(rules(withEdge('mid-0', [mid[0]!, [mid[1]![0] + 24, mid[1]![1]]]))).toContain('diagonal')
    const [from, to] = [mid[0]!, mid.at(-1)!]
    const step = (to[1] - from[1]) / 4
    const zigzag: Array<readonly [number, number]> = [from, [from[0], from[1] + step], [from[0] + 24, from[1] + step], [from[0] + 24, from[1] + 2 * step], [from[0], from[1] + 2 * step], to]
    expect(rules(withEdge('mid-0', zigzag))).toContain('bends')
  })

  test('too many symbols or too wide a drawing is refused with explicit reasons', () => {
    const crowded = draw(combined(4), { ...profile, limits: { ...profile.limits, symbols: 12, symbolsPerPartition: 2 } })
    expect(crowded).toEqual({
      ok: false,
      reasons: [
        { kind: 'density', limit: 'symbols', count: 16, max: 12 },
        { kind: 'density', limit: 'symbolsPerPartition', count: 3, max: 2 },
      ],
    })
    // The per-partition limit holds where partitions stand side by side; one partition alone answers to the symbol limit.
    const sparse = { ...profile, limits: { ...profile.limits, symbolsPerPartition: 1 } }
    expect(draw(combined(1), sparse).ok).toBe(true)
    expect(draw(combined(2), sparse)).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'symbolsPerPartition', count: 3, max: 1 }] })
    const tangled = draw(combined(4), { ...profile, limits: { ...profile.limits, crossings: 2 } })
    expect(tangled).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'crossings', count: 4, max: 2 }] })
    const partitions = draw(commonLoops(6), { ...profile, limits: { ...profile.limits, partitions: 4 } })
    expect(partitions).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'partitions', count: 6, max: 4 }] })
    const narrow = draw(commonLoops(6), { ...profile, maxWidth: 400, maxHeight: 300 })
    expect(narrow.ok).toBe(false)
    if (narrow.ok) return
    expect(narrow.reasons.length).toBe(2)
    for (const reason of narrow.reasons) {
      expect(reason.kind).toBe('size')
      if (reason.kind === 'size') expect(reason.width > 400 || reason.height > 300).toBe(true)
    }
  })

  test('input the engine cannot order by structure is rejected', () => {
    const twins: DiagramGraph = { nodes: [pump('a', 'same'), pump('b', 'same')], edges: [edge('e', 'line', 'a:out', 'b:in')] }
    expect(() => draw(twins, profile)).toThrow(/share rank/)
    const backwards: DiagramGraph = { nodes: [pump('a', 'a'), pump('b', 'b')], edges: [edge('e', 'line', 'a:in', 'b:in')] }
    expect(() => draw(backwards, profile)).toThrow(/leaves through in-port/)
  })

  test('the engine imports nothing outside itself: it stays Plant-agnostic', () => {
    const folder = join(import.meta.dir, '../src/features/displays/diagram')
    for (const file of readdirSync(folder).filter(name => name.endsWith('.ts'))) {
      const specifiers = [...readFileSync(join(folder, file), 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]!)
      for (const specifier of specifiers) expect(specifier.startsWith('./') || specifier === 'node:crypto').toBe(true)
    }
  })

  // What a layout costs is its main-thread CPU time in reference
  // computations timed immediately before it, the median of five rounds
  // (cpu-cost.ts). A loaded shared machine slows both alike: at load 30 to
  // 120 the dense graph kept 1.3 to 2.2 references while its wall time
  // reached a second.
  test('lays out within four reference computations (50 ms quiet), up to 40 nodes and 60 edges', () => {
    const largest = dense()
    expect([largest.nodes.length, largest.edges.length]).toEqual([40, 60])
    const graphs = [...fixtures.map(([, graph]) => graph), largest]
    const costs = costsInReferences(graphs.map(graph => () => draw(graph, profile)), 5)
    expect(Math.max(...costs)).toBeLessThan(4)
  }, 120_000)
})

/** 40 nodes and 60 edges: the combined drawing at six partitions with suction, drains, bypasses, recirculation and spills. */
const dense = (): DiagramGraph => {
  const partitions = 6
  const base = combined(partitions)
  return {
    nodes: [
      ...base.nodes.map(n => (n.id.startsWith('vessel-') ? { ...n, ports: [...n.ports, { id: 'drain', direction: 'out' as const, rank: 'drain' }] } : n)),
      vessel('tank', 'tank', { out: 'out', return: 'in' }),
      ...Array.from({ length: partitions }, (_, partition) => node(`drain-${partition}`, 'stub', 'drain', { in: 'in' }, { partition, cells: [2, 1], lines: [tag(48)] })),
      ...['a', 'b', 'c'].map(k => node(`spill-${k}`, 'stub', `spill.${k}`, { in: 'in' }, { cells: [2, 1], lines: [tag(40)] })),
    ],
    edges: [
      ...base.edges,
      ...['feed-pump-1', 'feed-pump-2', 'aux-pump-1', 'aux-pump-2'].map((p, i) => edge(`t-${i}`, 'suction', 'tank:out', `${p}:in`)),
      ...Array.from({ length: partitions }, (_, partition) => [
        edge(`dr-${partition}`, 'drain', `vessel-${partition}:drain`, `drain-${partition}:in`),
        edge(`by-${partition}`, 'bypass', 'feed-header:out', `vessel-${partition}:feed`),
        edge(`rc-${partition}`, 'recirculation', `aux-valve-${partition}:out`, 'tank:return'),
      ]).flat(),
      edge('sp-a', 'spill', 'feed-header:out', 'spill-a:in'),
      edge('sp-a2', 'spill.2', 'feed-header:out', 'spill-a:in'),
      edge('sp-b', 'spill', 'aux-header:out', 'spill-b:in'),
      edge('sp-c', 'spill', 'tank:out', 'spill-c:in'),
    ],
  }
}

// Structures the reference Plant's fuzz found drawn with four bends, or not at all.

const stub = (id: string, rank: string, direction: 'in' | 'out'): DiagramNode => node(id, 'stub', rank, { end: direction }, { cells: [2, 1], lines: [tag(64)] })

/** A pump drawn with its suction and its supply: two sources feed the bus through longer chains than the suction's. */
const pumpWithSupply = (): DiagramGraph => {
  const box = (id: string, rank: string, ports: Record<string, 'in' | 'out'>): DiagramNode => node(id, 'device', rank, ports, { lines: [tag(56), row(40)], frameable: true, flapWidth: 40 })
  return {
    nodes: [
      box('turbine', 'a.turbine', { out: 'out' }),
      box('grid', 'b.grid', { out: 'out' }),
      box('transformer', 'c.transformer', { in: 'in', out: 'out' }),
      box('breaker', 'd.breaker', { in: 'in', out: 'out' }),
      box('generator', 'e.generator', { out: 'out' }),
      box('generator-breaker', 'f.generator-breaker', { in: 'in', out: 'out' }),
      node('bus', 'bar', 'g.bus', { in: 'in', out: 'out' }, { lines: [tag(40)] }),
      node('pump', 'device', 'h.pump', { suction: 'in', power: 'in', out: 'out' }, { lines: [tag(44), row(40)], frameable: true, flapWidth: 52 }),
      vessel('tank', 'i.tank', { out: 'out' }),
      stub('other-pumps', 'j.other-pumps', 'in'),
      stub('onward', 'k.onward', 'in'),
      stub('other-loads', 'l.other-loads', 'in'),
      stub('other-buses', 'm.other-buses', 'in'),
    ],
    edges: [
      edge('p1', 'power', 'turbine:out', 'transformer:in'),
      edge('p2', 'power', 'grid:out', 'transformer:in'),
      edge('p3', 'power', 'transformer:out', 'breaker:in'),
      edge('p4', 'power', 'transformer:out', 'other-buses:end'),
      edge('p5', 'power', 'breaker:out', 'bus:in'),
      edge('p6', 'power', 'generator:out', 'generator-breaker:in'),
      edge('p7', 'power', 'generator-breaker:out', 'bus:in'),
      edge('p8', 'power', 'bus:out', 'pump:power'),
      edge('p9', 'power', 'bus:out', 'other-loads:end'),
      edge('f1', 'fluid', 'tank:out', 'pump:suction'),
      edge('f2', 'fluid', 'tank:out', 'other-pumps:end'),
      edge('f3', 'fluid', 'pump:out', 'onward:end'),
    ],
  }
}

/** Two supplies into one pump past a valve, and two pumps into one vessel: edges between symbols that skip a layer. */
const skippingEdges = (): DiagramGraph => ({
  nodes: [
    vessel('additive', 'a.additive', { out: 'out' }),
    vessel('supply', 'b.supply', { out: 'out' }),
    valve('valve', 'c.valve'),
    pump('pump-a', 'd.pump-a'),
    pump('pump-b', 'e.pump-b'),
    vessel('vessel', 'f.vessel', { a: 'in', b: 'in' }),
  ],
  edges: [
    edge('k1', 'line', 'additive:out', 'valve:in'),
    edge('k2', 'line', 'valve:out', 'pump-a:in'),
    edge('k3', 'line', 'supply:out', 'pump-a:in'),
    edge('k4', 'line', 'supply:out', 'pump-b:in'),
    edge('k5', 'line', 'pump-a:out', 'vessel:a'),
    edge('k6', 'line', 'pump-b:out', 'vessel:b'),
  ],
})

/** The loop drawing with a makeup pump that joins partition A's return at the common node's port. */
const commonWithMakeup = (partitions: number): DiagramGraph => {
  const loops = commonLoops(partitions)
  return {
    nodes: [...loops.nodes, vessel('makeup-tank', 'makeup.tank', { out: 'out' }), pump('makeup', 'makeup.pump')],
    edges: [...loops.edges, edge('m1', 'makeup', 'makeup-tank:out', 'makeup:in'), edge('m2', 'makeup', 'makeup:out', 'common:in-A')],
  }
}

const bendsOf = (points: ReadonlyArray<readonly [number, number]>): number =>
  points.slice(1, -1).filter((b, i) => {
    const [a, c] = [points[i]!, points[i + 2]!]
    return !((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]))
  }).length

describe('long edges, stubs and shared common node ports', () => {
  const cases: ReadonlyArray<readonly [string, DiagramGraph]> = [
    ['a pump with its suction and its supply', pumpWithSupply()],
    ['edges that skip a layer between symbols', skippingEdges()],
    ['a makeup line joining a loop at the common, 2 partitions', commonWithMakeup(2)],
    ['a makeup line joining a loop at the common, 4 partitions', commonWithMakeup(4)],
  ]
  for (const [name, graph] of cases) {
    test(`${name}: accepted, verified, at most three bends a pipe, deterministic and id-free`, () => {
      const result = accepted(graph)
      expect(verifyDiagram(graph, profile, result)).toEqual([])
      for (const routed of result.edges) expect(bendsOf(routed.points)).toBeLessThanOrEqual(3)
      expect(draw(graph, profile)).toMatchObject({ ok: true, hash: result.hash })
      for (const seed of [1, 2]) expect(accepted(scramble(graph, seed)).hash).toBe(result.hash)
    })
  }

  test('a source is drawn next to what it feeds: its stub does not hold it back, so its suction runs short', () => {
    const result = accepted(pumpWithSupply())
    expect(bendsOf(result.edges.find(e => e.id === 'f1')!.points)).toBeLessThanOrEqual(2)
  })

  test('an edge that skips a layer runs straight from one of its ends and jogs once', () => {
    const result = accepted(skippingEdges())
    for (const id of ['k3', 'k5', 'k6']) expect(bendsOf(result.edges.find(e => e.id === id)!.points)).toBeLessThanOrEqual(2)
  })

  test('edges reaching one common node port from both sides meet it in one place', () => {
    for (const partitions of [2, 4]) {
      const result = accepted(commonWithMakeup(partitions))
      const place = result.nodes.find(n => n.id === 'common')!.ports['in-A']!
      for (const id of ['cold-0', 'm2']) expect(result.edges.find(e => e.id === id)!.points.at(-1)).toEqual([place.x, place.y])
    }
  })
})

// Crossings the structure forces, and drawings that keep within two of them.

/** Three shared symbols each joined to every partition's vessel: K(3, n). */
const threeSources = (partitions: number): DiagramGraph => ({
  nodes: [
    pump('source-1', 'source.1'),
    pump('source-2', 'source.2'),
    pump('source-3', 'source.3'),
    ...Array.from({ length: partitions }, (_, partition) => vessel(`vessel-${partition}`, 'vessel', { a: 'in', b: 'in', c: 'in' }, partition)),
  ],
  edges: Array.from({ length: partitions }, (_, partition) => [
    edge(`a-${partition}`, 'a', 'source-1:out', `vessel-${partition}:a`),
    edge(`b-${partition}`, 'b', 'source-2:out', `vessel-${partition}:b`),
    edge(`c-${partition}`, 'c', 'source-3:out', `vessel-${partition}:c`),
  ]).flat(),
})

/**
 * Loops through a common node, each loop's exchanger also on a feed header and a
 * steam header (a ladder the common node must reach across), with or without a train
 * of shared symbols that returns from the steam header to the feed header.
 */
const ladder = (partitions: number, closed: boolean): DiagramGraph => ({
  nodes: [
    node('common', 'common', 'common', Object.fromEntries(Array.from({ length: partitions }, (_, partition) => [[`out-${PARTITIONS[partition]}`, 'out'], [`in-${PARTITIONS[partition]}`, 'in']]).flat()), { cells: [2, 4], inset: 5, lines: [tag(36)] }),
    node('feed', 'bar', 'feed', { in: 'in', out: 'out' }, { lines: [tag(40)] }),
    node('steam', 'bar', 'steam', { in: 'in', out: 'out' }, { lines: [tag(48)] }),
    ...(closed ? [pump('engine', 'train.1'), vessel('cooler', 'train.2', { in: 'in', out: 'out' }), pump('feed-pump', 'train.3')] : []),
    ...Array.from({ length: partitions }, (_, partition) => [
      valve(`feed-valve-${partition}`, 'feed.valve', partition),
      vessel(`exchanger-${partition}`, 'exchanger', { hot: 'in', cold: 'out', feed: 'in', steam: 'out' }, partition),
      pump(`pump-${partition}`, 'pump', partition),
      valve(`steam-valve-${partition}`, 'steam.valve', partition),
    ]).flat(),
  ],
  edges: [
    ...(closed ? [
      edge('t1', 'train', 'steam:out', 'engine:in'),
      edge('t2', 'train', 'engine:out', 'cooler:in'),
      edge('t3', 'train', 'cooler:out', 'feed-pump:in'),
      edge('t4', 'train', 'feed-pump:out', 'feed:in'),
    ] : []),
    ...Array.from({ length: partitions }, (_, partition) => [
      edge(`hot-${partition}`, 'hot', `common:out-${PARTITIONS[partition]}`, `exchanger-${partition}:hot`),
      edge(`cold-${partition}`, 'cold', `exchanger-${partition}:cold`, `pump-${partition}:in`),
      edge(`return-${partition}`, 'return', `pump-${partition}:out`, `common:in-${PARTITIONS[partition]}`),
      edge(`fb-${partition}`, 'feed', 'feed:out', `feed-valve-${partition}:in`),
      edge(`fl-${partition}`, 'feed.line', `feed-valve-${partition}:out`, `exchanger-${partition}:feed`),
      edge(`sl-${partition}`, 'steam.line', `exchanger-${partition}:steam`, `steam-valve-${partition}:in`),
      edge(`sb-${partition}`, 'steam', `steam-valve-${partition}:out`, 'steam:in'),
    ]).flat(),
  ],
})

/**
 * The open ladder closed by a long train from the steam header back to the
 * feed header: a throttle, an engine, a cooler (which a bypass from the
 * header also reaches), a lift pump, a tank and a feed pump. Its return leg
 * is deeper than the partitions are tall.
 */
const longTrain = (partitions: number): DiagramGraph => {
  const base = ladder(partitions, false)
  return {
    nodes: [
      ...base.nodes,
      valve('throttle', 'train.0'),
      valve('bypass', 'train.b'),
      pump('engine', 'train.1'),
      vessel('cooler', 'train.2', { in: 'in', out: 'out' }),
      pump('lift-pump', 'train.3'),
      vessel('tank', 'train.4', { in: 'in', out: 'out' }),
      pump('feed-pump', 'train.5'),
    ],
    edges: [
      ...base.edges,
      edge('t0', 'train.0', 'steam:out', 'throttle:in'),
      edge('b0', 'train.b', 'steam:out', 'bypass:in'),
      edge('b1', 'train.b1', 'bypass:out', 'cooler:in'),
      edge('t1', 'train.1', 'throttle:out', 'engine:in'),
      edge('t2', 'train.2', 'engine:out', 'cooler:in'),
      edge('t3', 'train.3', 'cooler:out', 'lift-pump:in'),
      edge('t4', 'train.4', 'lift-pump:out', 'tank:in'),
      edge('t5', 'train.5', 'tank:out', 'feed-pump:in'),
      edge('t6', 'train.6', 'feed-pump:out', 'feed:in'),
    ],
  }
}

// The crossings a graph's structure forces (diagram-crossing-bound.ts) are a
// diagnostic of how good a drawing is; the engine's limit is absolute.
describe('crossings the structure forces', () => {
  const roomy = { ...profile, maxWidth: 4000, maxHeight: 4000, limits: { ...profile.limits, symbols: 60, symbolsPerPartition: 6, crossings: 40 } }
  const forcedOf = (graph: DiagramGraph): number => forcedCrossings(buildModel(graph))

  test('three shared symbols reaching every partition force Zarankiewicz\'s ⌊n/2⌋⌊(n−1)/2⌋', () => {
    // A partition drawing keeps shared symbols on one side of the partitions, so it crosses more than the bound here.
    for (const [partitions, forced] of [[3, 1], [4, 2], [6, 6]] as const) {
      const result = draw(threeSources(partitions), roomy)
      if (!result.ok) throw new Error(JSON.stringify(result.reasons))
      expect(forcedOf(threeSources(partitions))).toBe(forced)
      expect(result.crossings).toBeGreaterThanOrEqual(forced)
    }
  })

  test('a common node reaching every partition across a ladder of two headers is forced across it 2n − 4 times; a train closing the ladder adds one', () => {
    // Two partitions are a ladder of one cycle: the common node reaches both from outside it, unless the train closes it there too.
    for (const partitions of [2, 3, 4, 6]) {
      expect(forcedOf(ladder(partitions, false))).toBe(2 * partitions - 4)
      expect(forcedOf(ladder(partitions, true))).toBe(2 * partitions - 3)
    }
  })

  test('the closed ladder draws within two crossings of the bound, verified, deterministic and id-free', () => {
    for (const partitions of [2, 4, 6]) {
      const graph = ladder(partitions, true)
      const result = accepted(graph, roomy)
      expect(result.crossings).toBeLessThanOrEqual(forcedOf(graph) + 2)
      expect(crossings(result)).toBe(result.crossings)
      expect(verifyDiagram(graph, roomy, result)).toEqual([])
      for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), roomy).hash).toBe(result.hash)
    }
  })

  test('ever shorter of height, a return leg folds at its turn, then beside it: its head shares the layer of what feeds it', () => {
    for (const partitions of [4, 6]) {
      const graph = longTrain(partitions)
      // At most two crossings over the bound, as a drawing an operator reads at a glance.
      const legible = { ...roomy, limits: { ...roomy.limits, crossings: forcedOf(graph) + 2 } }
      const tall = accepted(graph, legible)
      const folded = accepted(graph, { ...legible, maxHeight: tall.height - 1 })
      const short = { ...legible, maxHeight: folded.height - 1 }
      const result = accepted(graph, short)
      const centre = (id: string): number => {
        const placed = result.nodes.find(candidate => candidate.id === id)!
        return placed.y + placed.height / 2
      }
      expect(result.height).toBeLessThan(folded.height)
      // The leg (engine to feed pump) is drawn mirrored; the cooler, which the bypass feeds, sits in the bypass's layer, and the train runs down from there.
      expect(centre('cooler')).toBe(centre('bypass'))
      expect(centre('feed-pump')).toBeGreaterThan(centre('cooler'))
      expect(result.crossings).toBeLessThanOrEqual(forcedOf(graph) + 2)
      expect(verifyDiagram(graph, short, result)).toEqual([])
      for (const routed of result.edges) expect(bendsOf(routed.points)).toBeLessThanOrEqual(3)
      for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), short).hash).toBe(result.hash)
    }
  })

  test('a limit below what the structure forces refuses the graph, naming the limit and the fewest crossings drawn', () => {
    const strict = { ...roomy, limits: { ...roomy.limits, crossings: forcedOf(threeSources(6)) - 1 } }
    const result = draw(threeSources(6), strict)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons).toEqual([expect.objectContaining({ kind: 'density', limit: 'crossings', max: 5 })])
    const [reason] = result.reasons
    if (reason?.kind === 'density') expect(reason.count).toBeGreaterThanOrEqual(6)
  })
})
