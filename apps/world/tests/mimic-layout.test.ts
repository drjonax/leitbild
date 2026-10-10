import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  layoutDiagram,
  verifyDiagram,
  type DiagramEdge,
  type DiagramGraph,
  type DiagramLayoutResult,
  type DiagramNode,
  type DiagramProfile,
  type DiagramText,
} from '../src/packs/process-plant/displays/mimic/layout/index.ts'

// Synthetic, Plant-agnostic fixtures: the engine sees only structure.

type Line = DiagramText['lines'][number]
const tag = (width: number): Line => ({ width, height: 16, required: true })
const row = (width: number, required = false): Line => ({ width, height: 20, required })
const LANES = ['A', 'B', 'C', 'D', 'E', 'F']

interface NodeOptions {
  readonly lane?: number
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
  ...(options.lane === undefined ? {} : { lane: { key: `lane-${LANES[options.lane]}`, order: options.lane } }),
  text: { lines: options.lines ?? [] },
  frameable: options.frameable ?? false,
  ...(options.flapWidth === undefined ? {} : { flapWidth: options.flapWidth }),
})
const edge = (id: string, rank: string, from: string, to: string): DiagramEdge => {
  const [fromNode, fromPort] = from.split(':') as [string, string]
  const [toNode, toPort] = to.split(':') as [string, string]
  return { id, rank, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }
}
const pump = (id: string, rank: string, lane?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(lane === undefined ? {} : { lane }), lines: [tag(44), row(40)], frameable: true, flapWidth: 52 })
const valve = (id: string, rank: string, lane?: number): DiagramNode =>
  node(id, 'device', rank, { in: 'in', out: 'out' }, { ...(lane === undefined ? {} : { lane }), lines: [tag(48), row(44)], frameable: true, flapWidth: 40 })
const vessel = (id: string, rank: string, ports: Record<string, 'in' | 'out'>, lane?: number): DiagramNode =>
  node(id, 'device', rank, ports, { ...(lane === undefined ? {} : { lane }), cells: [2, 4], inset: 5, lines: [tag(40), row(52, true)], frameable: true, flapWidth: 44 })

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

const headerFanOut = (lanes: number): DiagramGraph => ({
  nodes: [
    pump('pump-1', 'pump.1'),
    pump('pump-2', 'pump.2'),
    node('header', 'bar', 'header', { in: 'in', out: 'out' }, { lines: [tag(56)] }),
    ...Array.from({ length: lanes }, (_, lane) => [valve(`valve-${lane}`, 'valve', lane), vessel(`vessel-${lane}`, 'vessel', { in: 'in' }, lane)]).flat(),
  ],
  edges: [
    edge('p1', 'feed', 'pump-1:out', 'header:in'),
    edge('p2', 'feed', 'pump-2:out', 'header:in'),
    ...Array.from({ length: lanes }, (_, lane) => [
      edge(`b-${lane}`, 'branch', 'header:out', `valve-${lane}:in`),
      edge(`l-${lane}`, 'line', `valve-${lane}:out`, `vessel-${lane}:in`),
    ]).flat(),
  ],
})

/** The classic loop drawing: every lane leaves the hub and returns to it. */
const hubLoops = (lanes: number): DiagramGraph => ({
  nodes: [
    node('hub', 'hub', 'hub', Object.fromEntries(Array.from({ length: lanes }, (_, lane) => [[`out-${LANES[lane]}`, 'out'], [`in-${LANES[lane]}`, 'in']]).flat()), { cells: [2, 4], inset: 5, lines: [tag(36)] }),
    ...Array.from({ length: lanes }, (_, lane) => [vessel(`vessel-${lane}`, 'vessel', { in: 'in', out: 'out' }, lane), pump(`pump-${lane}`, 'pump', lane)]).flat(),
  ],
  edges: Array.from({ length: lanes }, (_, lane) => [
    edge(`hot-${lane}`, 'hot', `hub:out-${LANES[lane]}`, `vessel-${lane}:in`),
    edge(`mid-${lane}`, 'mid', `vessel-${lane}:out`, `pump-${lane}:in`),
    edge(`cold-${lane}`, 'cold', `pump-${lane}:out`, `hub:in-${LANES[lane]}`),
  ]).flat(),
})

