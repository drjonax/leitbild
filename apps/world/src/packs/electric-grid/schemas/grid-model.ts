import { z } from 'zod'
import { parseGridData } from './data-issues.ts'
import { gridModelReferenceIssues } from './grid-model-references.ts'
import {
  aggregateGeneratorIdParts,
  externalAreas,
  externalAreaSchema,
  generatorKinds,
  gridIdPatterns,
  isCuratedId,
  municipalityLoadGroups,
  municipalityLoadIdParts,
  nordicSynchronousExternalAreas,
  priceAreaSchema,
  shuntIdParts,
  siteLoadKinds,
  transformerIdParts,
} from './grid-ids.ts'

// Grid Model v2: a generated, fully resolved data artefact (no inference at load).
// Units are in field names; consumers never default an absent optional field.

const text = z.string().min(1)
const positive = z.number().finite().positive()
const nonNegative = z.number().finite().nonnegative()
const lonLat = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const busRef = z.string().regex(gridIdPatterns.bus, 'must be a Grid bus id')
const osmWayIds = z.array(z.string().regex(gridIdPatterns.osmWay, 'must be a positive OSM way id'))
/** `<namespace>:<identity>`, e.g. `osm:pbf-power:NO@2026-10-09` or `nve:vannkraft1@2026-10-10`. */
export const gridSourceIdSchema = z.string().regex(/^[a-z][a-z0-9-]*:\S+$/, 'must be a namespaced source id')

type Context = z.core.$RefinementCtx<unknown>
const fail = (context: Context, path: ReadonlyArray<PropertyKey>, message: string): void => {
  context.addIssue({ code: 'custom', path: [...path], message })
}
const requireUnique = (context: Context, values: ReadonlyArray<string>, field: string): void => {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    if (seen.has(value)) fail(context, [field, index], `duplicate ${value}`)
    seen.add(value)
  })
}

export const gridProvenanceSchema = z.object({
  sources: z.array(gridSourceIdSchema).min(1),
  method: z.enum(['mapped', 'registry', 'measured', 'inferred', 'curated']),
  confidence: z.enum(['high', 'medium', 'low']),
  note: text.optional(),
}).strict().superRefine((value, context) => {
  if ((value.method === 'inferred' || value.method === 'curated') && value.note === undefined) {
    fail(context, ['note'], `a note is required for ${value.method} provenance`)
  }
  requireUnique(context, value.sources, 'sources')
})
export type GridProvenance = z.infer<typeof gridProvenanceSchema>

const requireCuratedProvenance = (context: Context, value: { readonly id: string; readonly provenance: GridProvenance }): void => {
  if (isCuratedId(value.id) && value.provenance.method !== 'curated') fail(context, ['provenance', 'method'], 'a curated id requires curated provenance')
}

export const gridBusSchema = z.object({
  id: busRef,
  label: text,
  kind: z.enum(['substation', 'junction', 'boundary', 'plant-terminal', 'connection-point']),
  /** Groups the voltage levels of one station; absent for junction and boundary buses. */
  substationId: z.string().regex(gridIdPatterns.substation).optional(),
  nominalKv: positive,
  location: lonLat,
  priceArea: priceAreaSchema.optional(),
  externalArea: externalAreaSchema.optional(),
  provenance: gridProvenanceSchema,
}).strict().superRefine((bus, context) => {
  requireCuratedProvenance(context, bus)
  if (bus.kind === 'boundary') {
    if (bus.externalArea === undefined) fail(context, ['externalArea'], 'required for a boundary bus')
    else {
      // An AC tie meets a synchronous neighbour at one voltage level; an HVDC area has one terminal.
      const expected = nordicSynchronousExternalAreas.has(bus.externalArea)
        ? `bus:boundary-${bus.externalArea}@${String(bus.nominalKv)}`
        : `bus:boundary-${bus.externalArea}`
      if (bus.id !== expected) fail(context, ['id'], `a boundary bus id must be ${expected}`)
    }
    if (bus.priceArea !== undefined) fail(context, ['priceArea'], 'a boundary bus lies outside the Norwegian price areas')
    if (bus.substationId !== undefined) fail(context, ['substationId'], 'a boundary bus has no substation')
    return
  }
  if (bus.priceArea === undefined) fail(context, ['priceArea'], 'required for a non-boundary bus')
  if (bus.externalArea !== undefined) fail(context, ['externalArea'], 'only boundary buses carry an external area')
  if (!bus.id.endsWith(`@${String(bus.nominalKv)}`)) fail(context, ['id'], `the id voltage suffix must be @${String(bus.nominalKv)}`)
  const junctionId = bus.id.startsWith('bus:junction-')
  if ((bus.kind === 'junction') !== junctionId) fail(context, ['id'], 'junction buses and only junction buses use bus:junction-osm-node-<id>@<kV>')
  if (bus.kind === 'junction' && bus.substationId !== undefined) fail(context, ['substationId'], 'a junction bus has no substation')
  if (bus.kind === 'substation') {
    if (bus.substationId === undefined) fail(context, ['substationId'], 'required for a substation bus')
    else if (bus.id !== `bus:${bus.substationId}@${String(bus.nominalKv)}`) fail(context, ['id'], `a substation bus id must be bus:${bus.substationId}@${String(bus.nominalKv)}`)
  }
})
export type GridBusV2 = z.infer<typeof gridBusSchema>

