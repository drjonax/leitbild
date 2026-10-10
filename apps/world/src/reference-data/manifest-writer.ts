import { z } from 'zod'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertKnownLicence } from './licences.ts'
import type {
  BuildId,
  CategoryTileConfig,
  DatasetConfig,
  DatasetId,
  Iso8601,
  LicenceRef,
  NormalizedFeature,
  SourceSnapshot,
} from './types.ts'

// Per-dataset manifest fragment written next to the PMTiles + sidecar GeoJSON.
// A later phase (A.6) aggregates fragments into the live /map/capabilities.json.
// This module does not touch the live response; it only writes per-dataset files.

export const datasetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().min(1),
  builtAt: z.string().min(1),
  buildId: z.string().min(1),
  artifact: z.object({
    pmtilesPath: z.string().min(1),
    sidecarGeoJsonPath: z.string().min(1),
    outputLayer: z.string().min(1),
  }),
  categories: z.array(z.object({
    category: z.string().min(1),
    minZoom: z.number().int().min(0).max(24),
    maxZoom: z.number().int().min(0).max(24),
    featureCount: z.number().int().min(0),
  })),
  sources: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['manual', 'local', 'remote']),
    snapshot: z.object({
      origin: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      byteLength: z.number().int().nonnegative(),
      dataTimestamp: z.string().min(1).nullable(),
    }),
  })).min(1),
  licences: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string(),
    attribution: z.string().min(1),
    commercialUseAllowed: z.boolean(),
    redistributionAllowed: z.boolean(),
    shareAlike: z.boolean(),
  })).min(1),
})

export type DatasetManifest = z.infer<typeof datasetManifestSchema>

const countByCategory = (
  features: ReadonlyArray<NormalizedFeature>,
  categoryOf: (f: NormalizedFeature) => string,
): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const feature of features) {
    const category = categoryOf(feature)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return counts
}

const categoryEntries = (
  cfg: ReadonlyArray<CategoryTileConfig>,
  counts: Map<string, number>,
): DatasetManifest['categories'] =>
  cfg.map(c => ({
    category: c.category,
    minZoom: c.minZoom,
    maxZoom: c.maxZoom,
    featureCount: counts.get(c.category) ?? 0,
  }))

const licencePayload = (licence: LicenceRef) => ({
  id: String(licence.id),
  name: licence.name,
  url: licence.url,
  attribution: licence.attribution,
  commercialUseAllowed: licence.commercialUseAllowed,
  redistributionAllowed: licence.redistributionAllowed,
  shareAlike: licence.shareAlike,
})

export interface BuildManifestInput<P> {
  readonly config: DatasetConfig<P>
  readonly features: ReadonlyArray<NormalizedFeature>
  /** One snapshot per entry of `config.sources`, in the same order. */
  readonly sourceSnapshots: ReadonlyArray<SourceSnapshot>
  readonly builtAt: Iso8601
  readonly buildId: BuildId
  readonly pmtilesRelativePath: string
  readonly sidecarRelativePath: string
}

export const composeDatasetManifest = <P>(input: BuildManifestInput<P>): DatasetManifest => {
  for (const licence of input.config.licences) assertKnownLicence(licence)
  if (input.sourceSnapshots.length !== input.config.sources.length) {
    throw new Error(`composeDatasetManifest: ${input.sourceSnapshots.length} source snapshot(s) for ${input.config.sources.length} source(s)`)
  }
  const counts = countByCategory(input.features, input.config.featureToCategory)
  const manifest: DatasetManifest = {
    schemaVersion: 1,
    datasetId: String(input.config.id),
    builtAt: String(input.builtAt),
    buildId: String(input.buildId),
    artifact: {
      pmtilesPath: input.pmtilesRelativePath,
      sidecarGeoJsonPath: input.sidecarRelativePath,
      outputLayer: input.config.tilebuild.outputLayer,
    },
    categories: categoryEntries(input.config.tilebuild.categories, counts),
    sources: input.config.sources.map((s, index) => ({ id: String(s.id), kind: s.kind, snapshot: input.sourceSnapshots[index]! })),
    licences: input.config.licences.map(licencePayload),
  }
  return datasetManifestSchema.parse(manifest)
}

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

export const writeDatasetManifest = async (path: string, manifest: DatasetManifest): Promise<void> => {
  datasetManifestSchema.parse(manifest)
  await atomicWriteJson(path, manifest)
}

export interface AuditReport {
  readonly datasetId: DatasetId
  readonly buildId: BuildId
  readonly status: 'ok' | 'failed'
  readonly featureCount: number
  readonly categoryCounts: Readonly<Record<string, number>>
  readonly errors: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}

export const writeAuditReport = async (path: string, report: AuditReport): Promise<void> => {
  await atomicWriteJson(path, report)
}
