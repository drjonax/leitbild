import { z } from 'zod'
import { measurePolygon, type TopologyPolygonGeometry } from '../topology/geometry.ts'
import type { LonLat } from './geo.ts'
import type { WayGeometry } from './paths.ts'

// The two things the build reads from the DS1 sidecar besides the topology: line and cable way
// geometry with OSM node keys (paths), and station outlines (generator containment).

const position = z.tuple([z.number().finite(), z.number().finite()]).rest(z.number().finite())
const ring = z.array(position).min(4)
const featureSchema = z.object({
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal('Point'), coordinates: position }),
    z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
    z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
    z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1)).min(1) }),
  ]),
  properties: z.object({
    category: z.string().min(1),
    externalId: z.string().regex(/^(node|way|relation)\/\d+$/),
    name: z.string().min(1).nullable(),
    osmNodeIds: z.array(z.string().regex(/^node\/\d+$/)).nullable(),
  }),
})
const sidecarSchema = z.object({ type: z.literal('FeatureCollection'), features: z.array(featureSchema) })

type PolygonGeometry = TopologyPolygonGeometry

export interface StationAnchor {
  readonly location: LonLat
  readonly category: 'substation' | 'plant'
  readonly name: string | null
}

export interface SidecarFeatures {
  readonly way: (featureId: string) => WayGeometry | undefined
  /** Every line and cable way of the sidecar ("way/123"). */
  readonly lineWayIds: ReadonlySet<string>
  readonly outline: (featureId: string) => PolygonGeometry | undefined
  /** Location (node, or outline centroid) of a station or plant feature. */
  readonly anchor: (featureId: string) => StationAnchor | undefined
}

const lonLat = (coordinates: ReadonlyArray<number>): LonLat => [coordinates[0]!, coordinates[1]!]

export const readSidecarFeatures = (raw: unknown): SidecarFeatures => {
  const ways = new Map<string, WayGeometry>()
  const outlines = new Map<string, PolygonGeometry>()
  const anchors = new Map<string, StationAnchor>()
  for (const feature of sidecarSchema.parse(raw).features) {
    const { geometry, properties } = feature
    if (geometry.type === 'LineString' && (properties.category === 'line' || properties.category === 'cable')) {
      const nodeIds = properties.osmNodeIds
      if (nodeIds === null || nodeIds.length !== geometry.coordinates.length) throw new Error(`sidecar ${properties.externalId}: node ids do not align with its geometry`)
      ways.set(properties.externalId, { coordinates: geometry.coordinates.map(lonLat), nodeKeys: nodeIds })
    }
    if (properties.category !== 'substation' && properties.category !== 'plant') continue
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      const outline: PolygonGeometry = geometry.type === 'Polygon'
        ? { type: 'Polygon', coordinates: geometry.coordinates.map(r => r.map(lonLat)) }
        : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon => polygon.map(r => r.map(lonLat))) }
      outlines.set(properties.externalId, outline)
      anchors.set(properties.externalId, { location: measurePolygon(outline).centroid, category: properties.category, name: properties.name })
    } else if (geometry.type === 'Point') {
      anchors.set(properties.externalId, { location: lonLat(geometry.coordinates), category: properties.category, name: properties.name })
    }
  }
  return { way: id => ways.get(id), lineWayIds: new Set(ways.keys()), outline: id => outlines.get(id), anchor: id => anchors.get(id) }
}
