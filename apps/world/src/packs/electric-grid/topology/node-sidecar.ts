import { z } from 'zod'
import { measurePolygon, type LonLat, type TopologyPolygonGeometry, type TopologyStationGeometry } from './geometry.ts'
import type { TopologyInput, TopologyInputFeature, TopologySystem } from './input.ts'
import { ledgerEntry, type TopologyLedgerEntry } from './ledger.ts'
import { levelsFromOsmTags, ratingMvaFromOsmTags, transformerVoltagesKv } from './osm-tags.ts'
import { compareText } from './ids.ts'

// Adapter for the per-way OSM sidecar (lane DS1): one feature per OSM element with its real id and
// `osmNodeIds` aligned with the geometry, so vertices are keyed by OSM node id. Circuit levels are
// read from the raw tags (one value per circuit) and must agree with the sidecar's parsed fields.

const osmElementId = z.string().regex(/^(node|way|relation)\/\d+$/)
const osmNodeId = z.string().regex(/^node\/\d+$/)
const position = z.tuple([z.number().finite(), z.number().finite()]).rest(z.number().finite())
const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position).min(4)).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(position).min(4)).min(1)).min(1) }),
])
const propertiesSchema = z.object({
  category: z.enum(['line', 'cable', 'busbar', 'substation', 'transformer', 'portal', 'terminal', 'plant', 'generator', 'circuit']),
  externalId: osmElementId,
  osmNodeIds: z.array(osmNodeId).nullable(),
  members: z.array(z.object({ id: osmElementId, role: z.string() })),
  name: z.string().min(1).nullable(),
  operator: z.string().min(1).nullable(),
  voltageKv: z.array(z.number().finite().gte(1)),
  systems: z.array(z.enum(['ac50', 'hvdc', 'traction', 'other'])).min(1),
  lifecycle: z.enum(['operational', 'construction', 'proposed', 'disused', 'abandoned']),
  circuits: z.number().int().positive().nullable(),
  cables: z.number().int().positive().nullable(),
  plantSource: z.string().min(1).nullable(),
  geometrySource: z.enum(['osm-node', 'osm-way', 'osm-multipolygon', 'osm-member-centroid']),
  tags: z.record(z.string(), z.string()),
})
const sidecarSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({ type: z.literal('Feature'), geometry: geometrySchema, properties: propertiesSchema })),
})

type SidecarFeature = z.infer<typeof sidecarSchema>['features'][number]

export type NodeSidecarAdaptation = {
  readonly input: TopologyInput
  readonly ignoredCategoryCounts: Readonly<Record<string, number>>
}

const lonLat = (coordinates: ReadonlyArray<number>): LonLat => [coordinates[0]!, coordinates[1]!]
const nodeKey = (nodeId: string): string => nodeId.slice('node/'.length)

const polygonOf = (geometry: SidecarFeature['geometry']): TopologyPolygonGeometry | null => {
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map(ring => ring.map(lonLat)) }
  if (geometry.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(lonLat))) }
  return null
}

