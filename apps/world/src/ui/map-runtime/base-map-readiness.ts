import type { Map as MapLibreMap } from 'maplibre-gl'
import type { MapRuntimeDiagnosticDetail } from './types.ts'

export interface BaseMapReadinessSnapshot {
  readonly container: { readonly width: number; readonly height: number }
  readonly canvas: { readonly cssWidth: number; readonly cssHeight: number; readonly bufferWidth: number; readonly bufferHeight: number }
  readonly baseSource: {
    readonly type: string | null
    readonly minZoom: number | null
    readonly maxZoom: number | null
    readonly tileUrlCount: number | null
    readonly vectorLayerIds: ReadonlyArray<string>
  }
  readonly tileManager: {
    readonly present: boolean
    readonly ids: ReadonlyArray<string>
  }
  readonly styleLoaded: boolean
  readonly styleGraphReady: boolean
  readonly mapLoaded: boolean
  readonly baseSourcePresent: boolean
  readonly baseSourceLoaded: boolean
  readonly tilesLoaded: boolean
  readonly requiredLayersPresent: boolean
  readonly missingLayerIds: ReadonlyArray<string>
  readonly sawRender: boolean
  readonly sawIdle: boolean
  readonly tileErrorCount: number
  readonly latestTileError: string | null
  readonly healthy: boolean
}

export interface BaseMapReadinessResult {
  readonly snapshot: BaseMapReadinessSnapshot
  readonly details: ReadonlyArray<MapRuntimeDiagnosticDetail>
}

export interface BaseMapReadinessOptions {
  readonly timeoutMs?: number
  readonly baseSourceId?: string
  readonly requiredLayerIds?: ReadonlyArray<string>
  readonly isCancelled?: () => boolean
}

export interface BaseMapReadinessFailure extends Error {
  readonly snapshot: BaseMapReadinessSnapshot
}

export const isBaseMapReadinessFailure = (err: unknown): err is BaseMapReadinessFailure =>
  err instanceof Error && 'snapshot' in err

/**
 * How long a base map may take to become ready before the start fails with
 * its retry. A cold tile cache, a slow disk or a browser throttling a hidden
 * window can take well past 8 s on a start that then succeeds, so the budget
 * leaves room for those; a map that never becomes ready still fails visibly.
 */
const defaultTimeoutMs = 20_000
const baseSourceIdsFor = (map: MapLibreMap, options: BaseMapReadinessOptions): string[] => {
  if (options.baseSourceId) return [options.baseSourceId]
  const metadata = map.getStyle()?.metadata as Record<string, unknown> | undefined
  const ids = metadata?.['leitbild:baseSources']
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}
const defaultRequiredLayerIds: ReadonlyArray<string> = [
  'water',
  'landuse',
  'landcover',
  'road',
  'place-label',
]

const visibleDimension = (value: number): boolean =>
  Number.isFinite(value) && value >= 1

const safeBoolean = (read: () => boolean): boolean => {
  try {
    return read()
  } catch (err) {
    void err
    return false
  }
}

interface MapLibreTileManagerReader {
  readonly style?: {
    readonly tileManagers?: unknown
  }
}

interface MapLibreTileManager {
  readonly loaded?: () => boolean
}

interface MapLibreTileManagerMapLike {
  readonly get: (key: string) => MapLibreTileManager | undefined
  readonly keys: () => Iterable<string>
}

interface MapLibreSourceDiagnosticReader {
  readonly type?: unknown
  readonly minzoom?: unknown
  readonly minZoom?: unknown
  readonly maxzoom?: unknown
  readonly maxZoom?: unknown
  readonly url?: unknown
  readonly tiles?: unknown
  readonly vectorLayerIds?: unknown
  readonly vector_layers?: unknown
  readonly _vectorLayerIds?: unknown
}

const isTileManager = (value: unknown): value is MapLibreTileManager =>
  typeof value === 'object' && value !== null

const isTileManagerMapLike = (value: unknown): value is MapLibreTileManagerMapLike => {
  const candidate = value as { readonly get?: unknown; readonly keys?: unknown }
  return typeof candidate?.get === 'function' && typeof candidate.keys === 'function'
}

