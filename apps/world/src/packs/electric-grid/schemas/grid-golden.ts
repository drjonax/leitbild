import { z } from 'zod'
import { osmIdPattern } from '../audit/audit-graph.ts'

// Reviewed reference list the grid audit checks a Grid Model against. Every entry cites a
// public source; thresholds are data so the model build can tighten them without code changes.

export const gridPriceAreaSchema = z.enum(['NO1', 'NO2', 'NO3', 'NO4', 'NO5'])
export const gridExternalAreaSchema = z.enum(['SE1', 'SE2', 'SE3', 'FI', 'DK1', 'NL', 'DE', 'GB'])
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const kv = z.number().finite().positive()
const share = z.number().finite().min(0).max(1)
const km = z.number().finite().positive()
const count = z.number().int().nonnegative()
const text = z.string().trim().min(1)

const evidenceSchema = z.object({
  sourceId: text,
  url: z.string().url(),
  /** Identifier inside the source: NVE globalid, registry number, or the page section relied on. */
  ref: text,
  note: text.optional(),
}).strict()

const sourceSchema = z.object({
  id: text,
  title: text,
  publisher: text,
  url: z.string().url(),
  licence: text,
  retrievedAt: isoDate,
}).strict()

const stationSchema = z.object({
  id: slug,
  name: text,
  osmIds: z.array(z.string().regex(osmIdPattern)).min(1),
  evidence: z.array(evidenceSchema).min(1),
}).strict()

const substationCheckSchema = z.object({
  stationId: slug,
  voltageKv: kv,
  /** Distinct neighbouring stations or junctions at this voltage level. */
  minDegree: z.number().int().positive(),
  evidence: z.array(evidenceSchema).min(1),
}).strict()

const corridorSchema = z.object({
  id: slug,
  name: text,
  fromStationId: slug,
  toStationId: slug,
  voltageKv: kv,
  minCircuits: z.number().int().positive(),
  evidence: z.array(evidenceSchema).min(1),
}).strict()

/** A corridor that must not be energised yet (under construction) or any more (decommissioned). */
const excludedCorridorSchema = z.object({
  id: slug,
  name: text,
  fromStationId: slug,
  toStationId: slug,
  voltageKv: kv,
  reason: text,
  evidence: z.array(evidenceSchema).min(1),
}).strict()

const interconnectorSchema = z.object({
  id: slug,
  name: text,
  kind: z.enum(['ac', 'hvdc']),
  stationId: slug,
  neighbourArea: gridExternalAreaSchema,
  voltageKv: kv,
  evidence: z.array(evidenceSchema).min(1),
}).strict()

export const gridRadialReasonSchema = z.enum([
  'radial-plant',
  'border-end',
  'converter-station',
  'industrial-customer',
  'offshore-landfall',
  'radial-supply',
])

const radialAllowanceSchema = z.object({
  stationId: slug,
  voltageKv: kv,
  reason: gridRadialReasonSchema,
  note: text,
  evidence: z.array(evidenceSchema).min(1),
}).strict()

const perArea = z.record(gridPriceAreaSchema, z.number().finite().nonnegative())

/**
 * A branch the AC load flow of an Operating Point loads above its continuous rating (but within its
 * emergency rating) for a reason the model cannot remove with evidence; the power-flow gate test
 * accepts it up to maxLoading (flow / continuous rating at the Operating Point's availability) and
 * fails once it no longer overloads.
 */
const powerFlowOverloadSchema = z.object({
  branchId: z.string().regex(/^branch:/),
  label: text,
  operatingPointId: text,
  maxLoading: z.number().finite().min(1),
  reason: text,
  evidence: z.array(evidenceSchema).min(1),
}).strict()

const thresholdsSchema = z.object({
  maxComponents: z.number().int().positive(),
  minLargestComponentBusShare300kv: share,
  minLargestComponentBusShare132kv: share,
  minLargestComponentLoadShare: share,
  maxUnexplainedBridges300kv: count,
  maxUnexplainedArticulationPoints300kv: count,
  maxUnexplainedDegreeOne300kv: count,
  voltageClassTolerance: share,
  maxVoltageMismatches: count,
  maxParallelDuplicates: count,
  maxOffTerminalEnds: count,
  terminalPolygonBufferKm: km,
  terminalPointRadiusKm: km,
  maxAttachmentKm: z.object({
    generator: z.object({ hydro: km, wind: km, solar: km, thermal: km, nuclear: km }).strict(),
    load: z.object({ distributed: km, site: km }).strict(),
  }).strict(),
  maxAttachmentViolations: count,
  generationTolerance: z.object({ hydro: share, wind: share }).strict(),
  maxUnassignedGenerationMw: z.number().finite().nonnegative(),
  loadTolerance: share,
  nveCoverage: z.object({ minKv: kv, bufferKm: km, maxUncoveredShare: share }).strict(),
  maxCuratedShare300kv: share,
  /** AC load flow gate (tests/electric-grid-model-power-flow.test.ts): admissible bus voltage band, pu. */
  minBusVoltagePu: z.number().finite().positive(),
  maxBusVoltagePu: z.number().finite().positive(),
}).strict()

