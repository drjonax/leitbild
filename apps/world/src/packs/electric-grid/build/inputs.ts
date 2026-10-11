import { z } from 'zod'
import { gridCurationCollectionSchema, type GridCurationCollection } from '../schemas/grid-curation.ts'
import { interconnectorTableSchema, type GridInterconnectorTable } from '../schemas/grid-interconnector.ts'
import { majorSiteTableSchema, type GridMajorSiteTable } from '../schemas/grid-major-site.ts'
import { referenceDispatchTableSchema, type GridReferenceDispatchTable } from '../schemas/grid-reference-dispatch.ts'
import { priceAreas } from '../schemas/grid-ids.ts'

// The explicit inputs of the Norway model build: the DS1 OSM sidecar and its manifest, the DS2
// registry and measurement snapshots of one date, and the curated tables in models/ (including the
// measured national dispatch of the reference hours). Each file is
// validated here (only the fields the build reads) and carries the SHA-256 of its bytes, so the
// build is a pure function of these values.

const lonLat = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const priceArea = z.enum(priceAreas)
const isoInstant = z.iso.datetime({ offset: true })

/** One fetched document behind a snapshot file (DS2 registry-fetch SourceSnapshot). */
const snapshotSourceSchema = z.object({
  sourceId: z.string().min(1),
  url: z.url(),
  retrievedAt: isoInstant,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  licence: z.enum(['nlod-2.0', 'cc-by-4.0']),
})
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>

export const sidecarManifestSchema = z.object({
  kind: z.literal('grid-norway-osm-sidecar'),
  source: z.object({
    id: z.string().min(1),
    snapshot: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), dataTimestamp: isoInstant }),
    licence: z.object({ id: z.literal('osm-odbl-1.0') }),
  }),
  sidecar: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), featureCount: z.number().int().positive() }),
})
export type SidecarManifest = z.infer<typeof sidecarManifestSchema>

export const hydroSnapshotSchema = z.object({
  sources: z.array(snapshotSourceSchema).min(1),
  plants: z.array(z.object({
    plantNumber: z.number().int().positive(),
    name: z.string().min(1),
    kind: z.enum(['generating', 'pumped-storage', 'pump']),
    capacityMw: z.number().finite().nonnegative(),
    meanAnnualProductionGwh: z.number().finite().nonnegative(),
    priceArea,
    municipalityNumber: z.string().regex(/^\d{4}$/),
    location: lonLat,
    // Vannkraft1 vannkraftverktype: K (power plant), KS/Mini/Mikro (small, mini, micro), P (pump), PK (pumped storage).
    registryType: z.enum(['K', 'KS', 'Mini', 'Mikro', 'P', 'PK']),
  })).min(1),
})
export type HydroSnapshot = z.infer<typeof hydroSnapshotSchema>
export type HydroPlantRecord = HydroSnapshot['plants'][number]

export const windSnapshotSchema = z.object({
  sources: z.array(snapshotSourceSchema).min(1),
  farms: z.array(z.object({
    farmId: z.number().int().positive(),
    plantNumber: z.number().int().positive(),
    name: z.string().min(1),
    installedMw: z.number().finite().positive(),
    normalAnnualProductionGwh: z.number().finite().nonnegative(),
    priceArea,
    location: lonLat,
    registryStatus: z.string().min(1),
    registryOutOfOperation: z.string().nullable(),
    sharedPlantNumberFarmIds: z.array(z.number().int().positive()),
  })).min(1),
})
export type WindSnapshot = z.infer<typeof windSnapshotSchema>
export type WindFarmRecord = WindSnapshot['farms'][number]

const ringSchema = z.array(lonLat).min(4)
export const biddingZoneSnapshotSchema = z.object({
  sources: z.array(snapshotSourceSchema).min(1),
  zones: z.array(z.object({
    priceArea,
    geometry: z.discriminatedUnion('type', [
      z.object({ type: z.literal('Polygon'), coordinates: z.array(ringSchema).min(1) }),
      z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ringSchema).min(1)).min(1) }),
    ]),
  })).length(5),
})
export type BiddingZoneSnapshot = z.infer<typeof biddingZoneSnapshotSchema>

