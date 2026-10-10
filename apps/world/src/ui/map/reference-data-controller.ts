import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import {
  buildReferenceDatasetLayers,
  type DatasetManifestForLayers,
} from './reference-layer-factory.ts'

// Imperative registration of Pack-styled reference datasets: fetches
// /map/capabilities.json and adds one vector source plus the Pack's layers for
// every active style whose dataset the server publishes. Visibility belongs to
// the Pack layer-group controller; stacking to the caller's `beforeLayerId`.

const CAPABILITIES_URL = '/map/capabilities.json'

interface ReferenceTilesetForController {
  readonly kind: 'reference'
  readonly datasetId: string
  readonly schemaVersion: number
  readonly builtAt: string
  readonly buildId: string
  readonly artifact: {
    readonly pmtilesPath: string
    readonly sidecarGeoJsonPath: string
    readonly outputLayer: string
  }
  readonly categories: ReadonlyArray<{
    readonly category: string
    readonly minZoom: number
    readonly maxZoom: number
    readonly featureCount: number
  }>
  readonly sources: ReadonlyArray<{ readonly id: string; readonly kind: string }>
  readonly licences: ReadonlyArray<{ readonly id: string; readonly attribution: string }>
  readonly tiles: DatasetManifestForLayers['tiles']
}

interface ManifestForController {
  readonly schemaVersion: number
  readonly tilesets: ReadonlyArray<{ readonly kind: string } & Record<string, unknown>>
}

const isReference = (entry: { readonly kind: string }): entry is ReferenceTilesetForController =>
  entry.kind === 'reference'

const manifestEntryForLayers = (tileset: ReferenceTilesetForController): DatasetManifestForLayers => ({
  datasetId: tileset.datasetId,
  buildId: tileset.buildId,
  artifact: tileset.artifact,
  categories: tileset.categories,
  licences: tileset.licences.map(l => ({ id: l.id, attribution: l.attribution })),
  tiles: tileset.tiles,
})

export interface ReferenceDatasetControllerConfig {
  readonly map: MapLibreMap
  readonly styles: ReadonlyArray<PackReferenceDatasetStyle>
  readonly appearance: PackMapAppearance
  /** Evaluated just before the layers are added; null appends them on top. */
  readonly beforeLayerId: () => string | null
  readonly fetchFn?: (input: string) => Promise<Response>
  readonly capabilitiesUrl?: string
  readonly logger?: (message: string) => void
}

export interface RegisteredReferenceDataset {
  readonly datasetId: string
  readonly sourceId: string
  readonly layerIds: ReadonlyArray<string>
}

export interface ReferenceDatasetController {
  readonly registered: ReadonlyArray<RegisteredReferenceDataset>
}

const fetchManifest = async (
  url: string,
  fetchFn: (input: string) => Promise<Response>,
  log: (m: string) => void,
): Promise<ManifestForController | null> => {
  try {
    const response = await fetchFn(url)
    if (!response.ok) {
      log(`reference-data: ${url} returned HTTP ${response.status}; no reference layers will be registered`)
      return null
    }
    const parsed = await response.json() as ManifestForController
    if (!Array.isArray(parsed.tilesets)) {
      log('reference-data: manifest is missing tilesets[]; no reference layers will be registered')
      return null
    }
    return parsed
  } catch (err) {
    log(`reference-data: manifest fetch failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

const registerOne = (
  map: MapLibreMap,
  tileset: ReferenceTilesetForController,
  style: PackReferenceDatasetStyle,
  appearance: PackMapAppearance,
  beforeLayerId: string | null,
): RegisteredReferenceDataset => {
  const built = buildReferenceDatasetLayers(manifestEntryForLayers(tileset), style, appearance)
  if (beforeLayerId !== null && !map.getLayer(beforeLayerId)) {
    throw new Error(`reference layers for ${tileset.datasetId} must be inserted before missing layer ${beforeLayerId}`)
  }
  if (!map.getSource(built.sourceId)) {
    map.addSource(built.sourceId, {
      type: built.source.type,
      tiles: [...built.source.tiles],
      minzoom: built.source.minzoom,
      maxzoom: built.source.maxzoom,
      bounds: [...built.source.bounds],
      attribution: built.source.attribution,
    })
  }
  for (const layer of built.layers) {
    if (map.getLayer(layer.id)) continue
    // Pack specs are validated MapLibre JSON; their loose records do not satisfy
    // MapLibre's per-type paint unions statically.
    map.addLayer(layer as unknown as Parameters<MapLibreMap['addLayer']>[0], beforeLayerId ?? undefined)
  }
  return {
    datasetId: tileset.datasetId,
    sourceId: built.sourceId,
    layerIds: built.layers.map(layer => layer.id),
  }
}

export const createReferenceDataController = async (
  config: ReferenceDatasetControllerConfig,
): Promise<ReferenceDatasetController> => {
  const log = config.logger ?? ((msg: string) => console.warn(msg))
  if (config.styles.length === 0) return { registered: [] }
  const fetchFn = config.fetchFn ?? ((input: string) => globalThis.fetch(input))
  const manifest = await fetchManifest(config.capabilitiesUrl ?? CAPABILITIES_URL, fetchFn, log)
  if (!manifest) return { registered: [] }

  const tilesets = new Map<string, ReferenceTilesetForController>()
  for (const entry of manifest.tilesets) if (isReference(entry)) tilesets.set(entry.datasetId, entry)
  const registered: RegisteredReferenceDataset[] = []
  for (const style of config.styles) {
    const tileset = tilesets.get(style.datasetId)
    if (!tileset) {
      log(`reference-data: dataset "${style.datasetId}" is not published in the map capabilities; its layers are not shown`)
      continue
    }
    registered.push(registerOne(config.map, tileset, style, config.appearance, config.beforeLayerId()))
  }
  return { registered }
}

export const __internals = { isReference }
