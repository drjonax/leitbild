import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGridNorwayDataset } from '../src/packs/electric-grid/datasets/grid-norway.ts'
import { compileGridReferenceGraph } from '../src/packs/electric-grid/reference-graph.ts'
import { gridReferenceFeatureSchema, type GridReferenceFeatureProperties } from '../src/packs/electric-grid/schemas/grid-reference.ts'
import {
  assertOsmPbfPin,
  extractOsmPower,
  inspectOsmPbf,
  osmPbfPowerSource,
  type OsmPowerExtraction,
} from '../src/packs/electric-grid/sources/osm-pbf-power.ts'
import { parseFrequency, parseOutputMw, parseVoltage, systemsFor } from '../src/packs/electric-grid/sources/osm-power-normalization.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'
import { buildDataset } from '../src/reference-data/pipeline.ts'
import type { NormalizedFeature } from '../src/reference-data/types.ts'
import { encodeOsmPbf, writeOsmPbfFixture, type FixtureOsm } from './helpers/osm-pbf-fixture.ts'

const replicationTimestamp = new Date('2026-10-08T20:21:06Z')

// Hand-made network: two 420 kV stations joined by a line whose fjord span is three single-phase ways,
// plus the tagging cases the normaliser must interpret.
const fixture: FixtureOsm = {
  replicationTimestamp,
  nodes: [
    { id: 1, lon: 4.999, lat: 59.999 }, { id: 2, lon: 5.001, lat: 59.999 },
    { id: 3, lon: 5.001, lat: 60.001 }, { id: 4, lon: 4.999, lat: 60.001 },
    { id: 5, lon: 5.199, lat: 59.999 }, { id: 6, lon: 5.201, lat: 59.999 },
    { id: 7, lon: 5.201, lat: 60.001 }, { id: 8, lon: 5.199, lat: 60.001 },
    { id: 10, lon: 5.0005, lat: 60.0, tags: { power: 'portal' } },
    { id: 11, lon: 5.05, lat: 60.0, tags: { power: 'tower' } },
    { id: 12, lon: 5.15, lat: 60.0, tags: { power: 'tower' } },
    { id: 13, lon: 5.1995, lat: 60.0, tags: { power: 'portal' } },
    { id: 14, lon: 4.9995, lat: 60.0005 }, { id: 15, lon: 5.0005, lat: 60.0005 },
    { id: 16, lon: 5.1, lat: 60.001 }, { id: 17, lon: 5.1, lat: 60.0 }, { id: 18, lon: 5.1, lat: 59.999 },
    { id: 20, lon: 10.7, lat: 59.93, tags: { power: 'substation', substation: 'traction', voltage: '11000;750', name: 'Majorstuen likeretter' } },
    { id: 21, lon: 10.71, lat: 59.93, tags: { power: 'substation', voltage: '750', name: 'Vorset' } },
    { id: 22, lon: 10.72, lat: 59.93, tags: { power: 'substation', voltage: '132000;750', name: 'Grefsen' } },
    { id: 23, lon: 5.73, lat: 58.86, tags: { power: 'substation', substation: 'transmission', name: 'Stølaheia' } },
    { id: 24, lon: 5.74, lat: 58.86, tags: { power: 'substation', substation: 'minor_distribution' } },
    ...[30, 31, 32].map((id, index) => ({
      id,
      lon: 6.0 + index * 0.01,
      lat: 58.5 + index * 0.005,
      tags: {
        power: 'generator',
        'generator:source': 'wind',
        'generator:method': 'wind_turbine',
        'generator:output:electricity': '3.6 MW',
        voltage: '690;22000',
      },
    })),
    { id: 40, lon: 5.3, lat: 60.1, tags: { power: 'portal' } },
    { id: 41, lon: 6.5, lat: 61.0 }, { id: 42, lon: 6.6, lat: 61.1 },
    { id: 43, lon: 6.7, lat: 61.0 }, { id: 44, lon: 6.8, lat: 61.1 },
    { id: 45, lon: 6.9, lat: 61.0 }, { id: 46, lon: 7.0, lat: 61.1 },
    { id: 47, lon: 6.6, lat: 58.0 }, { id: 48, lon: 5.0, lat: 56.0 },
    { id: 49, lon: 10.0, lat: 60.0 }, { id: 50, lon: 10.1, lat: 60.1 },
    { id: 51, lon: 9.0, lat: 60.0 }, { id: 52, lon: 9.1, lat: 60.1 },
    { id: 53, lon: 6.62, lat: 58.27, tags: { power: 'substation', substation: 'converter', frequency: '0;50', voltage: '500000;300000', name: 'Feda' } },
    { id: 60, lon: 7.0, lat: 61.0 }, { id: 61, lon: 7.01, lat: 61.0 },
    { id: 62, lon: 7.01, lat: 61.01 }, { id: 63, lon: 7.0, lat: 61.01 },
  ],
  ways: [
    { id: 100, refs: [1, 2, 3, 4, 1], tags: { power: 'substation', voltage: '420000;132000', name: 'A' } },
    { id: 101, refs: [5, 6, 7, 8, 5], tags: { power: 'substation', voltage: '420000', name: 'B' } },
    { id: 102, refs: [60, 61, 62] },
    { id: 103, refs: [62, 63, 60] },
    { id: 200, refs: [10, 11], tags: { power: 'line', voltage: '420000', name: 'A - B', circuits: '1', cables: '3', operator: 'Statnett' } },
    { id: 201, refs: [11, 16, 12], tags: { power: 'line', voltage: '420000', name: 'A - B', cables: '1' } },
    { id: 202, refs: [11, 17, 12], tags: { power: 'line', voltage: '420000', name: 'A - B', cables: '1' } },
    { id: 203, refs: [11, 18, 12], tags: { power: 'line', voltage: '420000', name: 'A - B', cables: '1' } },
    { id: 204, refs: [12, 13], tags: { power: 'line', voltage: '420000', name: 'A - B', cables: '3' } },
    { id: 300, refs: [14, 15], tags: { power: 'line', line: 'busbar', voltage: '420000' } },
    { id: 301, refs: [14, 10], tags: { power: 'bay', voltage: '420000' } },
    { id: 302, refs: [15, 10], tags: { power: 'cable', line: 'bay', voltage: '420000', location: 'underground' } },
    { id: 400, refs: [41, 42], tags: { power: 'line', name: 'Hove - Sogndal' } },
    { id: 401, refs: [43, 44], tags: { power: 'line', voltage: '420000', construction: 'yes' } },
    { id: 402, refs: [45, 46], tags: { power: 'construction', construction: 'line', voltage: '132000' } },
    { id: 403, refs: [43, 46], tags: { 'disused:power': 'line', voltage: '132000' } },
    { id: 500, refs: [47, 48], tags: { power: 'cable', voltage: '450000', frequency: '0', name: 'NorNed', location: 'underwater' } },
    { id: 501, refs: [49, 50], tags: { power: 'line', voltage: '132000', frequency: '16.7', operator: 'Bane NOR' } },
    { id: 600, refs: [51, 52], tags: { power: 'line', voltage: '22000' } },
    { id: 700, refs: [41, 9999], tags: { power: 'line', voltage: '132000' } },
  ],
  relations: [
    {
      id: 900,
      members: [30, 31, 32].map(ref => ({ type: 'node' as const, ref })),
      tags: {
        type: 'site',
        site: 'wind_farm',
        power: 'plant',
        'plant:source': 'wind',
        'plant:output:electricity': '208 MW',
        name: 'Testfjellet vindkraftverk',
      },
    },
    {
      id: 901,
      members: [200, 201, 202, 203, 204].map(ref => ({ type: 'way' as const, ref })),
      tags: { type: 'route', route: 'power', voltage: '420000', circuits: '1', name: 'A - B' },
    },
    {
      id: 902,
      members: [{ type: 'way', ref: 102, role: 'outer' }, { type: 'way', ref: 103, role: 'outer' }],
      tags: { type: 'multipolygon', power: 'substation', voltage: '132000', name: 'C' },
    },
  ],
}

