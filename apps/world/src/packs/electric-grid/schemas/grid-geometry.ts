import { z } from 'zod'
import { parseGridData } from './data-issues.ts'
import { gridIdPatterns } from './grid-ids.ts'

// Grid Geometry v1: the Pack-owned map paths of one Grid Model build, generated beside the
// model as models/<model-id>.geometry.json. Every path runs from the asset's fromBus to its
// toBus. Geometry is presentation only: it never enters the model or its digest.

const lonLat = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const path = z.array(lonLat).min(2)

const pathEntry = (id: RegExp, subject: string) => z.object({
  id: z.string().regex(id, `must be a Grid ${subject} id`),
  path,
}).strict()

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
  branches: z.array(pathEntry(gridIdPatterns.branch, 'branch')),
  hvdcLinks: z.array(pathEntry(gridIdPatterns.hvdcLink, 'HVDC link')),
}).strict().superRefine((artifact, context) => {
  requireUniqueIds(artifact.branches, 'branches', context)
  requireUniqueIds(artifact.hvdcLinks, 'hvdcLinks', context)
})
export type GridGeometryArtifact = z.infer<typeof gridGeometryArtifactSchema>

/** Validates Grid Geometry JSON; throws one error naming `source` and each issue's JSON path. */
export const validateGridGeometryArtifact = (json: unknown, source: string): GridGeometryArtifact =>
  parseGridData(gridGeometryArtifactSchema, json, source, 'Grid Geometry')