export const gridBranchSchema = z.object({
  id: z.string().regex(gridIdPatterns.branch, 'must be a Grid branch id'),
  label: text,
  kind: z.enum(['ac_line', 'cable', 'transformer']),
  fromBusId: busRef,
  toBusId: busRef,
  /** Transformer: high-side kV. */
  nominalKv: positive,
  /** Required for lines and cables; absent for transformers. */
  lengthKm: positive.optional(),
  circuits: z.number().int().positive(),
  /** Continuous rating of all circuits in parallel. */
  ratingMw: positive,
  emergencyRatingMw: positive,
  emergencyDurationSeconds: positive,
  /** Per unit on the model's sBaseMva, all circuits in parallel. */
  reactancePu: positive,
  resistancePu: nonNegative,
  chargingSusceptancePu: nonNegative,
  /** Off-nominal turns ratio (1 = nominal); required for transformers, absent for lines and cables. */
  tapRatio: positive.optional(),
  osmWayIds,
  provenance: gridProvenanceSchema,
}).strict().superRefine((branch, context) => {
  requireCuratedProvenance(context, branch)
  if (branch.kind === 'transformer' && branch.tapRatio === undefined) fail(context, ['tapRatio'], 'required for a transformer')
  if (branch.kind !== 'transformer' && branch.tapRatio !== undefined) fail(context, ['tapRatio'], `a ${branch.kind} has no tap changer`)
  if (branch.emergencyRatingMw < branch.ratingMw) fail(context, ['emergencyRatingMw'], `must be at least ratingMw (${branch.ratingMw})`)
  if (branch.fromBusId === branch.toBusId) fail(context, ['toBusId'], 'a branch must connect two different buses')
  if (branch.kind === 'transformer' && branch.lengthKm !== undefined) fail(context, ['lengthKm'], 'a transformer has no length')
  if (branch.kind !== 'transformer' && branch.lengthKm === undefined) fail(context, ['lengthKm'], `required for ${branch.kind}`)
  requireUnique(context, branch.osmWayIds, 'osmWayIds')
  const inferredTransformer = branch.kind === 'transformer' && branch.provenance.method === 'inferred'
  if (branch.osmWayIds.length === 0 && !inferredTransformer && branch.provenance.method !== 'curated') {
    fail(context, ['osmWayIds'], 'empty only for inferred transformers and curated branches')
  }
  const transformer = transformerIdParts(branch.id)
  if (branch.id.startsWith('branch:osm-') && branch.kind === 'transformer') fail(context, ['id'], 'transformers use branch:transformer-<substation>-<kVhi>-<kVlo>')
  if (branch.id.startsWith('branch:osm-') && branch.osmWayIds.length === 0) fail(context, ['osmWayIds'], 'an OSM-derived branch lists its OSM ways')
  if (transformer !== undefined && branch.kind !== 'transformer') fail(context, ['kind'], 'a transformer id requires kind transformer')
  if (transformer !== undefined) {
    if (transformer.highKv !== String(branch.nominalKv)) fail(context, ['id'], `the high-side voltage in the id must equal nominalKv ${String(branch.nominalKv)}`)
    if (Number(transformer.lowKv) >= Number(transformer.highKv)) fail(context, ['id'], 'the low-side voltage must be below the high-side voltage')
  }
})
export type GridBranchV2 = z.infer<typeof gridBranchSchema>

