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
  buses: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kv: finite,
    location: lonLat,
    external: z.object({ label: z.string(), synchronous: z.boolean() }).strict().optional()
      .describe('Only on a boundary bus of an external system: synchronous, the Nordic equivalent behind AC ties; asynchronous, a system reached only by HVDC links, outside the modelled AC network.'),
  }).strict()),
  branches: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: branchDefinitionSchema.shape.kind,
    kv: finite,
    fromBus: index.describe('Index into buses.'),
    toBus: index.describe('Index into buses.'),
    ratingMw: finite,
    pathSource: z.enum(['mapped-route', 'transformer', 'network-equivalent', 'bus-to-bus']).describe('mapped-route: a line or cable along its mapped route from the geometry artifact; transformer: a substation transformer, drawn between its buses; network-equivalent: a curated equivalent of sub-transmission below the model\'s voltage floor, not a mapped line, drawn between its buses; bus-to-bus: a straight segment between the bus locations, because no mapped route exists for the line (a model without an artifact, or a branch a Model Addition adds).'),
    path: z.array(lonLat).min(2).describe('[lon, lat] from fromBus to toBus.'),
  }).strict()),
  hvdcLinks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    fromBus: index.describe('Index into buses: the Norwegian converter.'),
    toBus: index.describe('Index into buses: the far converter, usually an external system\'s boundary bus.'),
    ratingMw: finite,
    pathSource: z.enum(['mapped-route', 'bus-to-bus']).describe('mapped-route: the cable route from the geometry artifact; bus-to-bus: a straight segment, because the model has no artifact.'),
    path: z.array(lonLat).min(2).describe('[lon, lat] from fromBus to toBus.'),
  }).strict()).describe('HVDC links in model order; map.state reports their state in the same order.'),
  generators: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: generatorDefinitionSchema.shape.kind,
    bus: index.describe('Index into buses.'),
    capacityMw: finite,
    location: lonLat,
  }).strict()),
  loads: z.array(z.object({
    bus: index.describe('Index into buses.'),
    label: z.string().describe('The load\'s label, or the number of loads and the bus label.'),
    loadIds: z.array(z.string()).min(1).describe('The loads at the bus, in model order.'),
    kinds: z.array(loadDefinitionSchema.shape.kind).min(1).describe('Their distinct kinds, in order of first appearance.'),
    location: lonLat.describe('Mean location of the loads.'),
  }).strict()).describe('Loads drawn per bus: one entry for all loads at a bus, in model order of each bus\'s first load. map.state reports their sums.'),
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
    flowModel: z.enum(['ac', 'dc']).nullable().describe('ac: flows from its converged AC load flow; dc: its AC load flow did not converge (DC flows); null: not energised.'),
  }).strict()).describe('Current electrical islands; buses.island indexes this list.'),
  buses: z.object({
    island: z.array(count.nullable()).describe('Index into islands per bus; null at an HVDC terminal (the bus of an external system reached only by HVDC), which lies in no island.'),
    energized: z.array(flag).describe('1 when the bus island is energised; 0 at an HVDC terminal, which takes no part in energisation.'),
  }).strict(),
  branches: z.object({
    loadingPercent: z.array(finite).describe('Rated flow (AC apparent power, or the DC flow) over the derated rating (%, 0.1 resolution).'),
    flowMw: z.array(finite).describe('Active power at the from end, positive from fromBus to toBus (MW, whole).'),
    flowModel: z.array(z.enum(['ac', 'dc']).nullable()).describe('Where each flow comes from: ac, dc (the island\'s AC load flow did not converge) or null (no flow).'),
    closed: z.array(flag),
    tripped: z.array(flag).describe('1 when the branch\'s protection tripped it: open (closed 0) until reset-branch-protection, unlike a branch an operator opened.'),
    availability: z.array(finite).describe('Available fraction of the rating (0.01 resolution).'),
  }).strict(),
  generators: z.object({
    dispatchMw: z.array(finite).describe('Active power output (MW, whole).'),
    state: z.array(generatorLifecycleStateSchema),
  }).strict(),
  loads: z.object({
    demandMw: z.array(finite).describe('Sum over the bus\'s loads (MW, 0.1 resolution).'),
    servedMw: z.array(finite).describe('Sum over the bus\'s loads (MW, 0.1 resolution).'),
    shedMw: z.array(finite).describe('Shed manually or by LFDD, summed over the bus\'s loads (MW, 0.1 resolution).'),
  }).strict().describe('Aligned with map.geometry loads: one entry per bus with loads.'),
  hvdcLinks: z.object({
    state: z.array(z.enum(['deblocked', 'blocked', 'tripped'])),
    transferMw: z.array(finite).describe('Power sent at the Norwegian converter, positive exporting from Norway (MW, whole).'),
    setpointMw: z.array(finite).describe('Transfer set-point, positive exporting from Norway (MW, whole).'),
  }).strict().describe('Aligned with map.geometry hvdcLinks.'),
}).strict()
export type GridMapStateResult = z.infer<typeof gridMapStateResultSchema>
