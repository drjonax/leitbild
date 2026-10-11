import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { readTerrainPmtilesMetadata, type TerrainDemEncoding } from './terrain-artifact.ts'
import { readVectorTileArchiveSummary } from './vector-tile-archive.ts'
import {
  sceneryAssetFormat,
  sceneryAssetTilesetSchema,
  sceneryAssetTileEncoding,
  sceneryAssetTilesetUrl,
  sceneryAssetTileTemplate,
  sceneryRoadTileTemplate,
} from './scenery.ts'

// Map Capability Manifest v2.
// Top-level shape:
//   { schemaVersion: 2, tilesets: [BaseTileset, ...ReferenceTileset[]] }
// The first element is the OSM base tileset (kind: 'base'); subsequent entries
// are reference datasets discovered at runtime from /opt/leitbild/reference/releases.
// See ADR 0019 (reference data pipeline) and docs/map-capability-manifest.md.

export const mapTilesetId = 'leitbild-osm-norway'
export const terrainTilesetId = 'leitbild-terrain-norway'
export const sceneryTilesetId = 'leitbild-scenery-norway'
export const mapManifestSchemaVersion = 2 as const
export const mapManifestSchemaVersionLiteral = z.literal(2)

export const mapCapabilityFieldAvailabilitySchema = z.enum(['required', 'optional'])
export type MapCapabilityFieldAvailability = z.infer<typeof mapCapabilityFieldAvailabilitySchema>

export const mapCapabilityFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  availability: mapCapabilityFieldAvailabilitySchema,
  values: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
})
export type MapCapabilityField = z.infer<typeof mapCapabilityFieldSchema>

export const mapCapabilityLayerSchema = z.object({
  id: z.string().min(1),
  sourceLayer: z.string().min(1),
  geometry: z.array(z.enum(['point', 'line', 'polygon'])).min(1),
  category: z.enum(['road_semantics', 'operational_poi', 'risk_context', 'mobility_constraint', 'base_context']),
  intendedUse: z.string().min(1),
  fields: z.array(mapCapabilityFieldSchema),
})
export type MapCapabilityLayer = z.infer<typeof mapCapabilityLayerSchema>

// --- Base (OSM) tileset entry ---------------------------------------------

export const baseTilesetSchema = z.object({
  kind: z.literal('base'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  region: z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceUrl: z.string().url(),
  }),
  artifact: z.object({
    format: z.literal('pmtiles'),
    tileEncoding: z.literal('mvt'),
    currentTileUrl: z.string().min(1),
    tileTemplate: z.string().min(1),
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    minZoom: z.number().int().min(0),
    maxZoom: z.number().int().max(24),
    attribution: z.string().min(1),
    styleUrl: z.literal('/map/style.json'),
    glyphsUrl: z.literal('/map/fonts/{fontstack}/{range}.pbf'),
  }),
  schema: z.object({
    name: z.enum(['openmaptiles-compatible-leitbild-v1', 'natural-earth-overview']),
    generatedBy: z.string().min(1),
    evolution: z.literal('breaking changes increment schemaVersion; no backward compatibility is preserved'),
  }),
  layers: z.array(mapCapabilityLayerSchema).min(1),
})
export type BaseTileset = z.infer<typeof baseTilesetSchema>

// --- Terrain tileset entry -------------------------------------------------

export const terrainAvailabilitySchema = z.object({
  status: z.enum(['available', 'unavailable']),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
})
export type TerrainAvailability = z.infer<typeof terrainAvailabilitySchema>

export const terrainTilesetSchema = z.object({
  kind: z.literal('terrain'),
  id: z.literal(terrainTilesetId),
  schemaVersion: z.literal(1),
  region: z.object({
    id: z.literal('norway'),
    preferredSource: z.literal('kartverket-dtm'),
    fallbackSource: z.literal('copernicus-dem-glo-30'),
  }),
  artifact: z.object({
    format: z.literal('pmtiles'),
    tileEncoding: z.literal('png'),
    demEncoding: z.enum(['terrarium', 'mapbox']),
    currentTileUrl: z.literal('/map/terrain/current.pmtiles'),
    currentTileTemplate: z.literal('/map/terrain/current/{z}/{x}/{y}.png'),
    tileJsonUrl: z.literal('/map/terrain/current/tiles.json'),
    minZoom: z.number().int().min(0).max(24),
    maxZoom: z.number().int().min(0).max(24),
    tileSize: z.union([z.literal(256), z.literal(512)]),
  }),
  intendedUse: z.string().min(1),
  verticalDatum: z.literal('orthometric-msl'),
  availability: terrainAvailabilitySchema,
})
export type TerrainTileset = z.infer<typeof terrainTilesetSchema>

