import { geoJsonGeometrySchema, type GeoJsonGeometry } from '../../core/model/geo.ts'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { longitudeIntervals, type ExternalGeometry, type ExternalRecord, type SituationConfig, type SituationSource } from './model.ts'

/** A record's colour names its kind, never its severity: severity is a word, and alert hues are kept for alerts (plan v3.1 §2.7, D9). */
export const recordAppearance = (record: Pick<ExternalRecord, 'kind' | 'category'>, source?: SituationSource) => {
  const icon = source?.map.icon ?? (record.category === 'camera' ? 'cctv' : record.category === 'road-weather' ? 'thermometer' : source?.adapter === 'vegvesen' ? 'construction' : record.kind === 'forecast' ? 'cloud-sun' : record.kind === 'event' ? 'triangle-alert' : record.kind === 'media' ? 'video' : record.kind === 'report' ? 'newspaper' : 'map-pin')
  return { icon, color: source?.map.color ?? (record.kind === 'media' ? '#7d5ff5' : record.kind === 'observation' ? '#06b6d4' : record.kind === 'forecast' ? '#0fcdfa' : record.kind === 'event' ? '#9a7b5f' : '#6e788c') }
}

export const recordItemId = (record: Pick<ExternalRecord, 'id' | 'sourceId'>): string => JSON.stringify([record.sourceId, record.id])
export const splitGeometry = (geometry: ExternalGeometry): GeoJsonGeometry[] => {
  switch (geometry.type) {
    case 'MultiPoint': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Point', coordinates }))
    case 'MultiLineString': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'LineString', coordinates }))
    case 'MultiPolygon': return geometry.coordinates.map(coordinates => geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates }))
    default: return [geoJsonGeometrySchema.parse(geometry)]
  }
}
export const recordMapFeatures = (record: ExternalRecord, source?: SituationSource): PackMapFeature[] => record.geometry ? splitGeometry(record.geometry).map((geometry, index) => ({
  id: 'situation:' + recordItemId(record) + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor', geometry,
  color: recordAppearance(record, source).color, symbol: { icon: recordAppearance(record, source).icon }, opacity: source?.map.opacity ?? .18, lineWidth: source?.map.lineWidth ?? 2, lineOpacity: .8,
  summary: record.title + ' · ' + (record.validAt ?? record.publishedAt ?? record.retrievedAt),
  selection: { panelId: 'situation-monitor.records', itemId: recordItemId(record) },
})) : []

export const watchedAreaFeatures = (areas: SituationConfig['areas']): PackMapFeature[] => areas.flatMap(area => longitudeIntervals(area.bounds[0], area.bounds[2]).map(([w,e], index) => ({
  id: 'situation:area:' + area.id + ':' + index, layerId: 'situation-monitor', categoryId: 'situation-monitor',
  geometry: geoJsonGeometrySchema.parse({ type: 'Polygon', coordinates: [[[w,area.bounds[1]],[e,area.bounds[1]],[e,area.bounds[3]],[w,area.bounds[3]],[w,area.bounds[1]]]] }),
  color: '#0fcdfa', opacity: 0, lineWidth: 1, lineOpacity: .7, summary: 'Watched area: ' + area.name,
})))
