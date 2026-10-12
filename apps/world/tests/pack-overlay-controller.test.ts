import { describe, expect, test } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { geoPointFromLonLat, type GeoJsonPolygon } from '../src/core/model/index.ts'
import type { PackMapFeature } from '../src/core/packs/protocol.ts'
import { createMapPerformanceDiagnostics } from '../src/ui/map-runtime/map-performance-diagnostics.ts'
import { createPackOverlayController } from '../src/ui/map-runtime/pack-overlay-controller.ts'
import type { MapRuntimeDiagnosticPhaseReport, MapRuntimeHandle } from '../src/ui/map-runtime/types.ts'

const viewport: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10, 59).coordinates,
    geoPointFromLonLat(11, 59).coordinates,
    geoPointFromLonLat(11, 60).coordinates,
    geoPointFromLonLat(10, 60).coordinates,
    geoPointFromLonLat(10, 59).coordinates,
  ]],
}

const featureFor = (id: string): PackMapFeature => ({
  id,
  categoryId: 'weather',
  geometry: viewport,
  color: '#2563eb',
  summary: id,
})

const createRuntime = (
  reports: MapRuntimeDiagnosticPhaseReport[],
): MapRuntimeHandle => ({
  map: {
    getZoom: () => 8,
  } as unknown as MapLibreMap,
  claimErrors: () => () => undefined,
  updateLayers: () => undefined,
  reportDiagnosticPhase: report => {
    reports.push(report)
  },
  setDiagnosticDetails: () => undefined,
  setStyleUrl: async () => undefined,
  resize: () => undefined,
  setCameraInteraction: () => undefined,
  diagnostics: () => ({ phases: [] }),
  destroy: () => undefined,
})

describe('PackOverlayController', () => {
  test('does not query when disabled and clears active features', async () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let loadCalls = 0
    let features: ReadonlyArray<PackMapFeature> = [featureFor('stale')]
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      enabled: () => false,
      loadFeatures: async () => {
        loadCalls += 1
        return [featureFor('fresh')]
      },
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    await controller.refresh()

    expect(loadCalls).toBe(0)
    expect(features).toEqual([])
    expect(changed).toBe(1)
    expect(reports.at(-1)?.message).toBe('No pack area features active')
    controller.destroy()
  })

  test('disabled sync is idempotent when no overlay features are active', () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let features: ReadonlyArray<PackMapFeature> = []
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      enabled: () => false,
      loadFeatures: async () => [featureFor('unused')],
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    controller.syncEnabled()
    controller.syncEnabled()

    expect(features).toEqual([])
    expect(changed).toBe(1)
    expect(reports.filter(report => report.message === 'No pack area features active')).toHaveLength(1)
    controller.destroy()
  })

  test('disabled sync waits for a runtime before reporting ready diagnostics', () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let runtime: MapRuntimeHandle | null = null
    let changed = 0
    const controller = createPackOverlayController({
      getRuntime: () => runtime,
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => 'r1',
      enabled: () => false,
      loadFeatures: async () => [featureFor('unused')],
      setFeatures: () => { changed += 1 },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    controller.syncEnabled()
    runtime = createRuntime(reports)
    controller.syncEnabled()
    controller.syncEnabled()

    expect(changed).toBe(1)
    expect(reports.filter(report => report.message === 'No pack area features active')).toHaveLength(1)
    controller.destroy()
  })

  test('caches enabled overlay results by viewport, zoom, time bucket, and source revision', async () => {
    const reports: MapRuntimeDiagnosticPhaseReport[] = []
    let loadCalls = 0
    let changed = 0
    let revision = 'r1'
    let features: ReadonlyArray<PackMapFeature> = []
    const controller = createPackOverlayController({
      getRuntime: () => createRuntime(reports),
      getViewport: () => viewport,
      getCurrentTime: () => undefined,
      getSourceRevisionKey: () => revision,
      enabled: () => true,
      loadFeatures: async () => {
        loadCalls += 1
        return [featureFor(`fresh-${loadCalls}`)]
      },
      setFeatures: next => {
        features = next
        changed += 1
      },
      onError: () => undefined,
      performanceDiagnostics: createMapPerformanceDiagnostics(() => 0),
    })

    await controller.refresh()
    await controller.refresh()
    revision = 'r2'
    await controller.refresh()

    expect(loadCalls).toBe(2)
    expect(features.map(feature => feature.id)).toEqual(['fresh-2'])
    expect(reports.filter(report => report.message === 'Pack area features ready')).toHaveLength(2)
    controller.destroy()
  })
})