// --- Precompiled scenery tileset entry ------------------------------------

export const sceneryAvailabilitySchema = z.object({
  status: z.enum(['available', 'unavailable']),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
})
export type SceneryAvailability = z.infer<typeof sceneryAvailabilitySchema>

export const sceneryFeatureKindSchema = z.enum([
  'aeroway',
  'building',
  'landcover',
  'landuse',
  'place',
  'poi',
  'transportation',
  'transportation_name',
  'water',
  'waterway',
])
export type SceneryFeatureKind = z.infer<typeof sceneryFeatureKindSchema>

export const sceneryRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().min(1),
  intendedUse: z.string().min(1),
  sourceTilesetId: z.literal(mapTilesetId),
  scenarioPackIds: z.array(z.string().min(1)).optional(),
  featureKinds: z.array(sceneryFeatureKindSchema).min(1),
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  detail: z.enum(['navigation', 'flight-visual', 'analysis']),
})
export type SceneryRecipe = z.infer<typeof sceneryRecipeSchema>

export const sceneryTilesetSchema = z.object({
  kind: z.literal('scenery'),
  id: z.literal(sceneryTilesetId),
  schemaVersion: z.literal(1),
  region: z.object({
    id: z.literal('norway'),
    sourceTilesetId: z.literal(mapTilesetId),
  }),
  artifact: z.object({
    format: z.literal(sceneryAssetFormat),
    tileEncoding: z.literal(sceneryAssetTileEncoding),
    lodStrategy: z.literal('hierarchical-screen-space-error'),
    tilesetUrl: z.literal(sceneryAssetTilesetUrl),
    currentTileTemplate: z.literal(sceneryAssetTileTemplate),
    roadTileTemplate: z.literal(sceneryRoadTileTemplate),
  }),
  recipes: z.array(sceneryRecipeSchema).min(1),
  availability: sceneryAvailabilitySchema,
})
export type SceneryTileset = z.infer<typeof sceneryTilesetSchema>

// --- Reference tileset entry (per-dataset manifest fragments on disk) ------

const tilesetSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['manual', 'local', 'remote']),
})

const tilesetLicenceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string(),
  attribution: z.string().min(1),
  commercialUseAllowed: z.boolean(),
  redistributionAllowed: z.boolean(),
  shareAlike: z.boolean(),
})

const tilesetCategorySchema = z.object({
  category: z.string().min(1),
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  featureCount: z.number().int().min(0),
})

const tilesetTilesSchema = z.object({
  minZoom: z.number().int().min(0).max(24),
  maxZoom: z.number().int().min(0).max(24),
  /** [west, south, east, north] in degrees. */
  bounds: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]),
})

// The per-dataset build manifest from manifest-writer.ts, as far as clients use it.
const referenceBuildManifestSchema = z.object({
  datasetId: z.string().min(1),
  schemaVersion: z.literal(1),
  builtAt: z.string().min(1),
  buildId: z.string().min(1),
  artifact: z.object({
    pmtilesPath: z.string().min(1),
    sidecarGeoJsonPath: z.string().min(1),
    outputLayer: z.string().min(1),
  }),
  categories: z.array(tilesetCategorySchema),
  sources: z.array(tilesetSourceSchema).min(1),
  licences: z.array(tilesetLicenceSchema).min(1),
})

// A promoted build manifest under `kind: 'reference'`, with the zoom range and
// bounds read from the header of the archive the release serves.
export const referenceTilesetSchema = referenceBuildManifestSchema.extend({
  kind: z.literal('reference'),
  tiles: tilesetTilesSchema,
})
export type ReferenceTileset = z.infer<typeof referenceTilesetSchema>

// --- Discriminated union + top-level manifest -----------------------------

export const tilesetEntrySchema = z.discriminatedUnion('kind', [
  baseTilesetSchema,
  terrainTilesetSchema,
  sceneryTilesetSchema,
  referenceTilesetSchema,
])
export type TilesetEntry = z.infer<typeof tilesetEntrySchema>

