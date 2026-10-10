import {
  degreesForKm,
  distanceToStationKm,
  geometryBbox,
  haversineKm,
  kmPerDegreeLon,
  measurePolygon,
  pointInStationPolygon,
  type Bbox,
  type LonLat,
  type TopologyStationGeometry,
} from './geometry.ts'
import { compareText } from './ids.ts'
import type { TopologyStationInput } from './input.ts'
import type { TopologyOptions } from './options.ts'

export type ContainerStation = TopologyStationInput & { readonly geometry: TopologyStationGeometry }

export type StationContainer = {
  readonly index: number
  readonly station: ContainerStation
  readonly isPoint: boolean
  readonly bbox: Bbox
  readonly areaKm2: number
  readonly anchor: LonLat                 // area centroid, or the station node
}

export type StationHitMethod = 'inside' | 'buffer' | 'point-radius'

export type StationHit = {
  readonly container: StationContainer
  readonly method: StationHitMethod
  readonly distanceM: number
  readonly tier: number                   // lower is preferred
}

export type StationIndex = {
  readonly containers: ReadonlyArray<StationContainer>
  // Ranked terminal candidates for a way end at `point` (best first, same-tier alternatives after).
  readonly locate: (point: LonLat) => ReadonlyArray<StationHit>
  // Polygon stations that strictly contain `point` (no buffer).
  readonly containing: (point: LonLat) => ReadonlyArray<StationContainer>
  readonly nearest: (point: LonLat, maximumKm: number) => { readonly container: StationContainer; readonly distanceKm: number } | null
}

// Grid cell edge in degrees: ≈1.1 km of longitude and 2.2 km of latitude at 60° N.
const cellDegrees = 0.02

const cellOf = (value: number): number => Math.floor(value / cellDegrees)

export const createStationContainers = (stations: ReadonlyArray<ContainerStation>): ReadonlyArray<StationContainer> =>
  stations.map((station, index) => {
    if (station.geometry.type === 'Point') {
      return { index, station, isPoint: true, bbox: geometryBbox(station.geometry), areaKm2: 0, anchor: station.geometry.coordinates }
    }
    const measure = measurePolygon(station.geometry)
    return { index, station, isPoint: false, bbox: geometryBbox(station.geometry), areaKm2: measure.areaKm2, anchor: measure.centroid }
  })

const tierOf = (container: StationContainer, method: StationHitMethod): number => {
  const plant = container.station.kind === 'plant' ? 1 : 0
  if (method === 'inside') return plant
  if (method === 'buffer') return 2 + plant
  return 4 + plant
}

const compareHits = (left: StationHit, right: StationHit): number =>
  left.tier - right.tier ||
  (left.method === 'inside' ? left.container.areaKm2 - right.container.areaKm2 : left.distanceM - right.distanceM) ||
  compareText(left.container.station.featureId, right.container.station.featureId)

export const createStationIndex = (
  containers: ReadonlyArray<StationContainer>,
  options: Pick<TopologyOptions, 'substationBufferM' | 'pointStationRadiusM'>,
): StationIndex => {
  const cells = new Map<string, StationContainer[]>()
  const reachKm = Math.max(options.substationBufferM, options.pointStationRadiusM) / 1000
  for (const container of containers) {
    const pad = degreesForKm(reachKm, Math.max(Math.abs(container.bbox[1]), Math.abs(container.bbox[3])))
    for (let x = cellOf(container.bbox[0] - pad.lon); x <= cellOf(container.bbox[2] + pad.lon); x += 1) {
      for (let y = cellOf(container.bbox[1] - pad.lat); y <= cellOf(container.bbox[3] + pad.lat); y += 1) {
        const key = `${x},${y}`
        const list = cells.get(key)
        if (list) list.push(container)
        else cells.set(key, [container])
      }
    }
  }
  const candidatesAt = (point: LonLat): ReadonlyArray<StationContainer> => cells.get(`${cellOf(point[0])},${cellOf(point[1])}`) ?? []

  const locate = (point: LonLat): ReadonlyArray<StationHit> => {
    const hits: StationHit[] = []
    for (const container of candidatesAt(point)) {
      const distanceM = distanceToStationKm(point, container.station.geometry) * 1000
      const method: StationHitMethod | null = container.isPoint
        ? (distanceM <= options.pointStationRadiusM ? 'point-radius' : null)
        : distanceM === 0 ? 'inside' : distanceM <= options.substationBufferM ? 'buffer' : null
      if (method) hits.push({ container, method, distanceM, tier: tierOf(container, method) })
    }
    return hits.sort(compareHits)
  }

  const containing = (point: LonLat): ReadonlyArray<StationContainer> =>
    candidatesAt(point).filter(container =>
      container.station.geometry.type !== 'Point' && pointInStationPolygon(point, container.station.geometry))

  const nearest = (point: LonLat, maximumKm: number): { container: StationContainer; distanceKm: number } | null => {
    const cellKm = Math.min(cellDegrees * kmPerDegreeLon(point[1]), cellDegrees * 110.574)
    const maximumRing = Math.ceil(maximumKm / cellKm) + 1
    const cx = cellOf(point[0])
    const cy = cellOf(point[1])
    let best: { container: StationContainer; distanceKm: number } | null = null
    const seen = new Set<number>()
    for (let ring = 0; ring <= maximumRing; ring += 1) {
      // Every container in ring r is at least (r - 1) cells away.
      if (best && (ring - 1) * cellKm > best.distanceKm) break
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        for (let y = cy - ring; y <= cy + ring; y += 1) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue
          for (const container of cells.get(`${x},${y}`) ?? []) {
            if (seen.has(container.index)) continue
            seen.add(container.index)
            const distanceKm = container.isPoint
              ? haversineKm(point, container.anchor)
              : distanceToStationKm(point, container.station.geometry)
            if (distanceKm <= maximumKm && (!best || distanceKm < best.distanceKm ||
              (distanceKm === best.distanceKm && compareText(container.station.featureId, best.container.station.featureId) < 0))) {
              best = { container, distanceKm }
            }
          }
        }
      }
    }
    return best
  }

  return { containers, locate, containing, nearest }
}
