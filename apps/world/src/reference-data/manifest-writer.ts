import { z } from 'zod'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VectorTileArchiveSummary } from '../map/vector-tile-archive.ts'
import { assertKnownLicence } from './licences.ts'
import type { TileCategorySummary } from './tile-projection.ts'
import type {
  BuildId,
  DatasetConfig,
  DatasetId,
  Iso8601,
  LicenceRef,
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
    /** The Pack's tile projection of the sidecar; tippecanoe's only input. */
    tileInputGeoJsonPath: z.string().min(1),
    /** Numeric tile feature id (`fid`) to sidecar external id. */
    featureIndexPath: z.string().min(1),
  }),
  /** Tiled sidecar features per category, with the zoom range the tile projection gave them. */
  categories: z.array(z.object({
    category: z.string().min(1),
    minZoom: z.number().int().min(0).max(24),
    maxZoom: z.number().int().min(0).max(24),
    featureCount: z.number().int().min(0),
  })),
  /** Sidecar features the tile projection left out, by reason. */
  tileExclusions: z.record(z.string().min(1), z.number().int().positive()),
  /** Zoom range and bounds from the PMTiles header; null when the build skipped tippecanoe. */
  tiles: z.object({
    minZoom: z.number().int().min(0).max(24),
    maxZoom: z.number().int().min(0).max(24),
    bounds: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }).nullable(),
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
  readonly tileCategories: ReadonlyArray<TileCategorySummary>
  readonly tileExclusions: Readonly<Record<string, number>>
  /** Null when the build skipped tippecanoe. */
  readonly tiles: VectorTileArchiveSummary | null
  /** One snapshot per entry of `config.sources`, in the same order. */
  readonly sourceSnapshots: ReadonlyArray<SourceSnapshot>
  readonly builtAt: Iso8601
  readonly buildId: BuildId
  readonly pmtilesRelativePath: string
  readonly sidecarRelativePath: string
  readonly tileInputRelativePath: string
  readonly featureIndexRelativePath: string
}

export const composeDatasetManifest = <P>(input: BuildManifestInput<P>): DatasetManifest => {
  for (const licence of input.config.licences) assertKnownLicence(licence)
  if (input.sourceSnapshots.length !== input.config.sources.length) {
    throw new Error(`composeDatasetManifest: ${input.sourceSnapshots.length} source snapshot(s) for ${input.config.sources.length} source(s)`)
  }
  const manifest: DatasetManifest = {
    schemaVersion: 1,
    datasetId: String(input.config.id),
    builtAt: String(input.builtAt),
    buildId: String(input.buildId),
    artifact: {
      pmtilesPath: input.pmtilesRelativePath,
      sidecarGeoJsonPath: input.sidecarRelativePath,
      outputLayer: input.config.tilebuild.outputLayer,
      tileInputGeoJsonPath: input.tileInputRelativePath,
      featureIndexPath: input.featureIndexRelativePath,
    },
    categories: input.tileCategories.map(category => ({ ...category })),
    tileExclusions: { ...input.tileExclusions },
    tiles: input.tiles === null ? null : { minZoom: input.tiles.minZoom, maxZoom: input.tiles.maxZoom, bounds: [...input.tiles.bounds] },
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
