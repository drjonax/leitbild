import { describe, expect, test } from 'bun:test'
import {
  continuationQuery,
  continuationSnapshotSchema,
  continueInterconnectors,
  type ContinuationSnapshot,
  type OverpassElement,
} from '../src/packs/electric-grid/model-build/interconnector-continuations.ts'

// A cable leaving the extract at node 1 (at sea), landing at a cable joint (transition station),
// running past a small distribution substation as an overhead line, and ending in a converter
// whose hall is mapped apart from its named site outline.
const way = (id: number, nodes: ReadonlyArray<readonly [number, number, number]>, tags: Record<string, string>): OverpassElement => ({
  type: 'way',
  id,
  nodes: nodes.map(node => node[0]),
  geometry: nodes.map(node => ({ lon: node[1], lat: node[2] })),
  tags,
})
const outline = (id: number, west: number, south: number, size: number, tags: Record<string, string>): OverpassElement => way(id, [
  [id * 10 + 1, west, south], [id * 10 + 2, west + size, south], [id * 10 + 3, west + size, south + size], [id * 10 + 4, west, south + size], [id * 10 + 1, west, south],
], tags)
const dc = { power: 'cable', voltage: '500000', frequency: '0' }
const elements: ReadonlyArray<OverpassElement> = [
  // The extract's own way, ending at node 1: never part of the continuation.
  way(100, [[9, 8.0, 58.0], [1, 8.5, 57.5]], dc),
  way(101, [[1, 8.5, 57.5], [2, 8.9, 57.15]], dc),
  way(102, [[2, 8.9, 57.15], [3, 9.0, 57.1]], { ...dc, power: 'line' }),
  way(103, [[3, 9.0, 57.1], [4, 9.3, 56.8], [5, 9.56, 56.48]], { ...dc, power: 'line' }),
  outline(20, 8.89, 57.14, 0.02, { power: 'substation', substation: 'transition', name: 'Cable joint' }),
  { type: 'node', id: 30, lon: 9.3005, lat: 56.8005, tags: { power: 'substation', substation: 'minor_distribution' } },
  outline(40, 9.555, 56.475, 0.01, { power: 'substation', substation: 'converter', voltage: '500000' }),
  outline(41, 9.561, 56.476, 0.01, { power: 'substation', substation: 'converter', voltage: '400000', name: 'Jævnstrømsstation Tjele' }),
]
const snapshot = (overrides: Partial<ContinuationSnapshot> = {}): ContinuationSnapshot => continuationSnapshotSchema.parse({
  kind: 'osm-overpass-interconnector-continuations',
  source: {
    id: 'osm:overpass-interconnector-continuations',
    endpoint: 'https://overpass-api.de/api/interpreter',
    query: 'test',
    snapshotAt: '2026-10-12T23:19:37Z',
    retrievedAt: '2026-10-13T08:00:00Z',
    licence: { id: 'osm-odbl-1.0', attribution: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.' },
  },
  systems: ['hvdc'],
  seeds: [{ interconnectorId: 'hvdc:test-link', system: 'hvdc', nodeId: 1, location: [8.5, 57.5], terminalName: 'Tjele' }],
  elements,
  ...overrides,
})

describe('Interconnector continuations beyond the extract', () => {
  test('follow the mapped ways from the free end past cable joints and distribution substations to the converter', () => {
    const [route] = continueInterconnectors({ snapshot: snapshot(), extractWayIds: new Set(['way/100']) })
    expect(route!.path).toEqual([[8.5, 57.5], [8.9, 57.15], [9.0, 57.1], [9.3, 56.8], [9.56, 56.48]])
    expect(route!.osmWayIds).toEqual(['way/101', 'way/102', 'way/103'])
    // The unnamed converter hall takes its site's name, which the interconnector table names.
    expect(route!.station).toMatchObject({ osmId: 'way/40', name: 'Jævnstrømsstation Tjele', namedInTable: true })
  })

  test('end at the station abroad that a way of the extract already reaches', () => {
    const [route] = continueInterconnectors({
      snapshot: snapshot({ seeds: [{ interconnectorId: 'hvdc:test-link', system: 'hvdc', nodeId: 5, location: [9.56, 56.48], terminalName: 'Tjele' }] }),
      extractWayIds: new Set(['way/100', 'way/101', 'way/102', 'way/103']),
    })
    expect(route!.path).toEqual([[9.56, 56.48]])
    expect(route!.station.osmId).toBe('way/40')
  })

  test('never guess an end: a free end without a continuation, or ways that reach no station, are errors', () => {
    expect(() => continueInterconnectors({ snapshot: snapshot({ seeds: [{ interconnectorId: 'hvdc:test-link', system: 'hvdc', nodeId: 7, location: [7, 57], terminalName: 'Tjele' }] }), extractWayIds: new Set() }))
      .toThrow('hvdc:test-link: no mapped line or cable continues from its free end node/7 in the snapshot')
    expect(() => continueInterconnectors({ snapshot: snapshot({ elements: elements.filter(element => element.tags?.power !== 'substation' || element.type === 'node') }), extractWayIds: new Set(['way/100']) }))
      .toThrow('hvdc:test-link: its mapped ways beyond node/1 reach no substation in the snapshot')
  })

  test('query each system\'s free ends, the transmission lines and cables connected to them within reach, and the substations along them', () => {
    const query = continuationQuery([
      { interconnectorId: 'hvdc:b', system: 'hvdc', nodeId: 22, location: [8, 57], terminalName: 'B' },
      { interconnectorId: 'hvdc:a', system: 'hvdc', nodeId: 11, location: [8, 57], terminalName: 'A' },
    ])
    expect(query).toContain('node(id:11,22)->.hvdcSeeds;')
    expect(query).toContain('(around.hvdcSeeds:250000)')
    expect(query).toContain('["voltage"~"(^|;)(1[3-9][0-9]|[2-9][0-9][0-9])[0-9][0-9][0-9]($|;)"]')
    expect(query).not.toContain('acSeeds')
    expect(query).toContain('nwr(around.routeNodes:150)["power"="substation"]')
    expect(query.endsWith('out body geom qt;')).toBe(true)
  })
})
