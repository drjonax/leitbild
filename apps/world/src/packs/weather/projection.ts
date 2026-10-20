import {
  hexCellBoundary,
  hexCellCenter,
  hexCellsForPolygon,
  hexCoverageEstimate,
  hexParentCell,
  hexResolution,
  type HexCellId,
} from '../../core/spatial/index.ts'
import { geoPointFromLonLat, type GeoJsonPolygon } from '../../core/model/index.ts'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { frameAt, weatherInfluenceEllipsePolygon } from './influence.ts'
import { sampleWeather, type WeatherField } from './cell-field.ts'
import { weatherPresentationSeverityForState } from './conditions.ts'

// One weather colour; a cell's severity is its fill strength (magnitude), never an alert hue (plan v3.1 §2.7).
const weatherColor = '#4669ff'
const cellOpacity = { normal: 0, notice: 0.07, adverse: 0.13, hazard: 0.22 }
export const projectWeatherFieldForMap = (
  field: WeatherField,
  viewport: GeoJsonPolygon,
  zoom: number,
  layers: ReadonlyArray<string>,
): ReadonlyArray<PackMapFeature> => {
  let resolution = Math.min(field.config.gridResolution, zoom < 7 ? 4 : zoom < 10 ? 6 : zoom < 12 ? 7 : 9)
  while (resolution > 0 && hexCoverageEstimate(viewport, hexResolution(resolution)) > 4000) resolution--
  if (hexCoverageEstimate(viewport, hexResolution(resolution)) > 4000)
    throw new Error('Weather viewport exceeds coverage budget')
  const visible = new Set(hexCellsForPolygon(viewport, hexResolution(resolution), 4000))
  const features: PackMapFeature[] = []
  if (layers.includes('baseGrid'))
    for (const id of visible)
      features.push({
        id: 'weather-grid:' + id,
        categoryId: 'weather',
        layerId: 'weather',
        geometry: hexCellBoundary(id),
        color: '#6e788c',
        opacity: 0,
        lineColor: '#6e788c',
        lineOpacity: 0.1,
        lineWidth: 0.4,
        sortKey: -10,
        summary: 'Display grid; ground resolution ' + field.config.gridResolution,
      })
  if (layers.includes('affectedCells')) {
    const ranks = ['normal', 'notice', 'adverse', 'hazard'] as const
    const cells = new Map<HexCellId, number>()
    for (const id of visible) {
      const rank = ranks.indexOf(weatherPresentationSeverityForState(sampleWeather(field, hexCellCenter(id)).state))
      if (rank > 0) cells.set(id, rank)
    }
    for (const id of field.cells.keys()) {
      const parent = hexParentCell(id, hexResolution(resolution))
      if (!visible.has(parent)) continue
      const rank = ranks.indexOf(weatherPresentationSeverityForState(sampleWeather(field, hexCellCenter(id)).state))
      cells.set(parent, Math.max(cells.get(parent) ?? 0, rank))
    }
    for (const [id, rank] of cells) {
      features.push({
        id: 'weather-cell:' + id,
        categoryId: 'weather',
        layerId: 'weather',
        geometry: hexCellBoundary(id),
        color: weatherColor,
        opacity: cellOpacity[ranks[rank]!],
        lineOpacity: 0.2,
        lineWidth: 0.4,
        sortKey: 0,
        summary: 'Worst ground-cell severity within this display cell',
      })
    }
  }
  if (layers.includes('influenceShapes'))
    for (const entry of field.influences) {
      const area = frameAt(entry, field.at),
        point = geoPointFromLonLat(...area.center)
      const geometry = weatherInfluenceEllipsePolygon(area)
      if (!overlaps(geometry, viewport)) continue
      features.push({
        id: 'weather-area:' + entry.objectId,
        categoryId: 'weather',
        layerId: 'weather',
        geometry,
        anchorPoint: point,
        symbol: { icon: 'cloud-rain', tone: 'working', opacity: 0.9, size: 0.82 },
        color: '#0fcdfa',
        opacity: 0.06,
        lineOpacity: 0.4,
        lineWidth: 1.4,
        sortKey: 10,
        summary: entry.label,
      })
    }
  return features
}
const bounds = (polygon: GeoJsonPolygon) => {
  const ring = polygon.coordinates[0]!
  return {
    west: Math.min(...ring.map((p) => p[0])),
    east: Math.max(...ring.map((p) => p[0])),
    south: Math.min(...ring.map((p) => p[1])),
    north: Math.max(...ring.map((p) => p[1])),
  }
}
const overlaps = (left: GeoJsonPolygon, right: GeoJsonPolygon): boolean => {
  const a = bounds(left),
    b = bounds(right)
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south
}