const sameNumbers = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean => {
  const a = [...new Set(left)].sort((x, y) => x - y)
  const b = [...new Set(right)].sort((x, y) => x - y)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export const adaptNodeSidecar = (raw: unknown, sourceId: string): NodeSidecarAdaptation => {
  const sidecar = sidecarSchema.parse(raw)
  const features: TopologyInputFeature[] = []
  const ledger: TopologyLedgerEntry[] = []
  const ignored: Record<string, number> = {}
  // Portal and terminal nodes are where lines end on station structures; a node of a line there is a
  // terminal candidate even when the line continues.
  const portalNodes = new Set<string>()
  for (const { properties, geometry } of sidecar.features) {
    if ((properties.category === 'portal' || properties.category === 'terminal') && properties.lifecycle === 'operational' && geometry.type === 'Point') {
      portalNodes.add(nodeKey(properties.externalId))
    }
  }
  const unsupported = (feature: SidecarFeature, detail: string): void => {
    ledger.push(ledgerEntry({ reason: 'unsupported-geometry', elementIds: [feature.properties.externalId], detail }))
  }

  for (const feature of sidecar.features) {
    const { properties, geometry } = feature
    const id = properties.externalId
    switch (properties.category) {
      case 'line':
      case 'cable':
      case 'busbar':
      case 'portal': {
        // A portal mapped as a way is a gantry: like a busbar it connects only inside its station.
        if (properties.category === 'portal' && geometry.type === 'Point') {
          ignored.portal = (ignored.portal ?? 0) + 1
          break
        }
        if (geometry.type !== 'LineString') {
          unsupported(feature, `${properties.category} with ${geometry.type} geometry`)
          break
        }
        const coordinates = geometry.coordinates.map(lonLat)
        const nodeIds = properties.osmNodeIds
        if (!nodeIds || nodeIds.length !== coordinates.length) throw new Error(`node sidecar: ${id} needs osmNodeIds aligned with its coordinates`)
        const vertexKeys = nodeIds.map(nodeKey)
        if (properties.category === 'busbar' || properties.category === 'portal') {
          features.push({ kind: 'busbar', featureId: id, osmWayIds: [id], lifecycle: properties.lifecycle, voltagesKv: properties.voltageKv, coordinates, vertexKeys })
          break
        }
        const reading = levelsFromOsmTags(properties.tags)
        if (!reading.ok) {
          ledger.push(ledgerEntry({ reason: reading.reason, elementIds: [id], detail: reading.detail }))
          break
        }
        const taggedKv = reading.levels.flatMap(level => level.voltageKv !== null && level.voltageKv >= 1 ? [level.voltageKv] : [])
        const systems = [...new Set(reading.levels.map(level => level.system))]
        if (!sameNumbers(taggedKv, properties.voltageKv) || !properties.systems.every(system => systems.includes(system as TopologySystem))) {
          throw new Error(`node sidecar: ${id} levels from tags (${taggedKv.join(';')} kV, ${systems.join(';')}) disagree with the sidecar (${properties.voltageKv.join(';')} kV, ${properties.systems.join(';')})`)
        }
        const last = coordinates.length - 1
        const terminals = [0, last, ...vertexKeys.flatMap((key, index) => portalNodes.has(key) ? [index] : [])]
        features.push({
          kind: properties.category,
          featureId: id,
          osmWayIds: [id],
          name: properties.name,
          operator: properties.operator,
          lifecycle: properties.lifecycle,
          levels: reading.levels,
          cables: properties.cables,
          coordinates,
          vertexKeys,
          terminalVertexIndices: [...new Set(terminals)].sort((left, right) => left - right),
        })
        break
      }
      case 'substation':
      case 'plant': {
        if (geometry.type === 'LineString') {
          unsupported(feature, `${properties.category} mapped as an unclosed way`)
          break
        }
        const stationGeometry: TopologyStationGeometry | null = properties.geometrySource === 'osm-member-centroid'
          ? null
          : geometry.type === 'Point' ? { type: 'Point', coordinates: lonLat(geometry.coordinates) } : polygonOf(geometry)
        features.push({
          kind: properties.category,
          featureId: id,
          name: properties.name,
          operator: properties.operator,
          role: properties.category === 'substation' ? properties.tags.substation ?? null : properties.plantSource,
          lifecycle: properties.lifecycle,
          voltagesKv: properties.voltageKv,
          systems: properties.systems.flatMap(system => system === 'other' ? [] : [system]),
          memberFeatureIds: properties.members.map(member => member.id).sort(compareText),
          geometry: stationGeometry,
        })
        break
      }
      case 'transformer': {
        const polygon = polygonOf(geometry)
        const location = geometry.type === 'Point' ? lonLat(geometry.coordinates) : polygon ? measurePolygon(polygon).centroid : null
        if (!location) {
          unsupported(feature, 'transformer mapped as an unclosed way')
          break
        }
        features.push({ kind: 'transformer', featureId: id, lifecycle: properties.lifecycle, location, voltagesKv: transformerVoltagesKv(properties.tags), ratingMva: ratingMvaFromOsmTags(properties.tags) })
        break
      }
      case 'circuit':
        features.push({
          kind: 'route',
          featureId: id,
          lifecycle: properties.lifecycle,
          voltagesKv: properties.voltageKv,
          osmWayIds: properties.members.flatMap(member => member.id.startsWith('way/') ? [member.id] : []),
        })
        break
      case 'terminal':
      case 'generator':
        ignored[properties.category] = (ignored[properties.category] ?? 0) + 1
        break
    }
  }
  return { input: { sourceId, keyMode: 'osm-node', features, adapterLedger: ledger }, ignoredCategoryCounts: ignored }
}
