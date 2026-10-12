import { describe, expect, test } from 'bun:test'
import { validateGridModel, type GridModelV2 } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { composeGridModel, validateGridModelAddition } from '../src/packs/electric-grid/schemas/grid-model-addition.ts'
import { gridExchangeBordersOf, gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

const base = validateGridModel(await Bun.file(new URL('./fixtures/grid-model-v2.fixture.json', import.meta.url)).json(), 'fixture')
const baseArtifact = { kind: 'model', model: base } as const

const message = (action: () => unknown): string => {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

const additionJson = () => ({
  schemaVersion: 2,
  id: 'electric-grid.test.v2-fixture.second-plant',
  title: 'Second test plant',
  description: 'Adds a curated plant switchyard to the v2 fixture.',
  baseModelRef: 'electric-grid.test.v2-fixture',
  sourceInputs: [{ sourceId: 'leitbild:second-plant@2026-10-10', snapshotAt: '2026-10-10T00:00:00Z', sha256: '0'.repeat(63) + '6', licence: 'Leitbild test fixture' }],
  buses: [{
    id: 'bus:curated-second-plant@420', label: 'Second plant switchyard', kind: 'plant-terminal', nominalKv: 420, location: [7.8, 58.2], priceArea: 'NO2',
    provenance: { sources: ['leitbild:second-plant@2026-10-10'], method: 'curated', confidence: 'low', note: 'Fixture.' },
  }],
  branches: [{
    id: 'branch:curated-second-plant-kristiansand', label: 'Second plant – Kristiansand', kind: 'ac_line',
    fromBusId: 'bus:curated-second-plant@420', toBusId: 'bus:osm-relation-7928148@420', nominalKv: 420, lengthKm: 8,
    circuits: 1, ratingMw: 1850, emergencyRatingMw: 2100, emergencyDurationSeconds: 900,
    reactancePu: 0.0015, resistancePu: 0.0001, chargingSusceptancePu: 0.04, osmWayIds: [],
    provenance: { sources: ['leitbild:second-plant@2026-10-10'], method: 'curated', confidence: 'low', note: 'Fixture.' },
  }],
  hvdcLinks: [] as unknown[],
  externalSystems: [] as unknown[],
  generators: [],
  loads: [{
    id: 'load:site-second-plant-auxiliaries', label: 'Second plant auxiliaries', kind: 'industry-site', busId: 'bus:curated-second-plant@420',
    location: [7.8, 58.2], referenceDemandMw: 40, powerFactor: 0.9, priority: 'critical', interruptibleMw: 0, priceArea: 'NO2', attachmentKm: 0,
    provenance: { sources: ['osm:pbf-power:NO@2026-10-09'], method: 'mapped', confidence: 'medium' },
  }],
  shunts: [],
  connectionPoints: [{ id: 'second-plant-unit-1', label: 'Second plant unit 1 bay', busId: 'bus:curated-second-plant@420', nominalKv: 420, maximumExportMw: 50, maximumImportMw: 1200 }],
})
const composeOnto = (artifact: Parameters<typeof composeGridModel>[0]['base'], json: unknown): GridModelV2 =>
  composeGridModel({ addition: validateGridModelAddition(json, 'models/second.grid-model-addition.json'), base: artifact, source: 'models/second.grid-model-addition.json' })
const compose = (json: unknown): GridModelV2 => composeOnto(baseArtifact, json)

describe('Grid Model Addition v2', () => {
  test('appends additive assets to the base and validates the composition', () => {
    const composed = compose(additionJson())
    expect(composed.id).toBe('electric-grid.test.v2-fixture.second-plant')
    expect(composed.buses).toHaveLength(base.buses.length + 1)
    expect(composed.branches.at(-1)?.toBusId).toBe('bus:osm-relation-7928148@420')
    expect(composed.connectionPoints.map(point => point.id)).toEqual(['test-plant-unit-1', 'second-plant-unit-1'])
    expect(composed.sourceBuild.inputs).toHaveLength(base.sourceBuild.inputs.length + 1)
    expect(composed.hvdcLinks).toEqual(base.hvdcLinks)
    expect(composed.hvdcRampGroups).toEqual(base.hvdcRampGroups)
  })

  test('leaves HVDC ramp groups to the base model: an addition cannot add or change one', () => {
    expect(message(() => compose({ ...additionJson(), hvdcRampGroups: [] })))
      .toContain('$.hvdcRampGroups: HVDC ramp groups belong to the base Grid Model; a Model Addition cannot add or change one')
  })

  test('reports unresolved references and id collisions at the addition JSON path', () => {
    const missing = additionJson()
    missing.branches[0]!.toBusId = 'bus:osm-relation-1@420'
    expect(message(() => compose(missing))).toContain('$.branches[0].toBusId: unknown bus bus:osm-relation-1@420')
    const collision = additionJson()
    collision.connectionPoints[0]!.id = 'test-plant-unit-1'
    expect(message(() => compose(collision))).toContain('$.connectionPoints[0].id: duplicates the id at connectionPoints[0]')
    const unrecorded = additionJson()
    unrecorded.sourceInputs = []
    expect(message(() => compose(unrecorded))).toContain('$.buses[0].provenance.sources[0]: leitbild:second-plant@2026-10-10 is not a sourceBuild input')
  })

  test('appends HVDC links and external systems, with the composed model\'s boundary rules', () => {
    const provenance = { sources: ['leitbild:second-plant@2026-10-10'], method: 'curated', confidence: 'low', note: 'Fixture.' }
    const json = {
      ...additionJson(),
      buses: [...additionJson().buses, { id: 'bus:boundary-GB', label: 'Great Britain HVDC terminal', kind: 'boundary', nominalKv: 400, location: [-1.5, 55.1], externalArea: 'GB', provenance }],
      hvdcLinks: [{ id: 'hvdc:test-gb-link', label: 'Test GB link', fromBusId: 'bus:osm-relation-7928148@420', toBusId: 'bus:boundary-GB', ratingMw: 1400, lossPercent: 3, rampMwPerMinute: 30, osmWayIds: ['300'], provenance }],
      externalSystems: [{ id: 'external:GB', label: 'Great Britain', area: 'GB', synchronous: false, boundaryBusIds: ['bus:boundary-GB'], provenance }],
    }
    const composed = compose(json)
    expect(composed.hvdcLinks.map(link => link.id)).toEqual(['hvdc:test-link', 'hvdc:test-gb-link'])
    expect(composed.externalSystems.map(system => system.id)).toEqual(['external:nordic-remainder', 'external:DE', 'external:GB'])
    expect(message(() => compose({ ...json, externalSystems: [] }))).toContain('$.buses[1].id: a boundary bus must belong to exactly one external system')
    expect(message(() => compose({ ...json, externalSystems: [{ ...json.externalSystems[0]!, boundaryBusIds: ['bus:boundary-DE'], id: 'external:DE', area: 'DE' }] })))
      .toContain('$.externalSystems[0].id: duplicates the id at externalSystems[1]')
  })

  test('stays one level, explicitly based and additive only', () => {
    const chained = validateGridModelAddition(additionJson(), 'first')
    expect(message(() => composeOnto({ kind: 'addition', addition: chained }, { ...additionJson(), id: 'electric-grid.test.v2-fixture.third-plant', baseModelRef: chained.id })))
      .toContain('$.baseModelRef: electric-grid.test.v2-fixture.second-plant is itself a Model Addition')
    expect(message(() => composeOnto(undefined, additionJson()))).toContain('$.baseModelRef: unknown Grid Model electric-grid.test.v2-fixture')
    expect(message(() => validateGridModelAddition({ ...additionJson(), storage: [] }, 'x'))).toContain('storage')
    expect(message(() => validateGridModelAddition({ ...additionJson(), removeBusIds: ['bus:boundary-DE'] }, 'x'))).toContain('removeBusIds')
    const { baseModelRef: _baseModelRef, ...unbased } = additionJson()
    expect(message(() => validateGridModelAddition(unbased, 'x'))).toContain('$.baseModelRef')
  })
})

const operatingPointJson = () => ({
  schemaVersion: 2,
  id: 'electric-grid.test.v2-fixture.winter-peak',
  title: 'Winter peak',
  description: 'Fixture Operating Point exercising every per-asset field.',
  compatibleModelRefs: ['electric-grid.test.v2-fixture'],
  demand: { season: 'winter', referenceHour: '2026-01-15T17:00:00+01:00', priceAreaGroupMw: { NO1: { private: 760 }, NO2: { industry: 250 } }, networkLossMw: { NO1: 38, NO2: 9 } },
  loadScale: 1.1,
  priceAreaDemandScale: { NO1: 1.05 },
  generatorStates: [
    { assetId: 'generator:nve-hydro-123', state: 'online', availableMw: 280, targetMw: 200 },
    { assetId: 'generator:nve-wind-45', state: 'offline' },
  ],
  branchStates: [{ assetId: 'branch:osm-fedcba9876543210', state: 'closed', availability: 0.6 }],
  hvdcSchedules: [{ assetId: 'hvdc:test-link', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: -700 }, { localTime: '08:00', transferMw: 1200 }] }],
  externalExchangeSchedules: [{ assetId: 'external:nordic-remainder', timeZone: 'Europe/Oslo', points: [{ localTime: '06:00', borders: [{ priceArea: 'NO1', externalArea: 'SE3', exportMw: 400 }] }] }],
})
const targets = gridOperatingPointTargetsForModel(base)
const validateOperatingPoint = (json: unknown) => validateGridOperatingPoint(json, 'operating-points/winter-peak.json', targets)

