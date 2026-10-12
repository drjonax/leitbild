import {
  getWorkerUrl,
  Map as MapLibre,
  NavigationControl,
  setWorkerUrl,
  type IControl,
  type Map as MapLibreMap,
  type MapOptions,
} from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { GeoJsonPoint } from '../../core/model/index.ts'
import { geoPointFromLonLat } from '../../core/model/index.ts'
import { assertCameraInteractionContract, type CameraInteraction } from '../map/map-camera.ts'
import {
  baseMapReadinessDetails,
  inspectBaseMapReadiness,
  isBaseMapReadinessFailure,
  waitForBaseMapReadiness,
} from './base-map-readiness.ts'
import { createMapDiagnostics } from './map-diagnostics.ts'
import { createMapErrorRouter } from './map-error-router.ts'
import { mapPerformanceDiagnostics } from './map-performance-diagnostics.ts'
import type {
  MapRuntimeDiagnosticDetail,
  MapRuntimeDiagnosticPhaseReport,
  MapRuntimeDiagnosticsSnapshot,
  MapRuntimeError,
  MapRuntimeHandle,
  MapRuntimeLayers,
  RenderPhase,
} from './types.ts'

type Cleanup = () => void

export interface CreateMapRuntimeConfig {
  readonly element: HTMLElement
  readonly styleUrl: string
  readonly center: GeoJsonPoint
  readonly zoom: number
  readonly preserveDrawingBuffer?: boolean
  /** Camera gestures on or off; only an active Pack switches one off. */
  readonly cameraInteraction: CameraInteraction
  readonly placementActive: () => boolean
  readonly onPlacementPoint: (point: GeoJsonPoint) => void
  readonly onMapClick: (point: GeoJsonPoint) => void
  /** `originalEvent` is present when the operator's gesture started the move. */
  readonly onMoveStart: (event: { readonly originalEvent?: unknown }) => void
  readonly onMoveEnd: () => void
  readonly onError: (error: MapRuntimeError) => void
  readonly onDiagnostics: (snapshot: MapRuntimeDiagnosticsSnapshot) => void
}

const configureMapLibreWorker = (): string => {
  if (getWorkerUrl() !== maplibreWorkerUrl) {
    setWorkerUrl(maplibreWorkerUrl)
  }
  return maplibreWorkerUrl
}

const containerDetails = (element: HTMLElement): ReadonlyArray<MapRuntimeDiagnosticDetail> => {
  const rect = element.getBoundingClientRect()
  return [
    { label: 'Container', value: `${Math.round(rect.width)}x${Math.round(rect.height)}` },
  ]
}

const installResizeObserver = (
  element: HTMLElement,
  map: MapLibreMap,
): Cleanup => {
  let lastWidth = 0
  let lastHeight = 0
  const resizeIfNeeded = (width: number, height: number, source: string): void => {
    const nextWidth = Math.round(width)
    const nextHeight = Math.round(height)
    if (nextWidth < 1 || nextHeight < 1) return
    if (nextWidth === lastWidth && nextHeight === lastHeight) return
    lastWidth = nextWidth
    lastHeight = nextHeight
    map.resize({ source: `leitbild-${source}` })
  }
  const rect = element.getBoundingClientRect()
  resizeIfNeeded(rect.width, rect.height, 'initial-resize')
  if (typeof ResizeObserver === 'undefined') {
    return () => undefined
  }
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    resizeIfNeeded(entry.contentRect.width, entry.contentRect.height, 'observed-resize')
  })
  observer.observe(element)
  return () => {
    observer.disconnect()
  }
}

const waitForBase = async (
  map: MapLibreMap,
  diagnostics: ReturnType<typeof createMapDiagnostics>,
  phase: RenderPhase,
  isCancelled: () => boolean,
): Promise<void> => {
  try {
    const readiness = await mapPerformanceDiagnostics.measureAsync(
      'base',
      'waitForBaseMapReadiness',
      async () => waitForBaseMapReadiness(map, { isCancelled }),
    )
    diagnostics.ready(phase, 'Base map rendered', readiness.details)
  } catch (err) {
    if (isBaseMapReadinessFailure(err)) {
      diagnostics.fail(phase, {
        phase,
        message: err.message,
        recoverable: false,
      }, baseMapReadinessDetails(err.snapshot))
    }
    throw err
  }
}

const diagnosticErrorFor = (
  report: MapRuntimeDiagnosticPhaseReport,
): MapRuntimeError => report.error ?? {
  phase: report.phase,
  message: report.message,
  recoverable: false,
}

