import { describe, expect, test } from 'bun:test'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

const model = validateGridModel(await Bun.file(new URL('./fixtures/grid-model-v2.fixture.json', import.meta.url)).json(), 'fixture')
const targets = gridOperatingPointTargetsForModel(model)
const operatingPoint = (branchRatings: ReadonlyArray<Record<string, unknown>>): unknown => ({
  schemaVersion: 2,
  id: 'electric-grid.test.summer',
  title: 'Summer',
  description: 'Summer ratings',
  compatibleModelRefs: [model.id],
  demand: { season: 'summer', referenceHour: '2026-07-12T06:00:00+02:00', priceAreaGroupMw: { NO1: { private: 300 }, NO2: { industry: 200 } }, networkLossMw: { NO1: 12, NO2: 8 } },
  loadScale: 1,
  branchRatings,
})

describe('Operating Point v2 branchRatings', () => {
  test('accepts a rating per known branch', () => {
    const point = validateGridOperatingPoint(operatingPoint([{ assetId: 'branch:osm-0123456789abcdef', ratingMw: 1600, emergencyRatingMw: 1920 }]), 'summer', targets)
    expect(point.branchRatings).toEqual([{ assetId: 'branch:osm-0123456789abcdef', ratingMw: 1600, emergencyRatingMw: 1920 }])
  })

  test('rejects an unknown branch with its path', () => {
    expect(() => validateGridOperatingPoint(operatingPoint([{ assetId: 'branch:osm-ffffffffffffffff', ratingMw: 100, emergencyRatingMw: 120 }]), 'summer', targets))
      .toThrow('$.branchRatings[0].assetId: unknown branch branch:osm-ffffffffffffffff')
  })

  test('requires emergency ≥ rating > 0 and one entry per branch', () => {
    expect(() => validateGridOperatingPoint(operatingPoint([{ assetId: 'branch:osm-0123456789abcdef', ratingMw: 100, emergencyRatingMw: 90 }]), 'summer', targets))
      .toThrow('emergencyRatingMw')
    expect(() => validateGridOperatingPoint(operatingPoint([{ assetId: 'branch:osm-0123456789abcdef', ratingMw: 0, emergencyRatingMw: 90 }]), 'summer', targets))
      .toThrow('ratingMw')
    expect(() => validateGridOperatingPoint(operatingPoint([
      { assetId: 'branch:osm-0123456789abcdef', ratingMw: 100, emergencyRatingMw: 120 },
      { assetId: 'branch:osm-0123456789abcdef', ratingMw: 110, emergencyRatingMw: 130 },
    ]), 'summer', targets)).toThrow('already has an entry')
  })
})
