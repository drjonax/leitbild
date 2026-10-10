import type { ZodTypeAny, z } from 'zod'

// Reference-data pipeline core types.
// See ADR 0019 for the design rationale.

export type Iso8601 = string & { readonly __iso8601: unique symbol }
export type BuildId = string & { readonly __buildId: unique symbol }
export type DatasetId = string & { readonly __datasetId: unique symbol }
export type SourceId = string & { readonly __sourceId: unique symbol }
export type LicenceId = string & { readonly __licenceId: unique symbol }

export const asBuildId = (value: string): BuildId => value as BuildId
export const asDatasetId = (value: string): DatasetId => value as DatasetId
export const asSourceId = (value: string): SourceId => value as SourceId
export const asLicenceId = (value: string): LicenceId => value as LicenceId
export const asIso8601 = (value: string): Iso8601 => value as Iso8601

export type RawBytes = Uint8Array

export interface FetchCacheEntry {
  readonly sourceId: SourceId
  readonly etag: string | null
  readonly lastModified: string | null
  readonly sha256: string
  readonly fetchedAt: Iso8601
  readonly path: string
}

export interface FetchCache {
  readonly read: (sourceId: SourceId) => Promise<FetchCacheEntry | null>
  readonly write: (entry: FetchCacheEntry, body: RawBytes) => Promise<void>
}

// Identity of the bytes a source was built from, recorded per source in the dataset manifest.
export interface SourceSnapshot {
  readonly origin: string
  readonly sha256: string
  readonly byteLength: number
  // Time the data itself describes (e.g. an OSM replication timestamp); null when the input carries none.
  readonly dataTimestamp: Iso8601 | null
}

export interface LocalSourceLoad {
  readonly features: ReadonlyArray<NormalizedFeature>
  readonly snapshot: SourceSnapshot
}

export type DatasetSource =
  | {
      readonly kind: 'manual'
      readonly id: SourceId
      readonly path: string
    }
  | {
      readonly kind: 'local'
      readonly id: SourceId
      readonly load: (cache: FetchCache) => Promise<LocalSourceLoad>
    }
  | {
      readonly kind: 'remote'
      readonly id: SourceId
      readonly fetch: (cache: FetchCache) => Promise<RawBytes>
      readonly parse: (raw: RawBytes) => Promise<ReadonlyArray<NormalizedFeature>>
    }

export type GeoJsonPosition = readonly [number, number] | readonly [number, number, number]
export type GeoJsonGeometry =
  | { readonly type: 'Point'; readonly coordinates: GeoJsonPosition }
  | { readonly type: 'LineString'; readonly coordinates: ReadonlyArray<GeoJsonPosition> }
  | { readonly type: 'Polygon'; readonly coordinates: ReadonlyArray<ReadonlyArray<GeoJsonPosition>> }
  | { readonly type: 'MultiPolygon'; readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<GeoJsonPosition>>> }

export interface NormalizedFeature {
  readonly type: 'Feature'
  readonly id?: string
  readonly geometry: GeoJsonGeometry
  readonly properties: Readonly<Record<string, unknown>>
}

export interface FeatureCollection {
  readonly type: 'FeatureCollection'
  readonly features: ReadonlyArray<NormalizedFeature>
}

export interface CategoryTileConfig {
  readonly category: string
  readonly minZoom: number
  readonly maxZoom: number
  readonly simplification?: number
}

export interface TilebuildConfig {
  readonly outputLayer: string
  readonly categories: ReadonlyArray<CategoryTileConfig>
  readonly globalMinZoom: number
  readonly globalMaxZoom: number
}

export interface LicenceRef {
  readonly id: LicenceId
  readonly name: string
  readonly url: string
  readonly attribution: string
  readonly commercialUseAllowed: boolean
  readonly redistributionAllowed: boolean
  readonly shareAlike: boolean
}

export interface DatasetConfig<P = Record<string, unknown>> {
  readonly id: DatasetId
  readonly schemaVersion: number
  readonly featureSchema: ZodTypeAny
  readonly sources: ReadonlyArray<DatasetSource>
  readonly tilebuild: TilebuildConfig
  readonly licences: ReadonlyArray<LicenceRef>
  readonly audit?: (features: ReadonlyArray<NormalizedFeature>) => void
  readonly featureToCategory: (feature: NormalizedFeature) => string
}

export type RefinedFeature<S extends ZodTypeAny> = NormalizedFeature & {
  readonly properties: z.infer<S>
}

export interface QueryOpts {
  readonly altitudeM?: number
  readonly categories?: ReadonlyArray<string>
}
