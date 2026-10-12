import { describe, expect, test } from 'bun:test'
import { withCuratedCircuits } from '../src/packs/electric-grid/model-build/curated-circuits.ts'
import { buildGenerators, registeredWindUnits } from '../src/packs/electric-grid/model-build/generators.ts'
import type { Station, StationIndex } from '../src/packs/electric-grid/model-build/stations.ts'
import type { ModelSourceIds } from '../src/packs/electric-grid/model-build/sources.ts'
import { curationSourceId, topologyCurationSet, withoutCuratedExclusions } from '../src/packs/electric-grid/model-build/curations.ts'
import { ambientRatingRule, cableRules, lineParameters, networkEquivalentParameters, overheadRules, reactanceFloorPu, transformerParameters } from '../src/packs/electric-grid/model-build/electrical.ts'
import { runOfRiverTurbineOf, runOfRiverTurbineRule } from '../src/packs/electric-grid/model-build/generator-rules.ts'
import { simplifyPath, type LonLat } from '../src/packs/electric-grid/model-build/geo.ts'
import { buildHvdcRampGroups } from '../src/packs/electric-grid/model-build/interconnectors.ts'
import { jsonLines } from '../src/packs/electric-grid/model-build/json-lines.ts'
import { createBuildLedger } from '../src/packs/electric-grid/model-build/ledger.ts'
import { dispatchGenerators, referenceSchedules } from '../src/packs/electric-grid/model-build/operating-points.ts'
import { corridorPath } from '../src/packs/electric-grid/model-build/paths.ts'
import { sourceBuildId } from '../src/packs/electric-grid/model-build/sources.ts'
import { gridCurationCollectionSchema } from '../src/packs/electric-grid/schemas/grid-curation.ts'
import { interconnectorTableSchema } from '../src/packs/electric-grid/schemas/grid-interconnector.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import type { GridReferenceHourDispatch } from '../src/packs/electric-grid/schemas/grid-reference-dispatch.ts'
import type { TopologyInput } from '../src/packs/electric-grid/topology/input.ts'
import type { TopologyBranch } from '../src/packs/electric-grid/topology/result.ts'

const fixture = validateGridModel(await Bun.file(new URL('./fixtures/grid-model-v2.fixture.json', import.meta.url)).json(), 'fixture')

describe('model build: electrical rules', () => {
  test('scale per-km parameters by length and circuits on 100 MVA', () => {
    const line = lineParameters({ nominalKv: 420, lengthKm: 100, cableLengthKm: 0, circuits: 2 })
    expect(line.reactancePu).toBeCloseTo(0.30 * 100 * 100 / 420 ** 2 / 2, 12)
    expect(line.resistancePu).toBeCloseTo(0.025 * 100 * 100 / 420 ** 2 / 2, 12)
    expect(line.chargingSusceptancePu).toBeCloseTo(4.0e-6 * 100 * 420 ** 2 / 100 * 2, 12)
    // Overhead ratings at 0 °C air (874/634 of the 35 °C design rating), and at 20 °C for summer (749/634).
    expect(line.ratings).toEqual({
      referenceMw: 2 * Math.round(overheadRules[420].ratingMvaPerCircuit * ambientRatingRule.referenceFactor),
      designMw: 2 * overheadRules[420].ratingMvaPerCircuit,
      summerMw: 2 * Math.round(overheadRules[420].ratingMvaPerCircuit * ambientRatingRule.summerFactor),
    })
    expect(ambientRatingRule.referenceFactor).toBeCloseTo(874 / 634, 3)
    expect(ambientRatingRule.summerFactor).toBeCloseTo(749 / 634, 4)
    expect(line.ratingMw).toBe(line.ratings.referenceMw)
    expect(line.emergencyRatingMw).toBe(Math.round(line.ratingMw * 1.2))
    const mixed = lineParameters({ nominalKv: 132, lengthKm: 10, cableLengthKm: 4, circuits: 1 })
    expect(mixed.reactancePu).toBeCloseTo((0.40 * 6 + 0.13 * 4) * 100 / 132 ** 2, 12)
    // The 132 kV cable (250 MVA) limits the corridor at 0 °C air; at the design and summer air the overhead part does.
    expect(mixed.ratings).toEqual({
      referenceMw: Math.min(Math.round(overheadRules[132].ratingMvaPerCircuit * ambientRatingRule.referenceFactor), cableRules[132].ratingMvaPerCircuit),
      designMw: Math.min(overheadRules[132].ratingMvaPerCircuit, cableRules[132].ratingMvaPerCircuit),
      summerMw: Math.min(Math.round(overheadRules[132].ratingMvaPerCircuit * ambientRatingRule.summerFactor), cableRules[132].ratingMvaPerCircuit),
    })
    expect(lineParameters({ nominalKv: 420, lengthKm: 0.05, cableLengthKm: 0, circuits: 1 }).reactancePu).toBe(reactanceFloorPu)
    expect(() => lineParameters({ nominalKv: 66, lengthKm: 1, cableLengthKm: 0, circuits: 1 })).toThrow('no electrical rule for 66 kV')
  })

  test('model a sub-transmission equivalent as its circuits in series with a transformation at each end', () => {
    const equivalent = networkEquivalentParameters({ viaKv: 47, routeKm: 16, circuits: 2 })
    expect(equivalent.ratings.designMw).toBe(2 * Math.round(Math.sqrt(3) * 47 * 0.645))
    expect(equivalent.ratingMw).toBe(Math.round(equivalent.ratings.designMw * ambientRatingRule.referenceFactor))
    expect(equivalent.endTransformerMva).toBe(150)
    expect(equivalent.reactancePu).toBeCloseTo(0.40 * 16 / 2 / (47 ** 2 / 100) + 2 * 0.12 * 100 / 150, 9)
    expect(equivalent.resistancePu).toBeCloseTo(0.10 * 16 / 2 / (47 ** 2 / 100) + 2 * 0.12 * 100 / 150 / 40, 9)
  })

  test('size transformer reactance on the unit rating', () => {
    const transformer = transformerParameters(500, 1)
    expect(transformer.reactancePu).toBeCloseTo(0.12 * 100 / 500, 12)
    expect(transformer.resistancePu).toBeCloseTo(transformer.reactancePu / 40, 12)
  })
})

