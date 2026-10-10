import type { GeoJsonGeometry, GeoJsonPosition } from '../../../reference-data/types.ts'
import type { GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'
import type { OsmRelationMember } from './osm-pbf-reader.ts'

// Geometry assembly for OSM power elements. Way-based geometry keeps the OSM node id of every position.

export type NodeCoordinates = ReadonlyMap<number, GeoJsonPosition>
export type WayRefs = ReadonlyMap<number, ReadonlyArray<number>>

export type GeometryFailure =
  | 'missing-node-coordinates'
  | 'degenerate-way'
  | 'missing-member-way'
  | 'unclosed-multipolygon'
  | 'no-member-coordinates'

export type GeometryOutcome =
  | {
      readonly ok: true
      readonly geometry: GeoJsonGeometry
      readonly osmNodeIds: ReadonlyArray<string> | null
      readonly geometrySource: GridReferenceFeatureProperties['geometrySource']
    }
  | { readonly ok: false; readonly failure: GeometryFailure }

export type GeometrySuccess = Extract<GeometryOutcome, { readonly ok: true }>

const failed = (failure: GeometryFailure): GeometryOutcome => ({ ok: false, failure })

export const osmNodeId = (id: number): string => `node/${id}`

const positionsOf = (refs: ReadonlyArray<number>, coordinates: NodeCoordinates): ReadonlyArray<GeoJsonPosition> | null => {
  const positions: GeoJsonPosition[] = []
  for (const ref of refs) {
    const position = coordinates.get(ref)
    if (!position) return null
    positions.push(position)
  }
  return positions
}

const isClosedRing = (refs: ReadonlyArray<number>): boolean =>
  refs.length >= 4 && refs[0] === refs[refs.length - 1]

export const pointGeometry = (id: number, position: GeoJsonPosition): GeometrySuccess => ({
  ok: true,
  geometry: { type: 'Point', coordinates: position },
  osmNodeIds: [osmNodeId(id)],
  geometrySource: 'osm-node',
})

/** A way becomes a Polygon when it is a closed ring of an area category, otherwise a LineString. */
export const wayGeometry = (
  refs: ReadonlyArray<number>,
  coordinates: NodeCoordinates,
  areaCategory: boolean,
): GeometryOutcome => {
  if (refs.length < 2) return failed('degenerate-way')
  const positions = positionsOf(refs, coordinates)
  if (!positions) return failed('missing-node-coordinates')
  const osmNodeIds = refs.map(osmNodeId)
  if (areaCategory && isClosedRing(refs)) {
    return { ok: true, geometry: { type: 'Polygon', coordinates: [positions] }, osmNodeIds, geometrySource: 'osm-way' }
  }
  return { ok: true, geometry: { type: 'LineString', coordinates: positions }, osmNodeIds, geometrySource: 'osm-way' }
}

/** Joins way segments into rings by shared end node ids. */
export const assembleRings = (
  segments: ReadonlyArray<ReadonlyArray<number>>,
): { readonly rings: ReadonlyArray<ReadonlyArray<number>>; readonly openSegmentCount: number } => {
  const open = segments.filter(segment => segment.length >= 2).map(segment => [...segment])
  const rings: number[][] = []
  let openSegmentCount = 0
  while (open.length > 0) {
    const ring = open.shift()!
    let extended = true
    while (extended && ring[0] !== ring[ring.length - 1]) {
      extended = false
      const end = ring[ring.length - 1]
      for (let index = 0; index < open.length; index += 1) {
        const candidate = open[index]!
        if (candidate[0] === end) ring.push(...candidate.slice(1))
        else if (candidate[candidate.length - 1] === end) ring.push(...candidate.slice(0, -1).reverse())
        else continue
        open.splice(index, 1)
        extended = true
        break
      }
    }
    if (isClosedRing(ring)) rings.push(ring)
    else openSegmentCount += 1
  }
  return { rings, openSegmentCount }
}

/** Outer rings of a `type=multipolygon` relation; inner rings are not represented. */
export const multipolygonGeometry = (
  members: ReadonlyArray<OsmRelationMember>,
  wayRefs: WayRefs,
  coordinates: NodeCoordinates,
): GeometryOutcome & { readonly openSegmentCount: number } => {
  const segments: Array<ReadonlyArray<number>> = []
  for (const member of members) {
    if (member.type !== 'way' || (member.role !== '' && member.role !== 'outer')) continue
    const refs = wayRefs.get(member.ref)
    if (!refs) return { ...failed('missing-member-way'), openSegmentCount: 0 }
    segments.push(refs)
  }
  const { rings, openSegmentCount } = assembleRings(segments)
  if (rings.length === 0) return { ...failed('unclosed-multipolygon'), openSegmentCount }
  const polygons: Array<ReadonlyArray<ReadonlyArray<GeoJsonPosition>>> = []
  const osmNodeIds: string[] = []
  for (const ring of rings) {
    const positions = positionsOf(ring, coordinates)
    if (!positions) return { ...failed('missing-node-coordinates'), openSegmentCount }
    polygons.push([positions])
    osmNodeIds.push(...ring.map(osmNodeId))
  }
  return {
    ok: true,
    geometry: { type: 'MultiPolygon', coordinates: polygons },
    osmNodeIds,
    geometrySource: 'osm-multipolygon',
    openSegmentCount,
  }
}

const meanPosition = (positions: ReadonlyArray<GeoJsonPosition>): GeoJsonPosition => {
  let lon = 0
  let lat = 0
  for (const position of positions) {
    lon += position[0]
    lat += position[1]
  }
  return [lon / positions.length, lat / positions.length]
}

/**
 * Point at the centroid of a relation's node members, or of its way members' nodes when it has no node
 * members (sites such as wind farms list their turbines; circuits list their ways). Members outside the
 * extract carry no coordinates and do not contribute; the relation's member list still names them.
 */
export const memberCentroidGeometry = (
  members: ReadonlyArray<OsmRelationMember>,
  wayRefs: WayRefs,
  coordinates: NodeCoordinates,
): GeometryOutcome => {
  const nodePositions = members.flatMap(member => {
    if (member.type !== 'node') return []
    const position = coordinates.get(member.ref)
    return position ? [position] : []
  })
  if (nodePositions.length > 0) {
    return { ok: true, geometry: { type: 'Point', coordinates: meanPosition(nodePositions) }, osmNodeIds: null, geometrySource: 'osm-member-centroid' }
  }
  const wayNodeIds = new Set<number>()
  for (const member of members) {
    if (member.type !== 'way') continue
    for (const ref of wayRefs.get(member.ref) ?? []) wayNodeIds.add(ref)
  }
  const wayPositions = [...wayNodeIds].flatMap(ref => {
    const position = coordinates.get(ref)
    return position ? [position] : []
  })
  if (wayPositions.length === 0) return failed('no-member-coordinates')
  return { ok: true, geometry: { type: 'Point', coordinates: meanPosition(wayPositions) }, osmNodeIds: null, geometrySource: 'osm-member-centroid' }
}