export const mapCapabilityManifestSchema = z.object({
  schemaVersion: mapManifestSchemaVersionLiteral,
  tilesets: z.array(tilesetEntrySchema).min(1),
})
export type MapCapabilityManifest = z.infer<typeof mapCapabilityManifestSchema>

// --- Base tileset payload + sync factory (for style.ts) -------------------

const roadClassValues = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'minor', 'service', 'track', 'path', 'rail', 'ferry',
]

const poiClassValues = [
  'hospital', 'fire_station', 'police', 'doctors', 'pharmacy',
  'helipad', 'airport', 'port', 'fuel', 'charging_station',
]

const baseLayers: ReadonlyArray<MapCapabilityLayer> = [
  {
    id: 'transportation', sourceLayer: 'transportation', geometry: ['line', 'polygon'],
    category: 'road_semantics',
    intendedUse: 'Road hierarchy, route context, surface-level mobility interpretation, and control-center visual road emphasis.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: roadClassValues, description: 'Normalized road or transportation class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived transportation subtype when emitted by the profile.' },
      { name: 'brunnel', type: 'string', availability: 'optional', values: ['bridge', 'tunnel', 'ford'], description: 'Bridge/tunnel/ford context where the profile emits it.' },
      { name: 'oneway', type: 'boolean', availability: 'optional', description: 'One-way direction hint where available.' },
      { name: 'ramp', type: 'boolean', availability: 'optional', description: 'Ramp hint where available.' },
      { name: 'service', type: 'string', availability: 'optional', description: 'Service road subtype where available.' },
      { name: 'access', type: 'string', availability: 'optional', description: 'Access restriction hint where available.' },
      { name: 'maxspeed', type: 'number', availability: 'optional', description: 'Speed-limit hint where available; routing engines remain authoritative for routing.' },
    ],
  },
  {
    id: 'transportation_name', sourceLayer: 'transportation_name', geometry: ['line'],
    category: 'road_semantics', intendedUse: 'Road labeling and operator orientation.',
    fields: [
      { name: 'name', type: 'string', availability: 'optional', description: 'Displayed road name.' },
      { name: 'class', type: 'string', availability: 'optional', values: roadClassValues, description: 'Road class associated with the label feature.' },
    ],
  },
  {
    id: 'poi', sourceLayer: 'poi', geometry: ['point'],
    category: 'operational_poi',
    intendedUse: 'Static map context for emergency, transport, and infrastructure POIs. These are not canonical Leitbild operational objects.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: poiClassValues, description: 'Normalized point-of-interest class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific OSM-derived POI subtype.' },
      { name: 'name', type: 'string', availability: 'optional', description: 'POI label.' },
    ],
  },
  {
    id: 'landuse', sourceLayer: 'landuse', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Urban, industrial, commercial, residential, and other land-use context useful for scenarios and risk interpretation.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', description: 'Normalized land-use class.' },
    ],
  },
  {
    id: 'landcover', sourceLayer: 'landcover', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Natural context such as wood, grass, wetland, rock, or sand for scenario interpretation and map readability.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', values: ['wood', 'grass', 'wetland', 'rock', 'sand', 'farmland', 'ice'], description: 'Normalized land-cover class.' },
      { name: 'subclass', type: 'string', availability: 'optional', description: 'More specific land-cover subtype.' },
    ],
  },
  {
    id: 'water', sourceLayer: 'water', geometry: ['polygon'],
    category: 'risk_context',
    intendedUse: 'Water polygons for situational awareness, route context, and scenario constraints.',
    fields: [
      { name: 'class', type: 'string', availability: 'optional', description: 'Water class where available.' },
    ],
  },
  {
    id: 'waterway', sourceLayer: 'waterway', geometry: ['line'],
    category: 'risk_context',
    intendedUse: 'Rivers, streams, canals, and drainage lines as scenario context.',
    fields: [
      { name: 'class', type: 'string', availability: 'optional', description: 'Waterway class where available.' },
    ],
  },
  {
    id: 'building', sourceLayer: 'building', geometry: ['polygon'],
    category: 'base_context',
    intendedUse: 'Building footprints for dense urban orientation and future 2.5D context.',
    fields: [
      { name: 'render_height', type: 'number', availability: 'optional', description: 'Approximate render height when emitted by the profile.' },
      { name: 'render_min_height', type: 'number', availability: 'optional', description: 'Approximate minimum render height when emitted by the profile.' },
    ],
  },
  {
    id: 'aeroway', sourceLayer: 'aeroway', geometry: ['line', 'polygon'],
    category: 'mobility_constraint',
    intendedUse: 'Airfield and runway context for helicopter, drone, aircraft, and emergency-response scenarios.',
    fields: [
      { name: 'class', type: 'string', availability: 'required', description: 'Aeroway class.' },
    ],
  },
  {
    id: 'place', sourceLayer: 'place', geometry: ['point'],
    category: 'base_context',
    intendedUse: 'Named settlement and locality context for map labels, operator orientation, and lightweight Babylon scene beacons.',
    fields: [
      { name: 'class', type: 'string', availability: 'optional', description: 'Place class where available.' },
      { name: 'name', type: 'string', availability: 'optional', description: 'Displayed place name.' },
    ],
  },
  {
    id: 'boundary', sourceLayer: 'boundary', geometry: ['line'],
    category: 'base_context',
    intendedUse: 'Administrative boundaries for jurisdiction and scenario region context.',
    fields: [
      { name: 'admin_level', type: 'number', availability: 'optional', description: 'OSM administrative level where available.' },
      { name: 'maritime', type: 'boolean', availability: 'optional', description: 'Maritime boundary hint where available.' },
    ],
  },
]