export const gridHvdcLinkSchema = z.object({
  id: z.string().regex(gridIdPatterns.hvdcLink, 'must be an HVDC link id'),
  label: text,
  /** Norwegian converter AC bus. */
  fromBusId: busRef,
  /** Boundary bus, or another Norwegian bus. */
  toBusId: busRef,
  ratingMw: positive,
  lossPercent: nonNegative.lt(100),
  rampMwPerMinute: positive,
  osmWayIds,
  provenance: gridProvenanceSchema,
}).strict().superRefine((link, context) => {
  if (link.fromBusId === link.toBusId) fail(context, ['toBusId'], 'an HVDC link must connect two different buses')
  requireUnique(context, link.osmWayIds, 'osmWayIds')
})
export type GridHvdcLinkV2 = z.infer<typeof gridHvdcLinkSchema>

/**
 * A ramp limit several HVDC links share (one market border, or a joint cap on several borders): the
 * change of their aggregate transfer stays within rampMwPerMinute, each link within its own ramp
 * too. A link belongs to at most one group; the provenance note states the basis.
 */
export const gridHvdcRampGroupSchema = z.object({
  id: z.string().regex(gridIdPatterns.hvdcRampGroup, 'must be an HVDC ramp group id'),
  linkIds: z.array(z.string().regex(gridIdPatterns.hvdcLink, 'must be an HVDC link id')).min(2),
  rampMwPerMinute: positive,
  provenance: gridProvenanceSchema,
}).strict().superRefine((group, context) => {
  requireUnique(context, group.linkIds, 'linkIds')
})
export type GridHvdcRampGroupV2 = z.infer<typeof gridHvdcRampGroupSchema>

export const gridExternalSystemSchema = z.object({
  id: z.string().regex(gridIdPatterns.externalSystem, 'must be an external system id'),
  label: text,
  area: z.enum([...externalAreas, 'nordic-remainder']),
  /** Shares frequency with the Norwegian island it touches. */
  synchronous: z.boolean(),
  boundaryBusIds: z.array(busRef).min(1),
  /** Kinetic energy E_k; required when synchronous. */
  inertiaGws: positive.optional(),
  /** Load for frequency-dependent damping; required when synchronous. */
  loadMw: positive.optional(),
  /** FCR-N held by the system, MW/Hz. */
  fcrNMwPerHz: nonNegative.optional(),
  fcrDUpMw: nonNegative.optional(),
  fcrDDownMw: nonNegative.optional(),
  afrrUpMw: nonNegative.optional(),
  afrrDownMw: nonNegative.optional(),
  /**
   * Required when synchronous: the share of the system's exchange with Norway (its schedule and its
   * frequency response) that enters at each external area's boundary buses. One entry per area of
   * its boundary buses, shares summing to 1.
   */
  areaParticipation: z.array(z.object({ area: externalAreaSchema, share: positive }).strict()).min(1).optional(),
  provenance: gridProvenanceSchema,
}).strict().superRefine((system, context) => {
  if (system.id !== `external:${system.area}`) fail(context, ['id'], `must be external:${system.area}`)
  requireUnique(context, system.boundaryBusIds, 'boundaryBusIds')
  const synchronousFields = ['inertiaGws', 'loadMw', 'fcrNMwPerHz', 'fcrDUpMw', 'fcrDDownMw', 'afrrUpMw', 'afrrDownMw', 'areaParticipation'] as const
  if (system.areaParticipation !== undefined) {
    requireUnique(context, system.areaParticipation.map(entry => entry.area), 'areaParticipation')
    const total = system.areaParticipation.reduce((sum, entry) => sum + entry.share, 0)
    if (!(Math.abs(total - 1) <= 1e-9)) fail(context, ['areaParticipation'], `shares must sum to 1, got ${total}`)
  }
  if (system.synchronous) {
    if (system.area !== 'nordic-remainder' && !nordicSynchronousExternalAreas.has(system.area)) fail(context, ['synchronous'], `${system.area} is not synchronous with the Nordic system`)
    for (const field of synchronousFields) {
      if (system[field] === undefined) fail(context, [field], 'required for a synchronous external system')
    }
    return
  }
  for (const field of synchronousFields) {
    if (system[field] !== undefined) fail(context, [field], 'only a synchronous external system shares frequency with Norway')
  }
})
export type GridExternalSystemV2 = z.infer<typeof gridExternalSystemSchema>

