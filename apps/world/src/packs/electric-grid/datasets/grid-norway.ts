import { z } from 'zod'
import { osmOdbl } from '../../../reference-data/licences.ts'
import {
  asDatasetId,
  type DatasetConfig,
  type NormalizedFeature,
  type TilebuildConfig,
} from '../../../reference-data/types.ts'
import { compileGridReferenceGraph } from '../reference-graph.ts'
import { gridReferenceFeatureSchema } from '../schemas/grid-reference.ts'
import { osmPbfPowerSource, type OsmPbfPin } from '../sources/osm-pbf-power.ts'
import { gridFootprintMinZoom } from '../ui/grid-zoom-classes.ts'
import { gridNorwayTileFeatures } from './grid-norway-tiles.ts'

export const gridNorwayDatasetId = asDatasetId('grid-norway')
export const gridNorwayOsmSourceId = 'osm:pbf-power:NO'

export const gridNorwayFeatureSchema = gridReferenceFeatureSchema
export type GridNorwayFeatureProperties = z.infer<typeof gridNorwayFeatureSchema>

export interface GridNorwayThresholds {
  readonly nodes: number
  readonly branches: number
  readonly maxUnresolvedEndpointFraction: number
}

export interface GridNorwayDatasetConfig {
  readonly osmPbf: {
    readonly path: string
    readonly pin: OsmPbfPin
  }
  readonly thresholds?: GridNorwayThresholds
}

export const gridNorwayProductionThresholds: GridNorwayThresholds = {
  nodes: 100,
  branches: 100,
  maxUnresolvedEndpointFraction: 0.65,
}

export const gridNorwayTilebuild: TilebuildConfig = {
  outputLayer: 'grid',
  globalMinZoom: 4,
  // Footprints and busbars appear at z12 with exact geometry; MapLibre overzooms z12 beyond.
  globalMaxZoom: gridFootprintMinZoom,
  // gzip bytes; about five times the largest tile (21 KB at z6) of the 2026-10-08 sidecar's build.
  maximumTileBytes: 100_000,
  tileFeatures: gridNorwayTileFeatures,
}

export const gridNorwayFeatureToCategory = (feature: NormalizedFeature): string => {
  const parsed = gridNorwayFeatureSchema.safeParse(feature.properties)
  return parsed.success ? parsed.data.category : 'unknown'
}

const failIfBelow = (
  label: string,
  actual: number,
  threshold: number,
): string | null =>
  actual < threshold ? `${label} ${actual} is below threshold ${threshold}` : null

export const createGridNorwayDataset = (config: GridNorwayDatasetConfig): DatasetConfig => {
  const thresholds = config.thresholds ?? gridNorwayProductionThresholds
  const powerSource = osmPbfPowerSource({
    id: gridNorwayOsmSourceId,
    path: config.osmPbf.path,
    pin: config.osmPbf.pin,
  })
  return {
    id: gridNorwayDatasetId,
    schemaVersion: 1,
    featureSchema: gridNorwayFeatureSchema,
    sources: [powerSource],
    tilebuild: gridNorwayTilebuild,
    licences: [osmOdbl],
    featureToCategory: gridNorwayFeatureToCategory,
    audit: (features): void => {
      const graph = compileGridReferenceGraph(features)
      const errors = [
        failIfBelow('grid node count', graph.audit.nodeCount, thresholds.nodes),
        failIfBelow('grid branch count', graph.audit.branchCount, thresholds.branches),
      ].filter((error): error is string => error !== null)
      const endpointTotal = graph.audit.branchCount * 2
      const unresolvedFraction = endpointTotal === 0 ? 1 : graph.audit.unresolvedBranchEndpointCount / endpointTotal
      if (unresolvedFraction > thresholds.maxUnresolvedEndpointFraction) {
        errors.push(`unresolved branch endpoint fraction ${unresolvedFraction.toFixed(2)} exceeds threshold ${thresholds.maxUnresolvedEndpointFraction}`)
      }
      if (errors.length > 0) throw new Error(`grid-norway audit thresholds not met: ${errors.join('; ')}`)
    },
  }
}
