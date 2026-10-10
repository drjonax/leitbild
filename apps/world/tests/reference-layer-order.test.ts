import { describe, expect, test } from 'bun:test'
import { electricGridPackView } from '../src/packs/electric-grid/ui-pack.ts'
import { gridNorwayStyle } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import { createMapLayerRegistry } from '../src/ui/map-runtime/map-layer-registry.ts'
import { referenceLayerAnchorId } from '../src/ui/map-runtime/reference-layer-order.ts'
import { gridNorwayReferenceTileset } from './fixtures/grid-norway-reference-manifest.ts'
import { createFakeMapStyle, layerOrder, leitbildBaseLayers, leitbildBaseMetadata } from './helpers/fake-map-style.ts'

const withCapabilities = async <T>(run: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ schemaVersion: 2, tilesets: [gridNorwayReferenceTileset] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('referenceLayerAnchorId', () => {
  test('anchors below the first base-map symbol layer', () => {
    expect(referenceLayerAnchorId({ layers: leitbildBaseLayers, metadata: leitbildBaseMetadata })).toBe('poi-emergency')
  })

  test('anchors below a runtime overlay registered first and skips existing reference layers', () => {
    const layers = [
      ...leitbildBaseLayers.slice(0, 5),
      { id: 'reference:grid-norway:lines:line', type: 'line', source: 'reference:grid-norway' },
      { id: 'leitbild-pack-fills', type: 'fill', source: 'leitbild-pack-features' },
      ...leitbildBaseLayers.slice(5),
    ]
    expect(referenceLayerAnchorId({ layers, metadata: leitbildBaseMetadata })).toBe('leitbild-pack-fills')
  })

  test('appends on top when nothing must stay above, and refuses a style without base metadata', () => {
    expect(referenceLayerAnchorId({ layers: leitbildBaseLayers.slice(0, 3), metadata: leitbildBaseMetadata })).toBeNull()
    expect(() => referenceLayerAnchorId({ layers: leitbildBaseLayers })).toThrow('leitbild:baseSources')
  })
})

describe('map layer registry ordering', () => {
  test('grid layers sit below the first base label and below Pack overlays, whatever the registration order', async () => {
    const fake = createFakeMapStyle()
    // A Pack feature overlay that registered before the reference data finished loading.
    fake.map.addLayer({ id: 'leitbild-pack-fills', type: 'fill', source: 'leitbild-pack-features' } as never, 'poi-emergency')
    const registration = await withCapabilities(async () => createMapLayerRegistry().registerReferenceLayers({
      map: fake.map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'light' },
      layerGroups: electricGridPackView.presentation.mapLayerGroups ?? [],
      visibility: {},
    }))
    const order = layerOrder(fake.layers)
    const gridIndexes = registration.layerIds.map(id => order.indexOf(id))
    expect(gridIndexes.every(index => index >= 0)).toBe(true)
    expect(Math.max(...gridIndexes)).toBeLessThan(order.indexOf('leitbild-pack-fills'))
    expect(Math.max(...gridIndexes)).toBeLessThan(order.indexOf('poi-emergency'))
    expect(Math.min(...gridIndexes)).toBeGreaterThan(order.indexOf('boundary'))
    expect(registration.layerIds).toEqual(gridNorwayStyle.layersFor({ theme: 'light' }).map(layer => `reference:grid-norway:${layer.id}`))

    // A live overlay added afterwards before the first base label lands above every grid layer.
    fake.map.addLayer({ id: 'live-grid-lines', type: 'line', source: 'live-grid' } as never, 'poi-emergency')
    const after = layerOrder(fake.layers)
    expect(Math.max(...registration.layerIds.map(id => after.indexOf(id)))).toBeLessThan(after.indexOf('live-grid-lines'))
  })

  test('layer group toggles hide exactly their own grid layers', async () => {
    const fake = createFakeMapStyle()
    const registry = createMapLayerRegistry()
    await withCapabilities(async () => registry.registerReferenceLayers({
      map: fake.map,
      styles: [gridNorwayStyle],
      appearance: { theme: 'dark' },
      layerGroups: electricGridPackView.presentation.mapLayerGroups ?? [],
      visibility: { 'electric-grid:reference-substations': false },
    }))
    const hidden = fake.layers.filter(layer => layer.visibility === 'none').map(layer => layer.id)
    expect(hidden).toEqual(['reference:grid-norway:substations:fill', 'reference:grid-norway:substations:outline', 'reference:grid-norway:substations:point', 'reference:grid-norway:substations:label'])
    registry.applyLayerGroupVisibility({ 'electric-grid:reference-substations': true, 'electric-grid:reference-generation': false })
    expect(fake.layers.filter(layer => layer.visibility === 'none').map(layer => layer.id))
      .toEqual(['reference:grid-norway:generation:outline', 'reference:grid-norway:generation:point', 'reference:grid-norway:generation:label'])
  })
})
