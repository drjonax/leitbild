import { describe, expect, test } from 'bun:test'
import { defineObservationCapability, observationDeclarationSchema, observationShapes } from '../src/core/observation/capabilities.ts'
import {
  decimalsFor, numberShown, numberText, observableSchema, observationSchema, quantitySchema, quantityUnits, stampSchema, thresholdSchema, unitDecimals, unitSymbol,
} from '../src/core/observation/model.ts'
import { displaySpecSchema, selectorSchema, viewSchema } from '../src/core/observation/spec.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'

const at = { at: '2026-10-20T08:00:00.000Z', clock: 'simulation' } as const
const threshold = { id: 'lo-lo', direction: 'low', value: 20, order: 2, effect: 'trip', priority: 'alarm' } as const
const observable = {
  ref: 'unit-2#SG-A-NR-LVL', label: 'Unit 2 SG A narrow-range level', quantity: 'level', unit: '%', valueType: 'number',
  series: { seriesId: 's-1', intervalMs: 1000 },
} as const
const spec = { title: 'SG A level', question: 'Is SG A level recovering?', subjects: ['unit-2#SG-A-NR-LVL'], views: [{ kind: 'trend', signals: ['unit-2#SG-A-NR-LVL'] }] }

describe('observation model', () => {
  test('every stamp names its clock and accepts an offset', () => {
    expect(stampSchema.parse({ at: '2026-10-20T10:00:00+02:00', clock: 'wall' }).clock).toBe('wall')
    expect(stampSchema.safeParse({ at: '2026-10-20T08:00:00Z' }).success).toBe(false)
  })

  test('each quantity allows only its listed short ASCII unit codes', () => {
    for (const [quantity, units] of Object.entries(quantityUnits)) {
      expect(units.length).toBeGreaterThan(0)
      for (const unit of units) expect(unit).toMatch(/^[\x21-\x7e]{0,8}$/)
      expect(observableSchema.safeParse({ ...observable, quantity, unit: units[0] }).success).toBe(true)
    }
    expect(observableSchema.safeParse({ ...observable, unit: 'percent' }).success).toBe(false)
    expect(observableSchema.safeParse({ ...observable, quantity: 'temperature', unit: '°C' }).success).toBe(false)
    expect(observableSchema.safeParse({ ...observable, quantity: 'direction-from', unit: 'degrees FROM north' }).success).toBe(false)
    expect(observableSchema.safeParse({ ...observable, quantity: 'state', unit: '' }).success).toBe(true)
  })

  test('quantities come from the fixed core list only', () => {
    expect(quantitySchema.parse('electric-power')).toBe('electric-power')
    expect(quantitySchema.safeParse('active-power').success).toBe(false)
    expect(quantitySchema.safeParse('power').success).toBe(false)
  })

  test('a threshold has an order 1–4 and a priority above none', () => {
    expect(thresholdSchema.parse(threshold).order).toBe(2)
    expect(thresholdSchema.safeParse({ ...threshold, order: 5 }).success).toBe(false)
    expect(thresholdSchema.safeParse({ ...threshold, priority: 'none' }).success).toBe(false)
    expect(thresholdSchema.safeParse({ ...threshold, colour: '#f00' }).success).toBe(false)
    // R31: a level that advises and raises no alarm (weather's severity ladder).
    expect(thresholdSchema.parse({ ...threshold, effect: 'advisory', priority: 'notice' }).effect).toBe('advisory')
    expect(thresholdSchema.safeParse({ ...threshold, effect: 'warning' }).success).toBe(false)
  })

  test('an observable is addressed objectId#signal and may name its tag and element', () => {
    expect(observableSchema.parse({ ...observable, tag: 'SG-A-NR-LVL', element: 'sg-a' }).tag).toBe('SG-A-NR-LVL')
    for (const ref of ['SG-A-NR-LVL', '#SG-A', 'unit-2#', 'unit 2#SG-A', 'unit-2#SG A']) {
      expect(observableSchema.safeParse({ ...observable, ref }).success).toBe(false)
    }
    expect(observableSchema.safeParse({ ...observable, tag: 'x'.repeat(65) }).success).toBe(false)
  })

  test('an observable defaults to no thresholds and may be unrecorded', () => {
    expect(observableSchema.parse(observable).thresholds).toEqual([])
    expect(observableSchema.parse({ ...observable, series: null, valueType: 'duration', quantity: 'duration', unit: 's' }).series).toBeNull()
    expect(observableSchema.safeParse({ ...observable, series: undefined }).success).toBe(false)
    expect(observableSchema.safeParse({ ...observable, thresholds: Array.from({ length: 13 }, (_, index) => ({ ...threshold, id: `t${index}` })) }).success).toBe(false)
  })

  test('an observation carries one six-level priority and refuses a second scale name', () => {
    const observation = { ...at, ref: observable.ref, value: 31.5, quality: 'good', priority: 'caution', timeToAct: { threshold: 'lo-lo', seconds: 140 } }
    expect(observationSchema.parse(observation).priority).toBe('caution')
    expect(observationSchema.safeParse({ ...observation, severity: 'caution' }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, clock: undefined }).success).toBe(false)
  })

  test('a state observable marks what a running or conducting binding reads as on, by flag and never by order', () => {
    const states = [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed', active: true }]
    expect(observableSchema.parse({ ...observable, quantity: 'state', unit: '', valueType: 'enum', states }).states?.find(state => state.active)?.value).toBe('closed')
    expect(observableSchema.safeParse({ ...observable, quantity: 'state', unit: '', valueType: 'enum', states: [{ value: 'open', label: 'Open', active: false }] }).success).toBe(false)
  })

  test('an observation names the declared threshold it is past; an observable may declare its lead rank', () => {
    const observation = { ...at, ref: observable.ref, value: 18.2, quality: 'good', priority: 'alarm', past: 'lo-lo' }
    expect(observationSchema.parse(observation).past).toBe('lo-lo')
    expect(observationSchema.safeParse({ ...observation, past: '' }).success).toBe(false)
    expect(observableSchema.parse({ ...observable, lead: 1 }).lead).toBe(1)
    for (const lead of [0, -1, 1.5]) expect(observableSchema.safeParse({ ...observable, lead }).success).toBe(false)
  })

  test('a reading\'s decimals come from its unit code; a code not listed shows three significant digits', () => {
    const codes = new Set<string>(Object.values(quantityUnits).flat())
    for (const unit of Object.keys(unitDecimals)) expect(codes.has(unit)).toBe(true)
    expect([decimalsFor('MPa', 15.5), decimalsFor('%', 31.52), decimalsFor('mSv/h', 0.0021), decimalsFor('Hz', 49.95)]).toEqual([2, 1, 3, 2])
    expect([decimalsFor('pcm', 150), decimalsFor('pcm', 15), decimalsFor('pcm', 1.5), decimalsFor('pu', 0.98), decimalsFor('degC/s', -0.0042), decimalsFor('pcm', 0)]).toEqual([0, 1, 2, 3, 5, 2])
    expect([numberText(-0.04, '%'), numberText(287.44, 'degC'), numberText(0.98, 'pu'), numberText(3, '1')]).toEqual(['0.0', '287.4', '0.980', '3.00'])
    expect([unitSymbol('degC'), unitSymbol('m3'), unitSymbol('1'), unitSymbol(''), unitSymbol('MPa')]).toEqual(['°C', 'm³', '', '', 'MPa'])
    // A count is whole whatever its unit code; a fraction of '1' keeps its two decimals.
    expect([numberText(1, '1', 'count'), numberText(0.85, '1', 'fraction'), decimalsFor('1', 12, 'count')]).toEqual(['1', '0.85', 0])
  })

  test('a value declared read over decades reads below its step as a power of ten; any other as a zero reads (docs audit, H9)', () => {
    // The intermediate-range current the display shows as 4.4×10⁻⁸ A, not "0 A"; the card carries the number it writes.
    expect([numberText(4.4e-8, 'A', 'current', true), numberText(-2.26e-11, 'A', 'current', true), numberText(0.004, 'A', 'current', true), numberText(0, 'A', 'current', true)])
      .toEqual(['4.4×10⁻⁸', '-2.3×10⁻¹¹', '4.0×10⁻³', '0'])
    expect([numberShown(4.4e-8, 'A', 'current', true), numberShown(0, 'A'), numberShown(15.504, 'MPa')]).toEqual([{ value: 4.4e-8, decimals: 9 }, { value: 0, decimals: 0 }, { value: 15.5, decimals: 2 }])
    // Not declared so: a value below its step reads 0, a leak rate's noise among them; a deviation a step's tenth off zero reads 0.0.
    expect([numberText(4.4e-8, 'A'), numberText(2.3e-12, 'kg/s'), numberText(0.6, 'A')]).toEqual(['0', '0', '1'])
    expect([numberText(-0.04, '%'), numberText(0.004, 'degC')]).toEqual(['0.0', '0.0'])
  })
})

