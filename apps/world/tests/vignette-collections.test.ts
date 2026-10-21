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
import { distanceText, entityCell, mapCaption } from '../src/ui/embed/vignette/collection.ts'
import { VIGNETTE_ROW_PX } from '../src/ui/embed/vignette/grid.ts'
import type { EntityRow, VignetteSection } from '../src/ui/embed/vignette/model.ts'
import { CHAR_PX, fitName, gappedPath, networkDrawing } from '../src/ui/embed/vignette/network.ts'

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

  test('the map section says what it frames and how many have no position', () => {
    expect(mapCaption({ positioned: 3, missing: 1, within: '5 km', around: 'Halden', bounds: [[11, 59], [11.5, 59.2]] })).toBe('3 with a position within 5 km of Halden · 1 without')
    expect(mapCaption({ positioned: 0, missing: 2, bounds: null })).toBe('0 with a position · 2 without')
    expect(mapCaption(undefined)).toBe('Reading positions…')
  })
})

describe('network drawing', () => {
  test('an edge breaks around each gap on its segments, and only there', () => {
    expect(gappedPath([[0, 0], [100, 0], [100, 50]], [[40, 0], [100, 30]])).toBe('M0 0 L36 0 M44 0 L100 0 L100 26 M100 34 L100 50')
    expect(gappedPath([[0, 0], [100, 0]], [[50, 10]])).toBe('M0 0 L100 0')
  })

  test('a name keeps the whole characters that fit its room', () => {
    expect(fitName('Halden 420 kV', 13 * CHAR_PX)).toBe('Halden 420 kV')
    expect(fitName('Halden 420 kV', 8 * CHAR_PX)).toBe('Halden …')
  })

  const grid = (() => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:halden-four-unit', model: { ref: 'electric-grid.halden.four-unit' }, operatingPoint: { ref: 'electric-grid.norway.winter-weekday-peak' }, automation: { ref: 'electric-grid.frequency.nordic-2025' },
    }))
    const instance = createGridRuntimeInstance({ definition, at: '2026-01-15T17:00:00.000Z' as never })
    advanceGrid(instance, 0, '2026-01-15T17:00:00.000Z' as never)
    return instance
  })()
  /** A name takes its characters at CHAR_PX plus a margin, in whole grid units; a box two units high holds the name and a reading. */
  const width = (name: string): number => Math.max(2, Math.ceil((name.length * CHAR_PX + 6) / VIGNETTE_ROW_PX))
  const sizing: NetworkSizing = {
    key: 'vignette', node: node => ({ width: width(node.shortLabel ?? node.label), height: 2 }),
    stop: stop => ({ width: width(stop.others.map(other => other.node).join(', ').slice(0, 24)), height: 1 }), spacing: 1, groupLabel: 1,
  }

  for (const hops of [1, 2]) {
    test(`T32 on the Halden ${hops}-hop view: the layout has ≤ 2 crossings and no overlapping boxes; every drawn name is whole`, async () => {
      const graph: TopologyGraph = topologyGraphSchema.parse(gridTopology(grid))
      const scoped = scopeTopology(graph, { around: ['bus:curated-halden-pwr-switchyard@420'], media: graph.media.filter(medium => (medium.level?.value ?? 0) >= 300).map(medium => medium.id), reach: 2 * hops })
      if (!scoped.ok) throw new Error(scoped.refusal.code)
      const layout = await networkLayout(scoped.scoped, sizing)
      const nodes = new Map(graph.nodes.map(node => [node.id, node]))
      const section: Extract<VignetteSection, { kind: 'topology' }> = {
        kind: 'topology', rows: layout.height + 1, family: 'network', layout,
        nodes: [
          ...scoped.scoped.nodes.map(id => { const node = nodes.get(id)!; return { id, class: node.class, label: node.label, ...(node.shortLabel === undefined ? {} : { shortLabel: node.shortLabel }), bindings: node.bindings.map(binding => ({ ...binding, unit: binding.role === 'flow' ? 'MW' : binding.role === 'loading' ? '%' : '' })) } }),
          ...scoped.scoped.stubs.map((stop, at) => ({ id: `s${at}`, class: 'stop' as const, label: stop.others.map(other => other.node).join(', ').slice(0, 24), bindings: [] })),
        ],
        edges: [], groups: graph.groups.map(group => ({ id: group.id, label: group.label })), ...(graph.attribution === undefined ? {} : { attribution: graph.attribution }),
      }
      const flowRef = section.nodes.flatMap(node => node.bindings).find(binding => binding.role === 'flow')!.ref
      const observations: Observation[] = [{ ref: flowRef, at: '2026-01-15T17:00:00.000Z', clock: 'simulation', value: 512.4, quality: 'good', priority: 'warning' }]
      const drawing = networkDrawing(section, observations)
      expect(layout.crossings).toBeLessThanOrEqual(2)
      expect(drawing.nodes.filter(node => node.name !== (section.nodes.find(entry => entry.id === node.id)!.shortLabel ?? section.nodes.find(entry => entry.id === node.id)!.label)).map(node => node.id)).toEqual([])
      const boxes = drawing.nodes.filter(node => node.shape !== 'stop')
      const overlapping = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map(b => `${a.id} × ${b.id}`))
      expect(overlapping).toEqual([])
      expect(drawing.height).toBe(layout.height * VIGNETTE_ROW_PX)
      const bound = drawing.nodes.find(node => node.reading === '512 MW')!
      expect(bound.tone).toBe('warning')
    })
  }
})
