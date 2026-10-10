import type {
  PackMapAppearance,
  PackReferenceDatasetStyle,
  PackReferenceLayerType,
} from '../../core/packs/reference-style.ts'
import { composeAttributionFromManifest } from './reference-attribution.ts'

// Manifest-driven MapLibre source + layers for a reference dataset. Pure: no
// MapLibre instance. The Pack style owns every filter and paint; this module
// adds the vector source, published layer ids and `source-layer`, and checks
// that the style matches the published artifact.

export interface DatasetManifestForLayers {
  readonly datasetId: string
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
  readonly licences: ReadonlyArray<{
    readonly id: string
    readonly attribution: string
  }>
}

export interface ReferenceLayerSpec {
  readonly id: string
  readonly type: PackReferenceLayerType
  readonly source: string
  readonly 'source-layer': string
  readonly minzoom?: number
  readonly filter: ReadonlyArray<unknown>
  readonly layout: Readonly<Record<string, unknown>>
  readonly paint: Readonly<Record<string, unknown>>
}

export interface ReferenceSourceSpec {
  readonly type: 'vector'
  readonly tiles: ReadonlyArray<string>
  readonly minzoom: number
  /** Highest zoom the archive holds; MapLibre overzooms these tiles beyond it. */
  readonly maxzoom: number
  readonly attribution: string
}

export interface ReferenceDatasetLayers {
  readonly sourceId: string
  readonly source: ReferenceSourceSpec
  /** Paint order, bottom first. */
  readonly layers: ReadonlyArray<ReferenceLayerSpec>
}

export const referenceLayerIdPrefix = 'reference:'

const sourceIdFor = (datasetId: string): string => `${referenceLayerIdPrefix}${datasetId}`

const layerIdFor = (datasetId: string, styleLayerId: string): string => `${referenceLayerIdPrefix}${datasetId}:${styleLayerId}`

// The manifest's pmtilesPath is the archive file name ("<dataset>.pmtiles"); the
// World API serves its tiles as plain HTTP MVT, so startup needs no PMTiles protocol.
const sourceTilesFor = (datasetId: string, manifestPmtilesPath: string): ReadonlyArray<string> => {
  const pmtilesBaseName = manifestPmtilesPath.replace(/\.pmtiles$/, '')
  return [`/map/datasets/${datasetId}/current/${pmtilesBaseName}/{z}/{x}/{y}.mvt`]
}

const sourceZoomRangeFor = (
  manifest: DatasetManifestForLayers,
): { readonly minzoom: number; readonly maxzoom: number } => {
  const populated = manifest.categories.filter(category => category.featureCount > 0)
  if (populated.length === 0) throw new Error(`reference dataset ${manifest.datasetId} publishes no features`)
  return {
    minzoom: Math.min(...populated.map(category => category.minZoom)),
    maxzoom: Math.max(...populated.map(category => category.maxZoom)),
  }
}

const assertStyleMatchesManifest = (manifest: DatasetManifestForLayers, style: PackReferenceDatasetStyle): void => {
  if (style.datasetId !== manifest.datasetId) {
    throw new Error(`reference style for ${style.datasetId} cannot draw dataset ${manifest.datasetId}`)
  }
  if (style.outputLayer !== manifest.artifact.outputLayer) {
    throw new Error(`reference style for ${style.datasetId} reads tile layer "${style.outputLayer}" but the build wrote "${manifest.artifact.outputLayer}"`)
  }
  const undrawn = manifest.categories
    .filter(category => category.featureCount > 0 && !style.categories.includes(category.category))
    .map(category => category.category)
  if (undrawn.length > 0) {
    throw new Error(`reference style for ${style.datasetId} does not draw published categories: ${undrawn.join(', ')}`)
  }
}

export const buildReferenceDatasetLayers = (
  manifest: DatasetManifestForLayers,
  style: PackReferenceDatasetStyle,
  appearance: PackMapAppearance,
): ReferenceDatasetLayers => {
  assertStyleMatchesManifest(manifest, style)
  const sourceId = sourceIdFor(manifest.datasetId)
  const source: ReferenceSourceSpec = {
    type: 'vector',
    tiles: sourceTilesFor(manifest.datasetId, manifest.artifact.pmtilesPath),
    ...sourceZoomRangeFor(manifest),
    attribution: composeAttributionFromManifest(manifest),
  }
  const layers = style.layersFor(appearance).map((spec): ReferenceLayerSpec => ({
    id: layerIdFor(manifest.datasetId, spec.id),
    type: spec.type,
    source: sourceId,
    'source-layer': manifest.artifact.outputLayer,
    ...(spec.minzoom === undefined ? {} : { minzoom: spec.minzoom }),
    filter: spec.filter,
    layout: { visibility: 'visible', ...spec.layout },
    paint: spec.paint,
  }))
  const ids = layers.map(layer => layer.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) throw new Error(`reference style for ${style.datasetId} declares layer ${duplicate} twice`)
  return { sourceId, source, layers }
}

export const __internals = { sourceIdFor, layerIdFor, sourceTilesFor }