describe('model build: geometry', () => {
  test('simplifies within the tolerance and keeps both ends', () => {
    const straight: LonLat[] = Array.from({ length: 11 }, (_, index) => [10 + index * 0.01, 60 + (index === 5 ? 0.0002 : 0)])
    expect(simplifyPath(straight, 50)).toEqual([straight[0]!, straight[10]!])
    const bent: LonLat[] = [...straight.slice(0, 5), [10.05, 60.01], ...straight.slice(6)]
    expect(simplifyPath(bent, 50)).toContainEqual([10.05, 60.01])
  })

  test('chains a corridor of reversed ways from its from-bus to its to-bus', () => {
    const ways = [
      { coordinates: [[10.2, 60], [10.1, 60]] as LonLat[], nodeKeys: ['c', 'b'] },
      { coordinates: [[10, 60], [10.1, 60]] as LonLat[], nodeKeys: ['a', 'b'] },
    ]
    expect(corridorPath(ways, [10, 60], [10.2, 60])).toEqual([[10, 60], [10.1, 60], [10.2, 60]])
    expect(corridorPath(ways, [10.2, 60], [10, 60])).toEqual([[10.2, 60], [10.1, 60], [10, 60]])
    // A 30 m gap between way ends still chains; a 5 km gap does not.
    const gap = [ways[1]!, { coordinates: [[10.1005, 60], [10.2, 60]] as LonLat[], nodeKeys: ['b2', 'c'] }]
    expect(corridorPath(gap, [10, 60], [10.2, 60])?.length).toBe(4)
    const apart = [ways[1]!, { coordinates: [[10.2, 60], [10.3, 60]] as LonLat[], nodeKeys: ['x', 'y'] }]
    expect(corridorPath(apart, [10, 60], [10.3, 60])).toBeUndefined()
  })
})