export const gridGeneratorSchema = z.object({
  id: z.string().regex(gridIdPatterns.generator, 'must be a Grid generator id'),
  label: text,
  kind: z.enum(generatorKinds),
  busId: busRef,
  location: lonLat,
  capacityMw: positive,
  ratedMva: positive,
  /** Rated power factor; the reactive limit is ratedMva·√(1 − powerFactor²). */
  powerFactor: z.number().finite().gt(0).max(1),
  /** Voltage set-point of the attached bus while the unit controls voltage. */
  voltageSetpointPu: z.number().finite().min(0.9).max(1.1),
  /** H on ratedMva; 0 for converter-connected units. */
  inertiaSeconds: nonNegative,
  synchronous: z.boolean(),
  minimumStableMw: nonNegative,
  rampMwPerMinute: positive,
  blackStartCapable: z.boolean(),
  annualProductionGwh: nonNegative.optional(),
  priceArea: priceAreaSchema,
  /** NVE plant numbers aggregated into this unit. */
  registryIds: z.array(text),
  /** Distance from location to the attached bus. */
  attachmentKm: nonNegative,
  provenance: gridProvenanceSchema,
}).strict().superRefine((generator, context) => {
  requireCuratedProvenance(context, generator)
  if (generator.ratedMva < generator.capacityMw) fail(context, ['ratedMva'], `must be at least capacityMw (${generator.capacityMw})`)
  if (generator.minimumStableMw > generator.capacityMw) fail(context, ['minimumStableMw'], `must not exceed capacityMw (${generator.capacityMw})`)
  if (!generator.synchronous && generator.inertiaSeconds !== 0) fail(context, ['inertiaSeconds'], 'a converter-connected unit has no synchronous inertia')
  requireUnique(context, generator.registryIds, 'registryIds')
  if (generator.id.startsWith('generator:nve-') && generator.registryIds.length === 0) fail(context, ['registryIds'], 'an NVE-registered unit lists its NVE plant numbers')
  const aggregate = aggregateGeneratorIdParts(generator.id)
  if (aggregate !== undefined && aggregate.busId !== generator.busId) fail(context, ['busId'], `the aggregate id names bus ${aggregate.busId}`)
  if (aggregate !== undefined && aggregate.kind !== generator.kind) fail(context, ['kind'], `the aggregate id names kind ${aggregate.kind}`)
})
export type GridGeneratorV2 = z.infer<typeof gridGeneratorSchema>

export const gridLoadSchema = z.object({
  id: z.string().regex(gridIdPatterns.load, 'must be a Grid load id'),
  label: text,
  kind: z.enum([...municipalityLoadGroups, ...siteLoadKinds]),
  busId: busRef,
  location: lonLat,
  /** Demand at the model's reference hour. */
  referenceDemandMw: nonNegative,
  powerFactor: z.number().finite().gt(0).max(1),
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  /** Contractually or technically curtailable; 0 when unknown, which the provenance states. */
  interruptibleMw: nonNegative,
  municipalityNr: z.string().regex(/^\d{4}$/).optional(),
  priceArea: priceAreaSchema,
  attachmentKm: nonNegative,
  provenance: gridProvenanceSchema,
}).strict().superRefine((load, context) => {
  if (load.interruptibleMw > load.referenceDemandMw) fail(context, ['interruptibleMw'], `must not exceed referenceDemandMw (${load.referenceDemandMw})`)
  const municipality = municipalityLoadIdParts(load.id)
  if (municipality !== undefined) {
    if (load.municipalityNr !== municipality.municipalityNr) fail(context, ['municipalityNr'], `the id names municipality ${municipality.municipalityNr}`)
    if (load.kind !== municipality.group) fail(context, ['kind'], `the id names group ${municipality.group}`)
  } else if (!(siteLoadKinds as ReadonlyArray<string>).includes(load.kind)) {
    fail(context, ['kind'], `a site load has kind ${siteLoadKinds.join(', ')}`)
  }
})
export type GridLoadV2 = z.infer<typeof gridLoadSchema>

