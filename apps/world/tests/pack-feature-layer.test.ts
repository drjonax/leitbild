import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import type { PackMapFeature } from '../src/core/packs/protocol.ts'
import { packFeatureCollection, packLineDash, packLineLayers, packSelectedLineWidths } from '../src/ui/map-runtime/pack-feature-layer.ts'

const line = (id: string, lineDashed?: boolean): PackMapFeature => ({
  id,
  categoryId: 'fixture',
  geometry: { type: 'LineString', coordinates: [geoPointFromLonLat(11.3, 59.1).coordinates, geoPointFromLonLat(11.4, 59.2).coordinates] },
  color: '#2f6f9f',
  summary: id,
  lineWidth: 1.5,
  ...(lineDashed === undefined ? {} : { lineDashed }),
})

describe('Pack feature lines', () => {
  test('a line asking for a dash is drawn by the dashed layer only; every other line stays solid, as before', () => {
    const data = packFeatureCollection([line('plain'), line('planned', true), line('explicit', false)])
    expect(data.features.map(feature => [feature.properties?.id, feature.properties?.dashed])).toEqual([['plain', false], ['planned', true], ['explicit', false]])
    const [solid, dashed] = packLineLayers
    expect(solid!.filter).toEqual(['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'dashed'], true]])
    expect(solid!.paint).not.toHaveProperty('line-dasharray')
    expect(dashed!.filter).toEqual(['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dashed'], true]])
    expect(dashed!.paint?.['line-dasharray']).toEqual([...packLineDash])
    expect(packLineLayers.map(layer => layer.id)).toEqual(['leitbild-pack-lines', 'leitbild-pack-dashed-lines'])
  })

  test('a selected line widens alike whether it is drawn solid or dashed', () => {
    const width = ['case', ['==', ['get', 'id'], 'planned'], ['+', ['get', 'lineWidth'], 2], ['get', 'lineWidth']]
    const widths: unknown = packSelectedLineWidths('planned')
    expect(widths).toEqual([['leitbild-pack-lines', width], ['leitbild-pack-dashed-lines', width]])
  })
})
