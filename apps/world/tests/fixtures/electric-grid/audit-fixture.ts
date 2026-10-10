// A small, fully valid grid for the audit tests: a 420 kV ring A–B–C–(junction J)–D with a double
// A–B corridor, a radial 420 kV station Q teed off J, a 300 kV plant P behind a C transformer, a
// 132 kV station E behind an A transformer, an SE3 AC boundary at A and a DK1 HVDC link at B.
// Every check passes on the unmodified fixture; tests change one thing at a time.
import type { AuditBranch, AuditBus, AuditFootprint, AuditGraph, LonLat } from '../../../src/packs/electric-grid/audit/audit-graph.ts'
import type { NveLine } from '../../../src/packs/electric-grid/audit/nve-coverage.ts'
import type { GridCurationCollection } from '../../../src/packs/electric-grid/schemas/grid-curation.ts'
import { gridCurationCollectionSchema } from '../../../src/packs/electric-grid/schemas/grid-curation.ts'
import { gridGoldenSchema, type GridGolden } from '../../../src/packs/electric-grid/schemas/grid-golden.ts'
import { haversineKm } from '../../../src/packs/electric-grid/audit/geodesy.ts'

const square = (location: LonLat, half = 0.002): AuditFootprint => ({
  kind: 'polygon',
  polygons: [[[
    [location[0] - half, location[1] - half],
    [location[0] + half, location[1] - half],
    [location[0] + half, location[1] + half],
    [location[0] - half, location[1] + half],
    [location[0] - half, location[1] - half],
  ]]],
})

const station = (id: string, osmId: string, kv: number, location: LonLat, kind: AuditBus['kind'] = 'substation'): AuditBus => ({
  id, label: id, kind, nominalKv: kv, location, substationId: osmId, priceArea: 'NO1', curationIds: [], footprint: square(location),
})

export const fixtureLocations = {
  a: [10.0, 60.0], b: [10.5, 60.0], c: [10.5, 60.5], d: [10.0, 60.5], j: [10.25, 60.5],
  q: [10.25, 60.7], p: [10.52, 60.52], e: [10.1, 60.1], se3: [9.8, 59.9], dk1: [10.5, 59.5],
} as const satisfies Record<string, LonLat>

const buses: ReadonlyArray<AuditBus> = [
  station('bus:a@420', 'way/101', 420, fixtureLocations.a),
  station('bus:a@132', 'way/101', 132, fixtureLocations.a),
  station('bus:b@420', 'way/102', 420, fixtureLocations.b),
  station('bus:c@420', 'way/103', 420, fixtureLocations.c),
  station('bus:c@300', 'way/103', 300, fixtureLocations.c),
  station('bus:d@420', 'way/104', 420, fixtureLocations.d),
  station('bus:p@300', 'way/105', 300, fixtureLocations.p, 'plant-terminal'),
  station('bus:e@132', 'way/106', 132, fixtureLocations.e),
  station('bus:q@420', 'way/107', 420, fixtureLocations.q),
  { id: 'bus:junction-j@420', label: 'J', kind: 'junction', nominalKv: 420, location: fixtureLocations.j, curationIds: [], footprint: { kind: 'point', location: fixtureLocations.j } },
  { id: 'bus:boundary-SE3', label: 'SE3', kind: 'boundary', nominalKv: 420, location: fixtureLocations.se3, externalArea: 'SE3', curationIds: ['fixture-se3-boundary'] },
  { id: 'bus:boundary-DK1', label: 'DK1', kind: 'boundary', nominalKv: 500, location: fixtureLocations.dk1, externalArea: 'DK1', curationIds: [] },
]

const busLocation = new Map(buses.map(bus => [bus.id, bus.location]))

