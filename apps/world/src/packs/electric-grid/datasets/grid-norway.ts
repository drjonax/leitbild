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
  globalMaxZoom: 14,
  categories: [
    { category: 'line', minZoom: 4, maxZoom: 14 },
    { category: 'cable', minZoom: 5, maxZoom: 14 },
    { category: 'substation', minZoom: 6, maxZoom: 14 },
    { category: 'transformer', minZoom: 9, maxZoom: 14 },
    { category: 'plant', minZoom: 6, maxZoom: 14 },
    { category: 'generator', minZoom: 8, maxZoom: 14 },
    { category: 'load', minZoom: 8, maxZoom: 14 },
    { category: 'unknown', minZoom: 10, maxZoom: 14 },
  ],
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
