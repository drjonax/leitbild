import { z } from 'zod'
import { geoJsonPosition2DSchema } from '../../../core/model/geo.ts'
import { branchDefinitionSchema, generatorDefinitionSchema, generatorLifecycleStateSchema, loadDefinitionSchema } from './schemas.ts'

// Wire schemas of the Grid map queries. Browser-safe: the live map layer validates results with them.

const finite = z.number().finite()
const index = z.number().int().nonnegative()
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const lonLat = geoJsonPosition2DSchema

export const gridMapGeometryResultSchema = z.object({
  gridId: z.string(),
  modelId: z.string(),
  sourceBuildId: z.string(),
  modelDigest: sha256Hex.describe('SHA-256 of the Grid Model the geometry draws.'),
  geometryDigest: sha256Hex.describe('Changes when the model or its geometry artifact changes. map.state reports the same digest, so a client refetches geometry only when they differ.'),
  simplificationMeters: finite.positive().nullable().describe('Douglas–Peucker tolerance of the geometry artifact (m); null when the model has no artifact.'),
  buses: z.array(z.object({ id: z.string(), label: z.string(), kv: finite, location: lonLat }).strict()),
  branches: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: branchDefinitionSchema.shape.kind,
    kv: finite,
    fromBus: index.describe('Index into buses.'),
    toBus: index.describe('Index into buses.'),
    ratingMw: finite,
    pathSource: z.enum(['artifact', 'bus-to-bus']).describe('artifact: the mapped route from the geometry artifact; bus-to-bus: a straight segment between the bus locations, because no mapped route exists for the branch (a model without an artifact, or a branch a Model Addition adds).'),
    path: z.array(lonLat).min(2).describe('[lon, lat] from fromBus to toBus.'),
  }).strict()),
  generators: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: generatorDefinitionSchema.shape.kind,
    bus: index.describe('Index into buses.'),
    capacityMw: finite,
    location: lonLat,
  }).strict()),
  loads: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: loadDefinitionSchema.shape.kind,
    bus: index.describe('Index into buses.'),
    location: lonLat,
  }).strict()),
}).strict()
/** As a client reads it: positions are typed longitude/latitude. */
export type GridMapGeometryResult = z.output<typeof gridMapGeometryResultSchema>
/** As the query answers it. */
export type GridMapGeometryWire = z.input<typeof gridMapGeometryResultSchema>

const count = z.number().int().nonnegative()
const flag = z.union([z.literal(0), z.literal(1)])

export const gridMapStateResultSchema = z.object({
  gridId: z.string(),
  geometryDigest: z.string().regex(/^[0-9a-f]{64}$/).describe('Digest of the geometry these arrays align with; refetch map.geometry when it differs from the cached one.'),
  revision: count.describe('Grid runtime tick of this state; it increases with every solve.'),
  elapsedMs: finite.describe('Grid simulated time at this state (ms).'),
  islands: z.array(z.object({
    id: z.string(),
    energized: z.boolean(),
    frequencyHz: finite.nullable().describe('Island frequency; null when the island is not energised.'),
  }).strict()).describe('Current electrical islands; buses.island indexes this list.'),
  buses: z.object({
    island: z.array(count).describe('Index into islands per bus.'),
    energized: z.array(flag).describe('1 when the bus island is energised.'),
  }).strict(),
  branches: z.object({
    loadingPercent: z.array(finite).describe('|flow| over the derated rating (%, 0.1 resolution).'),
    flowMw: z.array(finite).describe('Active power, positive from fromBus to toBus (MW, whole).'),
    closed: z.array(flag),
    availability: z.array(finite).describe('Available fraction of the rating (0.01 resolution).'),
  }).strict(),
  generators: z.object({
    dispatchMw: z.array(finite).describe('Active power output (MW, whole).'),
    state: z.array(generatorLifecycleStateSchema),
  }).strict(),
  loads: z.object({
    demandMw: z.array(finite).describe('MW, 0.1 resolution.'),
    servedMw: z.array(finite).describe('MW, 0.1 resolution.'),
    shedMw: z.array(finite).describe('Shed manually or by LFDD (MW, 0.1 resolution).'),
  }).strict(),
}).strict()
export type GridMapStateResult = z.infer<typeof gridMapStateResultSchema>
