import { describe, expect, test } from 'bun:test'
import type { PackReferenceDatasetStyle } from '../src/core/packs/reference-style.ts'
import {
  buildReferenceDatasetLayers,
  __internals,
  type DatasetManifestForLayers,
} from '../src/ui/map/reference-layer-factory.ts'

const testStyle: PackReferenceDatasetStyle = {
  datasetId: 'reference-areas',
  outputLayer: 'areas',
  categories: ['area', 'landmark'],
  layersFor: ({ theme }) => [{
    id: 'areas:fill',
    type: 'fill',
    filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'category'], 'area']],
    paint: { 'fill-color': theme === 'dark' ? '#223344' : '#ccddee' },
  }, {
    id: 'landmarks:point',
    type: 'circle',
    minzoom: 8,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'category'], 'landmark']],
    paint: { 'circle-radius': 4, 'circle-color': '#345678' },
  }, {
    id: 'landmarks:label',
    type: 'symbol',
    minzoom: 10,
    filter: ['==', ['get', 'category'], 'landmark'],
    layout: { 'text-field': ['get', 'name'] },
    paint: {},
  }],
}

const baseManifest: DatasetManifestForLayers = {
  datasetId: 'reference-areas',
  artifact: {
    pmtilesPath: 'reference-areas.pmtiles',
    sidecarGeoJsonPath: 'reference-areas.features.geojson',
    outputLayer: 'areas',
  },
  categories: [
    { category: 'area', minZoom: 6, maxZoom: 14, featureCount: 8 },
    { category: 'landmark', minZoom: 7, maxZoom: 13, featureCount: 42 },
    { category: 'empty', minZoom: 2, maxZoom: 14, featureCount: 0 },
  ],
  licences: [
    { id: 'cc-by-nc-sa-4.0', attribution: '© Map dataset A contributors · CC BY-NC-SA 4.0' },
    { id: 'nlod-2.0', attribution: '© Map dataset B · NLOD 2.0' },
    { id: 'nlod-2.0', attribution: '© Map dataset B · NLOD 2.0' },
  ],
}

describe('buildReferenceDatasetLayers', () => {
  test('publishes the Pack layers in paint order under dataset-scoped ids', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle, { theme: 'light' })
    expect(built.layers.map(layer => layer.id)).toEqual([
      'reference:reference-areas:areas:fill',
      'reference:reference-areas:landmarks:point',
      'reference:reference-areas:landmarks:label',
    ])
    for (const layer of built.layers) {
      expect(layer.source).toBe('reference:reference-areas')
      expect(layer['source-layer']).toBe('areas')
      expect(layer.layout.visibility).toBe('visible')
    }
    expect(built.layers[2]!.layout['text-field']).toEqual(['get', 'name'])
  })

  test('passes the map appearance to the Pack style', () => {
    const light = buildReferenceDatasetLayers(baseManifest, testStyle, { theme: 'light' })
    const dark = buildReferenceDatasetLayers(baseManifest, testStyle, { theme: 'dark' })
    expect(light.layers[0]!.paint['fill-color']).toBe('#ccddee')
    expect(dark.layers[0]!.paint['fill-color']).toBe('#223344')
  })

  test('keeps Pack minzoom and never limits layers with maxzoom', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle, { theme: 'light' })
    expect(built.layers.map(layer => layer.minzoom)).toEqual([undefined, 8, 10])
    for (const layer of built.layers) expect('maxzoom' in layer).toBe(false)
  })

  test('source spans the populated categories and overzooms past the archive', () => {
    const built = buildReferenceDatasetLayers(baseManifest, testStyle, { theme: 'light' })
    expect(built.sourceId).toBe('reference:reference-areas')
    expect(built.source).toEqual({
      type: 'vector',
      tiles: ['/map/datasets/reference-areas/current/reference-areas/{z}/{x}/{y}.mvt'],
      minzoom: 6,
      maxzoom: 14,
      attribution: '© Map dataset A contributors · CC BY-NC-SA 4.0 • © Map dataset B · NLOD 2.0',
    })
  })

  test('rejects a style written for another dataset or tile layer', () => {
    expect(() => buildReferenceDatasetLayers({ ...baseManifest, datasetId: 'other' }, testStyle, { theme: 'light' }))
      .toThrow('cannot draw dataset other')
    expect(() => buildReferenceDatasetLayers({ ...baseManifest, artifact: { ...baseManifest.artifact, outputLayer: 'zones' } }, testStyle, { theme: 'light' }))
      .toThrow('build wrote "zones"')
  })

  test('rejects published categories the style does not draw, ignoring empty ones', () => {
    const manifest: DatasetManifestForLayers = {
      ...baseManifest,
      categories: [...baseManifest.categories, { category: 'novel', minZoom: 5, maxZoom: 12, featureCount: 3 }],
    }
    expect(() => buildReferenceDatasetLayers(manifest, testStyle, { theme: 'light' })).toThrow('does not draw published categories: novel')
  })

  test('rejects a dataset without features and duplicate layer ids', () => {
    const empty: DatasetManifestForLayers = { ...baseManifest, categories: [{ category: 'area', minZoom: 4, maxZoom: 14, featureCount: 0 }] }
    expect(() => buildReferenceDatasetLayers(empty, testStyle, { theme: 'light' })).toThrow('publishes no features')
    const duplicated: PackReferenceDatasetStyle = { ...testStyle, layersFor: appearance => [...testStyle.layersFor(appearance), testStyle.layersFor(appearance)[0]!] }
    expect(() => buildReferenceDatasetLayers(baseManifest, duplicated, { theme: 'light' })).toThrow('declares layer reference:reference-areas:areas:fill twice')
  })
})

describe('reference-layer-factory internals', () => {
  test('layer ids are dataset-scoped Pack layer ids', () => {
    expect(__internals.layerIdFor('reference-areas', 'areas:fill')).toBe('reference:reference-areas:areas:fill')
    expect(__internals.sourceIdFor('reference-areas')).toBe('reference:reference-areas')
  })

  test('sourceTilesFor builds the API-served MVT tile template', () => {
    expect(__internals.sourceTilesFor('foo', 'foo.pmtiles')).toEqual(['/map/datasets/foo/current/foo/{z}/{x}/{y}.mvt'])
  })
})
