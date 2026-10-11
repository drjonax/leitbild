import { describe, expect, test } from 'bun:test'
import {
  geoPointFromLonLat,
  nowIso,
  type IsoTimestamp,
  type ObjectId,
  type OperationalObject,
  type PackId,
} from '../src/core/model/index.ts'
import type { PackMapFeature, PackObjectPresentation } from '../src/core/packs/protocol.ts'
import { inspectBaseMapReadiness } from '../src/ui/map-runtime/base-map-readiness.ts'
import { createMapFeatureStore } from '../src/ui/map-runtime/map-feature-store.ts'

const iconByPackId: Readonly<Record<string, string>> = { 'electric-grid': 'network', weather: 'cloud-rain', fixture: 'square' }

const presentationFor = (object: OperationalObject): PackObjectPresentation => ({
  categoryId: object.packId === 'electric-grid' ? 'electric-grids' : object.packId,
  icon: iconByPackId[object.packId] ?? object.packId,
  color: object.operational.status === 'constrained' ? '#b45309' : '#16834f',
  summary: object.label,
  fields: [],
  mapLineVisible: object.id === 'weather:line',
  status: {
    tone: object.operational.status === 'constrained' ? 'working' : 'ready',
    label: object.operational.status,
    indicator: { shape: 'dot' },
  },
  noteworthyUpdates: object.id === 'unit:1',
})

const makeObject = (
  id: string,
  patch: Partial<OperationalObject>,
): OperationalObject => ({
  id: id as ObjectId,
  kind: 'facility',
  packId: 'fixture' as PackId,
  label: id,
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: nowIso(), updatedAt: nowIso() },
  ...patch,
})

const updateStore = (
  objects: ReadonlyArray<OperationalObject>,
  extras: {
    readonly selectedControllerId?: string | null
    readonly highlightedObjectIds?: ReadonlyArray<string>
    readonly hiddenObjectCategoryIds?: ReadonlyArray<string>
    readonly placementPoints?: ReadonlyArray<ReturnType<typeof geoPointFromLonLat>>
    readonly packFeatures?: ReadonlyArray<PackMapFeature>
    readonly hasNewInfo?: (object: OperationalObject) => boolean
  } = {},
) => createMapFeatureStore().update({
  objects,
  selectedControllerId: extras.selectedControllerId ?? null,
  highlightedObjectIds: extras.highlightedObjectIds ?? [],
  hiddenObjectCategoryIds: extras.hiddenObjectCategoryIds ?? [],
  placementPoints: extras.placementPoints ?? [],
  packFeatures: extras.packFeatures ?? [],
  hasNewInfo: extras.hasNewInfo ?? (() => false),
  presentationFor,
})