let nextWay = 200
export const fixtureLine = (id: string, from: string, to: string, kv: number, extra: Partial<AuditBranch> = {}): AuditBranch => {
  const a = busLocation.get(from)!
  const b = busLocation.get(to)!
  nextWay += 1
  return {
    id, label: id, kind: 'ac_line', fromBusId: from, toBusId: to, nominalKv: kv, lengthKm: haversineKm(a, b), circuits: 1,
    osmWayIds: [`way/${nextWay}`], curationIds: [], ends: { from: a, to: b }, geometry: [[a, b]], ...extra,
  }
}

const transformer = (id: string, from: string, to: string, kv: number): AuditBranch => ({
  id, label: id, kind: 'transformer', fromBusId: from, toBusId: to, nominalKv: kv, circuits: 1, osmWayIds: [], curationIds: [],
})

const branches: ReadonlyArray<AuditBranch> = [
  fixtureLine('branch:a-b-1', 'bus:a@420', 'bus:b@420', 420),
  fixtureLine('branch:a-b-2', 'bus:a@420', 'bus:b@420', 420),
  fixtureLine('branch:b-c', 'bus:b@420', 'bus:c@420', 420),
  fixtureLine('branch:c-j', 'bus:c@420', 'bus:junction-j@420', 420),
  fixtureLine('branch:j-d', 'bus:junction-j@420', 'bus:d@420', 420),
  fixtureLine('branch:j-q', 'bus:junction-j@420', 'bus:q@420', 420),
  fixtureLine('branch:d-a', 'bus:d@420', 'bus:a@420', 420),
  fixtureLine('branch:a-se3', 'bus:a@420', 'bus:boundary-SE3', 420),
  fixtureLine('branch:c-p', 'bus:c@300', 'bus:p@300', 300, { curationIds: ['fixture-plant-terminal'] }),
  fixtureLine('branch:a-e', 'bus:a@132', 'bus:e@132', 132),
  transformer('branch:transformer-c-420-300', 'bus:c@420', 'bus:c@300', 420),
  transformer('branch:transformer-a-420-132', 'bus:a@420', 'bus:a@132', 420),
]

export const fixtureGraph = (): AuditGraph => ({
  modelId: 'fixture',
  modelKind: 'grid-model-v2',
  busPerVoltageLevel: true,
  referenceHour: '2026-01-15T00:00:00+01:00',
  buses,
  branches,
  hvdcLinks: [{ id: 'hvdc:fixture-link', label: 'Fixture link', fromBusId: 'bus:b@420', toBusId: 'bus:boundary-DK1', ratingMw: 700, osmWayIds: ['way/300'], curationIds: [] }],
  generators: [
    { id: 'generator:p', label: 'P hydro', kind: 'hydro-reservoir', family: 'hydro', busId: 'bus:p@300', capacityMw: 300, priceArea: 'NO1', attachmentKm: 1, curationIds: [] },
    { id: 'generator:c', label: 'C hydro', kind: 'hydro-reservoir', family: 'hydro', busId: 'bus:c@420', capacityMw: 500, priceArea: 'NO1', attachmentKm: 2, curationIds: [] },
    { id: 'generator:e', label: 'E wind', kind: 'wind', family: 'wind', busId: 'bus:e@132', capacityMw: 100, priceArea: 'NO1', attachmentKm: 5, curationIds: [] },
  ],
  loads: [
    { id: 'load:a', label: 'A municipality', kind: 'household', family: 'distributed', busId: 'bus:a@132', demandMw: 400, priceArea: 'NO1', attachmentKm: 20, curationIds: [] },
    { id: 'load:d', label: 'D smelter', kind: 'industry-site', family: 'site', busId: 'bus:d@420', demandMw: 200, priceArea: 'NO1', attachmentKm: 1, curationIds: [] },
  ],
})

const evidence = [{ sourceId: 'fixture', url: 'https://example.org/fixture', ref: 'fixture' }]
const zeroAreas = { NO1: 0, NO2: 0, NO3: 0, NO4: 0, NO5: 0 }
const thresholdNote = 'fixture threshold'