describe('Grid Operating Point v2', () => {
  test('accepts per-asset initial states and schedules keyed by stable ids', () => {
    const operatingPoint = validateOperatingPoint(operatingPointJson())
    expect(operatingPoint.generatorStates?.map(entry => entry.state)).toEqual(['online', 'offline'])
    expect(operatingPoint.hvdcSchedules?.[0]?.points).toHaveLength(2)
  })

  test('rejects asset ids the compiled model does not contain, with their paths', () => {
    const json = operatingPointJson()
    json.generatorStates[0]!.assetId = 'generator:nve-hydro-999'
    json.branchStates[0]!.assetId = 'branch:osm-ffffffffffffffff'
    json.hvdcSchedules[0]!.assetId = 'hvdc:missing-link'
    json.externalExchangeSchedules[0]!.assetId = 'external:FI'
    const rejection = message(() => validateOperatingPoint(json))
    expect(rejection).toStartWith('operating-points/winter-peak.json: invalid Grid Operating Point v2')
    expect(rejection).toContain('$.generatorStates[0].assetId: unknown generator generator:nve-hydro-999')
    expect(rejection).toContain('$.branchStates[0].assetId: unknown branch branch:osm-ffffffffffffffff')
    expect(rejection).toContain('$.hvdcSchedules[0].assetId: unknown HVDC link hvdc:missing-link')
    expect(rejection).toContain('$.externalExchangeSchedules[0].assetId: unknown external system external:FI')
  })

  test('bounds values by the addressed asset', () => {
    const json = operatingPointJson()
    json.generatorStates[0]!.availableMw = 301
    json.hvdcSchedules[0]!.points[1]!.transferMw = 1401
    json.externalExchangeSchedules[0]!.assetId = 'external:DE'
    const rejection = message(() => validateOperatingPoint({ ...json, priceAreaDemandScale: { NO3: 1.2 } }))
    expect(rejection).toContain('$.generatorStates[0].availableMw: must not exceed capacityMw (300)')
    expect(rejection).toContain('$.hvdcSchedules[0].points[1].transferMw: must be within ±1400 MW')
    expect(rejection).toContain('$.externalExchangeSchedules[0].assetId: external:DE is reached only through HVDC')
    expect(rejection).toContain('$.priceAreaDemandScale.NO3: the model has no loads in NO3')
  })

  test('requires coherent per-asset entries and ordered schedules', () => {
    const json = operatingPointJson()
    json.generatorStates[1] = { assetId: 'generator:nve-hydro-123', state: 'offline', targetMw: 10 } as typeof json.generatorStates[1]
    json.hvdcSchedules[0]!.points[1]!.localTime = '00:00'
    json.branchStates[0]!.availability = 0.01
    const rejection = message(() => validateOperatingPoint(json))
    expect(rejection).toContain('$.generatorStates[1].targetMw: a offline generator has no dispatch target')
    expect(rejection).toContain('$.generatorStates[1].assetId: generator:nve-hydro-123 already has an entry')
    expect(rejection).toContain('$.hvdcSchedules[0].points[1].localTime: must follow 00:00')
    expect(rejection).toContain('$.branchStates[0].availability')
    expect(message(() => validateOperatingPoint({ ...operatingPointJson(), loadScale: undefined }))).toContain('$.loadScale')
  })

  test('schedules a synchronous exchange on exactly each AC border of the model, within its ties\' rating', () => {
    // The fixture's Nordic remainder ties into NO1 at SE3 only (Hasle – Borgvik, 1850 MW).
    expect(gridExchangeBordersOf(base).get('external:nordic-remainder')).toEqual([{ priceArea: 'NO1', externalArea: 'SE3', boundaryBusIds: ['bus:boundary-SE3@400'], ratingMw: 1850 }])
    const withBorders = (borders: ReadonlyArray<Record<string, unknown>>) => message(() => validateOperatingPoint({
      ...operatingPointJson(),
      externalExchangeSchedules: [{ assetId: 'external:nordic-remainder', timeZone: 'Europe/Oslo', points: [{ localTime: '06:00', borders }] }],
    }))
    const path = '$.externalExchangeSchedules[0].points[0].borders'
    expect(withBorders([{ priceArea: 'NO2', externalArea: 'SE3', exportMw: 100 }]))
      .toContain(`${path}: required: external:nordic-remainder has the AC border NO1–SE3`)
    expect(withBorders([{ priceArea: 'NO1', externalArea: 'SE3', exportMw: 100 }, { priceArea: 'NO2', externalArea: 'SE3', exportMw: 100 }]))
      .toContain(`${path}[1]: external:nordic-remainder has no AC border NO2–SE3`)
    expect(withBorders([{ priceArea: 'NO1', externalArea: 'SE3', exportMw: -1851 }])).toContain(`${path}[0].exportMw: must be within ±1850 MW, the rating of the border's ties`)
    expect(withBorders([{ priceArea: 'NO1', externalArea: 'SE3', exportMw: 1 }, { priceArea: 'NO1', externalArea: 'SE3', exportMw: 2 }])).toContain(`${path}[1]: NO1–SE3 already has an entry`)
  })

  test('requires the season, the whole hour and the demand of every price area and group with loads', () => {
    const demand = operatingPointJson().demand
    expect(validateOperatingPoint(operatingPointJson()).demand).toEqual({ season: 'winter', referenceHour: '2026-01-15T17:00:00+01:00', priceAreaGroupMw: { NO1: { private: 760 }, NO2: { industry: 250 } }, networkLossMw: { NO1: 38, NO2: 9 } })
    const withDemand = (changed: Record<string, unknown>) => message(() => validateOperatingPoint({ ...operatingPointJson(), demand: { ...demand, ...changed } }))
    expect(message(() => validateOperatingPoint({ ...operatingPointJson(), demand: undefined }))).toContain('$.demand')
    expect(withDemand({ season: 'autumn' })).toContain('$.demand.season')
    expect(withDemand({ referenceHour: '2026-01-15T17:30:00+01:00' })).toContain('$.demand.referenceHour: must be an ISO timestamp on a whole hour with an offset')
    expect(withDemand({ referenceHour: '2026-01-15T17:00:00' })).toContain('$.demand.referenceHour')
    // The fixture model has NO1 private and NO2 industry (site) loads only.
    expect(withDemand({ priceAreaGroupMw: { NO1: { private: 760 } } })).toContain('$.demand.priceAreaGroupMw.NO2.industry: required: the model has NO2 industry loads')
    const extra = withDemand({ priceAreaGroupMw: { ...demand.priceAreaGroupMw, NO1: { private: 760, business: 10 }, NO3: { industry: 5 } } })
    expect(extra).toContain('$.demand.priceAreaGroupMw.NO1.business: the model has no NO1 business loads')
    expect(extra).toContain('$.demand.priceAreaGroupMw.NO3.industry: the model has no NO3 industry loads')
    expect(withDemand({ priceAreaGroupMw: { ...demand.priceAreaGroupMw, NO1: { private: 0 } } })).toContain('$.demand.priceAreaGroupMw.NO1.private')
    // The losses below 132 kV: one entry for exactly each price area with loads, never negative.
    expect(withDemand({ networkLossMw: { NO1: 38 } })).toContain('$.demand.networkLossMw.NO2: required: the model has NO2 loads')
    expect(withDemand({ networkLossMw: { ...demand.networkLossMw, NO3: 5 } })).toContain('$.demand.networkLossMw.NO3: the model has no loads in NO3')
    expect(withDemand({ networkLossMw: { ...demand.networkLossMw, NO1: -1 } })).toContain('$.demand.networkLossMw.NO1')
  })
})