/** Two headers (feed and auxiliary feed) feeding the same lane vessels. */
const combined = (lanes: number): DiagramGraph => ({
  nodes: [
    pump('feed-pump-1', 'feed.pump.1'),
    pump('feed-pump-2', 'feed.pump.2'),
    pump('aux-pump-1', 'aux.pump.1'),
    pump('aux-pump-2', 'aux.pump.2'),
    node('feed-header', 'bar', 'feed.header', { in: 'in', out: 'out' }, { lines: [tag(64)] }),
    node('aux-header', 'bar', 'aux.header', { in: 'in', out: 'out' }, { lines: [tag(60)] }),
    ...Array.from({ length: lanes }, (_, lane) => [
      valve(`feed-valve-${lane}`, 'feed.valve', lane),
      valve(`aux-valve-${lane}`, 'aux.valve', lane),
      vessel(`vessel-${lane}`, 'vessel', { feed: 'in', aux: 'in', steam: 'out' }, lane),
      node(`steam-${lane}`, 'stub', 'steam', { in: 'in' }, { lane, cells: [2, 1], lines: [tag(64)] }),
    ]).flat(),
  ],
  edges: [
    edge('fp1', 'feed', 'feed-pump-1:out', 'feed-header:in'),
    edge('fp2', 'feed', 'feed-pump-2:out', 'feed-header:in'),
    edge('ap1', 'aux', 'aux-pump-1:out', 'aux-header:in'),
    edge('ap2', 'aux', 'aux-pump-2:out', 'aux-header:in'),
    ...Array.from({ length: lanes }, (_, lane) => [
      edge(`fb-${lane}`, 'branch', 'feed-header:out', `feed-valve-${lane}:in`),
      edge(`fl-${lane}`, 'line', `feed-valve-${lane}:out`, `vessel-${lane}:feed`),
      edge(`ab-${lane}`, 'branch', 'aux-header:out', `aux-valve-${lane}:in`),
      edge(`al-${lane}`, 'line', `aux-valve-${lane}:out`, `vessel-${lane}:aux`),
      edge(`st-${lane}`, 'steam', `vessel-${lane}:steam`, `steam-${lane}:in`),
    ]).flat(),
  ],
})

// OpenBridge on its 24 px grid; the box is generous so every fixture fits.
const profile: DiagramProfile = {
  grid: 24,
  cell: 24,
  pipe: { outline: 6, cornerRadius: 8, crossingHalfGap: 5 },
  textClearance: 9,
  frameMargin: 1,
  flapHeight: 21,
  flapLabelPadding: 28,
  maxWidth: 1600,
  maxHeight: 1000,
  limits: { symbols: 40, symbolsPerLane: 4, sharedSymbols: 8, lanes: 6, crossings: 12, crossingsOverBound: 12, bendsPerEdge: 3 },
  fit: [
    { detail: 'full', text: 'right' }, { detail: 'full', text: 'lanesBelow' }, { detail: 'full', text: 'allBelow' },
    { detail: 'required', text: 'right' }, { detail: 'required', text: 'lanesBelow' }, { detail: 'required', text: 'allBelow' },
  ],
}