export const fixtureGoldenInput = () => ({
  id: 'fixture.golden',
  title: 'Fixture golden',
  reviewedAt: '2026-10-10',
  note: 'Test fixture.',
  sources: [{ id: 'fixture', title: 'Fixture', publisher: 'Tests', url: 'https://example.org/fixture', licence: 'test data', retrievedAt: '2026-10-10' }],
  thresholds: {
    maxComponents: 1, minLargestComponentBusShare300kv: 1, minLargestComponentBusShare132kv: 1, minLargestComponentLoadShare: 1,
    maxUnexplainedBridges300kv: 0, maxUnexplainedArticulationPoints300kv: 0, maxUnexplainedDegreeOne300kv: 0,
    voltageClassTolerance: 0.1, maxVoltageMismatches: 0, maxParallelDuplicates: 0, maxOffTerminalEnds: 0,
    terminalPolygonBufferKm: 0.05, terminalPointRadiusKm: 0.25,
    maxAttachmentKm: { generator: { hydro: 30, wind: 30, solar: 30, thermal: 30, nuclear: 30 }, load: { distributed: 60, site: 15 } },
    maxAttachmentViolations: 0, generationTolerance: { hydro: 0.03, wind: 0.05 }, maxUnassignedGenerationMw: 0, loadTolerance: 0.05,
    nveCoverage: { minKv: 300, bufferKm: 0.3, maxUncoveredShare: 0.03 }, maxCuratedShare300kv: 0.02,
  },
  thresholdNotes: Object.fromEntries([
    'maxComponents', 'minLargestComponentBusShare300kv', 'minLargestComponentBusShare132kv', 'minLargestComponentLoadShare',
    'maxUnexplainedBridges300kv', 'maxUnexplainedArticulationPoints300kv', 'maxUnexplainedDegreeOne300kv', 'voltageClassTolerance',
    'maxVoltageMismatches', 'maxParallelDuplicates', 'maxOffTerminalEnds', 'terminalPolygonBufferKm', 'terminalPointRadiusKm',
    'maxAttachmentKm', 'maxAttachmentViolations', 'generationTolerance', 'maxUnassignedGenerationMw', 'loadTolerance', 'nveCoverage',
    'maxCuratedShare300kv',
  ].map(key => [key, thresholdNote])),
  references: {
    generation: { sourceIds: ['fixture'], note: 'fixture totals', capacityMwByFamily: { hydro: { ...zeroAreas, NO1: 800 }, wind: { ...zeroAreas, NO1: 100 } } },
    load: { sourceId: 'fixture', referenceHour: '2026-01-15T00:00:00+01:00', note: 'fixture hour', demandMwByArea: { ...zeroAreas, NO1: 600 } },
  },
  stations: [
    { id: 'a', name: 'A', osmIds: ['way/101'], evidence },
    { id: 'b', name: 'B', osmIds: ['way/102'], evidence },
    { id: 'c', name: 'C', osmIds: ['way/103'], evidence },
    { id: 'd', name: 'D', osmIds: ['way/104'], evidence },
    { id: 'p', name: 'P', osmIds: ['way/105'], evidence },
    { id: 'e', name: 'E', osmIds: ['way/106'], evidence },
    { id: 'q', name: 'Q', osmIds: ['way/107'], evidence },
  ],
  substations: [
    { stationId: 'a', voltageKv: 420, minDegree: 3, evidence },
    { stationId: 'c', voltageKv: 420, minDegree: 2, evidence },
  ],
  corridors: [
    { id: 'a-b', name: 'A – B', fromStationId: 'a', toStationId: 'b', voltageKv: 420, minCircuits: 2, evidence },
    { id: 'c-d', name: 'C – D', fromStationId: 'c', toStationId: 'd', voltageKv: 420, minCircuits: 1, evidence },
    { id: 'c-p', name: 'C – P', fromStationId: 'c', toStationId: 'p', voltageKv: 300, minCircuits: 1, evidence },
  ],
  excludedCorridors: [
    { id: 'a-c', name: 'A – C', fromStationId: 'a', toStationId: 'c', voltageKv: 420, reason: 'it is under construction', evidence },
  ],
  interconnectors: [
    { id: 'a-se3', name: 'A – SE3', kind: 'ac', stationId: 'a', neighbourArea: 'SE3', voltageKv: 420, evidence },
    { id: 'b-dk1', name: 'B – DK1', kind: 'hvdc', stationId: 'b', neighbourArea: 'DK1', voltageKv: 500, evidence },
  ],
  radialAllowList: [
    { stationId: 'p', voltageKv: 300, reason: 'radial-plant', note: 'P is a radial plant', evidence },
  ],
})