export const createBaseTileset = (): BaseTileset => baseTilesetSchema.parse({
  kind: 'base',
  id: mapTilesetId,
  schemaVersion: 1,
  region: {
    id: 'norway',
    source: 'geofabrik',
    sourceUrl: 'https://download.geofabrik.de/europe/norway-latest.osm.pbf',
  },
  artifact: {
    format: 'pmtiles',
    tileEncoding: 'mvt',
    currentTileUrl: '/map/tiles/current.pmtiles',
    tileTemplate: '/map/tiles/current/{z}/{x}/{y}.mvt',
    bounds: [-12, 57, 36, 82], minZoom: 0, maxZoom: 14,
    attribution: '© OpenStreetMap contributors © OpenMapTiles',
    styleUrl: '/map/style.json',
    glyphsUrl: '/map/fonts/{fontstack}/{range}.pbf',
  },
  schema: {
    name: 'openmaptiles-compatible-leitbild-v1',
    generatedBy: 'planetiler-openmaptiles',
    evolution: 'breaking changes increment schemaVersion; no backward compatibility is preserved',
  },
  layers: baseLayers,
})

export const createOverviewTileset = (artifactMtime?: number): BaseTileset => baseTilesetSchema.parse({
  kind: 'base', id: 'world-overview', schemaVersion: 1,
  region: { id: 'world', source: 'natural-earth', sourceUrl: 'https://www.naturalearthdata.com/' },
  artifact: { format: 'pmtiles', tileEncoding: 'mvt', currentTileUrl: '/map/tiles/overview.pmtiles', tileTemplate: '/map/tiles/overview/{z}/{x}/{y}.mvt' + (artifactMtime === undefined ? '' : '?build=' + artifactMtime), bounds: [-180,-85.051129,180,85.051129], minZoom: 0, maxZoom: 6, attribution: 'Made with Natural Earth · generalized overview, not street detail', styleUrl: '/map/style.json', glyphsUrl: '/map/fonts/{fontstack}/{range}.pbf' },
  schema: { name: 'natural-earth-overview', generatedBy: 'tippecanoe', evolution: 'breaking changes increment schemaVersion; no backward compatibility is preserved' },
  layers: [
    { id: 'countries', sourceLayer: 'countries', geometry: ['polygon'], category: 'base_context', intendedUse: 'Generalized land and country outlines, not authoritative boundaries or operational truth', fields: [] },
    { id: 'places', sourceLayer: 'places', geometry: ['point'], category: 'base_context', intendedUse: 'Generalized country and populated-place labels', fields: [{ name: 'name', type: 'string', availability: 'required', description: 'Display label' }] },
  ],
})

export const overviewPmtilesPathForRoot = (mapRoot: string): string => resolve(mapRoot, 'overview', 'current.pmtiles')
const overviewStamp = async (mapRoot: string): Promise<{ id: string; mtimeMs: number }> => {
  try { return { id: 'overview', mtimeMs: (await stat(overviewPmtilesPathForRoot(mapRoot))).mtimeMs } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { id: 'overview', mtimeMs: -1 }; throw error }
}