const source = 'osm:pbf-power:test'
let directory = ''
let fixturePath = ''
let extraction: OsmPowerExtraction

const byId = (externalId: string): { readonly feature: NormalizedFeature; readonly properties: GridReferenceFeatureProperties } => {
  const feature = extraction.features.find(candidate => candidate.properties.externalId === externalId)
  if (!feature) throw new Error(`fixture feature ${externalId} was not emitted`)
  return { feature, properties: gridReferenceFeatureSchema.parse(feature.properties) }
}

const emittedIds = (): ReadonlyArray<string> =>
  extraction.features.map(feature => String(feature.properties.externalId))

const positionsOf = (feature: NormalizedFeature): ReadonlyArray<readonly number[]> => {
  const geometry = feature.geometry
  if (geometry.type === 'Point') return [geometry.coordinates]
  if (geometry.type === 'LineString') return geometry.coordinates
  if (geometry.type === 'Polygon') return geometry.coordinates.flat()
  return geometry.coordinates.flat(2)
}

const fixtureNodePosition = (id: number): readonly [number, number] => {
  const node = fixture.nodes.find(candidate => candidate.id === id)
  if (!node) throw new Error(`fixture node ${id} missing`)
  return [node.lon, node.lat]
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'leitbild-osm-pbf-'))
  fixturePath = join(directory, 'fixture.osm.pbf')
  await writeOsmPbfFixture(fixturePath, fixture)
  extraction = await extractOsmPower(fixturePath, source)
})

