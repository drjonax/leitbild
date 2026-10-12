import { z } from 'zod'
import { parseGridData } from './data-issues.ts'
import { gridIdPatterns } from './grid-ids.ts'

// Grid Geometry v1: the Pack-owned map paths of one Grid Model build, generated beside the
// model as models/<model-id>.geometry.json, or beside a Model Addition for its own branches.
// Every path runs from the asset's fromBus to its toBus. Geometry is presentation only: it never
// enters the model or its digest.

const lonLat = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const path = z.array(lonLat).min(2)

const pathEntry = (id: RegExp, subject: string) => z.object({
  id: z.string().regex(id, `must be a Grid ${subject} id`),
  path,
}).strict()

/** A source of map data beyond the model's own, such as the routes of interconnectors abroad. */
const sourceEntry = z.object({
  sourceId: z.string().regex(/^\S+$/),
  /** The OSM data time the source reflects. */
  snapshotAt: z.iso.datetime(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  licence: z.literal('osm-odbl-1.0'),
}).strict()
export type GridGeometrySource = z.infer<typeof sourceEntry>

const requireUniqueIds = (entries: ReadonlyArray<{ readonly id: string }>, field: string, context: z.core.$RefinementCtx<unknown>): void => {
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) context.addIssue({ code: 'custom', path: [field, index, 'id'], message: `duplicate ${entry.id}` })
    seen.add(entry.id)
  })
}

export const gridGeometryArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().regex(gridIdPatterns.definitionRef, 'must be an electric-grid definition ref'),
  /** The Grid Model's sourceBuild.id; geometry from another build is rejected. */
  sourceBuildId: z.string().regex(/^\S+$/),
  /** Douglas–Peucker tolerance the paths were simplified with (m). */
  simplificationMeters: z.number().finite().positive(),
  /**
   * mapped: lines and cables follow their mapped routes (OpenStreetMap ways); designed: the
   * fictional lines of a Model Addition, laid by the build along existing corridors
   * (model-build/designed-routes.ts). No designed path stands for a real line.
   */
  routes: z.enum(['mapped', 'designed']),
  sources: z.array(sourceEntry),
  branches: z.array(pathEntry(gridIdPatterns.branch, 'branch')),
  hvdcLinks: z.array(pathEntry(gridIdPatterns.hvdcLink, 'HVDC link')),
  /**
   * Where the map draws each boundary bus: at the station abroad that its first interconnector's
   * mapped route reaches. Drawing only; the model keeps the bus where its interconnector leaves the extract.
   */
  boundaryBuses: z.array(z.object({
    id: z.string().regex(gridIdPatterns.bus, 'must be a Grid bus id'),
    location: lonLat,
    station: z.object({ osmId: z.string().regex(/^(node|way|relation)\/\d+$/), name: z.string().min(1).nullable() }).strict(),
  }).strict()),
}).strict().superRefine((artifact, context) => {
  requireUniqueIds(artifact.branches, 'branches', context)
  requireUniqueIds(artifact.hvdcLinks, 'hvdcLinks', context)
  requireUniqueIds(artifact.boundaryBuses, 'boundaryBuses', context)
})
export type GridGeometryArtifact = z.infer<typeof gridGeometryArtifactSchema>

/** Validates Grid Geometry JSON; throws one error naming `source` and each issue's JSON path. */
export const validateGridGeometryArtifact = (json: unknown, source: string): GridGeometryArtifact =>
  parseGridData(gridGeometryArtifactSchema, json, source, 'Grid Geometry')
