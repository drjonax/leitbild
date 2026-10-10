import type { GeoJsonGeometry, GeoJsonPosition } from '../../../reference-data/types.ts'
import type { AuditFootprint, LonLat } from './audit-graph.ts'
import { haversineKm } from './geodesy.ts'

// Reference geometry for the audit adapters: line polylines and station footprints looked up by
// the source feature id of a normalised grid sidecar (GeoJSON features with properties.externalId).

export interface ReferenceFeatureInput {
  readonly geometry: GeoJsonGeometry
  readonly properties: { readonly externalId: string; readonly tags?: Readonly<Record<string, string>> }
}

export interface ReferenceGeometry {
  readonly polylines: (externalId: string) => ReadonlyArray<ReadonlyArray<LonLat>> | undefined
  readonly footprint: (externalId: string) => AuditFootprint | undefined
  /** OSM way ids a merged sidecar line was built from (`leitbild:merged_source_ids`). */
  readonly mergedWayIds: (externalId: string) => ReadonlyArray<string> | undefined
}

const lonLat = (position: GeoJsonPosition): LonLat => [position[0], position[1]]

const footprintOf = (geometry: GeoJsonGeometry): AuditFootprint | undefined => {
  switch (geometry.type) {
    case 'Point': return { kind: 'point', location: lonLat(geometry.coordinates) }
    case 'Polygon': return { kind: 'polygon', polygons: [geometry.coordinates.map(ring => ring.map(lonLat))] }
    case 'MultiPolygon': return { kind: 'polygon', polygons: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(lonLat))) }
    case 'LineString': return undefined
  }
}

export const createReferenceGeometry = (features: ReadonlyArray<ReferenceFeatureInput>): ReferenceGeometry => {
  const byId = new Map<string, ReferenceFeatureInput>()
  for (const feature of features) {
    const id = feature.properties.externalId
    if (byId.has(id)) throw new Error(`reference geometry: duplicate feature id ${id}`)
    byId.set(id, feature)
  }
  return {
    polylines: externalId => {
      const geometry = byId.get(externalId)?.geometry
      return geometry?.type === 'LineString' ? [geometry.coordinates.map(lonLat)] : undefined
    },
    footprint: externalId => {
      const feature = byId.get(externalId)
      return feature === undefined ? undefined : footprintOf(feature.geometry)
    },
    mergedWayIds: externalId => {
      const raw = byId.get(externalId)?.properties.tags?.['leitbild:merged_source_ids']
      return raw === undefined ? undefined : raw.split(';').map(id => id.trim()).filter(id => id.length > 0)
    },
  }
}

/**
 * Pairs the free ends of a branch's polylines with its terminals: the end nearest the from bus,
 * then the remaining end nearest the to bus.
 */
export const pairBranchEnds = (
  polylines: ReadonlyArray<ReadonlyArray<LonLat>>,
  fromLocation: LonLat,
  toLocation: LonLat,
): { readonly from: LonLat; readonly to: LonLat } | undefined => {
  const ends = polylines.flatMap(line => line.length >= 2 ? [line[0]!, line[line.length - 1]!] : [])
  if (ends.length < 2) return undefined
  const nearest = (target: LonLat, exclude: number): number => {
    let best = -1
    let bestKm = Number.POSITIVE_INFINITY
    ends.forEach((end, index) => {
      if (index === exclude) return
      const km = haversineKm(end, target)
      if (km < bestKm) {
        bestKm = km
        best = index
      }
    })
    return best
  }
  const fromIndex = nearest(fromLocation, -1)
  const toIndex = nearest(toLocation, fromIndex)
  return { from: ends[fromIndex]!, to: ends[toIndex]! }
}
