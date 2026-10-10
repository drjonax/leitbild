import { pointInPolygon } from '../../../reference-data/point-in-polygon.ts'
import type { PriceArea } from '../schemas/grid-ids.ts'
import type { GridBusV2 } from '../schemas/grid-model.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyPolygonGeometry } from '../topology/geometry.ts'
import type { TopologyBus } from '../topology/result.ts'
import { overheadRules, voltageClassOf } from './electrical.ts'
import { haversineKm, type LonLat } from './geo.ts'

// Stations of the main AC island that generators and loads attach to: one entry per station
// with its voltage-level buses, its OSM feature ids (for containment) and its price area.

export interface Station {
  readonly stationId: string
  readonly kind: 'substation' | 'plant-terminal'
  readonly label: string
  readonly location: LonLat
  readonly priceArea: PriceArea
  /** Voltage-level buses, lowest voltage first. */
  readonly buses: ReadonlyArray<GridBusV2>
  readonly featureIds: ReadonlyArray<string>
}

export interface StationIndex {
  readonly stations: ReadonlyArray<Station>
  /** Station whose mapped outline (any member feature) contains the point. */
  readonly containing: (point: LonLat) => Station | undefined
  readonly byFeatureId: (featureId: string) => Station | undefined
  readonly nearest: (point: LonLat, accept: (station: Station) => boolean) => { readonly station: Station; readonly km: number } | undefined
}

type PolygonGeometry = TopologyPolygonGeometry

export const createStationIndex = (
  buses: ReadonlyArray<GridBusV2>,
  topologyBuses: ReadonlyArray<TopologyBus>,
  mainBusIds: ReadonlySet<string>,
  outlineOf: (featureId: string) => PolygonGeometry | undefined,
): StationIndex => {
  const featureIdsOf = new Map<string, Set<string>>()
  for (const bus of topologyBuses) {
    if (bus.stationId === null) continue
    const set = featureIdsOf.get(bus.stationId) ?? new Set<string>()
    for (const id of bus.stationFeatureIds) set.add(id)
    featureIdsOf.set(bus.stationId, set)
  }
  const grouped = new Map<string, GridBusV2[]>()
  for (const bus of buses) {
    if (bus.substationId === undefined || !mainBusIds.has(bus.id)) continue
    if (bus.kind !== 'substation' && bus.kind !== 'plant-terminal') continue
    grouped.set(bus.substationId, [...(grouped.get(bus.substationId) ?? []), bus])
  }
  // `osm-way-123` → `way/123`: the representative feature belongs to its own station.
  const representative = (stationId: string): string => stationId.replace(/^osm-(node|way|relation)-/, '$1/')
  const stations: Station[] = [...grouped].sort(([left], [right]) => compareText(left, right)).map(([stationId, levels]) => {
    const sorted = [...levels].sort((left, right) => left.nominalKv - right.nominalKv)
    const first = sorted[0]!
    return {
      stationId,
      kind: sorted.some(bus => bus.kind === 'substation') ? 'substation' : 'plant-terminal',
      label: first.label.replace(/ \d+ kV$/, ''),
      location: first.location,
      priceArea: first.priceArea!,
      buses: sorted,
      featureIds: [...new Set([representative(stationId), ...(featureIdsOf.get(stationId) ?? [])])].sort(compareText),
    }
  })
  const byFeature = new Map<string, Station>()
  const outlines: Array<{ readonly station: Station; readonly geometry: PolygonGeometry }> = []
  for (const station of stations) {
    for (const featureId of station.featureIds) {
      byFeature.set(featureId, station)
      const geometry = outlineOf(featureId)
      if (geometry !== undefined) outlines.push({ station, geometry })
    }
  }
  return {
    stations,
    containing: point => outlines.find(entry => pointInPolygon(point, entry.geometry))?.station,
    byFeatureId: featureId => byFeature.get(featureId),
    nearest: (point, accept) => {
      let best: { station: Station; km: number } | undefined
      for (const station of stations) {
        if (!accept(station)) continue
        const km = haversineKm(point, station.location)
        if (best === undefined || km < best.km || (km === best.km && compareText(station.stationId, best.station.stationId) < 0)) best = { station, km }
      }
      return best
    },
  }
}

/**
 * The level a unit of this capacity connects at: the lowest level whose single overhead circuit
 * (overheadRules) carries it, else the station's highest level.
 */
export const levelForCapacity = (station: Station, capacityMw: number): GridBusV2 =>
  station.buses.find(bus => overheadRules[voltageClassOf(bus.nominalKv)].ratingMvaPerCircuit >= capacityMw) ?? station.buses.at(-1)!

/** Distributed demand connects at the station's lowest (regional) level. */
export const lowestLevel = (station: Station): GridBusV2 => station.buses[0]!