describe('model build: dispatch', () => {
  const hour: GridReferenceHourDispatch = {
    startUtc: '2026-01-12T07:00:00.000Z',
    generationMw: { hydroRunOfRiver: 2000, hydroReservoir: 15000, hydroPumpedStorage: 500, windOnshore: 3000, windOffshore: 0, fossilGas: 0, other: 100 },
    loadMw: 20000,
    importMw: { SE: -50, FI: 0, DK: 0, DE: -100, NL: 0, GB: 0 },
    queries: ['https://example.org/q'],
    note: 'fixture hour',
  }

  test('schedules the measured exchange and shares measured output by capacity, storage hydro closing the balance', () => {
    const schedules = referenceSchedules(fixture, hour)
    expect(schedules.hvdc).toEqual([{ assetId: 'hvdc:test-link', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: 100 }] }])
    expect(schedules.exchange).toEqual([{ assetId: 'external:nordic-remainder', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', exportMw: 50 }] }])
    // The fixture holds the only wind and run-of-river units: measured 3000 and 2000 MW exceed them, so both run at full output.
    const states = new Map(dispatchGenerators(fixture, () => 100, hour, schedules).map(state => [state.assetId, state]))
    expect(states.get('generator:nve-wind-45')).toMatchObject({ state: 'online', availableMw: 100, targetMw: 100 })
    expect(states.get('generator:aggregate-osm-way-60495669@132-hydro-run-of-river')).toMatchObject({ state: 'online', targetMw: 40 })
    // 2 × 100 MW demand + 150 MW export − 140 MW measured output.
    expect(states.get('generator:nve-hydro-123')).toMatchObject({ state: 'online', availableMw: 300, targetMw: 210 })
  })

  test('takes a run-of-river turbine and its minimum stable share from the gross head', () => {
    expect([10, 24.9, 25, 350, 351, 900].map(runOfRiverTurbineOf)).toEqual(['kaplan', 'kaplan', 'francis', 'francis', 'pelton', 'pelton'])
    expect(runOfRiverTurbineRule.minimumStableShare).toEqual({ kaplan: 0.2, francis: 0.4, pelton: 0.2 })
  })

  test('commits run-of-river units below their minimum largest first on their area\'s inflow', () => {
    const base = fixture.generators.find(generator => generator.id === 'generator:nve-hydro-123')!
    const unit = (plantNumber: number, capacityMw: number) => ({
      ...base, id: `generator:nve-hydro-${plantNumber}`, label: `run-of-river ${plantNumber}`, kind: 'hydro-run-of-river' as const,
      capacityMw, ratedMva: capacityMw / 0.9, minimumStableMw: capacityMw * 0.4, priceArea: 'NO1' as const,
      busId: 'bus:osm-way-60495669@132', registryIds: [String(plantNumber)], blackStartCapable: false,
    })
    const model = validateGridModel({ ...fixture, generators: [...fixture.generators, unit(901, 100), unit(902, 60), unit(903, 40)] }, 'fixture with run-of-river')
    const quiet = { ...hour, importMw: { ...hour.importMw, SE: 0, DE: 0 }, generationMw: { ...hour.generationMw, hydroRunOfRiver: 48 } }
    // Inflow share 48 / 240 MW = 0.2: the Francis group's 40 MW keeps only the 100 MW unit at its 40 % minimum.
    const states = new Map(dispatchGenerators(model, () => 150, quiet, referenceSchedules(model, quiet)).map(state => [state.assetId, state]))
    expect(states.get('generator:nve-hydro-901')).toMatchObject({ state: 'online', targetMw: 40 })
    expect(states.get('generator:nve-hydro-902')).toMatchObject({ state: 'offline', targetMw: 0 })
    expect(states.get('generator:nve-hydro-903')).toMatchObject({ state: 'offline', targetMw: 0 })
    expect(states.get('generator:aggregate-osm-way-60495669@132-hydro-run-of-river')).toMatchObject({ state: 'online', targetMw: 8 })
    // 300 MW demand − 100 MW wind − 48 MW run-of-river.
    expect(states.get('generator:nve-hydro-123')).toMatchObject({ state: 'online', targetMw: 152 })
  })

  test('commits storage hydro at one loading and refuses a balance it cannot cover', () => {
    const schedules = referenceSchedules(fixture, { ...hour, importMw: { ...hour.importMw, SE: 0, DE: 0 } })
    const states = new Map(dispatchGenerators(fixture, () => 120, hour, schedules).map(state => [state.assetId, state]))
    expect(states.get('generator:nve-hydro-123')).toMatchObject({ state: 'online', availableMw: 300, targetMw: 100 })
    expect(() => dispatchGenerators(fixture, () => 500, hour, schedules)).toThrow('cannot cover the residual demand')
  })
})

const modelsDirectory = new URL('../src/packs/electric-grid/models/', import.meta.url)
const interconnectorTable = interconnectorTableSchema.parse(await Bun.file(new URL('norway-interconnectors.json', modelsDirectory)).json())
const norwayModel = validateGridModel(await Bun.file(new URL('norway-transmission.grid-model.json', modelsDirectory)).json(), 'norway-transmission.grid-model.json')

describe('model build: HVDC ramp groups', () => {
  const table = interconnectorTable
  const norway = norwayModel
  const sourceIds = { interconnectors: norway.sourceBuild.inputs.find(input => input.sourceId.startsWith('curated:norway-interconnectors@'))!.sourceId } as Parameters<typeof buildHvdcRampGroups>[0]['sourceIds']

  test('the Norway model carries both shared ramp limits of the interconnector table, as the build derives them', () => {
    expect(norway.hvdcRampGroups.map(group => [group.id, group.linkIds, group.rampMwPerMinute])).toEqual([
      ['ramp:no2-continental', ['hvdc:nordlink', 'hvdc:norned'], 50],
      ['ramp:skagerrak', ['hvdc:skagerrak-1', 'hvdc:skagerrak-2', 'hvdc:skagerrak-3', 'hvdc:skagerrak-4'], 25],
    ])
    expect(buildHvdcRampGroups({ table, links: norway.hvdcLinks, sourceIds })).toEqual(norway.hvdcRampGroups)
    expect(norway.hvdcRampGroups.every(group => group.provenance.note === table.hvdcRampGroups.find(entry => entry.id === group.id)!.basis)).toBe(true)
  })

  test('fails when a group names a link the model does not carry', () => {
    expect(() => buildHvdcRampGroups({ table, links: norway.hvdcLinks.filter(link => link.id !== 'hvdc:norned'), sourceIds }))
      .toThrow('HVDC ramp group ramp:no2-continental names hvdc:norned, which the model does not carry')
  })
})

describe('model build: provenance and serialisation', () => {
  test('derives the build id from input hashes and rules only', () => {
    const inputs = [
      { sourceId: 'osm:a@2026-10-08', snapshotAt: '2026-10-08T00:00:00Z', sha256: '1'.repeat(64), licence: 'osm-odbl-1.0' },
      { sourceId: 'nve:b@2026-10-10', snapshotAt: '2026-10-10T00:00:00Z', sha256: '2'.repeat(64), licence: 'nve-nlod-2.0' },
    ]
    expect(sourceBuildId(inputs, 'r')).toBe(sourceBuildId([...inputs].reverse(), 'r'))
    expect(sourceBuildId(inputs, 'r')).not.toBe(sourceBuildId(inputs, 's'))
    expect(sourceBuildId(inputs, 'r')).not.toBe(sourceBuildId([inputs[0]!, { ...inputs[1]!, sha256: '3'.repeat(64) }], 'r'))
  })

  test('writes one array element per line', () => {
    expect(jsonLines({ id: 'x', items: [{ a: 1 }, { b: [2, 3] }], empty: [] })).toBe('{\n  "id": "x",\n  "items": [\n    {"a":1},\n    {"b":[2,3]}\n  ],\n  "empty": []\n}\n')
  })

  test('maps curation records onto the topology and leaves out excluded features', () => {
    const point = { type: 'Point', coordinates: [10, 60] }
    const common = { licence: 'osm-odbl-1.0', author: 'test', reviewedAt: '2026-10-10', reason: 'r', evidence: [{ url: 'https://example.org/e', ref: 'e' }], expiresWhen: [{ kind: 'review-by', date: '2027-01-01' }] }
    const collection = gridCurationCollectionSchema.parse({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 'cable-in-service', geometry: point, properties: { kind: 'assert-in-service', targetOsmIds: ['way/1'], ...common } },
        { type: 'Feature', id: 'link-ways', geometry: point, properties: { kind: 'add-interconnector-ways', targetOsmIds: ['way/2'], interconnectorId: 'hvdc:test', osmWayIds: ['way/2'], ...common } },
        { type: 'Feature', id: 'platform-cable', geometry: point, properties: { kind: 'offshore-load', targetOsmIds: ['way/3'], siteId: 'site:platform', ...common } },
      ],
    })
    const set = topologyCurationSet(collection, 'curated:test')
    expect(set.records.map(record => [record.kind, record.id])).toEqual([['assert-in-service', 'curation:cable-in-service'], ['add-interconnector-ways', 'curation:link-ways']])
    expect(set.records[0]!.evidence).toEqual(['https://example.org/e (e)'])
    const line = (id: string) => ({ kind: 'line' as const, featureId: id, osmWayIds: [id], name: null, operator: null, lifecycle: 'operational' as const, levels: [], cables: null, coordinates: [], vertexKeys: [], terminalVertexIndices: [] })
    const input: TopologyInput = { sourceId: 'osm:test', keyMode: 'osm-node', features: [line('way/1'), line('way/3')], adapterLedger: [] }
    const ledger = createBuildLedger()
    expect(withoutCuratedExclusions(input, collection, ledger).features.map(feature => feature.featureId)).toEqual(['way/1'])
    expect(ledger.entries().map(entry => entry.reason)).toEqual(['offshore-supply-explained'])
    expect(() => withoutCuratedExclusions({ ...input, features: [line('way/1')] }, collection, createBuildLedger())).toThrow(`${curationSourceId(collection.features[2]!)}: target way/3 is not in the topology input`)
  })

  test('gives a line the circuits a set-circuits record names, only where the topology inferred them', () => {
    const point = { type: 'Point', coordinates: [10, 60] }
    const common = { licence: 'osm-odbl-1.0', author: 'test', reviewedAt: '2026-10-12', reason: 'five unit cables', evidence: [{ url: 'https://example.org/e', ref: 'e' }], expiresWhen: [{ kind: 'review-by', date: '2027-01-01' }] }
    const record = (wayOsmIds: ReadonlyArray<string>, voltageKv = 300) => gridCurationCollectionSchema.parse({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'unit-cables', geometry: point, properties: { kind: 'set-circuits', targetOsmIds: wayOsmIds, wayOsmIds, voltageKv, circuits: 5, ...common } }],
    })
    const branch = (id: string, osmWayIds: ReadonlyArray<string>, circuitsSource: TopologyBranch['circuitsSource']): TopologyBranch => ({
      id, label: id, kind: 'cable', fromBusId: 'bus:a@300', toBusId: 'bus:b@300', nominalKv: 300, lowKv: null, lengthKm: 0.2, cableLengthKm: 0.2,
      circuits: 1, circuitsSource, voltageSource: 'mapped', ratingMva: null, osmWayIds, sourceFeatureIds: osmWayIds, osmTransformerIds: [], names: [],
      parallelSpanGroups: 0, interconnectorId: null,
      provenance: { sources: ['osm:test'], method: 'inferred', confidence: 'medium', note: 'circuit count inferred (1)' },
    })
    const lines = [branch('branch:unit-cables', ['way/1', 'way/2'], 'inferred'), branch('branch:other', ['way/3'], 'cables-tag')]
    const ledger = createBuildLedger()
    const curated = withCuratedCircuits(lines, record(['way/1']), ledger)
    expect(curated.branches.map(line => [line.id, line.circuits, line.provenance.note])).toEqual([
      ['branch:unit-cables', 5, '5 circuits by curation:unit-cables'],
      ['branch:other', 1, 'circuit count inferred (1)'],
    ])
    expect([...curated.curationOf]).toEqual([['branch:unit-cables', 'curation:unit-cables']])
    expect(ledger.entries().map(entry => [entry.reason, entry.elementIds])).toEqual([['curated-circuits-set', ['branch:unit-cables', 'curation:unit-cables']]])
    // All circuits share the per-circuit rule: five rule cables carry five times one.
    expect(lineParameters({ nominalKv: 300, lengthKm: 0.2, cableLengthKm: 0.2, circuits: 5 }).ratingMw).toBe(5 * cableRules[300].ratingMvaPerCircuit)
    expect(() => withCuratedCircuits(lines, record(['way/3']), createBuildLedger())).toThrow('curation:unit-cables: branch:other has 1 circuits from its cables-tag; the record is no longer needed')
    expect(() => withCuratedCircuits(lines, record(['way/9']), createBuildLedger())).toThrow('curation:unit-cables: 0 300 kV lines carry way/9; the record must name exactly one')
    expect(() => withCuratedCircuits(lines, record(['way/1'], 132), createBuildLedger())).toThrow('0 132 kV lines carry way/1')
    expect(gridCurationCollectionSchema.safeParse({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'one', geometry: point, properties: { kind: 'set-circuits', targetOsmIds: ['way/1'], wayOsmIds: ['way/1'], voltageKv: 300, circuits: 1, ...common } }] }).success).toBe(false)
  })

  test('splits a registered plant over the stations a split-plant record names, by weight', () => {
    const bus = (stationId: string, location: readonly [number, number]) => ({
      id: `bus:${stationId}@132`, label: `${stationId} 132 kV`, kind: 'substation' as const, substationId: stationId, nominalKv: 132, location: [location[0], location[1]] as [number, number], priceArea: 'NO4' as const,
      provenance: { sources: ['osm:test'], method: 'mapped' as const, confidence: 'high' as const },
    })
    const station = (stationId: string, location: readonly [number, number]): Station => ({ stationId, kind: 'substation', label: stationId, location, priceArea: 'NO4', buses: [bus(stationId, location)], featureIds: [stationId.replace(/^osm-way-/, 'way/')], transitionOnly: false })
    const stations = [station('osm-way-1', [13.02, 65.85]), station('osm-way-2', [13.08, 65.83])]
    const index: StationIndex = {
      stations,
      containing: () => undefined,
      byFeatureId: featureId => stations.find(candidate => candidate.featureIds.includes(featureId)),
      nearest: () => ({ station: stations[0]!, km: 0.75 }),
    }
    const units = registeredWindUnits([{ farmId: 1, plantNumber: 10269, name: 'Farm', installedMw: 400, normalAnnualProductionGwh: 1146, priceArea: 'NO4', location: [13.01, 65.86], registryStatus: 'D', registryOutOfOperation: null, sharedPlantNumberFarmIds: [] }], 'nve:wind-farms@test', createBuildLedger())
    const sourceIds = { osm: 'osm:test', hydroHeads: 'nve:hydro-heads@test' } as ModelSourceIds
    const split = (substationOsmIds: ReadonlyArray<string>, generatorId = 'generator:nve-wind-10269') => new Map([[generatorId, {
      curationId: 'curation:farm-two-stations', parts: substationOsmIds.map((substationOsmId, position) => ({ substationOsmId, voltageKv: 132, weight: position === 0 ? 140 : 280 })),
    }]])
    const ledger = createBuildLedger()
    const generators = buildGenerators({ units, stations: index, regionalRoutes: new Map(), splits: split(['way/1', 'way/2']), sourceIds, ledger })
    expect(generators.map(generator => [generator.id, generator.busId, generator.capacityMw, generator.annualProductionGwh, generator.registryIds])).toEqual([
      ['generator:curated-farm-two-stations-2', 'bus:osm-way-2@132', 266.667, 764, ['10269']],
      ['generator:nve-wind-10269', 'bus:osm-way-1@132', 133.333, 382, ['10269']],
    ])
    expect(generators.every(generator => generator.provenance.method === 'curated' && generator.provenance.sources.includes('curation:farm-two-stations'))).toBe(true)
    expect(ledger.entries().map(entry => entry.reason)).toEqual(['generator-split-by-curation', 'generator-split-by-curation'])
    expect(() => buildGenerators({ units, stations: index, regionalRoutes: new Map(), splits: split(['way/1', 'way/9']), sourceIds, ledger: createBuildLedger() })).toThrow('curation:farm-two-stations: way/9 is not a ≥132 kV station of the main island')
    expect(() => buildGenerators({ units, stations: index, regionalRoutes: new Map(), splits: split(['way/1', 'way/2'], 'generator:nve-wind-7'), sourceIds, ledger: createBuildLedger() })).toThrow('split-plant curations name generators that are not registered plants: generator:nve-wind-7')
    const point = { type: 'Point', coordinates: [13.05, 65.84] }
    const common = { licence: 'nve-nlod-2.0', author: 'test', reviewedAt: '2026-10-12', reason: 'two transformer stations', evidence: [{ url: 'https://example.org/e', ref: 'e' }], expiresWhen: [{ kind: 'review-by', date: '2027-01-01' }] }
    const part = (substationOsmId: string) => ({ substationOsmId, voltageKv: 132, weight: 1 })
    const record = (parts: ReadonlyArray<ReturnType<typeof part>>) => gridCurationCollectionSchema.safeParse({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'farm-two-stations', geometry: point, properties: { kind: 'split-plant', targetOsmIds: parts.map(entry => entry.substationOsmId), generatorId: 'generator:nve-wind-10269', parts, ...common } }] }).success
    expect(record([part('way/1'), part('way/2')])).toBe(true)
    expect(record([part('way/1')])).toBe(false)
    expect(record([part('way/1'), part('way/1')])).toBe(false)
  })
})