export const gridShuntSchema = z.object({
  id: z.string().regex(gridIdPatterns.shunt, 'must be a Grid shunt id'),
  busId: busRef,
  /** Reactive power at 1 pu voltage: negative for a reactor (absorbs), positive for a capacitor. */
  mvarAtNominalVoltage: z.number().finite().refine(value => value !== 0, 'must be non-zero'),
  switchable: z.boolean(),
  provenance: gridProvenanceSchema,
}).strict().superRefine((shunt, context) => {
  const parts = shuntIdParts(shunt.id)
  if (parts !== undefined && parts.busId !== shunt.busId) fail(context, ['busId'], `the shunt id names bus ${parts.busId}`)
})
export type GridShuntV2 = z.infer<typeof gridShuntSchema>

export const gridConnectionPointSchema = z.object({
  id: z.string().max(128).regex(gridIdPatterns.connectionPoint, 'must be a kebab-case connection point id'),
  label: text,
  busId: busRef,
  nominalKv: positive,
  /** Maximum power leaving the Grid through this point. */
  maximumExportMw: nonNegative,
  /** Maximum power entering the Grid through this point. */
  maximumImportMw: nonNegative,
}).strict()
export type GridConnectionPointV2 = z.infer<typeof gridConnectionPointSchema>

export const gridSourceInputSchema = z.object({
  sourceId: gridSourceIdSchema,
  snapshotAt: z.iso.datetime({ offset: true }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256'),
  licence: text,
}).strict()
export type GridSourceInput = z.infer<typeof gridSourceInputSchema>

/** An ISO timestamp on a whole hour with an explicit offset. */
const isoHour = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:\d{2})$/, 'must be an ISO timestamp on a whole hour with an offset')
  .refine(value => Number.isFinite(Date.parse(value)), 'must be a valid timestamp')

export const gridModelSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(gridIdPatterns.definitionRef, 'must be an electric-grid definition ref'),
  title: text,
  description: text,
  nominalFrequencyHz: z.literal(50),
  sBaseMva: positive,
  /**
   * What the runtime solves: active flows by a fast-decoupled AC load flow of each energised island
   * where it converges and by the DC solve otherwise ('ac-fdlf-or-dc'), voltages by the same AC
   * load flow ('ac-fdlf'), frequency by one swing equation per synchronous island.
   */
  fidelity: z.object({ powerFlow: z.literal('ac-fdlf-or-dc'), voltage: z.literal('ac-fdlf'), frequency: z.literal('island-swing') }).strict(),
  referenceHour: isoHour,
  sourceBuild: z.object({
    /** Deterministic from the inputs; never wall-clock. */
    id: z.string().regex(/^\S+$/),
    inputs: z.array(gridSourceInputSchema).min(1),
  }).strict(),
  buses: z.array(gridBusSchema).min(1),
  branches: z.array(gridBranchSchema),
  hvdcLinks: z.array(gridHvdcLinkSchema),
  hvdcRampGroups: z.array(gridHvdcRampGroupSchema),
  externalSystems: z.array(gridExternalSystemSchema),
  generators: z.array(gridGeneratorSchema),
  loads: z.array(gridLoadSchema),
  shunts: z.array(gridShuntSchema),
  /** Empty until a real storage asset with provenance exists. */
  storage: z.tuple([]),
  connectionPoints: z.array(gridConnectionPointSchema),
}).strict().superRefine((model, context) => {
  for (const issue of gridModelReferenceIssues(model)) fail(context, issue.path, issue.message)
})
export type GridModelV2 = z.infer<typeof gridModelSchema>

/** Validates Grid Model v2 JSON; throws one error naming `source` and each issue's JSON path. */
export const validateGridModel = (json: unknown, source: string): GridModelV2 =>
  parseGridData(gridModelSchema, json, source, 'Grid Model v2')
