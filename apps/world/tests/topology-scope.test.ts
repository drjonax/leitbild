import { describe, expect, test } from 'bun:test'
import { topologyGraphSchema, type TopologyGraph } from '../src/core/observation/topology.ts'
import { drawingStops, scopeTopology, type TopologyRequest } from '../src/features/displays/topology/scope.ts'

// World's generic topology scope on a graph no pack draws (architecture A5):
// a small water works with two laned branches, a two-circuit heat exchanger
// and a powered pump.

type Port = { readonly id: string; readonly media: ReadonlyArray<string>; readonly direction: 'in' | 'out' | 'both'; readonly circuit?: string }
const node = (id: string, ports: ReadonlyArray<Port>, group?: string) => ({
  id, class: 'junction' as const, kind: 'fixture', label: id, rank: id, ports: ports.map(port => ({ rank: port.id, ...port })), bindings: [], ...(group === undefined ? {} : { group }),
})
const water = (id: string, direction: Port['direction'], circuit = 'w'): Port => ({ id, media: ['water'], direction, circuit })
const pipe = (id: string, from: string, to: string, medium = 'water', group?: string) => {
  const [fromNode, fromPort] = from.split('.') as [string, string]
  const [toNode, toPort] = to.split('.') as [string, string]
  return { id, rank: id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }, medium, directed: true, bindings: [], ...(group === undefined ? {} : { group }) }
}
const graph: TopologyGraph = topologyGraphSchema.parse({
  objectId: 'site:works', revision: '1', family: 'flow',
  media: [{ id: 'water', label: 'Water', kind: 'fluid' }, { id: 'power', label: 'Power', kind: 'electric-ac' }],
  groups: [{ id: 'east', label: 'East', kind: 'branch', lane: { key: 'east', order: 0 } }, { id: 'west', label: 'West', kind: 'branch', lane: { key: 'west', order: 1 } }],
  nodes: [
    node('tank', [water('out', 'out')]),
    node('pump', [water('in', 'in'), water('out', 'out'), { id: 'supply', media: ['power'], direction: 'in' }]),
    node('header', [water('in', 'in'), water('east', 'out'), water('west', 'out')]),
    node('valveEast', [water('in', 'in'), water('out', 'out')], 'east'),
    node('valveWest', [water('in', 'in'), water('out', 'out')], 'west'),
    node('exchanger', [water('hotIn', 'in', 'hot'), water('hotOut', 'out', 'hot'), water('coldIn', 'in', 'cold'), water('coldOut', 'out', 'cold')]),
    node('basin', [water('in', 'in')]),
    node('river', [water('out', 'out')]),
    node('outfall', [water('in', 'in'), water('out', 'out')]),
    node('sea', [water('in', 'in')]),
    node('bus', [{ id: 'feed', media: ['power'], direction: 'out' }]),
  ],
  edges: [
    pipe('tank-pump', 'tank.out', 'pump.in'), pipe('pump-header', 'pump.out', 'header.in'),
    pipe('header-east', 'header.east', 'valveEast.in'), pipe('header-west', 'header.west', 'valveWest.in'),
    pipe('east-exchanger', 'valveEast.out', 'exchanger.hotIn'), pipe('exchanger-basin', 'exchanger.hotOut', 'basin.in'),
    pipe('west-basin', 'valveWest.out', 'basin.in'), pipe('river-exchanger', 'river.out', 'exchanger.coldIn'),
    pipe('exchanger-outfall', 'exchanger.coldOut', 'outfall.in'), pipe('outfall-sea', 'outfall.out', 'sea.in'), pipe('bus-pump', 'bus.feed', 'pump.supply', 'power'),
  ],
  boundaries: [],
})
const drawn = (request: TopologyRequest) => {
  const result = scopeTopology(graph, request)
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result.scoped
}