describe('vignette spec', () => {
  test('a values view lists a live collection of one category that excludes closed objects unless asked', () => {
    const view = viewSchema.parse({ kind: 'values', of: { category: 'incident', status: ['open'], near: 'ambulance-1', within: '5km' } })
    expect(view.kind === 'values' && view.of?.closed).toBe(false)
    expect(selectorSchema.safeParse({ near: 'ambulance-1', within: '5km' }).success).toBe(false)
    expect(selectorSchema.safeParse({ category: 'incident', within: '7km' }).success).toBe(false)
    expect(selectorSchema.safeParse({ class: 'line' }).success).toBe(false)
  })

  test('alerts default to related ones; the cut events view, columns, sort and count are refused', () => {
    expect(viewSchema.parse({ kind: 'alerts' })).toEqual({ kind: 'alerts', scope: 'related' })
    expect(viewSchema.safeParse({ kind: 'events' }).success).toBe(false)
    for (const extra of [{ columns: ['priority'] }, { sort: 'priority' }, { count: { by: 'priority' } }]) {
      expect(viewSchema.safeParse({ kind: 'values', of: { category: 'incident' }, ...extra }).success).toBe(false)
    }
  })

  test('no view carries coordinates, colours or numbers', () => {
    expect(viewSchema.safeParse({ kind: 'map', around: ['halden'], within: '20km' }).success).toBe(true)
    expect(viewSchema.safeParse({ kind: 'map', center: [11.38, 59.12] }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'trend', signals: ['a'], colour: '#f00' }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'values', signals: ['a'], limits: { high: 90 } }).success).toBe(false)
  })

  test('view kinds hold their caps', () => {
    expect(viewSchema.safeParse({ kind: 'trend', signals: Array.from({ length: 13 }, (_, index) => `s${index}`) }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'topology', around: ['bus-a'], reach: 5 }).success).toBe(false)
    expect(viewSchema.safeParse({ kind: 'gauge', signals: ['a'] }).success).toBe(false)
  })

  test('a spec names one to six subjects and at most four views', () => {
    expect(displaySpecSchema.parse(spec).subjects).toHaveLength(1)
    expect(displaySpecSchema.parse({ ...spec, subjects: [{ of: { category: 'vehicle' } }] }).subjects).toHaveLength(1)
    expect(displaySpecSchema.safeParse({ ...spec, subjects: [] }).success).toBe(false)
    expect(displaySpecSchema.safeParse({ ...spec, subjects: Array.from({ length: 7 }, (_, index) => `o${index}`) }).success).toBe(false)
    expect(displaySpecSchema.safeParse({ ...spec, views: Array.from({ length: 5 }, () => ({ kind: 'alerts' })) }).success).toBe(false)
    expect(displaySpecSchema.parse({ ...spec, views: [] }).views).toEqual([])
  })
})

