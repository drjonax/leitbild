import { describe, expect, test } from 'bun:test'
import { allocateByPopulation, openWaterRule } from '../src/packs/electric-grid/model-build/population-weights.ts'
import type { Station, StationIndex } from '../src/packs/electric-grid/model-build/stations.ts'
import { createWaterCrossings } from '../src/packs/electric-grid/model-build/water-crossings.ts'

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
    water: createWaterCrossings([[[20, 70], [20.001, 70]]]),
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

describe('model build: population allocation across open water', () => {
  // A fjord between two coastlines at 60.000° and 60.015° N (about 1.7 km of sea north–south).
  const fjord = [[[9.9, 60], [10.1, 60]], [[9.9, 60.015], [10.1, 60.015]]] as const
  const water = createWaterCrossings(fjord)
  const municipality = { municipalityNumber: '0001', point: [10, 59.99] as const, bbox: [9.8, 59.8, 10.2, 60.2] as const, priceArea: 'NO1' as const }
  const allocate = (stations: ReadonlyArray<Station>, centre: readonly [number, number]) => allocateByPopulation({
    stations: index(stations), water, municipalities: [municipality], squares: [{ id: 'a', centre, population: 100 }],
  })

  test('measures the open water between a place and a station on the far shore', () => {
    expect(water.openWaterKm([10, 59.99], [10, 60.02])).toBeCloseTo(0.015 * 110.574, 1)
    expect(water.openWaterKm([10, 59.99], [10, 59.96])).toBe(0)
    // A place offshore (a square centre in the fjord) is not across open water from the far shore.
    expect(water.openWaterKm([10, 60.005], [10, 60.02])).toBe(0)
  })

  test('serves a square from a substation on its own shore when the nearest lies across the fjord', () => {
    const across = station('across', [10, 60.02], 'NO1')
    const shore = station('shore', [10, 59.96], 'NO1')
    const moved = allocate([across, shore], [10, 59.99])
    expect(moved.sharesOf('0001')!.map(entry => entry.station.stationId)).toEqual(['shore'])
    expect(moved.acrossOpenWater).toEqual({ squares: 1, residents: 100 })
    // A same-shore substation beyond the distance factor leaves the square at the nearest one.
    const far = station('far', [10, 59.99 - 0.03 * (openWaterRule.maximumDistanceFactor + 0.5)], 'NO1')
    const kept = allocate([across, far], [10, 59.99])
    expect(kept.sharesOf('0001')!.map(entry => entry.station.stationId)).toEqual(['across'])
    expect(kept.acrossOpenWater).toEqual({ squares: 0, residents: 0 })
  })
})