const accepted = (graph: DiagramGraph, using: DiagramProfile = profile): Extract<DiagramLayoutResult, { ok: true }> => {
  const result = layoutDiagram(graph, using)
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
  const laneKeys = new Map(graph.nodes.flatMap(n => (n.lane === undefined ? [] : [[n.lane.key, fresh('z')] as const])))
  return {
    nodes: shuffle(graph.nodes, next).map(n => ({
      ...n,
      id: nodeIds.get(n.id)!,
      ports: shuffle(n.ports, next).map(p => ({ ...p, id: portIds.get(`${n.id}:${p.id}`)! })),
      ...(n.lane === undefined ? {} : { lane: { key: laneKeys.get(n.lane.key)!, order: n.lane.order } }),
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
  ...[2, 3, 4, 6].flatMap(lanes => [
    [`header fan-out, ${lanes} lanes`, headerFanOut(lanes)] as const,
    [`hub loops, ${lanes} lanes`, hubLoops(lanes)] as const,
    [`combined headers, ${lanes} lanes`, combined(lanes)] as const,
  ]),
]

describe('diagram layout engine', () => {
  for (const [name, graph] of fixtures) {
    test(`${name}: accepted, verified clean, deterministic and id-free`, () => {
      const result = accepted(graph)
      expect(verifyDiagram(graph, profile, result)).toEqual([])
      for (let run = 0; run < 50; run++) expect(layoutDiagram(graph, profile)).toMatchObject({ ok: true, hash: result.hash })
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

  test('loop drawings have no crossings at any lane count', () => {
    for (const lanes of [2, 3, 4, 6]) expect(crossings(accepted(hubLoops(lanes)))).toBe(0)
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

  test('adding lanes leaves lane 0 of a loop drawing where it was', () => {
    // A box too short for lanes stacked vertically, so flow runs bottom to top.
    const wide = { ...profile, maxWidth: 2400, maxHeight: 520 }
    const lane0 = (result: Extract<DiagramLayoutResult, { ok: true }>) => ({
      nodes: result.nodes.filter(n => n.id === 'vessel-0' || n.id === 'pump-0'),
      edges: result.edges.filter(e => e.id.endsWith('-0')),
      zone: result.zones[0],
    })
    const base = accepted(hubLoops(4), wide)
    const hub = base.nodes.find(n => n.id === 'hub')!
    const pump0 = base.nodes.find(n => n.id === 'pump-0')!
    const vessel0 = base.nodes.find(n => n.id === 'vessel-0')!
    expect(hub.x).toBeLessThan(vessel0.x)
    expect(pump0.y).toBeLessThan(vessel0.y)
    for (const lanes of [5, 6]) expect(lane0(accepted(hubLoops(lanes), wide))).toEqual(lane0(base))
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
  })

  test('a drawing too wide with text right of its symbols fits with text below them', () => {
    const budget = { ...profile, maxWidth: 600, maxHeight: 624 }
    const graph = hubLoops(4)
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
    // Lane symbols go below first; the shared pumps under a header keep their text right.
    const fanOut = accepted(headerFanOut(6), budget)
    expect(fanOut.width).toBeLessThanOrEqual(600)
    expect(fanOut.nodes.find(n => n.id === 'valve-0')!.text!.side).toBe('bottom')
    expect(fanOut.nodes.find(n => n.id === 'pump-1')!.text!.side).toBe('right')
    expect(verifyDiagram(headerFanOut(6), budget, fanOut)).toEqual([])
  })

  test('when the full text does not fit, optional trailing lines go, and the result says how many show', () => {
    // Left to right the stacks sit below their symbols, so dropping a line saves height.
    const result = accepted(chain(), { ...profile, maxWidth: 470, maxHeight: 150 })
    expect(result.nodes.find(n => n.id === 'pump')!.text!.lines).toBe(1)
    expect(result.nodes.find(n => n.id === 'tank')!.text!.lines).toBe(2)
    expect(accepted(chain()).nodes.find(n => n.id === 'pump')!.text!.lines).toBe(2)
  })

  test('the verifier finds tampered geometry', () => {
    const graph = hubLoops(2)
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
    const crowded = layoutDiagram(combined(4), { ...profile, limits: { ...profile.limits, symbols: 12, symbolsPerLane: 2 } })
    expect(crowded).toEqual({
      ok: false,
      reasons: [
        { kind: 'density', limit: 'symbols', count: 16, max: 12 },
        { kind: 'density', limit: 'symbolsPerLane', count: 3, max: 2 },
      ],
    })
    const tangled = layoutDiagram(combined(4), { ...profile, limits: { ...profile.limits, crossings: 2 } })
    expect(tangled).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'crossings', count: 4, max: 2 }] })
    const lanes = layoutDiagram(hubLoops(6), { ...profile, limits: { ...profile.limits, lanes: 4 } })
    expect(lanes).toEqual({ ok: false, reasons: [{ kind: 'density', limit: 'lanes', count: 6, max: 4 }] })
    const narrow = layoutDiagram(hubLoops(6), { ...profile, maxWidth: 400, maxHeight: 300 })
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
    expect(() => layoutDiagram(twins, profile)).toThrow(/share rank/)
    const backwards: DiagramGraph = { nodes: [pump('a', 'a'), pump('b', 'b')], edges: [edge('e', 'line', 'a:in', 'b:in')] }
    expect(() => layoutDiagram(backwards, profile)).toThrow(/leaves through in-port/)
  })

  test('the engine imports nothing outside itself: it stays Plant-agnostic', () => {
    const folder = join(import.meta.dir, '../src/packs/process-plant/displays/mimic/layout')
    for (const file of readdirSync(folder).filter(name => name.endsWith('.ts'))) {
      const specifiers = [...readFileSync(join(folder, file), 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]!)
      for (const specifier of specifiers) expect(specifier.startsWith('./') || specifier === 'node:crypto').toBe(true)
    }
  })

  // What a layout costs is its fastest of 20 runs, judged against a fixed
  // reference computation of the same kind (allocating, sorting, keyed
  // lookups) timed between them. A loaded shared machine slows both alike:
  // with several agents' suites running, even the fastest layout ran 60 ms
  // while the two kept a ratio of 2.0 to 2.5. On a quiet machine the
  // reference takes about 12 ms, so four references is the 50 ms budget, and
  // an engine 60 % slower than today fails.
  test('lays out within four reference computations (50 ms quiet), up to 40 nodes and 60 edges', () => {
    const largest = dense()
    expect([largest.nodes.length, largest.edges.length]).toEqual([40, 60])
    const graphs = [...fixtures.map(([, graph]) => graph), largest]
    const reference = (): number => {
      let sum = 0
      for (let round = 0; round < 40; round++) {
        const values = Array.from({ length: 2_000 }, (_, index) => ({ id: `n${(index * 7919) % 2_000}`, x: (index * 104729) % 1_013 }))
        values.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
        const byId = new Map(values.map(value => [value.id, value.x]))
        for (const value of values) sum += byId.get(value.id)!
      }
      return sum
    }
    const timed = (run: () => unknown): number => {
      const start = performance.now()
      run()
      return performance.now() - start
    }
    let referenceCost = Infinity
    const costs = graphs.map(graph => Math.min(...Array.from({ length: 20 }, () => {
      referenceCost = Math.min(referenceCost, timed(reference))
      return timed(() => layoutDiagram(graph, profile))
    })))
    expect(Math.max(...costs)).toBeLessThan(4 * referenceCost)
  }, 30_000)
})

/** 40 nodes and 60 edges: the combined drawing at six lanes with suction, drains, bypasses, recirculation and spills. */
const dense = (): DiagramGraph => {
  const lanes = 6
  const base = combined(lanes)
  return {
    nodes: [
      ...base.nodes.map(n => (n.id.startsWith('vessel-') ? { ...n, ports: [...n.ports, { id: 'drain', direction: 'out' as const, rank: 'drain' }] } : n)),
      vessel('tank', 'tank', { out: 'out', return: 'in' }),
      ...Array.from({ length: lanes }, (_, lane) => node(`drain-${lane}`, 'stub', 'drain', { in: 'in' }, { lane, cells: [2, 1], lines: [tag(48)] })),
      ...['a', 'b', 'c'].map(k => node(`spill-${k}`, 'stub', `spill.${k}`, { in: 'in' }, { cells: [2, 1], lines: [tag(40)] })),
    ],
    edges: [
      ...base.edges,
      ...['feed-pump-1', 'feed-pump-2', 'aux-pump-1', 'aux-pump-2'].map((p, i) => edge(`t-${i}`, 'suction', 'tank:out', `${p}:in`)),
      ...Array.from({ length: lanes }, (_, lane) => [
        edge(`dr-${lane}`, 'drain', `vessel-${lane}:drain`, `drain-${lane}:in`),
        edge(`by-${lane}`, 'bypass', 'feed-header:out', `vessel-${lane}:feed`),
        edge(`rc-${lane}`, 'recirculation', `aux-valve-${lane}:out`, 'tank:return'),
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

/** The loop drawing with a makeup pump that joins lane A's return at the hub's port. */
const hubWithMakeup = (lanes: number): DiagramGraph => {
  const loops = hubLoops(lanes)
  return {
    nodes: [...loops.nodes, vessel('makeup-tank', 'makeup.tank', { out: 'out' }), pump('makeup', 'makeup.pump')],
    edges: [...loops.edges, edge('m1', 'makeup', 'makeup-tank:out', 'makeup:in'), edge('m2', 'makeup', 'makeup:out', 'hub:in-A')],
  }
}

const bendsOf = (points: ReadonlyArray<readonly [number, number]>): number =>
  points.slice(1, -1).filter((b, i) => {
    const [a, c] = [points[i]!, points[i + 2]!]
    return !((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]))
  }).length

describe('long edges, stubs and shared hub ports', () => {
  const cases: ReadonlyArray<readonly [string, DiagramGraph]> = [
    ['a pump with its suction and its supply', pumpWithSupply()],
    ['edges that skip a layer between symbols', skippingEdges()],
    ['a makeup line joining a loop at the hub, 2 lanes', hubWithMakeup(2)],
    ['a makeup line joining a loop at the hub, 4 lanes', hubWithMakeup(4)],
  ]
  for (const [name, graph] of cases) {
    test(`${name}: accepted, verified, at most three bends a pipe, deterministic and id-free`, () => {
      const result = accepted(graph)
      expect(verifyDiagram(graph, profile, result)).toEqual([])
      for (const routed of result.edges) expect(bendsOf(routed.points)).toBeLessThanOrEqual(3)
      expect(layoutDiagram(graph, profile)).toMatchObject({ ok: true, hash: result.hash })
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

  test('edges reaching one hub port from both sides meet it in one place', () => {
    for (const lanes of [2, 4]) {
      const result = accepted(hubWithMakeup(lanes))
      const place = result.nodes.find(n => n.id === 'hub')!.ports['in-A']!
      for (const id of ['cold-0', 'm2']) expect(result.edges.find(e => e.id === id)!.points.at(-1)).toEqual([place.x, place.y])
    }
  })
})

// Crossings the structure forces, and drawings that keep within two of them.

/** Three shared symbols each joined to every lane's vessel: K(3, n). */
const threeSources = (lanes: number): DiagramGraph => ({
  nodes: [
    pump('source-1', 'source.1'),
    pump('source-2', 'source.2'),
    pump('source-3', 'source.3'),
    ...Array.from({ length: lanes }, (_, lane) => vessel(`vessel-${lane}`, 'vessel', { a: 'in', b: 'in', c: 'in' }, lane)),
  ],
  edges: Array.from({ length: lanes }, (_, lane) => [
    edge(`a-${lane}`, 'a', 'source-1:out', `vessel-${lane}:a`),
    edge(`b-${lane}`, 'b', 'source-2:out', `vessel-${lane}:b`),
    edge(`c-${lane}`, 'c', 'source-3:out', `vessel-${lane}:c`),
  ]).flat(),
})

/**
 * Loops through a hub, each loop's exchanger also on a feed header and a
 * steam header (a ladder the hub must reach across), with or without a train
 * of shared symbols that returns from the steam header to the feed header.
 */
const ladder = (lanes: number, closed: boolean): DiagramGraph => ({
  nodes: [
    node('hub', 'hub', 'hub', Object.fromEntries(Array.from({ length: lanes }, (_, lane) => [[`out-${LANES[lane]}`, 'out'], [`in-${LANES[lane]}`, 'in']]).flat()), { cells: [2, 4], inset: 5, lines: [tag(36)] }),
    node('feed', 'bar', 'feed', { in: 'in', out: 'out' }, { lines: [tag(40)] }),
    node('steam', 'bar', 'steam', { in: 'in', out: 'out' }, { lines: [tag(48)] }),
    ...(closed ? [pump('engine', 'train.1'), vessel('cooler', 'train.2', { in: 'in', out: 'out' }), pump('feed-pump', 'train.3')] : []),
    ...Array.from({ length: lanes }, (_, lane) => [
      valve(`feed-valve-${lane}`, 'feed.valve', lane),
      vessel(`exchanger-${lane}`, 'exchanger', { hot: 'in', cold: 'out', feed: 'in', steam: 'out' }, lane),
      pump(`pump-${lane}`, 'pump', lane),
      valve(`steam-valve-${lane}`, 'steam.valve', lane),
    ]).flat(),
  ],
  edges: [
    ...(closed ? [
      edge('t1', 'train', 'steam:out', 'engine:in'),
      edge('t2', 'train', 'engine:out', 'cooler:in'),
      edge('t3', 'train', 'cooler:out', 'feed-pump:in'),
      edge('t4', 'train', 'feed-pump:out', 'feed:in'),
    ] : []),
    ...Array.from({ length: lanes }, (_, lane) => [
      edge(`hot-${lane}`, 'hot', `hub:out-${LANES[lane]}`, `exchanger-${lane}:hot`),
      edge(`cold-${lane}`, 'cold', `exchanger-${lane}:cold`, `pump-${lane}:in`),
      edge(`return-${lane}`, 'return', `pump-${lane}:out`, `hub:in-${LANES[lane]}`),
      edge(`fb-${lane}`, 'feed', 'feed:out', `feed-valve-${lane}:in`),
      edge(`fl-${lane}`, 'feed.line', `feed-valve-${lane}:out`, `exchanger-${lane}:feed`),
      edge(`sl-${lane}`, 'steam.line', `exchanger-${lane}:steam`, `steam-valve-${lane}:in`),
      edge(`sb-${lane}`, 'steam', `steam-valve-${lane}:out`, 'steam:in'),
    ]).flat(),
  ],
})

/**
 * The open ladder closed by a long train from the steam header back to the
 * feed header: a throttle, an engine, a cooler (which a bypass from the
 * header also reaches), a lift pump, a tank and a feed pump. Its return leg
 * is deeper than the lanes are tall.
 */
const longTrain = (lanes: number): DiagramGraph => {
  const base = ladder(lanes, false)
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

describe('crossings the structure forces', () => {
  const roomy = { ...profile, maxWidth: 4000, maxHeight: 4000, limits: { ...profile.limits, symbols: 60, symbolsPerLane: 6, crossings: 40, crossingsOverBound: 2 } }

  test('three shared symbols reaching every lane force Zarankiewicz\'s ⌊n/2⌋⌊(n−1)/2⌋', () => {
    // A lane drawing keeps shared symbols on one side of the lanes, so it crosses more than the bound here.
    const lenient = { ...roomy, limits: { ...roomy.limits, crossingsOverBound: 40 } }
    for (const [lanes, forced] of [[3, 1], [4, 2], [6, 6]] as const) {
      const result = layoutDiagram(threeSources(lanes), lenient)
      if (!result.ok) throw new Error(JSON.stringify(result.reasons))
      expect(result.forcedCrossings).toBe(forced)
      expect(result.crossings).toBeGreaterThanOrEqual(forced)
    }
  })

  test('a hub reaching every lane across a ladder of two headers is forced across it 2n − 4 times; a train closing the ladder adds one', () => {
    // Two lanes are a ladder of one cycle: the hub reaches both from outside it, unless the train closes it there too.
    for (const lanes of [2, 3, 4, 6]) {
      const open = layoutDiagram(ladder(lanes, false), roomy)
      const closed = layoutDiagram(ladder(lanes, true), roomy)
      if (!open.ok || !closed.ok) throw new Error('refused')
      expect(open.forcedCrossings).toBe(2 * lanes - 4)
      expect(closed.forcedCrossings).toBe(2 * lanes - 3)
    }
  })

  test('the closed ladder draws within two crossings of the bound, verified, deterministic and id-free', () => {
    for (const lanes of [2, 4, 6]) {
      const graph = ladder(lanes, true)
      const result = accepted(graph, roomy)
      expect(result.crossings).toBeLessThanOrEqual(result.forcedCrossings + 2)
      expect(crossings(result)).toBe(result.crossings)
      expect(verifyDiagram(graph, roomy, result)).toEqual([])
      for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), roomy).hash).toBe(result.hash)
    }
  })

  test('ever shorter of height, a return leg folds at its turn, then beside it: its head shares the layer of what feeds it', () => {
    for (const lanes of [4, 6]) {
      const graph = longTrain(lanes)
      const tall = accepted(graph, roomy)
      const folded = accepted(graph, { ...roomy, maxHeight: tall.height - 1 })
      const short = { ...roomy, maxHeight: folded.height - 1 }
      const result = accepted(graph, short)
      const centre = (id: string): number => {
        const placed = result.nodes.find(candidate => candidate.id === id)!
        return placed.y + placed.height / 2
      }
      expect(result.height).toBeLessThan(folded.height)
      // The leg (engine to feed pump) is drawn mirrored; the cooler, which the bypass feeds, sits in the bypass's layer, and the train runs down from there.
      expect(centre('cooler')).toBe(centre('bypass'))
      expect(centre('feed-pump')).toBeGreaterThan(centre('cooler'))
      expect(result.crossings).toBeLessThanOrEqual(result.forcedCrossings + 2)
      expect(verifyDiagram(graph, short, result)).toEqual([])
      for (const routed of result.edges) expect(bendsOf(routed.points)).toBeLessThanOrEqual(3)
      for (const seed of [1, 2]) expect(accepted(scramble(graph, seed), short).hash).toBe(result.hash)
    }
  })

  test('a limit relative to the bound refuses a drawing that crosses more than it allows, naming the limit', () => {
    const strict = { ...profile, maxWidth: 4000, maxHeight: 4000, limits: { ...profile.limits, symbols: 60, symbolsPerLane: 6, crossings: 40, crossingsOverBound: 0 } }
    const result = layoutDiagram(threeSources(6), strict)
    if (result.ok) expect(result.crossings).toBe(result.forcedCrossings)
    else expect(result.reasons).toEqual([expect.objectContaining({ kind: 'density', limit: 'crossingsOverBound', max: 6 })])
  })
})