describe('OSM power tag interpretation', () => {
  test('reads voltage in volts and never reinterprets values below 1000 V as kV', () => {
    expect(parseVoltage('420000;132000')).toEqual({ kv: [420, 132], belowThresholdV: [], unparsed: [] })
    expect(parseVoltage('11000;750')).toEqual({ kv: [11], belowThresholdV: [750], unparsed: [] })
    expect(parseVoltage('690;22000')).toEqual({ kv: [22], belowThresholdV: [690], unparsed: [] })
    expect(parseVoltage('400')).toEqual({ kv: [], belowThresholdV: [400], unparsed: [] })
    expect(parseVoltage('132000,22000')).toEqual({ kv: [132, 22], belowThresholdV: [], unparsed: [] })
    expect(parseVoltage('66000?;medium')).toEqual({ kv: [], belowThresholdV: [], unparsed: ['66000?', 'medium'] })
    expect(parseVoltage(undefined)).toEqual({ kv: [], belowThresholdV: [], unparsed: [] })
  })

  test('parses frequency with 0 allowed and classifies the electrical system', () => {
    expect(parseFrequency('0')).toEqual({ hz: [0], unparsed: [] })
    expect(parseFrequency('50;16,7;x')).toEqual({ hz: [50, 16.7], unparsed: ['x'] })
    expect(systemsFor([0], true)).toEqual({ systems: ['hvdc'], systemProvenance: 'observed' })
    expect(systemsFor([16.67], true)).toEqual({ systems: ['traction'], systemProvenance: 'observed' })
    expect(systemsFor([0, 50], true)).toEqual({ systems: ['ac50', 'hvdc'], systemProvenance: 'observed' })
    expect(systemsFor([50, 0], true)).toEqual({ systems: ['ac50', 'hvdc'], systemProvenance: 'observed' })
    expect(systemsFor([60], true)).toEqual({ systems: ['other'], systemProvenance: 'observed' })
    expect(systemsFor([], false)).toEqual({ systems: ['ac50'], systemProvenance: 'inferred' })
  })

  test('parses electrical output only when it carries a unit', () => {
    expect(parseOutputMw('73.6 MW')).toBeCloseTo(73.6)
    expect(parseOutputMw('2,3 MW')).toBeCloseTo(2.3)
    expect(parseOutputMw('1.2 GW')).toBeCloseTo(1200)
    expect(parseOutputMw('800 kW')).toBeCloseTo(0.8)
    expect(parseOutputMw('yes')).toBeNull()
    expect(parseOutputMw('120')).toBeNull()
  })
})