const tileManagersFor = (
  map: MapLibreMap,
): {
  readonly ids: ReadonlyArray<string>
  readonly get: (sourceId: string) => MapLibreTileManager | null
} => {
  const tileManagers = (map as unknown as MapLibreTileManagerReader).style?.tileManagers
  if (isTileManagerMapLike(tileManagers)) {
    const ids = Array.from(tileManagers.keys()).filter((id): id is string => typeof id === 'string').sort()
    return {
      ids,
      get: sourceId => tileManagers.get(sourceId) ?? null,
    }
  }
  if (typeof tileManagers === 'object' && tileManagers !== null) {
    const record = tileManagers as Readonly<Record<string, unknown>>
    const ids = Object.keys(record).sort()
    return {
      ids,
      get: sourceId => isTileManager(record[sourceId]) ? record[sourceId] : null,
    }
  }
  return {
    ids: [],
    get: () => null,
  }
}

const tileManagerDiagnostics = (
  map: MapLibreMap,
  sourceId: string,
): BaseMapReadinessSnapshot['tileManager'] => {
  const managers = tileManagersFor(map)
  return {
    present: managers.get(sourceId) !== null,
    ids: managers.ids,
  }
}

const sourceLoadedWithoutEmittingMapError = (
  map: MapLibreMap,
  sourceId: string,
): boolean => {
  const tileManager = tileManagersFor(map).get(sourceId)
  if (!tileManager?.loaded) return false
  return safeBoolean(() => tileManager.loaded?.() === true)
}

const numberFromUnknown = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const stringFromUnknown = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const vectorLayerIdsFromUnknown = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return []
  return value
    .map((entry): string | null => {
      if (typeof entry === 'string') return entry
      if (typeof entry !== 'object' || entry === null) return null
      return stringFromUnknown((entry as { readonly id?: unknown }).id)
    })
    .filter((id): id is string => id !== null)
    .sort()
}

const sourceDiagnostics = (
  map: MapLibreMap,
  sourceId: string,
): BaseMapReadinessSnapshot['baseSource'] => {
  const source = map.getSource(sourceId) as MapLibreSourceDiagnosticReader | undefined
  const publicVectorLayerIds = vectorLayerIdsFromUnknown(source?.vectorLayerIds)
  const tileJsonVectorLayerIds = vectorLayerIdsFromUnknown(source?.vector_layers)
  return {
    type: stringFromUnknown(source?.type),
    minZoom: numberFromUnknown(source?.minzoom) ?? numberFromUnknown(source?.minZoom),
    maxZoom: numberFromUnknown(source?.maxzoom) ?? numberFromUnknown(source?.maxZoom),
    tileUrlCount: Array.isArray(source?.tiles) ? source.tiles.length : stringFromUnknown(source?.url) === null ? null : 1,
    vectorLayerIds: publicVectorLayerIds.length > 0
      ? publicVectorLayerIds
      : tileJsonVectorLayerIds.length > 0
        ? tileJsonVectorLayerIds
        : vectorLayerIdsFromUnknown(source?._vectorLayerIds),
  }
}

const compactIdList = (ids: ReadonlyArray<string>): string =>
  ids.length === 0 ? 'none' : ids.slice(0, 8).join(', ') + (ids.length > 8 ? ` +${ids.length - 8}` : '')

const zoomRangeLabel = (source: BaseMapReadinessSnapshot['baseSource']): string =>
  source.minZoom === null && source.maxZoom === null ? 'unknown' : `${source.minZoom ?? '?'}-${source.maxZoom ?? '?'}`

const sourceLabel = (source: BaseMapReadinessSnapshot['baseSource']): string => {
  const parts = [
    source.type ?? 'unknown',
    `z${zoomRangeLabel(source)}`,
    source.tileUrlCount === null ? 'tile urls unknown' : `${source.tileUrlCount} tile url${source.tileUrlCount === 1 ? '' : 's'}`,
  ]
  return parts.join('; ')
}