export const gridGoldenSchema = z.object({
  id: text,
  title: text,
  reviewedAt: isoDate,
  note: text,
  sources: z.array(sourceSchema).min(1),
  thresholds: thresholdsSchema,
  /** One line per threshold: unit and the source or measurement it comes from. */
  thresholdNotes: z.record(z.string(), text),
  references: z.object({
    generation: z.object({
      sourceIds: z.array(text).min(1),
      note: text,
      capacityMwByFamily: z.object({ hydro: perArea, wind: perArea }).strict(),
    }).strict(),
    load: z.object({
      sourceId: text,
      referenceHour: z.string().datetime({ offset: true }),
      note: text,
      demandMwByArea: perArea,
    }).strict(),
  }).strict(),
  stations: z.array(stationSchema).min(1),
  substations: z.array(substationCheckSchema),
  corridors: z.array(corridorSchema),
  excludedCorridors: z.array(excludedCorridorSchema),
  interconnectors: z.array(interconnectorSchema),
  radialAllowList: z.array(radialAllowanceSchema),
  powerFlowOverloads: z.array(powerFlowOverloadSchema),
}).strict().superRefine((golden, context) => {
  const issue = (path: ReadonlyArray<string | number>, message: string): void => {
    context.addIssue({ code: 'custom', path: [...path], message })
  }
  const thresholdKeys = Object.keys(thresholdsSchema.shape)
  for (const key of thresholdKeys) if (golden.thresholdNotes[key] === undefined) issue(['thresholdNotes'], `threshold ${key} has no note`)
  for (const key of Object.keys(golden.thresholdNotes)) if (!thresholdKeys.includes(key)) issue(['thresholdNotes', key], `unknown threshold ${key}`)
  const sourceIds = new Set(golden.sources.map(source => source.id))
  if (sourceIds.size !== golden.sources.length) issue(['sources'], 'duplicate source id')
  const stationIds = new Set<string>()
  const osmOwner = new Map<string, string>()
  golden.stations.forEach((station, index) => {
    if (stationIds.has(station.id)) issue(['stations', index, 'id'], `duplicate station id ${station.id}`)
    stationIds.add(station.id)
    for (const osmId of station.osmIds) {
      const owner = osmOwner.get(osmId)
      if (owner !== undefined) issue(['stations', index, 'osmIds'], `${osmId} already belongs to station ${owner}`)
      osmOwner.set(osmId, station.id)
    }
  })
  const checkEvidence = (path: ReadonlyArray<string | number>, evidence: ReadonlyArray<{ readonly sourceId: string }>): void => {
    evidence.forEach((entry, index) => {
      if (!sourceIds.has(entry.sourceId)) issue([...path, 'evidence', index, 'sourceId'], `unknown source ${entry.sourceId}`)
    })
  }
  const checkStation = (path: ReadonlyArray<string | number>, stationId: string): void => {
    if (!stationIds.has(stationId)) issue(path, `unknown station ${stationId}`)
  }
  golden.stations.forEach((station, index) => checkEvidence(['stations', index], station.evidence))
  golden.substations.forEach((entry, index) => {
    checkStation(['substations', index, 'stationId'], entry.stationId)
    checkEvidence(['substations', index], entry.evidence)
  })
  const corridorIds = new Set<string>()
  golden.corridors.forEach((corridor, index) => {
    if (corridorIds.has(corridor.id)) issue(['corridors', index, 'id'], `duplicate corridor id ${corridor.id}`)
    corridorIds.add(corridor.id)
    checkStation(['corridors', index, 'fromStationId'], corridor.fromStationId)
    checkStation(['corridors', index, 'toStationId'], corridor.toStationId)
    if (corridor.fromStationId === corridor.toStationId) issue(['corridors', index], 'corridor connects a station to itself')
    checkEvidence(['corridors', index], corridor.evidence)
  })
  golden.excludedCorridors.forEach((corridor, index) => {
    if (corridorIds.has(corridor.id)) issue(['excludedCorridors', index, 'id'], `duplicate corridor id ${corridor.id}`)
    corridorIds.add(corridor.id)
    checkStation(['excludedCorridors', index, 'fromStationId'], corridor.fromStationId)
    checkStation(['excludedCorridors', index, 'toStationId'], corridor.toStationId)
    checkEvidence(['excludedCorridors', index], corridor.evidence)
  })
  const interconnectorIds = new Set<string>()
  golden.interconnectors.forEach((entry, index) => {
    if (interconnectorIds.has(entry.id)) issue(['interconnectors', index, 'id'], `duplicate interconnector id ${entry.id}`)
    interconnectorIds.add(entry.id)
    checkStation(['interconnectors', index, 'stationId'], entry.stationId)
    checkEvidence(['interconnectors', index], entry.evidence)
  })
  golden.radialAllowList.forEach((entry, index) => {
    checkStation(['radialAllowList', index, 'stationId'], entry.stationId)
    checkEvidence(['radialAllowList', index], entry.evidence)
  })
  const overloads = new Set<string>()
  golden.powerFlowOverloads.forEach((entry, index) => {
    const key = `${entry.operatingPointId}|${entry.branchId}`
    if (overloads.has(key)) issue(['powerFlowOverloads', index], `${entry.branchId} is listed twice for ${entry.operatingPointId}`)
    overloads.add(key)
    checkEvidence(['powerFlowOverloads', index], entry.evidence)
  })
  if (golden.thresholds.minBusVoltagePu >= golden.thresholds.maxBusVoltagePu) issue(['thresholds', 'minBusVoltagePu'], 'must be below maxBusVoltagePu')
  for (const sourceId of golden.references.generation.sourceIds) {
    if (!sourceIds.has(sourceId)) issue(['references', 'generation', 'sourceIds'], `unknown source ${sourceId}`)
  }
  if (!sourceIds.has(golden.references.load.sourceId)) issue(['references', 'load', 'sourceId'], `unknown source ${golden.references.load.sourceId}`)
})

export type GridGolden = z.infer<typeof gridGoldenSchema>
export type GridGoldenThresholds = GridGolden['thresholds']
export type GridGoldenStation = GridGolden['stations'][number]
export type GridRadialReason = z.infer<typeof gridRadialReasonSchema>
