import { z } from 'zod'
import type {
  DatasetConfig,
  GeoJsonGeometry,
  NormalizedFeature,
  TileFeaturePropertyValue,
} from './types.ts'

// Applies a dataset's tile projection to its validated sidecar features. The
// result is tippecanoe's only input; the sidecar itself stays complete for model
// generation and audits. Every tiled sidecar feature gets one numeric `fid`
// (1-based, in sidecar order) shared by all of its tile geometries, and the
// feature index maps it back to the feature's external id.

export const tileFeatureIdProperty = 'fid'

export interface TippecanoeInputFeature {
  readonly type: 'Feature'
  /** Per-feature zoom range; tippecanoe reads this member of a GeoJSON feature. */
  readonly tippecanoe: { readonly minzoom: number; readonly maxzoom: number }
  readonly geometry: GeoJsonGeometry
  readonly properties: Readonly<Record<string, TileFeaturePropertyValue>>
}

export interface TileCategorySummary {
  readonly category: string
  readonly minZoom: number
  readonly maxZoom: number
  /** Sidecar features of this category in the tiles. */
  readonly featureCount: number
}

export interface ProjectedTiles {
  readonly features: ReadonlyArray<TippecanoeInputFeature>
  readonly externalIdByFid: Readonly<Record<string, string>>
  readonly categories: ReadonlyArray<TileCategorySummary>
  /** Sidecar features left out of the tiles, by the projection's reason. */
  readonly exclusions: Readonly<Record<string, number>>
}

export const featureIndexSchema = z.object({
  datasetId: z.string().min(1),
  buildId: z.string().min(1),
  externalIdByFid: z.record(z.string().regex(/^[1-9]\d*$/), z.string().min(1)),
})

export type FeatureIndex = z.infer<typeof featureIndexSchema>

type ProjectionConfig = Pick<DatasetConfig, 'id' | 'tilebuild' | 'featureToCategory'>

const assertZoomRange = (config: ProjectionConfig, externalId: string, minZoom: number, maxZoom: number): void => {
  const { globalMinZoom, globalMaxZoom } = config.tilebuild
  const valid = Number.isInteger(minZoom) && Number.isInteger(maxZoom)
    && minZoom >= globalMinZoom && maxZoom <= globalMaxZoom && minZoom <= maxZoom
  if (!valid) {
    throw new Error(`${String(config.id)} tile projection of ${externalId}: zoom range ${minZoom}-${maxZoom} is not an integer range within ${globalMinZoom}-${globalMaxZoom}`)
  }
}

export const projectTileFeatures = (
  features: ReadonlyArray<NormalizedFeature>,
  config: ProjectionConfig,
): ProjectedTiles => {
  const tileFeatures: TippecanoeInputFeature[] = []
  const externalIdByFid: Record<string, string> = {}
  const tiledExternalIds = new Set<string>()
  const categories = new Map<string, { minZoom: number; maxZoom: number; featureCount: number }>()
  const exclusions: Record<string, number> = {}
  for (const feature of features) {
    const projection = config.tilebuild.tileFeatures(feature)
    if (projection.kind === 'excluded') {
      exclusions[projection.reason] = (exclusions[projection.reason] ?? 0) + 1
      continue
    }
    const { externalId } = projection
    if (projection.features.length === 0) {
      throw new Error(`${String(config.id)} tile projection of ${externalId} has no tile features; exclude it with a reason instead`)
    }
    if (tiledExternalIds.has(externalId)) throw new Error(`${String(config.id)} tile projection: external id ${externalId} is tiled twice`)
    tiledExternalIds.add(externalId)
    const fid = tiledExternalIds.size
    externalIdByFid[String(fid)] = externalId
    const category = config.featureToCategory(feature)
    const summary = categories.get(category) ?? { minZoom: Number.POSITIVE_INFINITY, maxZoom: Number.NEGATIVE_INFINITY, featureCount: 0 }
    summary.featureCount += 1
    for (const tile of projection.features) {
      const maxZoom = tile.maxZoom ?? config.tilebuild.globalMaxZoom
      assertZoomRange(config, externalId, tile.minZoom, maxZoom)
      if (tileFeatureIdProperty in tile.properties) {
        throw new Error(`${String(config.id)} tile projection of ${externalId} sets the reserved property "${tileFeatureIdProperty}"`)
      }
      summary.minZoom = Math.min(summary.minZoom, tile.minZoom)
      summary.maxZoom = Math.max(summary.maxZoom, maxZoom)
      tileFeatures.push({
        type: 'Feature',
        tippecanoe: { minzoom: tile.minZoom, maxzoom: maxZoom },
        geometry: tile.geometry,
        properties: { ...tile.properties, [tileFeatureIdProperty]: fid },
      })
    }
    categories.set(category, summary)
  }
  return {
    features: tileFeatures,
    externalIdByFid,
    categories: [...categories]
      .map(([category, summary]) => ({ category, ...summary }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    exclusions,
  }
}
