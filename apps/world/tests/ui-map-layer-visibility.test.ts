import { describe, expect, test } from 'bun:test'
import {
  createOperationalDeckLayerDataCache,
  createOperationalDeckLayers,
} from '../src/ui/map-runtime/operational-deck-layers.ts'
import { emptyCatalogueSymbolAtlas } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import type { OperationalRenderSnapshot } from '../src/ui/map-runtime/types.ts'

const emptySnapshot = (): OperationalRenderSnapshot => ({
  points: [],
  paths: [
    {
      id: 'route:a',
      kind: 'route',
      path: [[10, 59], [11, 60]],
      color: [1, 2, 3, 255],
      casingColor: [255, 255, 255, 255],
      widthPx: 3,
      selected: false,
      priority: 1,
      signature: 'route',
    },
    {
      id: 'weather:a',
      kind: 'object-line',
      path: [
        [10, 59],
        [11, 60],
      ],
      color: [1, 2, 3, 255],
      casingColor: [255, 255, 255, 255],
      widthPx: 3,
      selected: false,
      priority: 1,
      signature: 'object-line',
    },
  ],
  areaSymbols: [],
  placementPoints: [],
  revisions: {
    points: 1,
    paths: 1,
    areaSymbols: 1,
    placement: 1,
  },
})

describe('operational deck layer visibility', () => {
  test('filters paths by scenario layer families before they reach deck', () => {
    const layers = createOperationalDeckLayers({
      snapshot: emptySnapshot(),
      visibleFamilies: new Set(['routes']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: false,
      diskClicks: null,
      zoom: 10,
      onObjectSelected: () => undefined,
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
    })
    const pathLayer = layers.find(layer => layer.id === 'leitbild-operational-paths')
    const data = pathLayer?.props.data as ReadonlyArray<{ readonly kind: string }> | undefined

    expect(data?.map(path => path.kind)).toEqual(['route'])
  })

  test('keeps visible deck data references stable while revisions and layer visibility are unchanged', () => {
    const cache = createOperationalDeckLayerDataCache()
    const snapshot = emptySnapshot()
    const families = new Set(['objects', 'routes'])

    const first = cache.dataFor(snapshot, families, emptyCatalogueSymbolAtlas, 10)
    const second = cache.dataFor(snapshot, new Set(['routes', 'objects']), emptyCatalogueSymbolAtlas, 10)

    expect(second.visiblePaths).toBe(first.visiblePaths)
    expect(second.visibleAreaSymbols).toBe(first.visibleAreaSymbols)
    expect(second.newInfoPoints).toBe(first.newInfoPoints)
    expect(second.placementPoints).toBe(first.placementPoints)
  })
})
