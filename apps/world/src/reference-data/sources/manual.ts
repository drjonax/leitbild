import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { asSourceId, type DatasetSource, type NormalizedFeature } from '../types.ts'

// Repo-tracked GeoJSON file source. Loads and validates a FeatureCollection from a path.
// Per ADR 0019, manual overlays are a first-class source kind alongside remote fetches.

const positionSchema = z.tuple([z.number(), z.number()]).or(z.tuple([z.number(), z.number(), z.number()]))
const ringSchema = z.array(positionSchema)

const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: positionSchema }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(positionSchema) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ringSchema) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ringSchema)) }),
])

const featureSchema = z.object({
  type: z.literal('Feature'),
  id: z.union([z.string(), z.number()]).optional(),
  geometry: geometrySchema,
  properties: z.record(z.string(), z.unknown()),
})

const featureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(featureSchema),
})

export interface ManualSourceConfig {
  readonly id: string
  readonly path: string
}

export const manualSource = (config: ManualSourceConfig): DatasetSource => ({
  kind: 'manual',
  id: asSourceId(config.id),
  path: config.path,
})

export const loadManualSource = async (path: string): Promise<ReadonlyArray<NormalizedFeature>> =>
  parseManualSource(await readFile(path, 'utf8'))

export const parseManualSource = (raw: string): ReadonlyArray<NormalizedFeature> => {
  const parsed = featureCollectionSchema.parse(JSON.parse(raw))
  return parsed.features.map((f): NormalizedFeature => ({
    type: 'Feature',
    ...(f.id !== undefined ? { id: String(f.id) } : {}),
    geometry: f.geometry,
    properties: f.properties,
  }))
}
