import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Observation } from '../src/core/observation/model.ts'
import type { TopologyGraph } from '../src/core/observation/topology.ts'
import type { VignetteSection } from '../src/features/displays/compose/model.ts'
import { FLOW_ROOM, overviewOf, topologySection } from '../src/features/displays/compose/topology.ts'
import { flowLayout } from '../src/features/displays/topology/flow-sizing.ts'
import { groupName, type TopologyLayout } from '../src/features/displays/topology/layout.ts'
import { scopeTopology, type TopologyRequest } from '../src/features/displays/topology/scope.ts'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { servedPlantTopology } from '../src/packs/process-plant/observation/topology.ts'
import { flowDrawing, glyphOf, symbolOf } from '../src/ui/embed/vignette/flow-symbols.ts'
import { overlaps } from './helpers/network-layout-measure.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// B3's flow topology: the diagram engine's layout under the vignette's flow
// sizing (0 overlaps; crossings within today's ceilings: twelve across lanes,
// four within one), the drawn ids of T01's reference mimics out of the
// topology, and what the renderer draws from the layout and the sample.

const ROOM = FLOW_ROOM
const overlapping = (layout: TopologyLayout): ReadonlyArray<string> => {
  const texts = layout.nodes.flatMap(node => (node.text === undefined ? [] : [{ id: `${node.id}:text`, ...node.text }]))
  return overlaps({ ...layout, nodes: [...layout.nodes, ...texts].map(box => ({ ...box, ports: {} })) })
}
const drawnIds = (layout: TopologyLayout): ReadonlyArray<string> =>
  layout.nodes.flatMap(node => node.members ?? [node.id]).filter(id => !/^s\d+$/.test(id)).sort()

