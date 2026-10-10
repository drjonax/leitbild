import { describe, expect, test } from 'bun:test'
import { validateGridModel, type GridModelV2 } from '../src/packs/electric-grid/schemas/grid-model.ts'

const fixturePath = new URL('./fixtures/grid-model-v2.fixture.json', import.meta.url)
const fixture = await Bun.file(fixturePath).json() as GridModelV2

type Draft = { -readonly [Key in keyof GridModelV2]: any }
const variant = (change: (model: Draft) => void): unknown => {
  const copy = structuredClone(fixture) as Draft
  change(copy)
  return copy
}
const rejection = (json: unknown): string => {
  try {
    validateGridModel(json, 'models/test.grid-model.json')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the Grid Model to be rejected')
}

describe('Grid Model v2 schema', () => {
  test('accepts the hand-written fixture as a typed model', () => {
    const model = validateGridModel(fixture, 'fixture')
    expect(model.schemaVersion).toBe(2)
    expect(model.buses.map(bus => bus.kind)).toEqual(['substation', 'substation', 'substation', 'junction', 'boundary', 'boundary', 'plant-terminal'])
    expect(model.branches.map(branch => branch.kind)).toEqual(['ac_line', 'ac_line', 'ac_line', 'transformer', 'ac_line'])
    expect(model.externalSystems.map(system => system.synchronous)).toEqual([true, false])
  })

  test('names the data source and the JSON path of each issue', () => {
    const message = rejection(variant(model => { delete model.buses[0].priceArea; model.branches[1].ratingMw = -1 }))
    expect(message).toStartWith('models/test.grid-model.json: invalid Grid Model v2')
    expect(message).toContain('$.buses[0].priceArea: required for a non-boundary bus')
    expect(message).toContain('$.branches[1].ratingMw')
  })

  test('resolves every bus reference and keeps assets on the right side of the border', () => {
    expect(rejection(variant(model => { model.branches[0].toBusId = 'bus:osm-way-1@420' }))).toContain('$.branches[0].toBusId: unknown bus bus:osm-way-1@420')
    expect(rejection(variant(model => { model.generators[0].busId = 'bus:osm-way-1@420' }))).toContain('$.generators[0].busId: unknown bus')
    expect(rejection(variant(model => { model.loads[1].busId = 'bus:boundary-DE' }))).toContain('$.loads[1].busId: bus:boundary-DE is a boundary bus')
    expect(rejection(variant(model => { model.connectionPoints[0].busId = 'bus:osm-way-1@420' }))).toContain('$.connectionPoints[0].busId: unknown bus')
    expect(rejection(variant(model => { model.hvdcLinks[0].fromBusId = 'bus:boundary-SE3' }))).toContain('$.hvdcLinks[0].fromBusId')
    expect(rejection(variant(model => { model.externalSystems[1].boundaryBusIds = ['bus:osm-way-60495669@420'] })))
      .toContain('$.externalSystems[1].boundaryBusIds[0]: bus:osm-way-60495669@420 is not a boundary bus')
    expect(rejection(variant(model => { model.externalSystems[1].boundaryBusIds = ['bus:boundary-SE3'] })))
      .toContain('$.externalSystems[1].boundaryBusIds[0]: bus:boundary-SE3 already belongs to external:nordic-remainder')
    expect(rejection(variant(model => { model.connectionPoints[0].nominalKv = 132 }))).toContain('$.connectionPoints[0].nominalKv')
  })

  test('requires unique ids across all asset collections', () => {
    expect(rejection(variant(model => { model.generators[1].id = model.generators[0].id })))
      .toContain('$.generators[1].id: duplicates the id at generators[0]')
    expect(rejection(variant(model => { model.connectionPoints.push({ ...model.connectionPoints[0] }) })))
      .toContain('$.connectionPoints[1].id: duplicates the id at connectionPoints[0]')
  })

  test('accepts only source-identity ids from the id grammar', () => {
    expect(rejection(variant(model => { model.buses[0].id = 'NO-HASLE-TRAFOSTASJON-420-WAY-60495669' }))).toContain('$.buses[0].id: must be a Grid bus id')
    expect(rejection(variant(model => { model.branches[0].id = 'branch:hasle-sylling-420' }))).toContain('$.branches[0].id: must be a Grid branch id')
    expect(rejection(variant(model => { model.generators[0].id = 'generator:kvilldal' }))).toContain('$.generators[0].id')
    expect(rejection(variant(model => { model.buses[2].id = 'bus:osm-relation-7928148@400' }))).toContain('$.buses[2].id: the id voltage suffix must be @420')
    expect(rejection(variant(model => { model.buses[2].substationId = 'osm-way-1' }))).toContain('$.buses[2].id: a substation bus id must be bus:osm-way-1@420')
    expect(rejection(variant(model => { model.buses[4].externalArea = 'SE2' }))).toContain('$.buses[4].id: a boundary bus id must be bus:boundary-SE2')
    expect(rejection(variant(model => { model.externalSystems[1].id = 'external:NL' }))).toContain('$.externalSystems[1].id: must be external:DE')
    expect(rejection(variant(model => { model.generators[2].busId = 'bus:osm-way-60495669@420' }))).toContain('$.generators[2].busId: the aggregate id names bus bus:osm-way-60495669@132')
    expect(rejection(variant(model => { model.loads[0].municipalityNr = '0302' }))).toContain('$.loads[0].municipalityNr: the id names municipality 0301')
    expect(rejection(variant(model => { model.connectionPoints[0].id = 'Unit 1' }))).toContain('$.connectionPoints[0].id')
  })

  test('requires an emergency rating at least the continuous rating', () => {
    expect(rejection(variant(model => { model.branches[2].emergencyRatingMw = 1800 }))).toContain('$.branches[2].emergencyRatingMw: must be at least ratingMw (1850)')
  })

  test('requires a price area on Norwegian buses and an external area on boundary buses', () => {
    expect(rejection(variant(model => { delete model.buses[3].priceArea }))).toContain('$.buses[3].priceArea: required for a non-boundary bus')
    expect(rejection(variant(model => { delete model.buses[4].externalArea }))).toContain('$.buses[4].externalArea: required for a boundary bus')
    expect(rejection(variant(model => { model.buses[5].priceArea = 'NO2' }))).toContain('$.buses[5].priceArea: a boundary bus lies outside')
    expect(rejection(variant(model => { model.buses[0].externalArea = 'SE3' }))).toContain('$.buses[0].externalArea: only boundary buses')
  })

  test('requires a provenance note for inferred and curated assets and recorded sources', () => {
    expect(rejection(variant(model => { delete model.branches[3].provenance.note }))).toContain('$.branches[3].provenance.note: a note is required for inferred provenance')
    expect(rejection(variant(model => { delete model.buses[6].provenance.note }))).toContain('$.buses[6].provenance.note: a note is required for curated provenance')
    expect(rejection(variant(model => { model.buses[6].provenance = { sources: ['osm:pbf-power:NO@2026-10-09'], method: 'mapped', confidence: 'high' } })))
      .toContain('$.buses[6].provenance.method: a curated id requires curated provenance')
    expect(rejection(variant(model => { model.generators[0].provenance.sources = ['nve:vannkraft1@2025-01-01'] })))
      .toContain('$.generators[0].provenance.sources[0]: nve:vannkraft1@2025-01-01 is not a sourceBuild input')
  })

  test('requires inertia and load for synchronous external systems only', () => {
    const missing = rejection(variant(model => { delete model.externalSystems[0].inertiaGws; delete model.externalSystems[0].loadMw }))
    expect(missing).toContain('$.externalSystems[0].inertiaGws: required for a synchronous external system')
    expect(missing).toContain('$.externalSystems[0].loadMw: required for a synchronous external system')
    expect(rejection(variant(model => { model.externalSystems[1].inertiaGws = 200 }))).toContain('$.externalSystems[1].inertiaGws: only a synchronous external system')
    expect(rejection(variant(model => { model.externalSystems[1].synchronous = true; model.externalSystems[1].inertiaGws = 200; model.externalSystems[1].loadMw = 50_000 })))
      .toContain('$.externalSystems[1].synchronous: DE is not synchronous with the Nordic system')
    expect(rejection(variant(model => { model.externalSystems = [model.externalSystems[0]] }))).toContain('$.buses[5].id: a boundary bus must belong to exactly one external system')
  })

  test('requires finite, non-negative attachment distances', () => {
    expect(rejection(variant(model => { model.generators[0].attachmentKm = Number.POSITIVE_INFINITY }))).toContain('$.generators[0].attachmentKm')
    expect(rejection(variant(model => { model.loads[0].attachmentKm = Number.NaN }))).toContain('$.loads[0].attachmentKm')
    expect(rejection(variant(model => { model.loads[1].attachmentKm = -1 }))).toContain('$.loads[1].attachmentKm')
  })

  test('keeps line, transformer and HVDC geometry consistent', () => {
    expect(rejection(variant(model => { delete model.branches[0].lengthKm }))).toContain('$.branches[0].lengthKm: required for ac_line')
    expect(rejection(variant(model => { model.branches[3].lengthKm = 1 }))).toContain('$.branches[3].lengthKm: a transformer has no length')
    expect(rejection(variant(model => { model.branches[0].osmWayIds = [] }))).toContain('$.branches[0].osmWayIds: empty only for inferred transformers and curated branches')
    expect(rejection(variant(model => { model.branches[3].toBusId = 'bus:osm-relation-7928148@420' }))).toContain('$.branches[3].toBusId: a transformer connects two voltage levels')
    expect(rejection(variant(model => { model.branches[3].id = 'branch:transformer-osm-way-1-420-132' }))).toContain('$.branches[3].id: both buses must belong to substation osm-way-1')
    expect(rejection(variant(model => { model.branches[0].toBusId = model.branches[0].fromBusId }))).toContain('$.branches[0].toBusId: a branch must connect two different buses')
    expect(rejection(variant(model => { model.storage = [{ id: 'storage:invented' }] }))).toContain('$.storage')
  })

  test('requires converter-connected units to carry no synchronous inertia', () => {
    expect(rejection(variant(model => { model.generators[1].inertiaSeconds = 1 }))).toContain('$.generators[1].inertiaSeconds: a converter-connected unit has no synchronous inertia')
    expect(rejection(variant(model => { model.generators[0].minimumStableMw = 400 }))).toContain('$.generators[0].minimumStableMw: must not exceed capacityMw (300)')
  })
})