describe('OSM PBF power extraction', () => {
  test('every emitted feature satisfies the grid reference schema', () => {
    for (const feature of extraction.features) gridReferenceFeatureSchema.parse(feature.properties)
  })

  test('emits one feature per way of a phase-split fjord span with real ids and aligned node ids', () => {
    const spanIds = ['way/200', 'way/201', 'way/202', 'way/203', 'way/204']
    for (const id of spanIds) {
      const { feature, properties } = byId(id)
      expect(feature.geometry.type).toBe('LineString')
      expect(properties.category).toBe('line')
      expect(properties.voltageKv).toEqual([420])
      expect(properties.osmNodeIds).toHaveLength(positionsOf(feature).length)
      const nodeIds = properties.osmNodeIds ?? []
      nodeIds.forEach((nodeId, index) => {
        expect(positionsOf(feature)[index]).toEqual(fixtureNodePosition(Number(nodeId.slice('node/'.length))))
      })
    }
    expect(byId('way/201').properties.osmNodeIds).toEqual(['node/11', 'node/16', 'node/12'])
    expect(byId('way/202').properties.cables).toBe(1)
    expect(byId('way/200').properties).toMatchObject({ circuits: 1, cables: 3, operator: 'Statnett', name: 'A - B' })
    expect(emittedIds().filter(id => id.startsWith('merged'))).toEqual([])
  })

  test('drops sub-kV readings instead of inflating them: metro rectifier, LV station and 690 V turbines', () => {
    expect(emittedIds()).not.toContain('node/20')
    expect(emittedIds()).not.toContain('node/21')
    for (const turbine of ['node/30', 'node/31', 'node/32']) expect(emittedIds()).not.toContain(turbine)
    expect(byId('node/22').properties).toMatchObject({ voltageKv: [132], maxVoltageKv: 132, voltageBelowThresholdV: [750] })
    expect(extraction.features.every(feature => {
      const max = feature.properties.maxVoltageKv
      return max === null || (typeof max === 'number' && max >= 1)
    })).toBe(true)
    expect(extraction.ledger['excluded:substation:below-voltage-floor']).toBe(2)
    expect(extraction.ledger['excluded:generator:below-generation-floor']).toBe(3)
  })

  test('builds a type=site wind relation as a plant at its member centroid', () => {
    const { feature, properties } = byId('relation/900')
    expect(properties).toMatchObject({
      category: 'plant',
      plantSource: 'wind',
      outputMw: 208,
      geometrySource: 'osm-member-centroid',
      osmNodeIds: null,
      members: [{ id: 'node/30', role: '' }, { id: 'node/31', role: '' }, { id: 'node/32', role: '' }],
    })
    expect(feature.geometry.type).toBe('Point')
    const [lon, lat] = positionsOf(feature)[0]!
    expect(lon).toBeCloseTo(6.01, 6)
    expect(lat).toBeCloseTo(58.505, 6)
  })

  test('puts busbars and bays in their own category', () => {
    expect(byId('way/300').properties.category).toBe('busbar')
    expect(byId('way/301').properties.category).toBe('busbar')
    expect(byId('way/302').properties.category).toBe('busbar')
    expect(extraction.features.filter(feature => feature.properties.category === 'line').map(feature => feature.properties.externalId))
      .not.toContain('way/300')
  })

  test('keeps voltage-less substations except minor distribution kiosks', () => {
    expect(byId('node/23').properties).toMatchObject({ category: 'substation', voltageKv: [], propertyProvenance: 'unknown' })
    expect(emittedIds()).not.toContain('node/24')
    expect(extraction.ledger['excluded:substation:no-voltage-minor-distribution']).toBe(1)
  })

  test('keeps voltage-less lines for topology inference with unknown provenance', () => {
    expect(byId('way/400').properties).toMatchObject({
      category: 'line',
      voltageKv: [],
      maxVoltageKv: null,
      propertyProvenance: 'unknown',
      confidence: 'low',
      name: 'Hove - Sogndal',
    })
    expect(emittedIds()).not.toContain('way/600')
    expect(extraction.ledger['excluded:line:below-voltage-floor']).toBe(1)
  })

  test('carries lifecycle from construction and disused tagging', () => {
    expect(byId('way/401').properties).toMatchObject({ category: 'line', lifecycle: 'construction', power: 'line' })
    expect(byId('way/402').properties).toMatchObject({ category: 'line', lifecycle: 'construction', power: 'construction' })
    expect(byId('way/403').properties).toMatchObject({ category: 'line', lifecycle: 'disused', power: null })
    expect(byId('way/200').properties.lifecycle).toBe('operational')
  })

  test('classifies HVDC (frequency=0), converter stations and traction', () => {
    expect(byId('way/500').properties).toMatchObject({ category: 'cable', frequencyHz: [0], systems: ['hvdc'], systemProvenance: 'observed' })
    expect(byId('node/53').properties).toMatchObject({ frequencyHz: [0, 50], systems: ['ac50', 'hvdc'] })
    expect(byId('way/501').properties).toMatchObject({ frequencyHz: [16.7], systems: ['traction'] })
    expect(byId('way/200').properties).toMatchObject({ frequencyHz: [], systems: ['ac50'], systemProvenance: 'inferred' })
  })

  test('keeps substations as polygons and portals only where an included branch uses them', () => {
    const substation = byId('way/100')
    expect(substation.feature.geometry.type).toBe('Polygon')
    expect(substation.properties.osmNodeIds).toEqual(['node/1', 'node/2', 'node/3', 'node/4', 'node/1'])
    expect(byId('node/10').properties).toMatchObject({ category: 'portal', osmNodeIds: ['node/10'] })
    expect(byId('node/13').properties.category).toBe('portal')
    expect(emittedIds()).not.toContain('node/40')
    expect(emittedIds()).not.toContain('node/11')
    expect(extraction.ledger['excluded:portal:not-on-included-branch']).toBe(1)
  })

  test('assembles multipolygon substations by shared node ids', () => {
    const { feature, properties } = byId('relation/902')
    expect(feature.geometry.type).toBe('MultiPolygon')
    expect(properties.osmNodeIds).toEqual(['node/60', 'node/61', 'node/62', 'node/63', 'node/60'])
    expect(positionsOf(feature)).toHaveLength(5)
    expect(properties.members).toEqual([{ id: 'way/102', role: 'outer' }, { id: 'way/103', role: 'outer' }])
  })

  test('extracts route=power circuit relations with members, voltage and circuits', () => {
    expect(byId('relation/901').properties).toMatchObject({
      category: 'circuit',
      name: 'A - B',
      voltageKv: [420],
      circuits: 1,
      members: [200, 201, 202, 203, 204].map(ref => ({ id: `way/${ref}`, role: '' })),
    })
  })

  test('records ways with nodes outside the extract in the ledger instead of emitting partial geometry', () => {
    expect(emittedIds()).not.toContain('way/700')
    expect(extraction.ledger['excluded:line:missing-node-coordinates']).toBe(1)
  })

  test('the legacy reference graph still compiles from per-way features', () => {
    const graph = compileGridReferenceGraph(extraction.features, { maxEndpointDistanceKm: 2 })
    expect(graph.branches.find(branch => branch.externalId === 'way/200')).toMatchObject({ voltageKv: [420] })
    expect(graph.nodes.map(node => node.externalId)).toContain('way/100')
  })
})