export const inspectBaseMapReadiness = (
  map: MapLibreMap,
  options: BaseMapReadinessOptions = {},
  eventState: {
    readonly sawRender?: boolean
    readonly sawIdle?: boolean
    readonly tileErrorCount?: number
    readonly latestTileError?: string | null
  } = {},
): BaseMapReadinessSnapshot => {
  const containerRect = map.getContainer().getBoundingClientRect()
  const canvas = map.getCanvas()
  const canvasRect = canvas.getBoundingClientRect()
  const baseSourceIds = baseSourceIdsFor(map, options)
  const baseSourceId = baseSourceIds[0] ?? ''
  const requiredLayerIds = options.requiredLayerIds ?? defaultRequiredLayerIds
  const missingLayerIds = requiredLayerIds.filter(layerId => !map.getLayer(layerId))
  const baseSourcePresent = baseSourceIds.length > 0 && baseSourceIds.every(id => Boolean(map.getSource(id)))
  const baseSource = sourceDiagnostics(map, baseSourceId)
  const tileManager = tileManagerDiagnostics(map, baseSourceId)
  const styleLoaded = safeBoolean(() => map.isStyleLoaded() === true)
  const mapLoaded = safeBoolean(() => map.loaded() === true)
  const baseSourceLoaded = baseSourceIds.length > 0 && baseSourceIds.every(id => sourceLoadedWithoutEmittingMapError(map, id))
  const tilesLoaded = safeBoolean(() => map.areTilesLoaded() === true)
  const styleGraphReady = baseSourcePresent && missingLayerIds.length === 0
  const presentable = visibleDimension(containerRect.width)
    && visibleDimension(containerRect.height)
    && visibleDimension(canvasRect.width)
    && visibleDimension(canvasRect.height)
    && canvas.width > 0
    && canvas.height > 0
  const sawRender = eventState.sawRender === true
  const sawIdle = eventState.sawIdle === true
  const tileErrorCount = eventState.tileErrorCount ?? 0
  const latestTileError = eventState.latestTileError ?? null
  return {
    container: {
      width: Math.round(containerRect.width),
      height: Math.round(containerRect.height),
    },
    canvas: {
      cssWidth: Math.round(canvasRect.width),
      cssHeight: Math.round(canvasRect.height),
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
    },
    baseSource,
    tileManager,
    styleLoaded,
    styleGraphReady,
    mapLoaded,
    baseSourcePresent,
    baseSourceLoaded,
    tilesLoaded,
    requiredLayersPresent: missingLayerIds.length === 0,
    missingLayerIds,
    sawRender,
    sawIdle,
    tileErrorCount,
    latestTileError,
    healthy: presentable && styleGraphReady && baseSourceLoaded && tilesLoaded && sawRender && tileErrorCount === 0,
  }
}

export const baseMapReadinessDetails = (
  snapshot: BaseMapReadinessSnapshot,
): ReadonlyArray<MapRuntimeDiagnosticDetail> => [
  { label: 'Container', value: `${snapshot.container.width}x${snapshot.container.height}` },
  { label: 'Canvas', value: `${snapshot.canvas.cssWidth}x${snapshot.canvas.cssHeight}/${snapshot.canvas.bufferWidth}x${snapshot.canvas.bufferHeight}` },
  { label: 'Style', value: snapshot.styleLoaded ? 'loaded' : snapshot.styleGraphReady ? 'graph-ready' : 'loading' },
  { label: 'Map tiles', value: snapshot.mapLoaded ? 'settled' : 'loading' },
  { label: 'Base source', value: snapshot.baseSourcePresent ? 'present' : 'missing' },
  { label: 'Base source spec', value: sourceLabel(snapshot.baseSource) },
  { label: 'Base vector layers', value: compactIdList(snapshot.baseSource.vectorLayerIds) },
  { label: 'Tile managers', value: compactIdList(snapshot.tileManager.ids) },
  { label: 'Base tile manager', value: snapshot.tileManager.present ? 'present' : 'missing' },
  { label: 'Base source loaded', value: snapshot.baseSourceLoaded ? 'yes' : 'no' },
  { label: 'Tiles loaded', value: snapshot.tilesLoaded ? 'yes' : 'no' },
  { label: 'Base layers', value: snapshot.requiredLayersPresent ? 'present' : `missing ${snapshot.missingLayerIds.join(', ')}` },
  { label: 'Render event', value: snapshot.sawRender ? 'seen' : 'pending' },
  { label: 'Idle event', value: snapshot.sawIdle ? 'seen' : 'pending' },
  ...(snapshot.tileErrorCount === 0
    ? []
    : [
        { label: 'Tile errors', value: String(snapshot.tileErrorCount) },
        { label: 'Latest tile error', value: snapshot.latestTileError ?? 'unknown' },
      ]),
]

