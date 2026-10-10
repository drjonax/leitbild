import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import { watchReferenceBuilds } from './reference-build-recovery.ts'
import {
  buildReferenceDatasetLayers,
  type DatasetManifestForLayers,
} from './reference-layer-factory.ts'

// Imperative registration of Pack-styled reference datasets: fetches
// /map/capabilities.json and adds one vector source plus the Pack's layers for
// every active style whose dataset the server publishes. Visibility belongs to
// the Pack layer-group controller; stacking to the caller's `beforeLayerId`.
// Once registered, a dataset follows promotions of its build on the server
// (`reference-build-recovery.ts`) until the controller is disposed.

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
  /** A registered dataset's build was superseded and the published one could not be adopted. */
  readonly onBuildRecoveryFailed: (message: string) => void
}

export interface RegisteredReferenceDataset {
  readonly datasetId: string
  readonly sourceId: string
  readonly buildId: string
  readonly layerIds: ReadonlyArray<string>
}

export interface ReferenceDatasetController {
  readonly registered: ReadonlyArray<RegisteredReferenceDataset>
  /** Stops following build promotions. */
  readonly dispose: () => void
}

const readManifest = async (url: string, fetchFn: (input: string) => Promise<Response>): Promise<ManifestForController> => {
  const response = await fetchFn(url)
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const parsed = await response.json() as ManifestForController
  if (!Array.isArray(parsed.tilesets)) throw new Error(`${url} lists no tilesets[]`)
  return parsed
}

const fetchManifest = async (
  url: string,
  fetchFn: (input: string) => Promise<Response>,
  log: (m: string) => void,
): Promise<ManifestForController | null> => {
  try {
    return await readManifest(url, fetchFn)
  } catch (err) {
    log(`reference-data: manifest fetch failed — ${err instanceof Error ? err.message : String(err)}; no reference layers will be registered`)
    return null
  }
}

const referenceTilesetsOf = (manifest: ManifestForController): Map<string, ReferenceTilesetForController> => {
  const tilesets = new Map<string, ReferenceTilesetForController>()
  for (const entry of manifest.tilesets) if (isReference(entry)) tilesets.set(entry.datasetId, entry)
  return tilesets
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
    buildId: tileset.buildId,
    layerIds: built.layers.map(layer => layer.id),
  }
}

export const createReferenceDataController = async (
  config: ReferenceDatasetControllerConfig,
): Promise<ReferenceDatasetController> => {
  const log = config.logger ?? ((msg: string) => console.warn(msg))
  const nothingRegistered: ReferenceDatasetController = { registered: [], dispose: () => {} }
  if (config.styles.length === 0) return nothingRegistered
  const capabilitiesUrl = config.capabilitiesUrl ?? CAPABILITIES_URL
  const fetchFn = config.fetchFn ?? ((input: string) => globalThis.fetch(input))
  const manifest = await fetchManifest(capabilitiesUrl, fetchFn, log)
  if (!manifest) return nothingRegistered

  const tilesets = referenceTilesetsOf(manifest)
  const registered: Array<RegisteredReferenceDataset & { readonly style: PackReferenceDatasetStyle }> = []
  for (const style of config.styles) {
    const tileset = tilesets.get(style.datasetId)
    if (!tileset) {
      log(`reference-data: dataset "${style.datasetId}" is not published in the map capabilities; its layers are not shown`)
      continue
    }
    registered.push({ ...registerOne(config.map, tileset, style, config.appearance, config.beforeLayerId()), style })
  }
  const recovery = watchReferenceBuilds({
    map: config.map,
    appearance: config.appearance,
    datasets: registered,
    readPublished: async () => new Map([...referenceTilesetsOf(await readManifest(capabilitiesUrl, fetchFn))]
      .map(([datasetId, tileset]) => [datasetId, manifestEntryForLayers(tileset)])),
    onAdopted: (datasetId, fromBuildId, toBuildId) => log(`reference-data: ${datasetId} moved from build ${fromBuildId} to ${toBuildId}`),
    onFailure: config.onBuildRecoveryFailed,
  })
  return {
    registered: registered.map(({ datasetId, sourceId, buildId, layerIds }) => ({ datasetId, sourceId, buildId, layerIds })),
    dispose: recovery.dispose,
  }
}

export const __internals = { isReference }