export const createMapRuntime = async (
  config: CreateMapRuntimeConfig,
): Promise<MapRuntimeHandle> => {
  const workerUrl = configureMapLibreWorker()
  const diagnostics = createMapDiagnostics()
  diagnostics.start('base', 'Creating vector map', [
    ...containerDetails(config.element),
    { label: 'Worker', value: workerUrl },
  ])

  const cleanups: Cleanup[] = []
  let destroyed = false
  let operationalDiagnosticsReported = false
  const snapshot = (): MapRuntimeDiagnosticsSnapshot => ({
    ...diagnostics.snapshot(),
    performance: mapPerformanceDiagnostics.snapshot(),
  })
  const emitDiagnostics = (): void => config.onDiagnostics(snapshot())
  const reportDiagnosticPhase = (report: MapRuntimeDiagnosticPhaseReport): void => {
    const details = report.details ?? []
    if (report.status === 'running') {
      diagnostics.start(report.phase, report.message, details)
    } else if (report.status === 'ready') {
      diagnostics.ready(report.phase, report.message, details)
    } else {
      diagnostics.fail(report.phase, diagnosticErrorFor(report), details)
    }
    emitDiagnostics()
  }
  const setDiagnosticDetails = (
    phase: RenderPhase | 'runtime',
    details: ReadonlyArray<MapRuntimeDiagnosticDetail>,
  ): void => {
    diagnostics.details(phase, details)
    emitDiagnostics()
  }
  emitDiagnostics()
  const reportError = (error: MapRuntimeError): void => {
    diagnostics.fail(error.phase, error, diagnostics.snapshot().phases.find(phase => phase.phase === error.phase)?.details ?? [])
    emitDiagnostics()
    config.onError(error)
  }

  const mapOptions: MapOptions & { readonly preserveDrawingBuffer?: boolean } = {
    container: config.element,
    style: config.styleUrl,
    center: [config.center.coordinates[0], config.center.coordinates[1]],
    zoom: config.zoom,
    interactive: true,
    dragPan: true,
    scrollZoom: true,
    boxZoom: true,
    doubleClickZoom: true,
    touchZoomRotate: true,
    keyboard: true,
    cooperativeGestures: false,
    preserveDrawingBuffer: config.preserveDrawingBuffer === true,
  }
  const current = mapPerformanceDiagnostics.measure(
    'base',
    'MapLibre constructor',
    () => new MapLibre(mapOptions),
    { styleUrl: config.styleUrl, workerUrl },
  )
  assertCameraInteractionContract(current, config.cameraInteraction)

  let overlay: MapboxOverlay | null = null
  /** The picking radius last set; a mouse's 0 until a finger or pen sets more. */
  let pickingRadiusPx = 0
  const installDeckOverlay = (): void => {
    diagnostics.start('operational-dynamic', 'Installing deck overlay')
    const nextOverlay = mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'Deck overlay constructor',
      () => new MapboxOverlay({
        interleaved: false,
        layers: [],
        // Layer clicks dispatch inside MapLibre's click event, which is how the map tells an
        // object click from a ground click; 'auto' would turn async on a WebGPU device.
        pickAsync: 'sync',
      }),
    )
    overlay = nextOverlay
    mapPerformanceDiagnostics.measure(
      'operational-dynamic',
      'add Deck overlay control',
      () => current.addControl(nextOverlay as unknown as IControl),
    )
    diagnostics.ready('operational-dynamic', 'Deck overlay installed')
    emitDiagnostics()
  }
  mapPerformanceDiagnostics.measure(
    'base',
    'add navigation control',
    () => current.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right'),
  )
  cleanups.push(installResizeObserver(config.element, current))
  let resourcesDestroyed = false
  const destroyResources = (): void => {
    if (resourcesDestroyed) return
    resourcesDestroyed = true
    destroyed = true
    overlay?.setProps({ layers: [] })
    current.remove()
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      cleanups[index]?.()
    }
  }

  const errorRouter = createMapErrorRouter({
    onReferenceWarning: (message) => {
      diagnostics.details('reference', [
        { label: 'Reference warning', value: message },
      ])
      emitDiagnostics()
    },
    onRuntimeError: (details) => {
      reportError({
        phase: 'runtime',
        message: details.message,
        recoverable: false,
        ...(details.sourceId ? { sourceId: details.sourceId } : {}),
      })
    },
  })
  current.on('error', errorRouter.route)

  const canvas = current.getCanvas()
  let contextLossTimer: ReturnType<typeof setTimeout> | null = null
  const onContextLost = (event: Event): void => {
    event.preventDefault()
    diagnostics.fail('runtime', {
      phase: 'runtime',
      message: 'Vector map WebGL context was lost',
      recoverable: true,
    })
    emitDiagnostics()
    contextLossTimer = setTimeout(() => {
      reportError({
        phase: 'runtime',
        message: 'Vector map WebGL context did not recover',
        recoverable: false,
      })
    }, 2_000)
  }
  const onContextRestored = (): void => {
    if (contextLossTimer !== null) {
      clearTimeout(contextLossTimer)
      contextLossTimer = null
    }
    diagnostics.ready('runtime', 'WebGL context restored')
    emitDiagnostics()
    current.resize({ source: 'leitbild-context-restored' })
    current.triggerRepaint()
  }
  canvas.addEventListener('webglcontextlost', onContextLost, false)
  canvas.addEventListener('webglcontextrestored', onContextRestored, false)
  cleanups.push(() => {
    if (contextLossTimer !== null) clearTimeout(contextLossTimer)
    contextLossTimer = null
    canvas.removeEventListener('webglcontextlost', onContextLost, false)
    canvas.removeEventListener('webglcontextrestored', onContextRestored, false)
  })

  current.on('click', (event) => {
    const point = geoPointFromLonLat(event.lngLat.lng, event.lngLat.lat)
    if (config.placementActive()) config.onPlacementPoint(point)
    else config.onMapClick(point)
  })
  current.on('movestart', config.onMoveStart)
  current.on('moveend', config.onMoveEnd)

  diagnostics.details('base', baseMapReadinessDetails(inspectBaseMapReadiness(current)))
  emitDiagnostics()
  try {
    await waitForBase(current, diagnostics, 'base', () => destroyed)
  } catch (err) {
    emitDiagnostics()
    destroyResources()
    throw err
  }
  emitDiagnostics()
  installDeckOverlay()

  return {
    map: current,
    claimErrors: errorRouter.claim,
    updateLayers: (layers: MapRuntimeLayers) => {
      const activeOverlay = overlay
      if (activeOverlay === null) {
        throw new Error('Deck overlay is not installed')
      }
      mapPerformanceDiagnostics.measure(
        'operational-dynamic',
        'deckOverlay.setProps',
        () => activeOverlay.setProps({ layers: [...layers.deckLayers] }),
        { deckLayers: layers.deckLayers.length },
      )
      if (operationalDiagnosticsReported) return
      operationalDiagnosticsReported = true
      diagnostics.start('operational-dynamic', `Applying ${layers.deckLayers.length} deck layers`)
      diagnostics.ready('operational-dynamic', 'Deck overlay ready', [
        { label: 'Deck layers', value: String(layers.deckLayers.length) },
      ])
      emitDiagnostics()
    },
    reportDiagnosticPhase,
    setDiagnosticDetails,
    setStyleUrl: async (styleUrl: string): Promise<void> => {
      diagnostics.start('base', 'Changing vector map style')
      emitDiagnostics()
      mapPerformanceDiagnostics.measure(
        'base',
        'MapLibre setStyle',
        () => current.setStyle(styleUrl),
        { styleUrl },
      )
      try {
        await waitForBase(current, diagnostics, 'base', () => destroyed)
      } catch (err) {
        emitDiagnostics()
        throw err
      }
      emitDiagnostics()
    },
    resize: () => {
      current.resize({ source: 'leitbild-runtime-resize' })
    },
    setCameraInteraction: (interaction: CameraInteraction) => {
      assertCameraInteractionContract(current, interaction)
    },
    setPickingRadius: (radiusPx: number) => {
      if (!Number.isFinite(radiusPx) || radiusPx < 0) throw new Error(`Picking radius must be a non-negative number of px: ${radiusPx}`)
      const activeOverlay = overlay
      if (activeOverlay === null) throw new Error('Deck overlay is not installed')
      activeOverlay.setProps({ pickingRadius: radiusPx })
      pickingRadiusPx = radiusPx
    },
    pickObjectsAt: (screen, layerIds, depth) => {
      const activeOverlay = overlay
      if (activeOverlay === null) throw new Error('Deck overlay is not installed')
      return activeOverlay.pickMultipleObjects({ x: screen.x, y: screen.y, radius: pickingRadiusPx, depth, layerIds: [...layerIds] })
    },
    diagnostics: snapshot,
    destroy: () => {
      destroyResources()
    },
  }
}
