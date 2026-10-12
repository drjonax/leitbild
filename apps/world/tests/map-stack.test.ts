import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { emptyCatalogueSymbolAtlas } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { stackedObjects, stackLayerIds } from '../src/ui/map/map-stack.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
const objectOf = (id: string): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.4, 59.12), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
})

describe('objects stacked under one tap', () => {
  test('the deck\'s picks name each object once, top first; a pick of nothing counts for nothing', () => {
    const [truck1, truck2, depot] = [objectOf('truck-1'), objectOf('truck-2'), objectOf('depot')]
    const picks = [{ object: { object: truck1 } }, { object: { object: truck1 } }, {}, { object: { object: truck2 } }, { object: { object: depot } }]
    expect(stackedObjects(picks).map(object => object.id as string)).toEqual(['truck-1', 'truck-2', 'depot'])
    expect(stackedObjects([{ object: { object: depot } }])).toHaveLength(1)
    expect(stackedObjects([])).toEqual([])
  })

  test('a stack is what the icon layers draw: the glyphs and the disks, never the labels', () => {
    const objects = [objectOf('truck-1'), objectOf('depot')]
    const snapshot = createMapFeatureStore().update({
      objects,
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: object => ({ categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [], mapLabel: object.label }),
    })
    const ids = createOperationalDeckLayers({
      snapshot,
      visibleFamilies: new Set(['objects']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      exactPointer: true,
      onObjectSelected: () => undefined,
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
    }).map(layer => layer.id)
    // The catalogue layer exists only while a Pack draws a catalogue icon; the others always.
    for (const id of stackLayerIds.filter(entry => entry !== 'leitbild-object-catalogue-symbols')) expect(ids).toContain(id)
    expect(ids).toContain('leitbild-object-labels')
    expect(stackLayerIds as ReadonlyArray<string>).not.toContain('leitbild-object-labels')
  })
})
