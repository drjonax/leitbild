import { z } from 'zod'
import { gridReferenceFeatureSchema } from '../schemas/grid-reference.ts'
import { measurePolygon, type LonLat, type TopologyStationGeometry } from './geometry.ts'
import type { TopologyInput, TopologyInputFeature } from './input.ts'
import { ledgerEntry, type TopologyLedgerEntry } from './ledger.ts'
import {
  levelsFromOsmTags,
  lifecycleFromOsmTags,
  ratingMvaFromOsmTags,
  systemsFromOsmTags,
  transformerVoltagesKv,
  voltagesKvFromOsmTags,
} from './osm-tags.ts'

// Adapter for sidecars without OSM node ids (the 2026-05 production build): line features are
// concatenations of ways (`leitbild:merged_source_ids`), so vertices are keyed by their coordinate
// rounded to 1e-7° (the OSM storage precision) and only feature ends are terminal candidates.

const position = z.tuple([z.number().finite(), z.number().finite()]).rest(z.number().finite())
const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position).min(4)).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(position).min(4)).min(1)).min(1) }),
])
const sidecarSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({ type: z.literal('Feature'), geometry: geometrySchema, properties: gridReferenceFeatureSchema })),
})

type SidecarGeometry = z.infer<typeof geometrySchema>
type SidecarFeature = z.infer<typeof sidecarSchema>['features'][number]

export type CoordinateSidecarAdaptation = {
  readonly input: TopologyInput
  readonly ignoredCategoryCounts: Readonly<Record<string, number>>
}

const lonLat = (coordinates: ReadonlyArray<number>): LonLat => [coordinates[0]!, coordinates[1]!]

export const coordinateVertexKey = (coordinate: LonLat): string => `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`

const wayIdsOf = (feature: SidecarFeature): ReadonlyArray<string> => {
  const merged = feature.properties.tags['leitbild:merged_source_ids']
  if (merged !== undefined) return merged.split(';')
  if (/^way\/\d+$/.test(feature.properties.externalId)) return [feature.properties.externalId]
  throw new Error(`coordinate sidecar: ${feature.properties.externalId} has no OSM way id`)
}

const stationGeometry = (geometry: SidecarGeometry): TopologyStationGeometry | null => {
  if (geometry.type === 'Point') return { type: 'Point', coordinates: lonLat(geometry.coordinates) }
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(lonLat)) }
  if (geometry.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(lonLat))) }
  return null
}

export const adaptCoordinateSidecar = (raw: unknown, sourceId: string): CoordinateSidecarAdaptation => {
  const sidecar = sidecarSchema.parse(raw)
  const features: TopologyInputFeature[] = []
  const ledger: TopologyLedgerEntry[] = []
  const ignored: Record<string, number> = {}
  const unsupported = (feature: SidecarFeature, detail: string): void => {
    ledger.push(ledgerEntry({ reason: 'unsupported-geometry', elementIds: [feature.properties.externalId], detail }))
  }

  for (const feature of sidecar.features) {
    const { properties, geometry } = feature
    const tags = properties.tags
    const lifecycle = lifecycleFromOsmTags(tags)
    if (properties.category === 'line' || properties.category === 'cable') {
      if (geometry.type !== 'LineString') {
        unsupported(feature, `${properties.category} with ${geometry.type} geometry`)
        continue
      }
      const coordinates = geometry.coordinates.map(lonLat)
      const vertexKeys = coordinates.map(coordinateVertexKey)
      const osmWayIds = wayIdsOf(feature)
      if (tags.line === 'busbar' || tags.line === 'bay') {
        features.push({ kind: 'busbar', featureId: properties.externalId, osmWayIds, lifecycle, coordinates, vertexKeys })
        continue
      }
      const reading = levelsFromOsmTags(tags)
      if (!reading.ok) {
        ledger.push(ledgerEntry({ reason: reading.reason, elementIds: [properties.externalId, ...osmWayIds], detail: reading.detail }))
        continue
      }
      features.push({
        kind: properties.category,
        featureId: properties.externalId,
        osmWayIds,
        name: properties.name,
        operator: properties.operator,
        lifecycle,
        levels: reading.levels,
        cables: properties.cables,
        coordinates,
        vertexKeys,
        terminalVertexIndices: [0, coordinates.length - 1],
      })
      continue
    }
    if (properties.category === 'substation' || properties.category === 'plant') {
      const stationGeometryValue = stationGeometry(geometry)
      if (!stationGeometryValue) {
        unsupported(feature, `${properties.category} mapped as an unclosed ${geometry.type}`)
        continue
      }
      features.push({
        kind: properties.category,
        featureId: properties.externalId,
        name: properties.name,
        operator: properties.operator,
        role: properties.category === 'substation' ? tags.substation ?? null : properties.plantSource,
        lifecycle,
        voltagesKv: voltagesKvFromOsmTags(tags.voltage),
        systems: systemsFromOsmTags(tags),
        memberFeatureIds: [],
        geometry: stationGeometryValue,
      })
      continue
    }
    if (properties.category === 'transformer') {
      const location = geometry.type === 'Point'
        ? lonLat(geometry.coordinates)
        : geometry.type === 'LineString' ? null : measurePolygon(stationGeometry(geometry) as Exclude<TopologyStationGeometry, { type: 'Point' }>).centroid
      if (!location) {
        unsupported(feature, 'transformer mapped as an unclosed way')
        continue
      }
      features.push({
        kind: 'transformer',
        featureId: properties.externalId,
        lifecycle,
        location,
        voltagesKv: transformerVoltagesKv(tags),
        ratingMva: ratingMvaFromOsmTags(tags),
      })
      continue
    }
    ignored[properties.category] = (ignored[properties.category] ?? 0) + 1
  }
  return {
    input: { sourceId, keyMode: 'coordinate', features, adapterLedger: ledger },
    ignoredCategoryCounts: ignored,
  }
}
