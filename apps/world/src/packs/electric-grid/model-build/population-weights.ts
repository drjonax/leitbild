import type { PriceArea } from '../schemas/grid-ids.ts'
import { compareText } from '../topology/ids.ts'
import { haversineKm, type LonLat } from './geo.ts'
import { servesLoad, type Station, type StationIndex } from './stations.ts'

// Where a municipality's demand enters the ≥132 kV grid: Elhub meters demand per municipality only,
// so the municipality's residents (SSB 1 km grid) stand in for its consumers. Each populated square
// belongs to the municipality whose Kartverket bounding box contains it and whose representative
// point is nearest (Kartverket publishes no outline with the point), and is served by the nearest
// ≥132 kV substation of that municipality's price area that serves load (stations.ts servesLoad). A substation's share of the municipality's
// demand is its share of the municipality's residents.

export interface PopulationSquare {
  readonly id: string
  readonly centre: LonLat
  readonly population: number
}

export interface MunicipalityPlace {
  readonly municipalityNumber: string
  readonly point: LonLat
  readonly bbox: readonly [west: number, south: number, east: number, north: number]
  readonly priceArea: PriceArea
}

export interface StationShare {
  readonly station: Station
  /** Share of the municipality's residents served by this station. */
  readonly share: number
  readonly residents: number
  /** Resident-weighted centre of the squares the station serves. */
  readonly centre: LonLat
  /** Resident-weighted mean distance from those squares to the station, km. */
  readonly meanKm: number
}

export interface PopulationAllocation {
  /** Station shares per municipality number, largest first; absent for a municipality without residents in the grid. */
  readonly sharesOf: (municipalityNumber: string) => ReadonlyArray<StationShare> | undefined
  /** Squares no municipality bounding box contains (assigned to the nearest municipality point). */
  readonly squaresOutsideEveryBox: number
}

const insideBox = (point: LonLat, bbox: MunicipalityPlace['bbox']): boolean =>
  point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]

export const allocateByPopulation = (config: {
  readonly squares: ReadonlyArray<PopulationSquare>
  readonly municipalities: ReadonlyArray<MunicipalityPlace>
  readonly stations: StationIndex
}): PopulationAllocation => {
  const municipalities = [...config.municipalities].sort((left, right) => compareText(left.municipalityNumber, right.municipalityNumber))
  const eligibleOf = new Map<PriceArea, Station[]>()
  for (const station of config.stations.stations) {
    if (!servesLoad(station)) continue
    eligibleOf.set(station.priceArea, [...(eligibleOf.get(station.priceArea) ?? []), station])
  }
  const nearestOf = <T extends object>(point: LonLat, items: ReadonlyArray<T>, locate: (item: T) => LonLat): { readonly item: T; readonly km: number } => {
    if (items.length === 0) throw new Error('population allocation: nothing to choose the nearest from')
    let best = items[0]!
    let bestKm = haversineKm(point, locate(best))
    for (let index = 1; index < items.length; index += 1) {
      const item = items[index]!
      const km = haversineKm(point, locate(item))
      if (km < bestKm) {
        best = item
        bestKm = km
      }
    }
    return { item: best, km: bestKm }
  }
  type Sum = { station: Station; residents: number; lon: number; lat: number; km: number }
  const sums = new Map<string, Map<string, Sum>>()
  let outside = 0
  for (const square of config.squares) {
    const boxes = municipalities.filter(place => insideBox(square.centre, place.bbox))
    if (boxes.length === 0) outside += 1
    const owner = nearestOf(square.centre, boxes.length > 0 ? boxes : municipalities, place => place.point).item
    const eligible = eligibleOf.get(owner.priceArea)
    if (eligible === undefined) throw new Error(`municipality ${owner.municipalityNumber}: no ≥132 kV substation in ${owner.priceArea}`)
    const served = nearestOf(square.centre, eligible, station => station.location)
    const perStation = sums.get(owner.municipalityNumber) ?? new Map<string, Sum>()
    const sum = perStation.get(served.item.stationId) ?? { station: served.item, residents: 0, lon: 0, lat: 0, km: 0 }
    sum.residents += square.population
    sum.lon += square.centre[0] * square.population
    sum.lat += square.centre[1] * square.population
    sum.km += served.km * square.population
    perStation.set(served.item.stationId, sum)
    sums.set(owner.municipalityNumber, perStation)
  }
  const shares = new Map<string, ReadonlyArray<StationShare>>()
  for (const [municipalityNumber, perStation] of sums) {
    const total = [...perStation.values()].reduce((sum, entry) => sum + entry.residents, 0)
    shares.set(municipalityNumber, [...perStation.values()]
      .map(entry => ({
        station: entry.station,
        share: entry.residents / total,
        residents: entry.residents,
        centre: [entry.lon / entry.residents, entry.lat / entry.residents] as const,
        meanKm: entry.km / entry.residents,
      }))
      .sort((left, right) => right.residents - left.residents || compareText(left.station.stationId, right.station.stationId)))
  }
  return { sharesOf: municipalityNumber => shares.get(municipalityNumber), squaresOutsideEveryBox: outside }
}