describe('map feature store', () => {
  test('projects positioned operational objects into semantic point features', () => {
    const unit = makeObject('unit:1', {
      kind: 'mobile_entity',
      packId: 'fixture' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.75, 59.91),
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
    })

    const snapshot = updateStore([unit], {
      selectedControllerId: unit.id,
      highlightedObjectIds: [unit.id],
      hasNewInfo: object => object.id === unit.id,
    })
    const point = snapshot.points[0]

    expect(snapshot.points).toHaveLength(1)
    expect(point?.id).toBe(unit.id)
    expect(point?.symbolId).toBe('square')
    expect(point?.selected).toBe(true)
    expect(point?.highlighted).toBe(true)
    expect(point?.hasNewInfo).toBe(true)
    expect(point?.position.slice(0, 2)).toEqual([10.75, 59.91])
  })

  test('projects selected mobile routes without mutating object geometry', () => {
    const route = {
      type: 'LineString' as const,
      coordinates: [
        geoPointFromLonLat(10.75, 59.91).coordinates,
        geoPointFromLonLat(10.80, 59.93).coordinates,
        geoPointFromLonLat(10.85, 59.94).coordinates,
      ],
    }
    const unit = makeObject('unit:route', {
      kind: 'mobile_entity',
      packId: 'fixture' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.80, 59.93),
          observedAt: '2026-05-30T00:00:01.000Z' as IsoTimestamp,
        },
        route: {
          planned: route,
          progress: {
            segmentIndex: 1,
            updatedAt: '2026-05-30T00:00:01.000Z' as IsoTimestamp,
          },
          source: 'simulator',
        },
      },
    })

    const snapshot = updateStore([unit], { selectedControllerId: unit.id })
    const routePath = snapshot.paths.find(path => path.kind === 'route')

    expect(routePath?.selected).toBe(true)
    expect(routePath?.path[0]).toEqual(geoPointFromLonLat(10.80, 59.93).coordinates)
    expect(route.coordinates[0]).toEqual(geoPointFromLonLat(10.75, 59.91).coordinates)
  })

  test('projects weather line objects while leaving grid reference geometry out of operational paths', () => {
    const weather = makeObject('weather:line', {
      kind: 'zone',
      packId: 'weather' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        geometry: {
          type: 'LineString',
          coordinates: [
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
          ],
        },
      },
    })
    const grid = makeObject('grid:branch', {
      kind: 'zone',
      packId: 'electric-grid' as PackId,
      spatial: weather.spatial,
      operational: { status: 'constrained', mode: 'simulated' },
    })

    const snapshot = updateStore([weather, grid])

    expect(snapshot.paths.map(path => path.kind).sort()).toEqual(['object-line'])
  })

  test('projects only anchored pack symbols; native polygons are not copied into Deck', () => {
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [[
        geoPointFromLonLat(10.70, 59.90).coordinates,
        geoPointFromLonLat(10.82, 59.90).coordinates,
        geoPointFromLonLat(10.82, 59.98).coordinates,
        geoPointFromLonLat(10.70, 59.90).coordinates,
      ]],
    }
    const features: ReadonlyArray<PackMapFeature> = [
      {
        id: 'weather-grid:8:cell-1',
        categoryId: 'weather',
        layerId: 'weather',
        geometry: polygon,
        color: '#2563eb',
        summary: 'base cell',
      },
      {
        id: 'weather:test-area',
        categoryId: 'weather',
        layerId: 'weather',
        geometry: polygon,
        anchorPoint: geoPointFromLonLat(10.75, 59.91),
        symbol: { icon: 'cloud-rain', tone: 'working' },
        color: '#2563eb',
        summary: 'influence',
      },
    ]

    const snapshot = updateStore([], { packFeatures: features })

    expect(snapshot.paths.map(path => path.kind)).toEqual([])
    expect('areas' in snapshot).toBe(false)
    expect(snapshot.areaSymbols).toHaveLength(1)
    expect(snapshot.areaSymbols[0]?.symbolId).toBe('cloud-rain')
  })

  test('keeps stable revisions when non-visual object revisions change', () => {
    const grid = makeObject('grid:branch', {
      kind: 'zone',
      packId: 'electric-grid' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        geometry: {
          type: 'LineString',
          coordinates: [
            geoPointFromLonLat(10.70, 59.90).coordinates,
            geoPointFromLonLat(10.72, 59.92).coordinates,
          ],
        },
      },
    })
    const store = createMapFeatureStore()
    const first = store.update({
      objects: [grid],
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor,
    })
    const second = store.update({
      objects: [{ ...grid, revision: 2 }],
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor,
    })

    expect(second.revisions.paths).toBe(first.revisions.paths)
    expect(second.paths[0]).toBe(first.paths[0])
  })

  test('keeps sub-meter display-motion updates visible to Deck layers', () => {
    const store = createMapFeatureStore()
    const base = makeObject('drone:smooth', {
      kind: 'mobile_entity',
      packId: 'drone' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.7500000, 59.9100000),
          speedMps: 18,
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
    })
    const input = {
      objects: [base],
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor,
    }
    const first = store.update(input)
    const second = store.update({
      ...input,
      objects: [{
        ...base,
        revision: 2,
        spatial: {
          ...base.spatial,
          position: {
            ...base.spatial.position!,
            point: geoPointFromLonLat(10.7500015, 59.9100000),
          },
        },
      }],
    })

    expect(second.revisions.points).toBe(first.revisions.points + 1)
    expect(second.points[0]?.position[0]).toBe(10.7500015)
  })

  test('filters hidden rail categories from operational map features only', () => {
    const generator = makeObject('grid:generator', {
      packId: 'electric-grid' as PackId,
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.75, 59.91),
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
    })

    const visible = updateStore([generator])
    const hidden = updateStore([generator], { hiddenObjectCategoryIds: ['electric-grids'] })

    expect(visible.points).toHaveLength(1)
    expect(hidden.points).toHaveLength(0)
  })

  test('updates placement without re-projecting object presentations', () => {
    const object = makeObject('unit:placement-selective', {
      spatial: {
        frame: { kind: 'wgs84' },
        position: {
          point: geoPointFromLonLat(10.75, 59.91),
          observedAt: '2026-05-30T00:00:00.000Z' as IsoTimestamp,
        },
      },
    })
    let presentationCallCount = 0
    const store = createMapFeatureStore()
    const input = {
      objects: [object],
      selectedControllerId: null,
      highlightedObjectIds: [],
      hiddenObjectCategoryIds: [],
      placementPoints: [],
      packFeatures: [],
      hasNewInfo: () => false,
      presentationFor: (nextObject: OperationalObject) => {
        presentationCallCount += 1
        return presentationFor(nextObject)
      },
    }
    const first = store.update(input)
    presentationCallCount = 0
    const second = store.updateFamilies({
      ...input,
      placementPoints: [geoPointFromLonLat(10.76, 59.92)],
    }, new Set(['placement'] as const))

    expect(presentationCallCount).toBe(0)
    expect(second.revisions.points).toBe(first.revisions.points)
    expect(second.revisions.placement).toBe(first.revisions.placement + 1)
  })
})

