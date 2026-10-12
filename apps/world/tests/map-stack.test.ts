import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { emptyCatalogueSymbolAtlas } from '../src/ui/map-runtime/catalogue-symbol-atlas.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'
import { createOperationalDeckLayers } from '../src/ui/map-runtime/operational-deck-layers.ts'
import { operationalIconPx, statusDiskRadiusPx } from '../src/ui/map-runtime/symbol-kit.ts'
import type { OperationalPointFeature, Position3 } from '../src/ui/map-runtime/types.ts'
import { objectsUnder } from '../src/ui/map/map-stack.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
/** One screen px is 0.00001° here, east right and north up, from the origin. */
const origin = [11.4, 59.12] as const
const objectOf = (id: string, eastPx = 0, northPx = 0): OperationalObject => ({
  id: id as ObjectId,
  kind: 'mobile_entity',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(origin[0] + eastPx * 1e-5, origin[1] + northPx * 1e-5), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
})
const screenOf = (position: Position3) => ({ x: (position[0] - origin[0]) / 1e-5, y: -(position[1] - origin[1]) / 1e-5 })
const pointsOf = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<OperationalPointFeature> => createMapFeatureStore().update({
  objects,
  selectedControllerId: null,
  highlightedObjectIds: [],
  hiddenObjectCategoryIds: [],
  placementPoints: [],
  packFeatures: [],
  hasNewInfo: () => false,
  presentationFor: object => ({ categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [], mapLabel: object.label }),
}).points
const ids = (objects: ReadonlyArray<OperationalObject>): ReadonlyArray<string> => objects.map(object => object.id)
const disk = statusDiskRadiusPx(operationalIconPx)

describe('objects stacked under one tap', () => {
  test('trucks parked on a depot all lie under a tap on the spot, each once, the last drawn first', () => {
    const points = pointsOf([objectOf('depot'), objectOf('truck-1'), objectOf('truck-2')])
    const drawn = points.map(point => point.object.id as string)
    expect(ids(objectsUnder(points, screenOf, { x: 0, y: 0 }))).toEqual([...drawn].reverse())
    expect(ids(objectsUnder(points, screenOf, { x: disk - 1, y: 0 }))).toHaveLength(3)
  })

  test('only icons under the tap point itself count, never those a picking radius would reach: icons standing near each other are no stack', () => {
    // Two icons 22 px apart: a tap on either one's centre lies on it alone.
    const near = pointsOf([objectOf('a'), objectOf('b', 22)])
    expect(ids(objectsUnder(near, screenOf, { x: 0, y: 0 }))).toEqual(['a'])
    expect(ids(objectsUnder(near, screenOf, { x: 22, y: 0 }))).toEqual(['b'])
    // Where their disks overlap, the finger lies on both.
    expect([...ids(objectsUnder(near, screenOf, { x: 11, y: 0 }))].sort()).toEqual(['a', 'b'])
    // Icons 40 px apart never overlap; a tap beside an icon's disk lies on nothing.
    const apart = pointsOf([objectOf('a'), objectOf('b', 40)])
    for (let x = -30; x <= 70; x += 1) expect(objectsUnder(apart, screenOf, { x, y: 0 }).length).toBeLessThanOrEqual(1)
    expect(objectsUnder(apart, screenOf, { x: 0, y: disk + 1 })).toEqual([])
  })

  test('the disk a stack is judged by is the one the map draws beneath each icon, which covers its glyph', () => {
    const points = pointsOf([objectOf('truck-1')])
    const layers = createOperationalDeckLayers({
      snapshot: createMapFeatureStore().update({
        objects: [objectOf('truck-1')],
        selectedControllerId: null,
        highlightedObjectIds: [],
        hiddenObjectCategoryIds: [],
        placementPoints: [],
        packFeatures: [],
        hasNewInfo: () => false,
        presentationFor: object => ({ categoryId: 'fixture', icon: 'square', color: '#334155', summary: object.label, fields: [], mapLabel: object.label }),
      }),
      visibleFamilies: new Set(['objects']),
      catalogueAtlas: emptyCatalogueSymbolAtlas,
      disksPick: false,
      onObjectSelected: () => undefined,
      onObjectSeen: () => undefined,
      onObjectHover: () => undefined,
    })
    const disks = layers.find(layer => layer.id === 'leitbild-object-status-disks')?.props as unknown as { readonly getRadius: (point: OperationalPointFeature) => number }
    const getRadius = disks.getRadius
    expect(getRadius(points[0]!)).toBe(statusDiskRadiusPx(points[0]!.sizePx))
    // The disk reaches past the glyph's corners.
    expect(disk).toBeGreaterThan(Math.hypot(operationalIconPx / 2, operationalIconPx / 2))
  })
})