describe('OSM PBF pinned input and source snapshot', () => {
  test('inspection reads the replication timestamp and hashes the file', async () => {
    const inspection = await inspectOsmPbf(fixturePath)
    const expected = new Bun.CryptoHasher('sha256').update(encodeOsmPbf(fixture)).digest('hex')
    expect(inspection.sha256).toBe(expected)
    expect(inspection.replicationTimestamp.toISOString()).toBe('2026-10-08T20:21:06.000Z')
    expect(inspection.header.replicationBaseUrl).toBe('https://download.geofabrik.de/europe/norway-updates')
  })

  test('a sha256 pin mismatch fails loudly', async () => {
    const inspection = await inspectOsmPbf(fixturePath)
    expect(() => assertOsmPbfPin(inspection, { kind: 'sha256', sha256: '0'.repeat(64) })).toThrow('pinned input expects')
    expect(() => assertOsmPbfPin(inspection, { kind: 'sha256', sha256: inspection.sha256 })).not.toThrow()
  })

  test('a max-age pin rejects an extract older than allowed', async () => {
    const inspection = await inspectOsmPbf(fixturePath)
    const now = () => new Date('2026-10-10T08:00:00Z')
    expect(() => assertOsmPbfPin(inspection, { kind: 'max-age', maxAgeDays: 7, now })).not.toThrow()
    expect(() => assertOsmPbfPin(inspection, { kind: 'max-age', maxAgeDays: 1, now })).toThrow('exceeding the 1-day maximum')
  })

  test('an extract without a replication timestamp cannot be used', async () => {
    const path = join(directory, 'undated.osm.pbf')
    await writeOsmPbfFixture(path, { ...fixture, replicationTimestamp: null })
    await expect(inspectOsmPbf(path)).rejects.toThrow('no osmosis_replication_timestamp')
    const undated = osmPbfPowerSource({ id: source, path, pin: { kind: 'max-age', maxAgeDays: 30, now: () => new Date() } })
    if (undated.kind !== 'local') throw new Error('expected a local source')
    await expect(undated.load(createFetchCache(join(directory, 'cache')))).rejects.toThrow('no osmosis_replication_timestamp')
  })

  test('the grid-norway pipeline build records the PBF snapshot in its manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leitbild-grid-norway-'))
    const sha256 = (await inspectOsmPbf(fixturePath)).sha256
    const dataset = createGridNorwayDataset({
      osmPbf: { path: fixturePath, pin: { kind: 'sha256', sha256 } },
      thresholds: { nodes: 1, branches: 1, maxUnresolvedEndpointFraction: 1 },
    })
    const outcome = await buildDataset(dataset, {
      referenceRoot: root,
      fetchCache: createFetchCache(join(root, 'sources')),
      skipTileBuild: true,
      now: () => new Date('2026-10-10T10:00:00Z'),
    })
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'grid-norway.manifest.json'), 'utf8')) as {
      readonly sources: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly snapshot: unknown }>
      readonly licences: ReadonlyArray<{ readonly id: string }>
    }
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'grid-norway.features.geojson'), 'utf8')) as {
      readonly features: ReadonlyArray<unknown>
    }
    expect(outcome.featureCount).toBe(extraction.features.length)
    expect(sidecar.features).toHaveLength(extraction.features.length)
    expect(manifest.sources).toEqual([{
      id: 'osm:pbf-power:NO',
      kind: 'local',
      snapshot: {
        origin: fixturePath,
        sha256,
        byteLength: encodeOsmPbf(fixture).byteLength,
        dataTimestamp: '2026-10-08T20:21:06.000Z',
      },
    }])
    expect(manifest.licences.map(licence => licence.id)).toEqual(['osm-odbl-1.0'])
  })
})