export const terrainPmtilesPathForRoot = (mapRoot: string): string =>
  resolve(mapRoot, 'current', 'terrain.pmtiles')

const terrainMetadataPathForRoot = (mapRoot: string): string =>
  resolve(mapRoot, 'current', 'terrain.json')

export const sceneryTilesetPathForRoot = (mapRoot: string): string =>
  resolve(mapRoot, 'current', 'scenery', 'tileset.json')

export const createTerrainTileset = (config: {
  readonly availability: TerrainAvailability
  readonly artifact?: {
    readonly demEncoding?: TerrainDemEncoding
    readonly minZoom?: number
    readonly maxZoom?: number
    readonly tileSize?: 256 | 512
  }
}): TerrainTileset => terrainTilesetSchema.parse({
  kind: 'terrain',
  id: terrainTilesetId,
  schemaVersion: 1,
  region: {
    id: 'norway',
    preferredSource: 'kartverket-dtm',
    fallbackSource: 'copernicus-dem-glo-30',
  },
  artifact: {
    format: 'pmtiles',
    tileEncoding: 'png',
    demEncoding: config.artifact?.demEncoding ?? 'terrarium',
    currentTileUrl: '/map/terrain/current.pmtiles',
    currentTileTemplate: '/map/terrain/current/{z}/{x}/{y}.png',
    tileJsonUrl: '/map/terrain/current/tiles.json',
    minZoom: config.artifact?.minZoom ?? 0,
    maxZoom: config.artifact?.maxZoom ?? 13,
    tileSize: config.artifact?.tileSize ?? 256,
  },
  intendedUse: 'Self-hosted raster DEM tiles for terrain mesh generation, hillshade, altitude-above-ground calculations, and low-altitude simulation context.',
  verticalDatum: 'orthometric-msl',
  availability: config.availability,
})

export const defaultSceneryRecipes: ReadonlyArray<SceneryRecipe> = [
  sceneryRecipeSchema.parse({
    id: 'drone-urban-flight',
    label: 'Drone urban flight scenery',
    intendedUse: 'Low-altitude Babylon.js flight visualization with roads, buildings, water, vegetation, labels, and operational points of interest derived from the canonical vector map.',
    sourceTilesetId: mapTilesetId,
    scenarioPackIds: ['drone'],
    featureKinds: [
      'aeroway',
      'building',
      'landcover',
      'landuse',
      'place',
      'poi',
      'transportation',
      'transportation_name',
      'water',
      'waterway',
    ],
    minZoom: 12,
    maxZoom: 14,
    detail: 'flight-visual',
  }),
]

export const createSceneryTileset = (availability: SceneryAvailability): SceneryTileset =>
  sceneryTilesetSchema.parse({
    kind: 'scenery',
    id: sceneryTilesetId,
    schemaVersion: 1,
    region: {
      id: 'norway',
      sourceTilesetId: mapTilesetId,
    },
    artifact: {
      format: sceneryAssetFormat,
      tileEncoding: sceneryAssetTileEncoding,
      lodStrategy: 'hierarchical-screen-space-error',
      tilesetUrl: sceneryAssetTilesetUrl,
      currentTileTemplate: sceneryAssetTileTemplate,
      roadTileTemplate: sceneryRoadTileTemplate,
    },
    recipes: defaultSceneryRecipes,
    availability,
  })

/**
 * Synchronous manifest with the base OSM tileset only. Used by style.ts (which
 * is synchronous and doesn't need reference tilesets at construction time) and
 * by tests. The async loadMapCapabilityManifest() variant additionally reads
 * promoted reference datasets from disk.
 */
export const createMapCapabilityManifest = (): MapCapabilityManifest =>
  mapCapabilityManifestSchema.parse({
    schemaVersion: mapManifestSchemaVersion,
    tilesets: [createBaseTileset()],
  })

// --- Async loader: base + on-disk reference manifests ---------------------

export interface LoadManifestConfig {
  readonly referenceRoot: string
  readonly mapRoot?: string
}

export const referenceRootFromEnv = (): string =>
  resolve(process.env.LEITBILD_REFERENCE_ROOT ?? '/opt/leitbild/reference')

export const mapRootFromEnv = (): string =>
  resolve(process.env.LEITBILD_MAP_ROOT ?? '/opt/leitbild/maps')