export const waitForBaseMapReadiness = (
  map: MapLibreMap,
  options: BaseMapReadinessOptions = {},
): Promise<BaseMapReadinessResult> => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let sawRender = false
  let sawIdle = false
  let tileErrorCount = 0
  let latestTileError: string | null = null
  let settled = false
  let timeout: number | null = null
  let frame: number | null = null

  const cleanup = (): void => {
    map.off('render', onRender)
    map.off('idle', onIdle)
    map.off('style.load', onStyleLoad)
    map.off('error', onError)
    if (timeout !== null) window.clearTimeout(timeout)
    if (frame !== null) cancelAnimationFrame(frame)
    timeout = null
    frame = null
  }

  const settle = (snapshot: BaseMapReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve({ snapshot, details: baseMapReadinessDetails(snapshot) })
  }

  const fail = (snapshot: BaseMapReadinessSnapshot): void => {
    if (settled) return
    settled = true
    cleanup()
    const error = new Error(
      `Base map did not become ready; style=${snapshot.styleLoaded ? 'loaded' : snapshot.styleGraphReady ? 'graph-ready' : 'loading'}; `
      + `source=${snapshot.baseSourcePresent ? 'present' : 'missing'}; `
      + `tileManager=${snapshot.tileManager.present ? 'present' : 'missing'}; `
      + `sourceLoaded=${snapshot.baseSourceLoaded ? 'yes' : 'no'}; `
      + `tilesLoaded=${snapshot.tilesLoaded ? 'yes' : 'no'}; `
      + `tileErrors=${snapshot.tileErrorCount}; `
      + `layers=${snapshot.missingLayerIds.join(',') || 'ok'}; `
      + `container=${snapshot.container.width}x${snapshot.container.height}; `
      + `canvas=${snapshot.canvas.cssWidth}x${snapshot.canvas.cssHeight}/${snapshot.canvas.bufferWidth}x${snapshot.canvas.bufferHeight}`,
    ) as BaseMapReadinessFailure
    Object.assign(error, { snapshot })
    reject(error)
  }

  const inspect = (): BaseMapReadinessSnapshot =>
    inspectBaseMapReadiness(map, options, { sawRender, sawIdle, tileErrorCount, latestTileError })

  const maybeSettle = (): void => {
    if (settled) return
    if (options.isCancelled?.() === true) {
      settle(inspect())
      return
    }
    const snapshot = inspect()
    if (snapshot.healthy) settle(snapshot)
  }

  function onRender(): void {
    sawRender = true
    maybeSettle()
  }

  function onIdle(): void {
    sawIdle = true
    maybeSettle()
  }

  function onStyleLoad(): void {
    maybeSettle()
  }

  function onError(event: unknown): void {
    const candidate = event as { readonly error?: unknown; readonly sourceId?: unknown }
    const message = candidate.error instanceof Error ? candidate.error.message : String(candidate.error ?? 'map source error')
    const sourceId = typeof candidate.sourceId === 'string' ? candidate.sourceId : null
    if (sourceId && !baseSourceIdsFor(map, options).includes(sourceId)) return
    tileErrorCount += 1
    latestTileError = message
  }

  map.on('render', onRender)
  map.on('idle', onIdle)
  map.on('style.load', onStyleLoad)
  map.on('error', onError)
  timeout = window.setTimeout(() => {
    const snapshot = inspect()
    if (snapshot.healthy) settle(snapshot)
    else fail(snapshot)
  }, timeoutMs)
  frame = requestAnimationFrame(() => {
    frame = null
    maybeSettle()
    map.triggerRepaint()
  })
  maybeSettle()
})
