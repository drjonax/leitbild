import { z } from 'zod'

// Normalised OSM power features (the grid-norway sidecar). One feature per OSM element with its real OSM id;
// ways are never merged here; corridor assembly belongs to the topology compiler.

export const gridReferenceCategorySchema = z.enum([
  'line',
  'cable',
  'busbar',
  'substation',
  'transformer',
  'portal',
  'terminal',
  'plant',
  'generator',
  'circuit',
])

export type GridReferenceCategory = z.infer<typeof gridReferenceCategorySchema>

export const gridReferenceSystemSchema = z.enum(['ac50', 'hvdc', 'traction', 'other'])
export type GridReferenceSystem = z.infer<typeof gridReferenceSystemSchema>

export const gridReferenceLifecycleSchema = z.enum(['operational', 'construction', 'proposed', 'disused', 'abandoned'])
export type GridReferenceLifecycle = z.infer<typeof gridReferenceLifecycleSchema>

const osmElementIdSchema = z.string().regex(/^(node|way|relation)\/\d+$/)
const osmNodeIdSchema = z.string().regex(/^node\/\d+$/)

export const gridReferenceMemberSchema = z.object({
  id: osmElementIdSchema,
  role: z.string(),
})

export const gridReferenceFeatureSchema = z.object({
  source: z.string().min(1),
  category: gridReferenceCategorySchema,
  externalId: osmElementIdSchema,
  // One entry per geometry position in GeoJSON order (Polygon/MultiPolygon rings flattened);
  // null when the geometry is a computed member centroid rather than OSM nodes.
  osmNodeIds: z.array(osmNodeIdSchema).nullable(),
  // Relation members in OSM order; empty for nodes and ways.
  members: z.array(gridReferenceMemberSchema),
  name: z.string().min(1).nullable(),
  ref: z.string().min(1).nullable(),
  operator: z.string().min(1).nullable(),
  // OSM `voltage` is in volts; values ≥ 1000 V are listed here in kV, descending.
  voltageKv: z.array(z.number().finite().gte(1)),
  maxVoltageKv: z.number().finite().gte(1).nullable(),
  // Tagged values below 1000 V, kept in volts and never reinterpreted as kV.
  voltageBelowThresholdV: z.array(z.number().finite().gt(0).lt(1000)),
  // Tagged `frequency` values in Hz; 0 is direct current.
  frequencyHz: z.array(z.number().finite().nonnegative()),
  systems: z.array(gridReferenceSystemSchema).min(1),
  // 'observed' when derived from a `frequency` tag; 'inferred' (ac50) when the tag is absent.
  systemProvenance: z.enum(['observed', 'inferred']),
  lifecycle: gridReferenceLifecycleSchema,
  circuits: z.number().int().positive().nullable(),
  cables: z.number().int().positive().nullable(),
  power: z.string().min(1).nullable(),
  plantSource: z.string().min(1).nullable(),
  outputMw: z.number().finite().nonnegative().nullable(),
  geometrySource: z.enum(['osm-node', 'osm-way', 'osm-multipolygon', 'osm-member-centroid']),
  // 'observed' when the feature carries a usable voltage or output; 'unknown' otherwise.
  propertyProvenance: z.enum(['observed', 'unknown']),
  confidence: z.enum(['high', 'low']),
  tags: z.record(z.string(), z.string()),
})

export type GridReferenceFeatureProperties = z.infer<typeof gridReferenceFeatureSchema>

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

// Manifest written next to a standalone sidecar build (scripts/electric-grid/build-osm-power-sidecar.ts).
export const gridReferenceSidecarManifestSchema = z.object({
  kind: z.literal('grid-norway-osm-sidecar'),
  builtAt: z.string().min(1),
  generator: z.object({
    script: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    workingTreeClean: z.boolean(),
  }),
  source: z.object({
    id: z.string().min(1),
    snapshot: z.object({
      origin: z.string().min(1),
      sha256: sha256Schema,
      byteLength: z.number().int().positive(),
      dataTimestamp: z.string().min(1),
    }),
    osmHeader: z.object({
      writingProgram: z.string().nullable(),
      source: z.string().nullable(),
      replicationSequenceNumber: z.number().int().nullable(),
      replicationBaseUrl: z.string().nullable(),
    }),
    licence: z.object({ id: z.string().min(1), attribution: z.string().min(1), url: z.string().min(1) }),
  }),
  sidecar: z.object({
    path: z.string().min(1),
    sha256: sha256Schema,
    byteLength: z.number().int().positive(),
    featureCount: z.number().int().nonnegative(),
  }),
  featureCounts: z.record(gridReferenceCategorySchema, z.number().int().nonnegative()),
  ledger: z.record(z.string(), z.number().int().positive()),
})

export type GridReferenceSidecarManifest = z.infer<typeof gridReferenceSidecarManifestSchema>