interface ManifestCacheEntry {
  readonly manifest: MapCapabilityManifest
  readonly stamps: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>
}

let cache: ManifestCacheEntry | null = null

const readReferenceManifest = async (
  referenceRoot: string,
  datasetId: string,
): Promise<{ readonly tileset: ReferenceTileset | null; readonly mtimeMs: number | null }> => {
  const currentDir = join(referenceRoot, 'releases', datasetId, 'current')
  let mtimeMs: number | null = null
  try {
    const s = await stat(currentDir)
    mtimeMs = s.mtimeMs
  } catch {
    return { tileset: null, mtimeMs: null }
  }
  // Manifest file is `<datasetId>.manifest.json` per the pipeline writer.
  const manifestPath = join(currentDir, `${datasetId}.manifest.json`)
  try {
    const build = referenceBuildManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const { pmtilesPath } = build.artifact
    if (basename(pmtilesPath) !== pmtilesPath) throw new Error(`archive path ${pmtilesPath} is not a file name in the release`)
    const tiles = await readVectorTileArchiveSummary(join(currentDir, pmtilesPath))
    const tileset = referenceTilesetSchema.parse({ kind: 'reference', ...build, tiles })
    return { tileset, mtimeMs }
  } catch (err) {
    console.warn(`map-capabilities: skipping reference dataset "${datasetId}" — ${err instanceof Error ? err.message : String(err)}`)
    return { tileset: null, mtimeMs }
  }
}

const listReferenceDatasetIds = async (referenceRoot: string): Promise<ReadonlyArray<string>> => {
  const releasesDir = join(referenceRoot, 'releases')
  try {
    const entries = await readdir(releasesDir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return []
  }
}

const stampsMatch = (a: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>, b: ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.mtimeMs !== b[i]!.mtimeMs) return false
  }
  return true
}

const buildStamps = async (referenceRoot: string, datasetIds: ReadonlyArray<string>): Promise<ReadonlyArray<{ readonly id: string; readonly mtimeMs: number }>> => {
  const stamps: { readonly id: string; readonly mtimeMs: number }[] = []
  for (const id of datasetIds) {
    try {
      const s = await stat(join(referenceRoot, 'releases', id, 'current'))
      stamps.push({ id, mtimeMs: s.mtimeMs })
    } catch {
      // Skip; reader will handle missing.
    }
  }
  return stamps
}

const terrainDemEncodingFor = async (mapRoot: string): Promise<TerrainDemEncoding> => {
  const path = terrainMetadataPathForRoot(mapRoot)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    const artifact = record.artifact && typeof record.artifact === 'object' && !Array.isArray(record.artifact)
      ? record.artifact as Record<string, unknown>
      : {}
    const source = record.source && typeof record.source === 'object' && !Array.isArray(record.source)
      ? record.source as Record<string, unknown>
      : {}
    const value = artifact.demEncoding ?? source.demEncoding
    return value === 'mapbox' ? 'mapbox' : 'terrarium'
  } catch {
    return 'terrarium'
  }
}