export const municipalitySnapshotSchema = z.object({
  sources: z.array(snapshotSourceSchema).min(1),
  municipalities: z.array(z.object({
    municipalityNumber: z.string().regex(/^\d{4}$/),
    name: z.string().min(1),
    point: lonLat,
    bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  })).min(1),
  pointPriceAreas: z.array(z.object({ municipalityNumber: z.string().regex(/^\d{4}$/), priceAreas: z.array(priceArea) })).min(1),
})
export type MunicipalitySnapshot = z.infer<typeof municipalitySnapshotSchema>

const referenceHourSchema = z.object({
  priceAreas: z.object({
    startUtc: isoInstant,
    startTime: isoInstant,
    nationalMw: z.number().finite().positive(),
    rule: z.string().min(1),
    byAreaMw: z.record(priceArea, z.number().finite().positive()),
  }),
  municipalities: z.object({
    startUtc: isoInstant,
    nationalMw: z.number().finite().positive(),
    municipalities: z.array(z.object({
      municipalityNumber: z.string().regex(/^\d{4}$/),
      name: z.string().min(1),
      byGroupMw: z.object({ private: z.number().finite().nonnegative(), business: z.number().finite().nonnegative(), industry: z.number().finite().nonnegative() }).strict(),
    })).min(1),
  }),
})
export const referenceHoursSnapshotSchema = z.object({
  sources: z.array(snapshotSourceSchema).min(1),
  referenceHours: z.object({ winterPeak: referenceHourSchema, summerLow: referenceHourSchema }),
})
export type ReferenceHoursSnapshot = z.infer<typeof referenceHoursSnapshotSchema>
export type ReferenceHour = ReferenceHoursSnapshot['referenceHours']['winterPeak']

export const weekProfileSnapshotSchema = z.object({
  source: snapshotSourceSchema,
  week: z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  hoursUtc: z.array(isoInstant).min(24),
  series: z.array(z.object({
    priceArea,
    group: z.enum(['household', 'cabin', 'primary', 'secondary', 'tertiary']),
    mw: z.array(z.number().finite().nonnegative()),
  })).min(1),
})
export type WeekProfileSnapshot = z.infer<typeof weekProfileSnapshotSchema>

/** One input file: its validated content and the SHA-256 of its bytes. */
export interface BuildFile<T> {
  readonly sha256: string
  readonly data: T
}

export interface NorwayModelBuildInputs {
  /** Raw DS1 sidecar GeoJSON (validated by the topology adapter). */
  readonly sidecar: BuildFile<unknown>
  readonly sidecarManifest: SidecarManifest
  /** Snapshot directory date, YYYY-MM-DD. */
  readonly snapshotDate: string
  readonly hydro: BuildFile<HydroSnapshot>
  readonly wind: BuildFile<WindSnapshot>
  readonly biddingZones: BuildFile<BiddingZoneSnapshot>
  readonly municipalities: BuildFile<MunicipalitySnapshot>
  readonly referenceHours: BuildFile<ReferenceHoursSnapshot>
  readonly winterWeek: BuildFile<WeekProfileSnapshot>
  readonly summerWeek: BuildFile<WeekProfileSnapshot>
  readonly curations: BuildFile<GridCurationCollection>
  readonly interconnectors: BuildFile<GridInterconnectorTable>
  readonly majorSites: BuildFile<GridMajorSiteTable>
  readonly referenceDispatch: BuildFile<GridReferenceDispatchTable>
}

export const buildFileSchemas = {
  curations: gridCurationCollectionSchema,
  interconnectors: interconnectorTableSchema,
  majorSites: majorSiteTableSchema,
  referenceDispatch: referenceDispatchTableSchema,
} as const
