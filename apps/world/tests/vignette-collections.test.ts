import { describe, expect, test } from 'bun:test'
import type { Observation } from '../src/core/observation/model.ts'
import { topologyGraphSchema, type TopologyGraph } from '../src/core/observation/topology.ts'
import { networkLayout, type NetworkSizing } from '../src/features/displays/topology/network.ts'
import { scopeTopology } from '../src/features/displays/topology/scope.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { gridTopology } from '../src/packs/electric-grid/observation/topology.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { entityCell, mapCaption, slotLook } from '../src/ui/embed/vignette/collection.ts'
import { distanceText } from '../src/ui/embed/vignette/format.ts'
import { VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import type { EntityRow, VignetteSection } from '../src/features/displays/compose/model.ts'
import { barLine, CHAR_PX, fitName, networkDrawing, stub } from '../src/ui/embed/vignette/network.ts'

// The vignette's objects and networks (architecture B2): entity cells, the map
// section's words, and the network drawing over the server's ELK layout on the
// Halden station views (T32: ≤ 2 crossings, 0 overlaps, every name whole).

describe('entity table and map focus', () => {
  const row: EntityRow = {
    objectId: 'unit-7', label: 'Unit 7', status: { word: 'en route', since: { at: '2026-10-21T10:04:05.000Z', clock: 'simulation' } }, urgency: 'P1',
    alert: { priority: null, severity: 'warning', message: 'Delayed' }, etaS: 250, distanceM: 4_280, ageS: 12,
  }

  test('status and urgency are words in a box; only the worst alert\'s own priority colours, and an undeclared one is said so', () => {
    expect(entityCell(row, 'status')).toEqual({ text: 'en route', boxed: true, tone: null, title: 'since 10:04:05' })
    expect(entityCell(row, 'urgency')).toEqual({ text: 'P1', boxed: true, tone: null })
    expect(entityCell(row, 'alert')).toEqual({ text: 'Delayed', boxed: false, tone: null, title: 'warning · priority not declared' })
    expect(entityCell({ ...row, alert: { priority: 'alarm', severity: 'critical', message: 'Lost contact' } }, 'alert').tone).toBe('alarm')
    expect([entityCell(row, 'eta').text, entityCell(row, 'distance').text, entityCell(row, 'age').text]).toEqual(['4 min', '4.28 km', '12 s ago'])
    expect(entityCell({ objectId: 'x', label: 'X' }, 'eta').text).toBe('—')
    expect([distanceText(640), distanceText(23_456)]).toEqual(['640 m', '23.5 km'])
  })

  test('slots write a duration and a distance in the units the card writes them in', () => {
    expect([slotLook({ key: 'eta', label: 'ETA', unit: 's' }, { value: 250 }), slotLook({ key: 'remaining', label: 'Remaining', unit: 'm' }, { value: 4_280 })].map(look => [look.text, look.unit, look.decimals]))
      .toEqual([['4', 'min', 0], ['4.28', 'km', 2]])
    expect(slotLook({ key: 'fuel', label: 'Fuel', unit: '%' }, { value: 41.24 })).toMatchObject({ text: '41.2', unit: '%', tone: null })
    expect(slotLook({ key: 'status', label: 'Status', unit: '' }, { value: 'en route' })).toMatchObject({ kind: 'state', text: 'en route' })
  })

  test('the map section says what it frames and how many have no position', () => {
    expect(mapCaption({ positioned: 3, missing: 1, within: '5 km', around: 'Halden', bounds: [[11, 59], [11.5, 59.2]], extentM: 4_200 })).toBe('3 with a position within 5 km of Halden · 1 without')
    expect(mapCaption({ positioned: 0, missing: 2, bounds: null, extentM: null })).toBe('0 with a position · 2 without')
    expect(mapCaption(undefined)).toBe('Reading positions…')
  })
})

describe('network drawing', () => {
  test('an edge end reaches a point inside its box straight in, then along', () => {
    const box = { x: 0, y: 0, width: 96, height: 72 }
    expect(stub([0, 24], [48, 24], box)).toEqual([[0, 24], [48, 24]])
    expect(stub([96, 40], [48, 24], box)).toEqual([[96, 40], [48, 40], [48, 24]])
    expect(stub([30, 0], [48, 24], box)).toEqual([[30, 0], [30, 24], [48, 24]])
  })

  test('a bus is a bar along the face its feeders meet, across between opposite faces, across its middle otherwise', () => {
    const box = { x: 0, y: 0, width: 168, height: 132 }
    expect(barLine(box, [[168, 24], [168, 120], [400, 50]])).toEqual({ x1: 168, y1: 0, x2: 168, y2: 132 })
    expect(barLine({ x: 0, y: 0, width: 192, height: 48 }, [[0, 30], [192, 30]])).toEqual({ x1: 0, y1: 30, x2: 192, y2: 30 })
    expect(barLine({ x: 0, y: 0, width: 96, height: 48 }, [[40, 0], [60, 0]])).toEqual({ x1: 0, y1: 0, x2: 96, y2: 0 })
    expect(barLine({ x: 0, y: 0, width: 48, height: 96 }, [])).toEqual({ x1: 24, y1: 0, x2: 24, y2: 96 })
  })

  test('a name keeps the whole characters that fit its room', () => {
    expect(fitName('Halden 420 kV', 13 * CHAR_PX)).toBe('Halden 420 kV')
    expect(fitName('Halden 420 kV', 8 * CHAR_PX)).toBe('Halden …')
  })

  test('each class is drawn by its OpenBridge element; a line element is a line; "on" only where declared (Q8); an open line is empty', () => {
    const states = [{ value: 'closed', label: 'closed', active: true as const }, { value: 'open', label: 'open' }]
    const node = (id: string, cls: VignetteSection & { kind: 'topology' } extends { nodes: ReadonlyArray<infer N> } ? N extends { class: infer C } ? C : never : never, x: number, bindings: ReadonlyArray<{ role: 'conducting' | 'flow'; ref: string; unit: string; states?: typeof states }> = []) =>
      ({ box: { id, x, y: 0, width: 4, height: 3, ports: {} }, node: { id, class: cls, label: `${id} name`, bindings } })
    const parts = [
      node('bus-1', 'bus', 0), node('tx-1', 'converter', 6, [{ role: 'conducting', ref: 'g#tx.state', unit: '', states }]),
      node('line-1', 'transfer', 12, [{ role: 'conducting', ref: 'g#line.state', unit: '', states }, { role: 'flow', ref: 'g#line.flow', unit: 'MW' }]),
      node('sw-1', 'switch', 18), node('s0', 'stop', 24),
    ]
    const section: Extract<VignetteSection, { kind: 'topology' }> = {
      kind: 'topology', rows: 4, objectId: 'g', family: 'network', nodes: parts.map(part => part.node), edges: [],
      layout: { family: 'network', unit: 'grid', width: 28, height: 3, crossings: 0, hash: 'h', nodes: parts.map(part => part.box),
        edges: [{ id: 'e1', points: [[4, 1], [6, 1]], gaps: [] }, { id: 'e2', points: [[10, 1], [12, 1]], gaps: [] }, { id: 'e3', points: [[16, 1], [24, 1]], gaps: [[20, 1]] }] },
    }
    const reading = (ref: string, value: Observation['value'], priority: Observation['priority'] = 'none'): Observation => ({ ref, at: '2026-01-15T17:00:00.000Z', clock: 'simulation', value, quality: 'good', priority })
    const drawing = networkDrawing(section, [reading('g#tx.state', 'closed'), reading('g#line.state', 'open'), reading('g#line.flow', 512.4, 'warning')])
    // A bus whose name does not fit its bar is an empty obc-bus with its name as text beside it.
    expect(drawing.buses.map(bus => [bus.id, bus.vertical, bus.label])).toEqual([['bus-1', true, '']])
    expect(drawing.texts.find(text => text.id === 'bus-1')?.name).toBe('bus-1 name')
    expect(drawing.devices.map(device => [device.element, device.on, device.x, device.y])).toEqual([['obc-transformer', true, 192, 24], ['obc-switch', false, 480, 24]])
    expect(drawing.texts.find(text => text.id === 'line-1')).toMatchObject({ name: 'line-1 name', reading: '512 MW', below: true, tone: 'warning' })
    // The open line, its edges and its own line through its box: OpenBridge's empty line; the gap on e3 splits it; the stop gets an end cap.
    expect([...new Set(drawing.segments.filter(segment => segment.connectionId.startsWith('line-1') || segment.connectionId === 'e2').map(segment => segment.value))]).toEqual(['empty'])
    expect(drawing.segments.filter(segment => segment.connectionId === 'e3' && segment.kind === 'straight')).toHaveLength(2)
    expect(drawing.segments.filter(segment => segment.kind === 'endpoint').map(segment => segment.connectionId)).toEqual(['e3:end'])
  })

  const grid = (() => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
    }))
    const instance = createGridRuntimeInstance({ definition, at: '2026-01-15T17:00:00.000Z' as never })
    advanceGrid(instance, 0, '2026-01-15T17:00:00.000Z' as never)
    return instance
  })()
  /** A name takes its characters at CHAR_PX plus a margin, in whole grid units; a device box is its 2-unit symbol over a row of text. */
  const width = (name: string): number => Math.max(2, Math.ceil((name.length * CHAR_PX + 6) / VIGNETTE_ROW_PX))
  const sizing: NetworkSizing = {
    key: 'vignette',
    node: node => ({ width: width(node.shortLabel ?? node.label), height: node.class === 'switch' || node.class === 'converter' || node.class === 'source' ? 3 : 2 }),
    stop: stop => ({ width: width(stop.others.map(other => other.node).join(', ').slice(0, 24)), height: 1 }), spacing: 1,
  }

  for (const hops of [1, 2]) {
    test(`T32 on the Halden ${hops}-hop view: the layout has ≤ 2 crossings and no overlapping boxes; every drawn name is whole`, async () => {
      const graph: TopologyGraph = topologyGraphSchema.parse(gridTopology(grid))
      const scoped = scopeTopology(graph, { around: ['bus:curated-halden-pwr-switchyard@420'], media: graph.media.filter(medium => (medium.level?.value ?? 0) >= 300).map(medium => medium.id), reach: 2 * hops })
      if (!scoped.ok) throw new Error(scoped.refusal.code)
      const layout = await networkLayout(scoped.scoped, sizing)
      const nodes = new Map(graph.nodes.map(node => [node.id, node]))
      const section: Extract<VignetteSection, { kind: 'topology' }> = {
        kind: 'topology', rows: layout.height + 1, objectId: graph.objectId, family: 'network', layout,
        nodes: [
          ...scoped.scoped.nodes.map(id => { const node = nodes.get(id)!; return { id, class: node.class, label: node.label, ...(node.shortLabel === undefined ? {} : { shortLabel: node.shortLabel }), bindings: node.bindings.map(binding => ({ ...binding, unit: binding.role === 'flow' ? 'MW' : binding.role === 'loading' ? '%' : '' })) } }),
          ...scoped.scoped.stubs.map((stop, at) => ({ id: `s${at}`, class: 'stop' as const, label: stop.others.map(other => other.node).join(', ').slice(0, 24), bindings: [] })),
        ],
        edges: [], ...(graph.attribution === undefined ? {} : { attribution: graph.attribution }),
      }
      const flowRef = section.nodes.flatMap(node => node.bindings).find(binding => binding.role === 'flow')!.ref
      const observations: Observation[] = [{ ref: flowRef, at: '2026-01-15T17:00:00.000Z', clock: 'simulation', value: 512.4, quality: 'good', priority: 'warning' }]
      const drawing = networkDrawing(section, observations)
      expect(layout.crossings).toBeLessThanOrEqual(2)
      const named = new Map(section.nodes.map(node => [node.id, node.shortLabel ?? node.label]))
      expect(drawing.texts.filter(text => text.reading === null && text.name !== named.get(text.id)).map(text => text.id)).toEqual([])
      expect(drawing.buses.filter(bus => bus.label === '' && !drawing.texts.some(text => text.id === bus.id)).map(bus => bus.id)).toEqual([])
      const boxes = layout.nodes.filter(box => !box.id.startsWith('s'))
      const overlapping = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map(b => `${a.id} × ${b.id}`))
      expect(overlapping).toEqual([])
      expect(drawing.height).toBe(layout.height * VIGNETTE_ROW_PX)
      expect(drawing.texts.find(text => text.reading === '512 MW')!.tone).toBe('warning')
      expect(drawing.segments.length).toBeGreaterThan(layout.edges.length)
    })
  }
})