const terrainArtifactFor = async (mapRoot: string): Promise<{
  readonly availability: TerrainAvailability
  readonly artifact?: {
    readonly demEncoding: TerrainDemEncoding
    readonly minZoom: number
    readonly maxZoom: number
    readonly tileSize: 256
  }
}> => {
  const path = terrainPmtilesPathForRoot(mapRoot)
  const demEncoding = await terrainDemEncodingFor(mapRoot)
  try {
    const metadata = await readTerrainPmtilesMetadata({ filePath: path, demEncoding })
    return {
      availability: {
        status: 'available',
        path,
        sizeBytes: metadata.sizeBytes,
        modifiedAt: metadata.modifiedAt,
      },
      artifact: {
        demEncoding: metadata.demEncoding,
        minZoom: metadata.minZoom,
        maxZoom: metadata.maxZoom,
        tileSize: 256,
      },
    }
  } catch (error) {
    return {
      availability: {
        status: 'unavailable',
        path,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

const sceneryArtifactFor = async (mapRoot: string): Promise<SceneryAvailability> => {
  const path = sceneryTilesetPathForRoot(mapRoot)
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size <= 0) {
      return {
        status: 'unavailable',
        path,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        error: 'scenery tileset is empty or not a file',
      }
    }
    const raw = await readFile(path, 'utf8')
    sceneryAssetTilesetSchema.parse(JSON.parse(raw) as unknown)
    return {
      status: 'available',
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const terrainStamp = async (mapRoot: string): Promise<{ readonly id: string; readonly mtimeMs: number }> => {
  try {
    const s = await stat(terrainPmtilesPathForRoot(mapRoot))
    return { id: 'terrain', mtimeMs: s.mtimeMs }
  } catch {
    return { id: 'terrain', mtimeMs: -1 }
  }
}

const terrainMetadataStamp = async (mapRoot: string): Promise<{ readonly id: string; readonly mtimeMs: number }> => {
  try {
    const s = await stat(terrainMetadataPathForRoot(mapRoot))
    return { id: 'terrain-metadata', mtimeMs: s.mtimeMs }
  } catch {
    return { id: 'terrain-metadata', mtimeMs: -1 }
  }
}

const sceneryStamp = async (mapRoot: string): Promise<{ readonly id: string; readonly mtimeMs: number }> => {
  try {
    const s = await stat(sceneryTilesetPathForRoot(mapRoot))
    return { id: 'scenery', mtimeMs: s.mtimeMs }
  } catch {
    return { id: 'scenery', mtimeMs: -1 }
  }
}

/**
 * Asynchronously load the full manifest including reference tilesets discovered
 * on disk. Uses an in-process cache keyed by per-dataset symlink mtime so the
 * hot path (every /map/capabilities.json request) only does cheap stat calls
 * unless something actually changed.
 */
export const loadMapCapabilityManifest = async (
  config: LoadManifestConfig = { referenceRoot: referenceRootFromEnv() },
): Promise<MapCapabilityManifest> => {
  const mapRoot = config.mapRoot ?? mapRootFromEnv()
  const datasetIds = await listReferenceDatasetIds(config.referenceRoot)
  const freshStamps = [
    { id: `reference-root:${resolve(config.referenceRoot)}`, mtimeMs: 0 },
    { id: `map-root:${resolve(mapRoot)}`, mtimeMs: 0 },
    ...await buildStamps(config.referenceRoot, datasetIds),
    await terrainStamp(mapRoot),
    await terrainMetadataStamp(mapRoot),
    await sceneryStamp(mapRoot),
    await overviewStamp(mapRoot),
  ]
  if (cache && stampsMatch(cache.stamps, freshStamps)) return cache.manifest

  const referenceTilesets: ReferenceTileset[] = []
  for (const id of datasetIds) {
    const { tileset } = await readReferenceManifest(config.referenceRoot, id)
    if (tileset) referenceTilesets.push(tileset)
  }
  const terrainArtifact = await terrainArtifactFor(mapRoot)
  const terrain = createTerrainTileset(terrainArtifact)
  const scenery = createSceneryTileset(await sceneryArtifactFor(mapRoot))
  const overview = freshStamps.find(stamp => stamp.id === 'overview' && stamp.mtimeMs >= 0)
  const manifest = mapCapabilityManifestSchema.parse({
    schemaVersion: mapManifestSchemaVersion,
    tilesets: [createBaseTileset(), ...(overview ? [createOverviewTileset(overview.mtimeMs)] : []), terrain, scenery, ...referenceTilesets],
  })
  cache = { manifest, stamps: freshStamps }
  return manifest
}

/** Test seam: drop the in-process manifest cache. */
export const __clearManifestCacheForTests = (): void => { cache = null }

// --- Helpers for consumers ------------------------------------------------

export const findBaseTileset = (manifest: MapCapabilityManifest): BaseTileset => {
  for (const t of manifest.tilesets) if (t.kind === 'base') return t
  throw new Error('map capability manifest contains no base tileset')
}

export const findReferenceTilesets = (manifest: MapCapabilityManifest): ReadonlyArray<ReferenceTileset> =>
  manifest.tilesets.filter((t): t is ReferenceTileset => t.kind === 'reference')

export const findTerrainTilesets = (manifest: MapCapabilityManifest): ReadonlyArray<TerrainTileset> =>
  manifest.tilesets.filter((t): t is TerrainTileset => t.kind === 'terrain')

export const findSceneryTilesets = (manifest: MapCapabilityManifest): ReadonlyArray<SceneryTileset> =>
  manifest.tilesets.filter((t): t is SceneryTileset => t.kind === 'scenery')