export const fixtureGolden = (): GridGolden => gridGoldenSchema.parse(fixtureGoldenInput())

const curationCommon = {
  reason: 'fixture', evidence: [{ url: 'https://example.org/fixture', ref: 'fixture' }],
  licence: 'osm-odbl-1.0', author: 'tests', reviewedAt: '2026-10-10',
}

export const fixtureCurationsInput = () => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature', id: 'fixture-plant-terminal', geometry: { type: 'Point', coordinates: [10.52, 60.52] },
      properties: {
        kind: 'add-terminal', ...curationCommon, targetOsmIds: ['way/209', 'way/105'],
        wayOsmId: 'way/209', substationOsmId: 'way/105', remoteSubstationOsmId: 'way/103', voltageKv: 300,
        expiresWhen: [{ kind: 'mapped-corridor-present', fromSubstationOsmId: 'way/105', toSubstationOsmId: 'way/103', voltageKv: 300 }, { kind: 'review-by', date: '2027-10-10' }],
      },
    },
    {
      type: 'Feature', id: 'fixture-q-radial', geometry: { type: 'Point', coordinates: [10.25, 60.7] },
      properties: {
        kind: 'assert-radial', ...curationCommon, targetOsmIds: ['way/107'], substationOsmId: 'way/107', voltageKv: 420, radialReason: 'radial-supply',
        expiresWhen: [{ kind: 'radial-no-longer', substationOsmId: 'way/107', voltageKv: 420 }],
      },
    },
    {
      type: 'Feature', id: 'fixture-exclude', geometry: { type: 'Point', coordinates: [10.3, 60.3] },
      properties: { kind: 'exclude-feature', ...curationCommon, targetOsmIds: ['way/999'], expiresWhen: [{ kind: 'review-by', date: '2027-04-10' }] },
    },
    {
      type: 'Feature', id: 'fixture-se3-boundary', geometry: { type: 'Point', coordinates: [9.8, 59.9] },
      properties: {
        kind: 'boundary', ...curationCommon, targetOsmIds: ['way/101'], substationOsmId: 'way/101', externalArea: 'SE3', linkKind: 'ac', voltageKv: 420, ratingMw: 2000,
        expiresWhen: [{ kind: 'review-by', date: '2027-10-10' }],
      },
    },
  ],
})

export const fixtureCurations = (): GridCurationCollection => gridCurationCollectionSchema.parse(fixtureCurationsInput())

/** NVE lines a few hundred metres beside the fixture's 420 kV ring. */
export const fixtureNveLines = (offsetDegrees = 0.001): ReadonlyArray<NveLine> =>
  branches.filter(branch => branch.kind !== 'transformer' && branch.nominalKv >= 420 && branch.toBusId !== 'bus:boundary-SE3' && branch.id !== 'branch:a-b-2')
    .map(branch => ({
      globalId: `{${branch.id}}`,
      name: branch.label,
      voltageKv: branch.nominalKv,
      parts: [[busLocation.get(branch.fromBusId)!, busLocation.get(branch.toBusId)!].map((point): LonLat => [point[0], point[1] + offsetDegrees])],
    }))
