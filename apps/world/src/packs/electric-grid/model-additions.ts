import { z } from 'zod'
import type { GridModelDefinition } from './grid-model.ts'
import { gridDataError, parseGridData, type GridDataIssue } from './schemas/data-issues.ts'

// v1 Model Addition, read by the definition loader on first use (never at import).
// Grid Model Addition v2 lives in schemas/grid-model-addition.ts.

const identity = { id: z.string().min(1), label: z.string().min(1) }
const provenance = { sourceId: z.string().min(1), sourceFeatureId: z.string().min(1) }
const kv = z.number().finite().positive()
const mw = z.number().finite().nonnegative()
const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const evidenceProvenance = z.object({
  sources: z.array(z.string().min(1)).min(1),
  method: z.enum(['mapped', 'registry', 'measured', 'inferred', 'curated']),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().min(1).optional(),
}).strict().refine(value => (value.method !== 'inferred' && value.method !== 'curated') || value.note !== undefined, 'inferred and curated provenance needs a note')
const externalArea = z.enum(['SE1', 'SE2', 'SE3', 'SE4', 'FI', 'DK1', 'NL', 'DE', 'GB'])

// Deliberately one level: named base topology plus explicit additional assets.
// No recursive inheritance, arbitrary patches, implicit nodes or scenario logic.
export const gridModelAdditionSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), description: z.string().min(1),
  baseModelRef: z.string().min(1), sourceIds: z.array(z.string().min(1)),
  buses: z.array(z.object({
    ...identity, nominalKv: kv,
    location: lonLat,
    ...provenance,
    provenance: evidenceProvenance.optional(),
  }).strict()),
  branches: z.array(z.object({
    ...identity,
    kind: z.enum(['ac_line', 'cable', 'transformer', 'hvdc_link', 'switch']),
    fromBusId: z.string().min(1), toBusId: z.string().min(1), nominalKv: kv,
    ratingMw: mw, emergencyRatingMw: mw,
    reactancePu: z.number().finite().positive(), resistancePu: z.number().finite().nonnegative(),
    weatherExposure: z.enum(['low', 'medium', 'high']),
    ...provenance,
    provenance: evidenceProvenance.optional(),
  }).strict()),
  connectionPoints: z.array(z.object({
    ...identity, busId: z.string().min(1), nominalKv: kv,
    maximumExportMw: mw, maximumImportMw: mw,
  }).strict()),
  externalSystems: z.array(z.object({
    ...identity,
    area: z.union([externalArea, z.literal('nordic-remainder')]),
    synchronous: z.boolean(),
    boundaryBusIds: z.array(z.string().min(1)).min(1),
    inertiaGws: z.number().finite().positive().optional(),
    loadMw: mw.optional(),
    fcrNMwPerHz: mw.optional(),
    fcrDUpMw: mw.optional(),
    fcrDDownMw: mw.optional(),
    afrrUpMw: mw.optional(),
    afrrDownMw: mw.optional(),
    provenance: evidenceProvenance,
  }).strict()).optional(),
  hvdcLinks: z.array(z.object({
    ...identity,
    fromBusId: z.string().min(1), toBusId: z.string().min(1),
    ratingMw: z.number().finite().positive(),
    lossPercent: z.number().finite().nonnegative().lt(100),
    rampMwPerMinute: z.number().finite().positive(),
    osmWayIds: z.array(z.string().min(1)),
    provenance: evidenceProvenance,
  }).strict()).optional(),
}).strict()
export type GridModelAddition = z.infer<typeof gridModelAdditionSchema>

const subject = 'Grid Model Addition'

export const parseGridModelAddition = (json: unknown, source: string): GridModelAddition =>
  parseGridData(gridModelAdditionSchema, json, source, subject)

/** Collisions with the base and unresolved bus references, at the addition's JSON paths. */
const additionIssues = (base: GridModelDefinition, addition: GridModelAddition): ReadonlyArray<GridDataIssue> => {
  const issues: GridDataIssue[] = []
  const assetIds = new Set([...base.buses, ...base.branches, ...base.generators, ...base.loads, ...base.storage].map(asset => asset.id))
  const busIds = new Set(base.buses.map(bus => bus.id))
  const pointIds = new Set(base.connectionPoints.map(point => point.id))
  addition.buses.forEach((bus, index) => {
    if (assetIds.has(bus.id)) issues.push({ path: ['buses', index, 'id'], message: `duplicate Grid Asset id ${bus.id}` })
    assetIds.add(bus.id)
    busIds.add(bus.id)
  })
  addition.branches.forEach((branch, index) => {
    if (assetIds.has(branch.id)) issues.push({ path: ['branches', index, 'id'], message: `duplicate Grid Asset id ${branch.id}` })
    assetIds.add(branch.id)
    for (const end of ['fromBusId', 'toBusId'] as const) {
      if (!busIds.has(branch[end])) issues.push({ path: ['branches', index, end], message: `unknown bus ${branch[end]} in ${base.id} or this addition` })
    }
  })
  addition.connectionPoints.forEach((point, index) => {
    if (pointIds.has(point.id)) issues.push({ path: ['connectionPoints', index, 'id'], message: `duplicate connection point id ${point.id}` })
    pointIds.add(point.id)
    if (!busIds.has(point.busId)) issues.push({ path: ['connectionPoints', index, 'busId'], message: `unknown bus ${point.busId} in ${base.id} or this addition` })
  })
  return issues
}

export const addGridModelAssets = (base: GridModelDefinition, addition: GridModelAddition, source: string): GridModelDefinition => {
  if (base.id !== addition.baseModelRef) throw new Error(`Grid Model base mismatch: ${addition.baseModelRef}`)
  const issues = additionIssues(base, addition)
  if (issues.length > 0) throw gridDataError(source, subject, issues)
  return {
    ...base, id: addition.id, title: addition.title, description: addition.description,
    sourceIds: [...new Set([...base.sourceIds, ...addition.sourceIds])],
    buses: [...base.buses, ...addition.buses],
    branches: [...base.branches, ...addition.branches],
    connectionPoints: [...base.connectionPoints, ...addition.connectionPoints],
    ...(base.externalSystems === undefined && addition.externalSystems === undefined
      ? {}
      : { externalSystems: [...base.externalSystems ?? [], ...addition.externalSystems ?? []] }),
    ...(base.hvdcLinks === undefined && addition.hvdcLinks === undefined
      ? {}
      : { hvdcLinks: [...base.hvdcLinks ?? [], ...addition.hvdcLinks ?? []] }),
  }
}