describe('base map readiness diagnostics', () => {
  test('does not call MapLibre v6 isSourceLoaded while tile managers are still settling', () => {
    let sideEffectingProbeCalled = false
    const fakeMap = {
      getStyle: () => ({ metadata: { 'leitbild:baseSources': ['leitbild-osm'] } }),
      style: {
        tileManagers: {
          'leitbild-osm': {
            loaded: () => true,
          },
        },
      },
      getContainer: () => ({
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
      }),
      getCanvas: () => ({
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        width: 800,
        height: 600,
      }),
      getLayer: () => ({}),
      getSource: () => ({
        type: 'vector',
        minzoom: 0,
        maxzoom: 14,
        tiles: ['/map/tiles/current/{z}/{x}/{y}.mvt'],
        vectorLayerIds: ['landcover', 'place', 'water'],
      }),
      isStyleLoaded: () => true,
      loaded: () => false,
      isSourceLoaded: () => {
        sideEffectingProbeCalled = true
        throw new Error('MapLibre would emit an error event here')
      },
      areTilesLoaded: () => true,
    } as unknown as Parameters<typeof inspectBaseMapReadiness>[0]

    const snapshot = inspectBaseMapReadiness(fakeMap, {}, { sawRender: true })

    expect(sideEffectingProbeCalled).toBe(false)
    expect(snapshot.baseSourceLoaded).toBe(true)
    expect(snapshot.tileManager.present).toBe(true)
    expect(snapshot.tileManager.ids).toEqual(['leitbild-osm'])
    expect(snapshot.baseSource).toEqual({
      type: 'vector',
      minZoom: 0,
      maxZoom: 14,
      tileUrlCount: 1,
      vectorLayerIds: ['landcover', 'place', 'water'],
    })
    expect(snapshot.healthy).toBe(true)
  })
})
