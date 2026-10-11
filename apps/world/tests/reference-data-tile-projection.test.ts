import { describe, expect, test } from 'bun:test'
import { projectTileFeatures } from '../src/reference-data/tile-projection.ts'
import { asDatasetId, type NormalizedFeature, type TileProjection, type TilebuildConfig } from '../src/reference-data/types.ts'

const point = (id: string, category: string): NormalizedFeature => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [10, 60] },
  properties: { category },
})

const configWith = (tileFeatures: (feature: NormalizedFeature) => TileProjection) => {
  const tilebuild: TilebuildConfig = { outputLayer: 'test', globalMinZoom: 4, globalMaxZoom: 12, maximumTileBytes: 100_000, tileFeatures }
  return { id: asDatasetId('test'), tilebuild, featureToCategory: (feature: NormalizedFeature) => String(feature.properties.category) }
}

const tiledAt = (minZoom: number, maxZoom?: number, properties: Record<string, string | number> = {}) => (feature: NormalizedFeature): TileProjection => ({
  kind: 'tiled',
  externalId: String(feature.id),
  features: [{ geometry: feature.geometry, properties: { category: String(feature.properties.category), ...properties }, minZoom, ...(maxZoom === undefined ? {} : { maxZoom }) }],
})

describe('projectTileFeatures', () => {
  test('numbers tiled features from 1 in sidecar order and summarises categories and exclusions', () => {
    const features = [point('a', 'site'), point('b', 'helper'), point('c', 'line'), point('d', 'site')]
    const projected = projectTileFeatures(features, configWith(feature => feature.properties.category === 'helper'
      ? { kind: 'excluded', reason: 'helper:topology' }
      : tiledAt(feature.id === 'd' ? 9 : 5)(feature)))
    expect(projected.features.map(feature => [feature.properties.fid, feature.tippecanoe])).toEqual([
      [1, { minzoom: 5, maxzoom: 12 }],
      [2, { minzoom: 5, maxzoom: 12 }],
      [3, { minzoom: 9, maxzoom: 12 }],
    ])
    expect(projected.externalIdByFid).toEqual({ 1: 'a', 2: 'c', 3: 'd' })
    expect(projected.categories).toEqual([
      { category: 'line', minZoom: 5, maxZoom: 12, featureCount: 1 },
      { category: 'site', minZoom: 5, maxZoom: 12, featureCount: 2 },
    ])
    expect(projected.exclusions).toEqual({ 'helper:topology': 1 })
  })

  test('fails loudly on zoom ranges outside the tile set, the reserved fid, empty or repeated projections', () => {
    const features = [point('a', 'site')]
    expect(() => projectTileFeatures(features, configWith(tiledAt(3)))).toThrow('zoom range 3-12 is not an integer range within 4-12')
    expect(() => projectTileFeatures(features, configWith(tiledAt(9, 8)))).toThrow('zoom range 9-8')
    expect(() => projectTileFeatures(features, configWith(tiledAt(4, 13)))).toThrow('zoom range 4-13')
    expect(() => projectTileFeatures(features, configWith(tiledAt(4.5)))).toThrow('zoom range 4.5-12')
    expect(() => projectTileFeatures(features, configWith(tiledAt(5, undefined, { fid: 7 })))).toThrow('reserved property "fid"')
    expect(() => projectTileFeatures(features, configWith(() => ({ kind: 'tiled', externalId: 'a', features: [] })))).toThrow('exclude it with a reason instead')
    const twice = [point('a', 'site'), point('a', 'site')]
    expect(() => projectTileFeatures(twice, configWith(tiledAt(5)))).toThrow('external id a is tiled twice')
  })
})
