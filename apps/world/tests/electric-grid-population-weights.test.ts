import { describe, expect, test } from 'bun:test'
import { allocateByPopulation } from '../src/packs/electric-grid/model-build/population-weights.ts'
import type { Station, StationIndex } from '../src/packs/electric-grid/model-build/stations.ts'

const station = (stationId: string, location: readonly [number, number], priceArea: Station['priceArea'], kind: Station['kind'] = 'substation', transitionOnly = false): Station => ({
  stationId, kind, label: stationId, location, priceArea, buses: [], featureIds: [], transitionOnly,
})

const index = (stations: ReadonlyArray<Station>): StationIndex => ({
  stations,
  containing: () => undefined,
  byFeatureId: () => undefined,
  nearest: () => undefined,
})

describe('model build: population allocation', () => {
  const stations = index([
    station('west', [10, 60], 'NO1'),
    station('east', [11, 60], 'NO1'),
    station('plant', [10.4, 60], 'NO1', 'plant-terminal'),
    station('cable-transition', [10.12, 60], 'NO1', 'substation', true),
    station('other-area', [10.5, 60], 'NO2'),
  ])
  const allocation = allocateByPopulation({
    stations,
    municipalities: [
      { municipalityNumber: '0001', point: [10.2, 60], bbox: [9.8, 59.9, 10.6, 60.1], priceArea: 'NO1' },
      { municipalityNumber: '0002', point: [10.8, 60], bbox: [10.6, 59.9, 11.2, 60.1], priceArea: 'NO1' },
    ],
    squares: [
      { id: 'a', centre: [10.1, 60], population: 300 },
      { id: 'b', centre: [10.45, 60], population: 100 },
      { id: 'c', centre: [10.9, 60], population: 50 },
      { id: 'd', centre: [12, 60], population: 10 },
    ],
  })

  test("shares a municipality's residents over the nearest substations of its price area", () => {
    // a lies nearest a cable transition point and b nearest the plant terminal and the NO2 station,
    // but only NO1 substations with a transformation serve load.
    const shares = allocation.sharesOf('0001')!
    expect(shares.map(entry => [entry.station.stationId, entry.residents, entry.share])).toEqual([['west', 400, 1]])
    expect(shares[0]!.centre[0]).toBeCloseTo((10.1 * 300 + 10.45 * 100) / 400, 9)
  })

  test('assigns a square outside every bounding box to the nearest municipality point', () => {
    expect(allocation.squaresOutsideEveryBox).toBe(1)
    expect(allocation.sharesOf('0002')!.map(entry => [entry.station.stationId, entry.residents])).toEqual([['east', 60]])
    expect(allocation.sharesOf('0003')).toBeUndefined()
  })
})
