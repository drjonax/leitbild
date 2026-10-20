import { describe, expect, test } from 'bun:test'
import { cardItemSchema, displayCardSchema } from '../src/core/observation/card.ts'
import { defineObservationCapability, observationDeclarationSchema, observationShapes } from '../src/core/observation/capabilities.ts'
import { observableSchema, observationSchema, quantitySchema, quantityUnits, stampSchema, thresholdSchema } from '../src/core/observation/model.ts'
import {
  dashboardSchema, dashboardsFileSchema, displaySpecSchema, sectionSchema, selectorSchema, viewSchema,
} from '../src/core/observation/spec.ts'
import { topologyGraphSchema } from '../src/core/observation/topology.ts'

const at = { at: '2026-10-20T08:00:00.000Z', clock: 'simulation' } as const
const threshold = { id: 'lo-lo', direction: 'low', value: 20, order: 2, effect: 'trip', priority: 'alarm' } as const
const observable = {
  ref: 'unit-2#SG-A-NR-LVL', label: 'Unit 2 SG A narrow-range level', quantity: 'level', unit: '%', valueType: 'number',
  series: { seriesId: 's-1', intervalMs: 1000 },
} as const
const spec = { title: 'SG A level', question: 'Is SG A level recovering?', subjects: ['unit-2#SG-A-NR-LVL'], views: [{ kind: 'trend', signals: ['unit-2#SG-A-NR-LVL'] }] }
const section = { id: 's1', by: 'agent', source: { spec }, composedAt: { ...at, mode: 'Mode 1' } }

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
})

describe('vignette and dashboard spec', () => {
  test('a values view lists a live collection that excludes closed objects unless asked', () => {
    const view = viewSchema.parse({ kind: 'values', of: { category: 'incident', status: ['open'] }, columns: ['priority', 'age'], count: { by: 'priority' } })
    expect(view.kind === 'values' && view.of?.closed).toBe(false)
    expect(selectorSchema.safeParse({ near: 'ambulance-1', within: '5km' }).success).toBe(false)
    expect(selectorSchema.safeParse({ class: 'line', within: '7km' }).success).toBe(false)
  })

  test('events default to the last 30 minutes and alerts to related ones', () => {
    expect(viewSchema.parse({ kind: 'events' })).toEqual({ kind: 'events', since: '30m' })
    expect(viewSchema.parse({ kind: 'alerts' })).toEqual({ kind: 'alerts', scope: 'related' })
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
  })

  test('dashboard sections are stored by value, never as templates', () => {
    expect(sectionSchema.parse(section).composedAt?.mode).toBe('Mode 1')
    expect(sectionSchema.parse({ id: 's2', by: 'world', source: { default: 'unit-2' } }).by).toBe('world')
    expect(sectionSchema.safeParse({ id: 's3', by: 'person', source: { template: 'plant-overview' } }).success).toBe(false)
  })

  test('a dashboard holds at most eight uniquely named sections', () => {
    expect(dashboardSchema.parse({ scope: 'run', revision: 3, sections: [section] }).revision).toBe(3)
    expect(dashboardSchema.safeParse({ scope: 'run', revision: 3, sections: [section, section] }).success).toBe(false)
    expect(dashboardSchema.safeParse({ scope: { subject: 'unit-2' }, revision: 0, sections: Array.from({ length: 9 }, (_, index) => ({ ...section, id: `s${index}` })) }).success).toBe(false)
  })

  test('the stored file keeps revision ids and at most twenty removed sections by value', () => {
    const removed = Array.from({ length: 20 }, (_, index) => ({ revision: index + 1, section: { ...section, id: `r${index}` } }))
    const entry = {
      dashboard: { scope: { of: { category: 'incident' } }, revision: 21, sections: [section] },
      revisions: [{ revision: 21, by: { actor: 'person', id: 'p1' }, at: { ...at, clock: 'wall' }, added: ['s1'], removed: ['r19'] }],
      removed,
    }
    expect(dashboardsFileSchema.parse({ dashboards: [entry] }).dashboards[0]?.removed).toHaveLength(20)
    expect(dashboardsFileSchema.safeParse({ dashboards: [{ ...entry, removed: [...removed, removed[0]] }] }).success).toBe(false)
  })
})

describe('card', () => {
  const item = { key: 'k3', label: 'SG A NR level', reading: '31.5 % falling', unit: '%', numbers: [{ value: 31.5, decimals: 1 }], subject: { ref: observable.ref } }

  test('items are keyed for citation and carry their numbers', () => {
    expect(cardItemSchema.parse(item).key).toBe('k3')
    expect(cardItemSchema.safeParse({ ...item, key: 'x3' }).success).toBe(false)
    expect(cardItemSchema.safeParse({ ...item, numbers: Array.from({ length: 9 }, () => ({ value: 1, decimals: 0 })) }).success).toBe(false)
  })

  test('items reserve entity rows, events and map features', () => {
    expect(cardItemSchema.safeParse({ ...item, subject: { objectId: 'incident-7' } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { eventId: 'e-9', at } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { featureId: 'line-420', attribution: '© OpenStreetMap contributors' } }).success).toBe(true)
    expect(cardItemSchema.safeParse({ ...item, subject: { lon: 11.3 } }).success).toBe(false)
  })

  test('a card holds at most 48 unique items and eight adjustments', () => {
    const card = { at, items: [item], more: 0, adjusted: [{ kind: 'scope', text: 'Reach narrowed to 2 links', lost: 'aux feed', alternatives: ['feed-to-sg'] }] }
    expect(displayCardSchema.parse(card).items).toHaveLength(1)
    expect(displayCardSchema.safeParse({ ...card, items: [item, item] }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, items: Array.from({ length: 49 }, (_, index) => ({ ...item, key: `k${index}` })) }).success).toBe(false)
    expect(displayCardSchema.safeParse({ ...card, adjusted: [{ kind: 'layout', text: 'x', alternatives: ['y'] }] }).success).toBe(false)
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
  const port = (id: string, medium = 'water') => ({ id, rank: id, medium, direction: 'both' as const })
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

  test('a consistent graph validates', () => {
    expect(topologyGraphSchema.parse(graph).nodes).toHaveLength(2)
  })

  test('every reference resolves and media agree along an edge', () => {
    const issues = (change: Record<string, unknown>) => topologyGraphSchema.safeParse({ ...graph, ...change }).error?.issues.map(issue => issue.message)
    expect(issues({ nodes: [...graph.nodes, node('pump')] })).toEqual(['duplicate node id'])
    expect(issues({ nodes: [node('pump', { group: 'loop-z' }), node('sg')] })).toEqual(['node pump has unknown group loop-z'])
    const steam = { id: 'steam', label: 'Steam', kind: 'steam' }
    expect(issues({ media: [...graph.media, steam], nodes: [node('pump', { ports: [port('a'), port('b', 'steam')] }), node('sg')] }))
      .toEqual(['edge e1 carries water into port pump.b of steam'])
    expect(issues({ edges: [{ ...graph.edges[0], to: { node: 'sg', port: 'z' } }] })).toEqual(['edge e1 ends at unknown port sg.z'])
    expect(issues({ boundaries: [{ node: 'sg', port: 'z', externalPortId: 'steam-out' }] })).toEqual(['boundary steam-out names unknown port sg.z'])
    expect(issues({ groups: [...graph.groups, { id: 'g1', label: 'G1', kind: 'k', parent: 'g2' }, { id: 'g2', label: 'G2', kind: 'k', parent: 'g1' }] }))
      .toEqual(['group g1 is its own ancestor', 'group g2 is its own ancestor'])
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