describe('observation Capabilities', () => {
  const declaration = { objectId: 'unit-2', revision: 'digest-1', observables: [observable] }

  test('a declaration holds its own object\'s observables once, each label once, elements default to none', () => {
    expect(observationDeclarationSchema.parse(declaration).elements).toEqual([])
    expect(observationDeclarationSchema.safeParse({ ...declaration, observables: [observable, observable] }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, objectId: 'unit-3' }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, observables: [observable, { ...observable, ref: 'unit-2#SG-A-WR-LVL' }] }).success).toBe(false)
    const element = { id: 'sg-a', class: 'converter', label: 'Steam generator A' }
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [element, element] }).success).toBe(false)
  })

  test('an element may name the element it is part of and what its detail leads with, in order, other elements\' values among them (Q22)', () => {
    const valve = { id: 'sg-a.relief', class: 'valve', label: 'SG A relief', parent: 'sg-a', lead: ['unit-2#SG-A-NR-LVL', 'unit-2#FW-A-FLOW'] }
    expect(observationDeclarationSchema.parse({ ...declaration, elements: [valve] }).elements[0]).toEqual(valve)
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [{ ...valve, parent: 'sg-a.relief' }] }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [{ ...valve, lead: ['unit-2#SG-A-NR-LVL', 'unit-2#SG-A-NR-LVL'] }] }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [{ ...valve, lead: [] }] }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [{ ...valve, lead: Array.from({ length: 17 }, (_, index) => `unit-2#v${index}`) }] }).success).toBe(false)
    expect(observationDeclarationSchema.safeParse({ ...declaration, elements: [{ ...valve, lead: ['SG-A-NR-LVL'] }] }).success).toBe(false)
  })

  test('declarations answer unchanged for a revision the caller holds', () => {
    const output = observationShapes.declarations.output
    expect(output.parse({ declarations: [{ objectId: 'unit-2', revision: 'digest-1', unchanged: true }] }).declarations).toHaveLength(1)
    expect(output.safeParse({ declarations: [{ objectId: 'unit-2', revision: 'digest-1', unchanged: false }] }).success).toBe(false)
    const input = observationShapes.declarations.input
    expect(input.safeParse({ objectIds: [] }).success).toBe(false)
    expect(input.safeParse({ objectIds: Array.from({ length: 17 }, (_, index) => `o${index}`) }).success).toBe(false)
    expect(input.parse({ objectIds: ['unit-2'], known: { 'unit-2': 'digest-1' } }).known).toEqual({ 'unit-2': 'digest-1' })
  })

  test('a read names refs or asks for an object\'s lead, never both', () => {
    const input = observationShapes.read.input
    expect(input.safeParse({ refs: ['unit-2#A'] }).success).toBe(true)
    expect(input.safeParse({ lead: { objectId: 'unit-2', count: 6 } }).success).toBe(true)
    expect(input.safeParse({ refs: ['unit-2#A'], lead: { objectId: 'unit-2', count: 6 } }).success).toBe(false)
    expect(input.safeParse({ lead: { objectId: 'unit-2', count: 17 } }).success).toBe(false)
    expect(input.safeParse({ refs: Array.from({ length: 65 }, (_, index) => `unit-2#s${index}`) }).success).toBe(false)
  })

  test('each Capability names the objects it inspects, from refs, a lead or an object id', () => {
    const inspected = (kind: keyof typeof observationShapes, input: unknown): ReadonlyArray<string> => observationShapes[kind].inspectObjectIds(input)
    expect(inspected('declarations', { objectIds: ['unit-1', 'unit-2'] })).toEqual(['unit-1', 'unit-2'])
    expect(inspected('read', { refs: ['unit-2#A', 'unit-2#B', 'grid#bus:7/v'] })).toEqual(['unit-2', 'grid'])
    expect(inspected('read', { lead: { objectId: 'unit-2', count: 6 } })).toEqual(['unit-2'])
    expect(inspected('topology', { objectId: 'unit-2' })).toEqual(['unit-2'])
    expect(() => inspected('read', { refs: ['no-object'] })).toThrow()
  })

  test('a Pack builds its Capability with the system audience and the core shape', () => {
    const capability = defineObservationCapability('read', { id: 'world.fixture.observation.read', title: 'Read observations', description: 'Reads values.' })
    expect(capability).toMatchObject({ kind: 'query', risk: 'read', idempotent: true, audience: 'system' })
    expect(capability.input).toBe(observationShapes.read.input)
    expect(capability.output).toBe(observationShapes.read.output)
    expect(() => defineObservationCapability('read', { id: 'fixture.read', title: 'x', description: 'y' })).toThrow()
  })
})