describe('flow layout', () => {
  test('the fixture: a unit\'s tank feeding its engine draws without a crossing or an overlap', () => {
    const graph: TopologyGraph = {
      objectId: 'fixture:unit' as never, revision: 'r', family: 'flow', media: [{ id: 'fuel', label: 'Fuel', kind: 'fluid' }], groups: [], boundaries: [],
      nodes: [
        { id: 'tank', class: 'store', kind: 'tank', label: 'Unit tank', rank: '1', ports: [{ id: 'out', rank: '1', media: ['fuel'], direction: 'out' }], bindings: [] },
        { id: 'engine', class: 'mover', kind: 'engine', label: 'Unit engine', rank: '2', ports: [{ id: 'in', rank: '1', media: ['fuel'], direction: 'in' }], bindings: [{ role: 'flow', ref: 'fixture:unit#speed' }] },
      ],
      edges: [{ id: 'feed', rank: '1', from: { node: 'tank', port: 'out' }, to: { node: 'engine', port: 'in' }, medium: 'fuel', directed: true, bindings: [] }],
    }
    const scoped = scopeTopology(graph, { from: ['tank'], to: ['engine'] })
    if (!scoped.ok) throw new Error(scoped.refusal.code)
    const drawn = flowLayout(scoped.scoped, ROOM)!
    expect(drawn.layout.crossings).toBe(0)
    expect(overlapping(drawn.layout)).toEqual([])
    expect(drawnIds(drawn.layout)).toEqual(['engine', 'tank'])
  })

  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:flow', loopCount: 4 }))
  const graph = servedPlantTopology('plant:flow' as never, plant)
  const media = (ids: ReadonlyArray<string>): ReadonlyArray<string> => graph.media.filter(medium => ids.includes(medium.id)).map(medium => medium.id)
  const layoutOf = (request: TopologyRequest) => {
    const scoped = scopeTopology(graph, request)
    if (!scoped.ok) throw new Error(scoped.refusal.code)
    return flowLayout(scoped.scoped, ROOM)
  }

  test('the whole Plant\'s declared overview at two to four loops: within the overview\'s twelve crossings, no overlap, in its room', () => {
    for (const loops of [2, 3, 4]) {
      const model = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:overview', loopCount: loops }))
      const served = servedPlantTopology('plant:overview' as never, model)
      expect(served.overview).toBeDefined()
      const scoped = overviewOf(served)!
      const drawn = flowLayout(scoped, ROOM)!
      expect(drawn.layout.crossings).toBeLessThanOrEqual(12)
      expect(overlapping(drawn.layout)).toEqual([])
      expect(drawn.layout.width).toBeLessThanOrEqual(ROOM.columns)
      expect(drawn.layout.height).toBeLessThanOrEqual(ROOM.rows)
    }
  })

  test('four loops: the feed line-up from MFW A and the AFW header to every steam generator draws (E2 show-feed-lineup), taking a fourth bend only where three draw nothing', () => {
    const drawn = layoutOf({ from: ['mainFeedwaterPumpA', 'auxFeedwaterHeader'], to: ['sgA', 'sgB', 'sgC', 'sgD'] })
    expect(drawn).not.toBeNull()
    expect(drawn!.layout.crossings).toBeLessThanOrEqual(12)
    expect(overlapping(drawn!.layout)).toEqual([])
    expect(drawnIds(drawn!.layout)).toEqual(expect.arrayContaining(['sgA', 'sgB', 'sgC', 'sgD', 'mainFeedwaterPumpA', 'auxFeedwaterHeader']))
  })

  test('four loops: around a steam generator and the pressurizer, each within one lane, at most four crossings and no overlap', () => {
    for (const request of [{ around: ['sgA'], reach: 1 }, { around: ['pressurizer'], reach: 1 }]) {
      const drawn = layoutOf(request)!
      expect(drawn.layout.crossings).toBeLessThanOrEqual(4)
      expect(overlapping(drawn.layout)).toEqual([])
    }
  })

  test('T01\'s reference mimics draw the same ids out of the topology, the pressurizer\'s relief valves on its relief path included', () => {
    const record = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/display-characterization/old-path.json'), 'utf8')) as { readonly states: { readonly steady: { readonly elementActions: ReadonlyArray<{ readonly drawn: ReadonlyArray<string> }> } } }
    const recorded = record.states.steady.elementActions.map(entry => entry.drawn.map(drawn => drawn.split(':')[0]!).sort())
    const requests: ReadonlyArray<TopologyRequest> = [
      { around: ['auxFeedwaterValveA'] },
      { from: ['pressurizer'], to: ['pressurizerReliefTank'], media: media(['primaryRelief']) },
      { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'], media: media(['electricalPower']) },
      { around: ['mainSteamIsolationValveA'] },
    ]
    const drawn = requests.map(request => layoutOf(request)!)
    for (const entry of drawn) {
      expect(entry.layout.crossings).toBeLessThanOrEqual(4)
      expect(overlapping(entry.layout)).toEqual([])
    }
    expect(drawn.map(entry => drawnIds(entry.layout))).toEqual(recorded)
  })
})

type Topology = Extract<VignetteSection, { kind: 'topology' }>
const at = '2026-10-21T12:00:00.000Z'
const observation = (ref: string, value: Observation['value'], quality: Observation['quality'] = 'good'): Observation => ({ ref, at, clock: 'simulation', value, quality, priority: 'none', rank: 1 })

// A tank feeding two alike movers into a valve and a header: the layout as the engine would give it, in grid units.
const section: Topology = {
  kind: 'topology', rows: 8, objectId: 'unit:x', packId: 'fixture', family: 'flow',
  layout: {
    family: 'flow', unit: 'grid', width: 20, height: 6, crossings: 0, hash: 'h',
    nodes: [
      { id: 'tank', x: 0, y: 1, width: 2, height: 4, ports: { out: { x: 2, y: 3, face: 'right' } }, text: { x: 0, y: 5, width: 3, height: 1, lines: 2, side: 'bottom' } },
      { id: 'mover', x: 5, y: 2, width: 2, height: 2, ports: { in: { x: 5, y: 3, face: 'left' }, out: { x: 7, y: 3, face: 'right' } }, members: ['mover', 'moverB'], text: { x: 5, y: 4, width: 3, height: 1, lines: 2, side: 'bottom' } },
      { id: 'valve', x: 10, y: 2, width: 2, height: 2, ports: { in: { x: 10, y: 3, face: 'left' }, out: { x: 12, y: 3, face: 'right' } } },
      { id: 's0', x: 16, y: 2.5, width: 2, height: 1, ports: { end: { x: 16, y: 3, face: 'left' } } },
    ],
    edges: [
      { id: 'a.0', points: [[2, 3], [5, 3]], gaps: [] },
      { id: 'b.0', points: [[7, 3], [10, 3]], gaps: [] },
      { id: 's0.edge', points: [[12, 3], [16, 3]], gaps: [] },
    ],
  },
  nodes: [
    { id: 'tank', class: 'store', label: 'Supply tank', shortLabel: 'Tank', bindings: [{ role: 'level', ref: 'unit:x#level', quantity: 'level', unit: '%' }] },
    { id: 'mover', class: 'mover', label: 'Mover A', bindings: [{ role: 'running', ref: 'unit:x#runA', quantity: 'state', unit: '' }] },
    { id: 'moverB', class: 'mover', label: 'Mover B', bindings: [{ role: 'running', ref: 'unit:x#runB', quantity: 'state', unit: '' }] },
    { id: 'valve', class: 'switch', label: 'Valve', bindings: [{ role: 'position', ref: 'unit:x#open', quantity: 'fraction', unit: '1' }] },
    { id: 's0', class: 'stop', label: 'Header', bindings: [] },
  ],
  edges: [
    { id: 'a', mediumKind: 'fluid', bindings: [{ role: 'flow', ref: 'unit:x#flowA', quantity: 'flow', unit: 'kg/s' }] },
    { id: 'b', mediumKind: 'fluid', bindings: [] },
    { id: 's0.edge', mediumKind: 'fluid', bindings: [] },
  ],
}
const live = [observation('unit:x#level', 62), observation('unit:x#runA', true), observation('unit:x#runB', false), observation('unit:x#open', 0.4), observation('unit:x#flowA', 12.5)]

describe('flow symbols', () => {
  test('OpenBridge equipment by class first, then the drawn lines: a mover generates only where a power line leaves it', () => {
    const node = (cls: Topology['nodes'][number]['class'], running = false) => ({ class: cls, bindings: running ? [{ role: 'running' as const, ref: 'x#r', quantity: 'state' as const, unit: '' }] : [] })
    const into = (...kinds: ReadonlyArray<string>) => kinds.map(kind => ({ kind, out: false }))
    const outOf = (...kinds: ReadonlyArray<string>) => kinds.map(kind => ({ kind, out: true }))
    expect(symbolOf(node('mover'), [...into('fluid'), ...outOf('fluid')], false)).toBe('mover')
    // A mover drawn with the power line that drives it, or with only that line (a view around its bus), is still a mover.
    expect(symbolOf(node('mover'), [...outOf('fluid'), ...into('electric-ac')], false)).toBe('mover')
    expect(symbolOf(node('mover'), into('electric-ac'), false)).toBe('mover')
    expect(symbolOf(node('mover'), outOf('electric-ac'), false)).toBe('generator')
    // A valve with its motor's supply is still a valve.
    expect(symbolOf(node('switch'), [...into('electric-ac'), ...outOf('steam')], false)).toBe('valve')
    expect(symbolOf(node('switch'), outOf('steam'), false)).toBe('valve')
    expect(symbolOf(node('switch'), outOf('electric-ac'), false)).toBe('breaker')
    expect(symbolOf(node('store'), outOf('fluid'), false)).toBe('tank')
    expect(symbolOf(node('transfer'), [...into('fluid'), ...outOf('steam')], false)).toBe('exchanger')
    expect(symbolOf(node('source'), outOf('fluid'), false)).toBe('vessel')
    expect(symbolOf(node('source'), outOf('electric-ac'), false)).toBe('source')
    expect(symbolOf(node('sink', true), into('steam'), false)).toBe('generator')
    expect(symbolOf(node('sink'), into('fluid'), false)).toBe('end')
    expect(symbolOf(node('junction'), outOf('steam'), true)).toBe('header')
    expect(symbolOf(node('bus'), outOf('electric-ac'), true)).toBe('bus')
  })

  test('four loops: around a bus, the movers it drives draw as movers and only its diesel generator as a generator', () => {
    const graph = servedPlantTopology('plant:flow' as never, compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:flow', loopCount: 4 })))
    for (const around of ['safetyBusA', 'unitBusA']) {
      const scoped = scopeTopology(graph, { around: [around], reach: 1 })
      if (!scoped.ok) throw new Error(scoped.refusal.code)
      const drawn = flowLayout(scoped.scoped, ROOM)!
      const drawing = flowDrawing(topologySection('plant:flow', 'process-plant', scoped.scoped, drawn, 30, () => undefined) as Topology, [], [], false)
      const generators = drawing.devices.filter(device => device.glyph?.tag.startsWith('obi-electric-generator') === true).map(device => device.id)
      expect(generators).toEqual(around === 'safetyBusA' ? ['dieselGeneratorA'] : [])
      expect(drawing.devices.filter(device => device.glyph?.tag.startsWith('obi-pump') === true).length).toBeGreaterThan(0)
    }
  })

  test('glyphs: static where the state is not known, no breaker glyph then, a valve\'s opening from its position', () => {
    expect(glyphOf('mover', { kind: 'on' }, false)).toEqual({ tag: 'obi-pump-on-horizontal' })
    expect(glyphOf('mover', { kind: 'unknown' }, true)).toEqual({ tag: 'obi-pump-static-vertical' })
    expect(glyphOf('breaker', { kind: 'unknown' }, false)).toBeNull()
    expect(glyphOf('breaker', { kind: 'off' }, false)).toEqual({ tag: 'obi-switch-01-off' })
    expect(glyphOf('valve', { kind: 'position', fraction: 0.4 }, false)).toEqual({ tag: 'obc-valve-analog-two-way-icon', value: 40 })
    expect(glyphOf('valve', { kind: 'unknown' }, false)).toEqual({ tag: 'obi-twoway-digital-static' })
  })

  test('bindings drive the drawing: a level fills the tank, a group counts its running members, a position opens the valve, a flow fills its pipe', () => {
    const drawing = flowDrawing(section, live, [], false)
    expect(drawing.vessels).toMatchObject([{ id: 'tank', kind: 'tank', level: 62, unknown: false }])
    expect(drawing.devices.map(device => [device.id, device.on, device.unknown, device.glyph])).toEqual([
      ['mover', true, false, { tag: 'obi-pump-on-horizontal' }],
      ['valve', true, false, { tag: 'obc-valve-analog-two-way-icon', value: 40 }],
    ])
    expect(drawing.texts.map(text => text.lines.map(line => line.text))).toEqual([['Tank', '62.0 %'], [groupName(['Mover A', 'Mover B']), 'RUN 1/2']])
    const pipes = drawing.segments.filter(segment => 'connectionId' in segment && segment.connectionId === 'a.0')
    expect(pipes.every(segment => segment.value === 'open-flow')).toBe(true)
    expect(pipes.some(segment => segment.kind === 'direction')).toBe(true)
    expect(drawing.segments.some(segment => segment.kind === 'endpoint')).toBe(true)
  })

  test('a lone item writes its state in its observable\'s declared words, or in their place the command it does not follow; unknown reads "?"', () => {
    const lone: Topology = {
      ...section,
      layout: { ...section.layout, nodes: section.layout.nodes.map(node => (node.id === 'mover' ? { id: 'mover', x: 5, y: 2, width: 2, height: 2, ports: node.ports, text: { x: 7, y: 2, width: 4, height: 2, lines: 3, side: 'right' as const } } : node)) },
      nodes: section.nodes.map(node => (node.id === 'mover' ? { ...node, bindings: [{ role: 'running' as const, ref: 'unit:x#runA', quantity: 'state' as const, unit: '', states: [{ value: 'on', label: 'RUN', active: true as const }, { value: 'off', label: 'STOP' }] }] } : node)),
    }
    const words = (observations: ReadonlyArray<Observation>) => flowDrawing(lone, observations, [], false).texts.find(text => text.id === 'mover')!.lines.map(line => `${line.kind}:${line.text}`)
    expect(words([{ ...observation('unit:x#runA', 'off'), why: 'CMD RUN' }])).toEqual(['name:Mover A', 'command:CMD RUN'])
    expect(words([observation('unit:x#runA', 'off')])).toEqual(['name:Mover A', 'word:STOP'])
    expect(words([observation('unit:x#runA', 'on')])).toEqual(['name:Mover A', 'word:RUN'])
    expect(words([observation('unit:x#runA', 'on', 'bad')])).toEqual(['name:Mover A', 'word:?'])
    // Outside the validity its observable declares, a state reads "—" and draws as not known.
    expect(words([observation('unit:x#runA', null, 'not-applicable')])).toEqual(['name:Mover A', 'word:—'])
    expect(flowDrawing(lone, [observation('unit:x#runA', null, 'not-applicable')], [], false).devices.find(device => device.id === 'mover')!.unknown).toBe(true)
  })

  test('an active alert on an item\'s element frames it at its priority; a returned one, or one on another object, does not', () => {
    const row = (objectId: string, element: string, priority: 'alarm' | 'caution', state: 'active-unack' | 'returned-unack') => ({
      key: `${objectId}|a`, objectId, objectLabel: 'Unit', packId: 'fixture', categoryId: 'unit', group: { objectId }, priority, state, raised: null,
      alert: { id: 'a', kind: 'alarm', severity: priority === 'alarm' ? 'critical' : 'warning', message: 'm', raisedAt: at, acknowledged: false, priority, subject: { element } },
    }) as never
    const drawing = flowDrawing(section, live, [row('unit:x', 'valve', 'alarm', 'active-unack'), row('unit:x', 'tank', 'caution', 'returned-unack'), row('unit:y', 'mover', 'alarm', 'active-unack')], false)
    expect(drawing.devices.map(device => [device.id, device.tone])).toEqual([['mover', null], ['valve', 'alarm']])
    expect(drawing.vessels[0]!.tone).toBeNull()
  })

  test('missing, bad or stale readings and a frozen sample read as unknown, never as off or empty', () => {
    const stale = flowDrawing(section, [observation('unit:x#level', 62, 'stale'), observation('unit:x#runA', true, 'bad'), observation('unit:x#flowA', 0)], [], false)
    expect(stale.vessels[0]).toMatchObject({ level: null, unknown: true })
    expect(stale.devices.map(device => [device.id, device.unknown])).toEqual([['mover', true], ['valve', true]])
    expect(stale.texts[1]!.lines[1]!.text).toBe('RUN ?/2')
    expect(stale.segments.filter(segment => 'connectionId' in segment && segment.connectionId === 'a.0').every(segment => segment.value === 'empty')).toBe(true)
    // A reading outside its declared validity writes "—", never its value.
    const invalid = flowDrawing(section, [observation('unit:x#level', 62, 'not-applicable')], [], false)
    expect(invalid.texts[0]!.lines.map(line => line.text)).toEqual(['Tank', '—'])
    expect(invalid.vessels[0]).toMatchObject({ level: null, unknown: true })
    const frozen = flowDrawing(section, live, [], true)
    expect(frozen.devices.every(device => device.unknown)).toBe(true)
    expect(frozen.segments.filter(segment => 'connectionId' in segment && segment.connectionId === 'a.0').every(segment => segment.value === 'closed-dash')).toBe(true)
  })
})
