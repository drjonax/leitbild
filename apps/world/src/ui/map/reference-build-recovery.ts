import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import {
  buildReferenceDatasetLayers,
  type DatasetManifestForLayers,
  type ReferenceDatasetLayers,
} from './reference-layer-factory.ts'

// A reference tile answered 409 names a build the server no longer serves: the
// release was promoted while this map was open. The map then re-reads the
// published datasets once per superseded build and swaps the dataset's source to
// the published build, re-adding the Pack's layers in place with their current
// visibility. When the datasets cannot be read, no longer publish the dataset, or
// still publish the refused build, the dataset's layers and source are removed
// and the failure reported, so tiles of a superseded build never stay on screen.

export interface RecoverableReferenceDataset {
  readonly datasetId: string
  readonly sourceId: string
  readonly buildId: string
  readonly layerIds: ReadonlyArray<string>
  readonly style: PackReferenceDatasetStyle
}

export interface ReferenceBuildRecoveryConfig {
  readonly map: MapLibreMap
  readonly appearance: PackMapAppearance
  readonly datasets: ReadonlyArray<RecoverableReferenceDataset>
  /** Reads the published datasets afresh, by dataset id; rejects with the reason when it cannot. */
  readonly readPublished: () => Promise<ReadonlyMap<string, DatasetManifestForLayers>>
  readonly onAdopted: (datasetId: string, fromBuildId: string, toBuildId: string) => void
  readonly onFailure: (message: string) => void
}

export interface ReferenceBuildRecovery {
  readonly dispose: () => void
}

/** The source and build of a tile request the server refused as superseded (HTTP 409). */
const supersededTileOf = (event: unknown): { readonly sourceId: string; readonly buildId: string } | null => {
  if (typeof event !== 'object' || event === null) return null
  const { sourceId, error } = event as { readonly sourceId?: unknown; readonly error?: unknown }
  if (typeof sourceId !== 'string' || typeof error !== 'object' || error === null) return null
  const { status, url } = error as { readonly status?: unknown; readonly url?: unknown }
  if (status !== 409 || typeof url !== 'string' || !url.includes('?')) return null
  const buildId = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('build')
  return buildId ? { sourceId, buildId } : null
}

const sourceSpecOf = (built: ReferenceDatasetLayers) => ({
  type: built.source.type,
  tiles: [...built.source.tiles],
  minzoom: built.source.minzoom,
  maxzoom: built.source.maxzoom,
  bounds: [...built.source.bounds] as [number, number, number, number],
  attribution: built.source.attribution,
})

/** Removes the dataset's layers and source and adds the new build's in the same place, keeping each layer's visibility. */
const replaceDatasetSource = (map: MapLibreMap, dataset: RecoverableReferenceDataset, built: ReferenceDatasetLayers): void => {
  const order = map.getStyle().layers.map(layer => layer.id)
  const present = dataset.layerIds.filter(id => map.getLayer(id) !== undefined)
  if (present.length === 0) throw new Error(`none of ${dataset.datasetId}'s layers is on the map any more`)
  const anchor = order[Math.max(...present.map(id => order.indexOf(id))) + 1]
  const visibility = new Map(present.map(id => [id, map.getLayoutProperty(id, 'visibility') as unknown]))
  for (const id of present) map.removeLayer(id)
  map.removeSource(dataset.sourceId)
  map.addSource(built.sourceId, sourceSpecOf(built))
  for (const layer of built.layers) {
    const kept = visibility.get(layer.id)
    const spec = kept === 'none' || kept === 'visible' ? { ...layer, layout: { ...layer.layout, visibility: kept } } : layer
    // Pack specs are validated MapLibre JSON; their loose records do not satisfy MapLibre's per-type unions statically.
    map.addLayer(spec as unknown as Parameters<MapLibreMap['addLayer']>[0], anchor)
  }
}

const withdrawDataset = (map: MapLibreMap, dataset: RecoverableReferenceDataset): void => {
  for (const id of dataset.layerIds) if (map.getLayer(id) !== undefined) map.removeLayer(id)
  if (map.getSource(dataset.sourceId) !== undefined) map.removeSource(dataset.sourceId)
}

export const watchReferenceBuilds = (config: ReferenceBuildRecoveryConfig): ReferenceBuildRecovery => {
  const current = new Map(config.datasets.map(dataset => [dataset.sourceId, dataset]))
  const attempted = new Set<string>()
  let disposed = false

  const recover = async (dataset: RecoverableReferenceDataset, supersededBuildId: string): Promise<void> => {
    try {
      const published = await config.readPublished()
      if (disposed) return
      const manifest = published.get(dataset.datasetId)
      if (!manifest) throw new Error('the map capabilities no longer publish it')
      if (manifest.buildId === supersededBuildId) throw new Error('the map capabilities still publish the build the server refuses')
      const built = buildReferenceDatasetLayers(manifest, dataset.style, config.appearance)
      replaceDatasetSource(config.map, dataset, built)
      current.set(dataset.sourceId, { ...dataset, buildId: manifest.buildId, layerIds: built.layers.map(layer => layer.id) })
      config.onAdopted(dataset.datasetId, supersededBuildId, manifest.buildId)
    } catch (error) {
      if (disposed) return
      current.delete(dataset.sourceId)
      const reason = error instanceof Error ? error.message : String(error)
      config.onFailure(`reference dataset ${dataset.datasetId} left build ${supersededBuildId} and its replacement could not be loaded (${reason}); its layers are removed`)
      withdrawDataset(config.map, dataset)
    }
  }

  const onError = (event: unknown): void => {
    const superseded = supersededTileOf(event)
    if (!superseded) return
    const dataset = current.get(superseded.sourceId)
    // Late answers for a build this map already left need nothing.
    if (!dataset || dataset.buildId !== superseded.buildId) return
    const key = `${dataset.datasetId}@${superseded.buildId}`
    if (attempted.has(key)) return
    attempted.add(key)
    void recover(dataset, superseded.buildId)
  }

  config.map.on('error', onError)
  return {
    dispose: () => {
      disposed = true
      config.map.off('error', onError)
    },
  }
}