describe('topology graph', () => {
  const port = (id: string, medium = 'water') => ({ id, rank: id, media: [medium], direction: 'both' as const })
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, class: 'transfer', kind: 'pipe', label: id, rank: id, ports: [port('a'), port('b')], bindings: [], ...extra,
  })
  const graph = {
    objectId: 'unit-2', revision: 'digest-1', family: 'flow',
    media: [{ id: 'water', label: 'Feedwater', kind: 'fluid' }],
    groups: [{ id: 'loop-a', label: 'Loop A', kind: 'loop', lane: { key: 'loop', order: 0 } }],
    nodes: [node('pump', { class: 'mover', group: 'loop-a', bindings: [{ role: 'flow', ref: 'unit-2#FW-FLOW' }] }), node('sg')],
    edges: [{ id: 'e1', rank: 'e1', from: { node: 'pump', port: 'b' }, to: { node: 'sg', port: 'a' }, medium: 'water', directed: true, bindings: [] }],
    boundaries: [{ node: 'sg', port: 'b', externalPortId: 'steam-out' }],
  }

  test('a consistent graph validates, with circuits on ports and groups on edges', () => {
    expect(topologyGraphSchema.parse(graph).nodes).toHaveLength(2)
    const exchanger = node('sg', { class: 'converter', ports: [
      { id: 'primary-in', rank: '1', media: ['water'], direction: 'in', circuit: 'primary' }, { id: 'primary-out', rank: '2', media: ['water'], direction: 'out', circuit: 'primary' },
      { id: 'a', rank: '3', media: ['water'], direction: 'both', circuit: 'secondary' }, { id: 'b', rank: '4', media: ['water'], direction: 'both', circuit: 'secondary' },
    ] })
    const parsed = topologyGraphSchema.parse({ ...graph, nodes: [graph.nodes[0], exchanger], edges: [{ ...graph.edges[0], group: 'loop-a' }] })
    expect([parsed.nodes[1]?.ports[0]?.circuit, parsed.edges[0]?.group]).toEqual(['primary', 'loop-a'])
    expect(topologyGraphSchema.safeParse({ ...graph, nodes: [node('pump', { ports: [{ id: 'a', rank: 'a', media: [], direction: 'both' }] }), node('sg')] }).success).toBe(false)
    expect(topologyGraphSchema.safeParse({ ...graph, nodes: [node('pump', { ports: [{ id: 'a', rank: 'a', medium: 'water', direction: 'both' }] }), node('sg')] }).success).toBe(false)
  })

  test('every reference resolves and media agree along an edge', () => {
    const issues = (change: Record<string, unknown>) => topologyGraphSchema.safeParse({ ...graph, ...change }).error?.issues.map(issue => issue.message)
    expect(issues({ nodes: [...graph.nodes, node('pump')] })).toEqual(['duplicate node id'])
    expect(issues({ nodes: [node('pump', { group: 'loop-z' }), node('sg')] })).toEqual(['node pump has unknown group loop-z'])
    const steam = { id: 'steam', label: 'Steam', kind: 'steam' }
    expect(issues({ media: [...graph.media, steam], nodes: [node('pump', { ports: [port('a'), port('b', 'steam')] }), node('sg')] }))
      .toEqual(['edge e1 carries water into port pump.b of steam'])
    // A port may carry several media (R35); the edge's medium must be one of each end's.
    const both = { id: 'b', rank: 'b', media: ['steam', 'water'], direction: 'both' as const }
    expect(issues({ media: [...graph.media, steam], nodes: [node('pump', { ports: [port('a'), both] }), node('sg')] })).toBeUndefined()
    expect(issues({ edges: [{ ...graph.edges[0], group: 'loop-z' }] })).toEqual(['edge e1 has unknown group loop-z'])
    expect(issues({ edges: [{ ...graph.edges[0], to: { node: 'sg', port: 'z' } }] })).toEqual(['edge e1 ends at unknown port sg.z'])
    expect(issues({ boundaries: [{ node: 'sg', port: 'z', externalPortId: 'steam-out' }] })).toEqual(['boundary steam-out names unknown port sg.z'])
    expect(issues({ groups: [...graph.groups, { id: 'g1', label: 'G1', kind: 'k', parent: 'g2' }, { id: 'g2', label: 'G2', kind: 'k', parent: 'g1' }] }))
      .toEqual(['group g1 is its own ancestor', 'group g2 is its own ancestor'])
  })

  test('a node binds what it shows: flow, loading, level, conducting, available, running or a value', () => {
    for (const role of ['flow', 'loading', 'level', 'conducting', 'available', 'running', 'position', 'value']) {
      expect(topologyGraphSchema.safeParse({ ...graph, nodes: [node('pump', { bindings: [{ role, ref: 'unit-2#P-RUN' }] }), node('sg')] }).success).toBe(true)
    }
    expect(topologyGraphSchema.safeParse({ ...graph, nodes: [node('pump', { bindings: [{ role: 'colour', ref: 'unit-2#P-RUN' }] }), node('sg')] }).success).toBe(false)
  })

  test('a graph may declare its overview: nodes and the edges among them, each one it has', () => {
    expect(topologyGraphSchema.parse({ ...graph, overview: { nodes: ['pump', 'sg'], edges: ['e1'] } }).overview?.edges).toEqual(['e1'])
    const issues = (overview: unknown) => topologyGraphSchema.safeParse({ ...graph, overview }).error?.issues.map(issue => issue.message)
    expect(issues({ nodes: ['pump', 'tank'], edges: [] })).toEqual(['the overview names unknown node tank'])
    expect(issues({ nodes: ['pump'], edges: ['e1'] })).toEqual(['the overview edge e1 ends outside the overview\'s nodes'])
    expect(issues({ nodes: [], edges: [] })).toHaveLength(1)
  })

  test('bindings read only the graph\'s own object', () => {
    const foreign = node('pump', { bindings: [{ role: 'flow', ref: 'unit-3#FW-FLOW' }] })
    expect(topologyGraphSchema.safeParse({ ...graph, nodes: [foreign, node('sg')] }).error?.issues[0]?.message).toBe('pump binds unit-3#FW-FLOW of another object')
  })

  test('the topology Capability answers a graph or unchanged', () => {
    expect(observationShapes.topology.output.safeParse({ objectId: 'unit-2', revision: 'digest-1', unchanged: true }).success).toBe(true)
    expect(observationShapes.topology.output.safeParse({ ...graph, family: 'tree' }).success).toBe(false)
  })
})