describe('generic topology scope', () => {
  test('a route keeps every parallel branch between its ends and none beyond them', () => {
    expect(drawn({ from: ['tank'], to: ['basin'] }).nodes).toEqual(['tank', 'pump', 'header', 'valveEast', 'valveWest', 'exchanger', 'basin'])
  })

  test('flow leaves a node only by a port of the circuit it entered by: the exchanger\'s cold side is no part of the hot side\'s reach', () => {
    expect(drawn({ from: ['valveEast'], reach: 3 }).nodes).toEqual(['valveEast', 'exchanger', 'basin'])
  })

  test('around an item draws its process, stops where its power joins, and roots the layout at it', () => {
    const scoped = drawn({ around: ['pump'], reach: 1 })
    expect(scoped.media).toEqual(['water'])
    expect(scoped.nodes).toEqual(['tank', 'pump', 'header'])
    expect(scoped.roots).toEqual(['pump'])
    expect(scoped.stubs.filter(stub => stub.node === 'pump')).toEqual([{ node: 'pump', port: 'supply', direction: 'in', edges: ['bus-pump'], others: [{ node: 'bus', port: 'feed' }] }])
  })

  test('groups narrow to their own edges and the shared ones on routes into and out of them', () => {
    const east = drawn({ from: ['tank'], to: ['basin'], groups: ['east'] })
    expect(east.nodes).toEqual(['tank', 'pump', 'header', 'valveEast', 'exchanger', 'basin'])
    expect(east.stubs.map(stub => `${stub.node}.${stub.port} ${stub.direction}`)).toEqual(['header.west out', 'exchanger.coldIn in', 'exchanger.coldOut out'])
  })

  test('refusals are codes with what was found', () => {
    expect(scopeTopology(graph, { from: ['basin'], to: ['tank'] })).toEqual({ ok: false, refusal: { code: 'reversed', media: [] } })
    expect(scopeTopology(graph, { from: ['tank'], to: ['basin'], groups: ['nowhere'] })).toEqual({ ok: false, refusal: { code: 'groups-empty', media: ['water'], reached: ['east', 'west'] } })
    expect(scopeTopology(graph, { from: ['pump'] })).toEqual({ ok: true, scoped: expect.objectContaining({ media: ['water'] }) })
  })

  test('a stop over alike ports of one circuit names every far end', () => {
    expect(drawingStops(graph, ['header'], new Set(['pump-header']), new Set(['water']))).toEqual([
      { node: 'header', port: 'east', direction: 'out', edges: ['header-east', 'header-west'], others: [{ node: 'valveEast', port: 'in' }, { node: 'valveWest', port: 'in' }] },
    ])
  })

  test('an undirected edge (a grid line) is reached from either end, whatever its declared orientation', () => {
    const line = (id: string, from: string, to: string, directed: boolean) => ({ ...pipe(id, `${from}.p`, `${to}.p`, 'ac'), directed })
    const bus = (id: string) => node(id, [{ id: 'p', media: ['ac'], direction: 'both', circuit: 'through' }])
    const chain = (directed: boolean): TopologyGraph => topologyGraphSchema.parse({
      objectId: 'grid:chain', revision: '1', family: 'network', media: [{ id: 'ac', label: 'AC', kind: 'electric-ac' }], groups: [],
      nodes: [bus('north'), bus('middle'), bus('south'), bus('far')],
      edges: [line('middle-north', 'middle', 'north', directed), line('middle-south', 'middle', 'south', directed), line('far-south', 'far', 'south', directed)],
      boundaries: [],
    })
    const reached = (directed: boolean) => {
      const result = scopeTopology(chain(directed), { around: ['north'], media: ['ac'], reach: 3 })
      return result.ok ? result.scoped.nodes : result.refusal
    }
    expect(reached(false)).toEqual(['north', 'middle', 'south', 'far'])
    // Directed, flow follows the declared orientation only: north is where the line ends.
    expect(reached(true)).toEqual(['north', 'middle'])
  })

  test('asked (a vignette), a node joined to drawn nodes from two sides, by every edge of the media joining it, is drawn, not named at a stop on each side', () => {
    // A vessel relieves through a block valve and a relief valve, and through its safety valves, into a header and a
    // tank. Around the header one link out, the relief and safety valves are drawn and the vessel is too (where that
    // flow starts); the block valve between the vessel and the relief valve is not reached.
    const relief: TopologyGraph = topologyGraphSchema.parse({
      objectId: 'site:relief', revision: '1', family: 'flow', media: [{ id: 'water', label: 'Water', kind: 'fluid' }, { id: 'power', label: 'Power', kind: 'electric-ac' }], groups: [],
      nodes: [
        node('vessel', [water('relief', 'out'), water('safety', 'out')]), node('block', [water('in', 'in'), water('out', 'out'), { id: 'motor', media: ['power'], direction: 'in' }]),
        node('reliefValve', [water('in', 'in'), water('out', 'out')]), node('safetyValve', [water('in', 'in'), water('out', 'out')]),
        node('header', [water('in', 'in'), water('out', 'out')]), node('tank', [water('in', 'in')]), node('bus', [{ id: 'feed', media: ['power'], direction: 'out' }]),
      ],
      edges: [
        pipe('vessel-block', 'vessel.relief', 'block.in'), pipe('block-relief', 'block.out', 'reliefValve.in'), pipe('vessel-safety', 'vessel.safety', 'safetyValve.in'),
        pipe('relief-header', 'reliefValve.out', 'header.in'), pipe('safety-header', 'safetyValve.out', 'header.in'), pipe('header-tank', 'header.out', 'tank.in'),
        pipe('bus-block', 'bus.feed', 'block.motor', 'power'),
      ],
      boundaries: [],
    })
    const scoped = (request: TopologyRequest) => {
      const result = scopeTopology(relief, request)
      if (!result.ok) throw new Error(JSON.stringify(result.refusal))
      return { nodes: result.scoped.nodes, named: result.scoped.stubs.flatMap(stub => stub.others.map(other => other.node)) }
    }
    // Not asked (today's mimic): the drawing stops at the block valve from the vessel and from the relief valve.
    expect(scoped({ around: ['header'], reach: 1 })).toEqual({ nodes: ['vessel', 'reliefValve', 'safetyValve', 'header', 'tank'], named: ['block', 'block'] })
    // Asked: it is drawn with its two links, and nothing is named twice.
    expect(scoped({ around: ['header'], reach: 1, between: true })).toEqual({ nodes: ['vessel', 'block', 'reliefValve', 'safetyValve', 'header', 'tank'], named: [] })
    // Its motor's supply, power named, does not join it to the drawing: it is drawn all the same, and the supply stops
    // the drawing at it, naming the bus once.
    expect(scoped({ around: ['header'], reach: 1, media: ['water', 'power'], between: true })).toEqual({ nodes: ['vessel', 'block', 'reliefValve', 'safetyValve', 'header', 'tank'], named: ['bus'] })
    // A node joined by one medium where another of its edges in that medium leads elsewhere stays a stop: a second
    // outlet of the block valve to a drain not drawn.
    const drained: TopologyGraph = topologyGraphSchema.parse({
      ...relief,
      nodes: [...relief.nodes.map(entry => entry.id === 'block' ? { ...entry, ports: [...entry.ports, { id: 'drain', rank: 'drain', media: ['water'], direction: 'out', circuit: 'w' }] } : entry), node('drain', [water('in', 'in')])],
      edges: [...relief.edges, pipe('block-drain', 'block.drain', 'drain.in')],
    })
    const stopped = scopeTopology(drained, { around: ['header'], reach: 1, between: true })
    if (!stopped.ok) throw new Error(JSON.stringify(stopped.refusal))
    expect(stopped.scoped.nodes).toEqual(['vessel', 'reliefValve', 'safetyValve', 'header', 'tank'])
  })
})
