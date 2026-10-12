import { z } from 'zod'
import { findLicence } from '../../../reference-data/licences.ts'
import { asLicenceId } from '../../../reference-data/types.ts'
import { osmIdPattern } from '../audit/audit-graph.ts'
import { gridExternalAreaSchema, gridRadialReasonSchema } from './grid-golden.ts'

// Curated corrections for gaps open data cannot close. Each record is one typed, reviewed
// correction with evidence and an expiry condition the grid audit evaluates. This is a
// one-level record list, not a patch language: records never reference or modify each other.

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const osmId = z.string().regex(osmIdPattern)
const wayId = z.string().regex(/^way\/[1-9][0-9]*$/)
const interconnectorId = z.string().regex(/^(?:ac|hvdc):[a-z0-9]+(?:-[a-z0-9]+)*$/)
const siteId = z.string().regex(/^site:[a-z0-9]+(?:-[a-z0-9]+)*$/)
const registeredGeneratorId = z.string().regex(/^generator:nve-(?:hydro|wind)-[1-9][0-9]*$/)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const text = z.string().trim().min(1)
const kv = z.number().finite().positive()
const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const evidenceSchema = z.object({
  url: z.string().url(),
  /** Identifier inside the source: NVE globalid, registry number, or the page section relied on. */
  ref: text,
  note: text.optional(),
}).strict()

const expirySchema = z.discriminatedUnion('kind', [
  /** Open data alone now yields this corridor; the curation is redundant. */
  z.object({ kind: z.literal('mapped-corridor-present'), fromSubstationOsmId: osmId, toSubstationOsmId: osmId, voltageKv: kv }).strict(),
  /** The asserted radial station has gained a second neighbour at this voltage. */
  z.object({ kind: z.literal('radial-no-longer'), substationOsmId: osmId, voltageKv: kv }).strict(),
  /** The record must be re-reviewed by this date. */
  z.object({ kind: z.literal('review-by'), date: isoDate }).strict(),
])

const common = {
  targetOsmIds: z.array(osmId).min(1),
  reason: text,
  evidence: z.array(evidenceSchema).min(1),
  licence: text.refine(id => findLicence(asLicenceId(id)) !== null, 'licence must be registered in src/reference-data/licences.ts'),
  author: text,
  reviewedAt: isoDate,
  expiresWhen: z.array(expirySchema).min(1),
}

const propertiesSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add-line'), ...common,
    fromSubstationOsmId: osmId, toSubstationOsmId: osmId, voltageKv: kv, circuits: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('add-terminal'), ...common,
    wayOsmId: wayId, substationOsmId: osmId, voltageKv: kv,
    /** The station at the far end of the way, which the attached terminal connects to. */
    remoteSubstationOsmId: osmId,
  }).strict(),
  z.object({
    kind: z.literal('assert-radial'), ...common,
    substationOsmId: osmId, voltageKv: kv, radialReason: gridRadialReasonSchema,
  }).strict(),
  z.object({ kind: z.literal('exclude-feature'), ...common }).strict(),
  z.object({
    kind: z.literal('boundary'), ...common,
    substationOsmId: osmId, externalArea: gridExternalAreaSchema, linkKind: z.enum(['ac', 'hvdc']),
    voltageKv: kv, ratingMw: z.number().finite().positive(),
  }).strict(),
  /** Mapped features whose lifecycle tag is stale: the topology compiles them as operational. */
  z.object({ kind: z.literal('assert-in-service'), ...common }).strict(),
  /** OSM ways of a listed interconnector that the interconnector table does not list yet. */
  z.object({
    kind: z.literal('add-interconnector-ways'), ...common,
    interconnectorId, osmWayIds: z.array(wayId).min(1),
  }).strict(),
  /**
   * An offshore power-from-shore HVDC link: no grid branch, because the platform demand is the
   * major-site load at the onshore converter; the mapped cable ways are explained, not dropped.
   */
  z.object({ kind: z.literal('offshore-load'), ...common, siteId }).strict(),
  /**
   * A registered plant beyond the attachment radius of every ≥132 kV station, connected through
   * the mapped regional (<132 kV) grid: it attaches at the station the regional route reaches.
   */
  z.object({
    kind: z.literal('attach-via-regional-grid'), ...common,
    generatorId: registeredGeneratorId, substationOsmId: osmId, voltageKv: kv,
    /** The mapped regional route from the plant to the station, in order (ways and stations). */
    viaOsmIds: z.array(osmId),
    networkKm: z.number().finite().positive(),
  }).strict(),
  /**
   * A municipality beyond the load attachment limit of every ≥132 kV station, supplied through
   * the regional or distribution grid: its loads attach at the station that route reaches.
   * routeKm counts the mapped part of the route (NVE Nettanlegg5 or OSM); the reason names any
   * unmapped distribution leg.
   */
  z.object({
    kind: z.literal('attach-load-via-regional-grid'), ...common,
    municipalityNr: z.string().regex(/^\d{4}$/), substationOsmId: osmId, voltageKv: kv,
    routeKm: z.number().finite().nonnegative(),
  }).strict(),
  /**
   * A reactive compensation device in service that open data does not map (Statnett concession
   * documents): it replaces the rule-inferred shunt of that bus. Negative MVAr absorbs (reactor).
   */
  z.object({
    kind: z.literal('add-shunt-device'), ...common,
    substationOsmId: osmId, voltageKv: kv,
    device: z.enum(['shunt-reactor', 'capacitor-bank']),
    mvarAtNominalVoltage: z.number().finite().refine(value => value !== 0, 'must not be 0'),
    switchable: z.boolean(),
  }).strict().refine(properties => (properties.device === 'shunt-reactor') === (properties.mvarAtNominalVoltage < 0), 'a shunt reactor absorbs (negative MVAr), a capacitor bank supplies (positive)'),
  /**
   * A line whose conductors a published document gives (NVE concession, operator): the one model
   * line carrying every listed way takes this rating, all circuits, at the 35 °C design air of the
   * overhead rules; the ambient rule rates it at the model's and the summer air like any overhead
   * line. Its impedance stays rule-based.
   */
  z.object({
    kind: z.literal('set-line-rating'), ...common,
    wayOsmIds: z.array(wayId).min(1), voltageKv: kv,
    designRatingMva: z.number().finite().positive(),
  }).strict(),
  /**
   * A network equivalent of sub-transmission below the model's 132 kV floor (a 47 or 66 kV mesh)
   * that couples two model buses of different voltage in parallel with the grid: the build adds
   * one branch labelled as an equivalent, not a mapped line, whose impedance and rating follow the
   * sub-transmission equivalent rule from the mapped route (viaKv, circuits, routeKm).
   */
  z.object({
    kind: z.literal('add-network-equivalent'), ...common,
    fromSubstationOsmId: osmId, fromKv: kv, toSubstationOsmId: osmId, toKv: kv,
    viaKv: kv, circuits: z.number().int().positive(), routeKm: z.number().finite().positive(),
  }).strict()
    .refine(properties => properties.fromKv !== properties.toKv, 'an equivalent couples two voltage levels')
    .refine(properties => properties.viaKv < Math.min(properties.fromKv, properties.toKv), 'viaKv must lie below both end voltages'),
  /** A transformer whose rating a published document gives: the station's highKv/lowKv transformer takes it, with the transformer rule's impedance on that rating. */
  z.object({
    kind: z.literal('set-transformer-rating'), ...common,
    substationOsmId: osmId, highKv: kv, lowKv: kv,
    ratingMva: z.number().finite().positive(),
  }).strict().refine(properties => properties.highKv > properties.lowKv, 'highKv must exceed lowKv'),
  /**
   * Transformer units in service that a published document gives (concession, operator) and OSM
   * does not map: the topology joins the station's highKv and lowKv levels with these units, as it
   * would mapped transformers, so no unit is inferred between levels they already join; the units
   * take units × unitRatingMva with the transformer rule's impedance on that rating.
   */
  z.object({
    kind: z.literal('add-transformer-units'), ...common,
    substationOsmId: osmId, highKv: kv, lowKv: kv,
    units: z.number().int().positive(),
    unitRatingMva: z.number().finite().positive(),
  }).strict().refine(properties => properties.highKv > properties.lowKv, 'highKv must exceed lowKv'),
  /**
   * A mapped line or cable operated open in normal operation (a sectioning point, delt drift): it
   * stays in the model, and the Operating Points start it open. Every listed way must lie on
   * exactly one model line; each line carrying a listed way starts open.
   */
  z.object({
    kind: z.literal('normally-open'), ...common,
    wayOsmIds: z.array(wayId).min(1), voltageKv: kv,
  }).strict(),
  /**
   * A mapped line or cable whose circuit count OSM does not give (no circuits, cables or route
   * relation) and a published document does: the one model line carrying every listed way takes
   * this many circuits, and the line rules rate it and set its impedance for that count.
   */
  z.object({
    kind: z.literal('set-circuits'), ...common,
    wayOsmIds: z.array(wayId).min(1), voltageKv: kv,
    circuits: z.number().int().min(2),
  }).strict(),
  /**
   * A registered plant whose units a published document places at several ≥132 kV stations where
   * NVE registers one point: the plant becomes one generator per part, each with its weight's share
   * of the registered capacity and production (weight: what the document gives per part, such as
   * the part's transformer MVA). The first part keeps the registered generator id; part n (from 2)
   * is generator:curated-<record id>-<n>.
   */
  z.object({
    kind: z.literal('split-plant'), ...common,
    generatorId: registeredGeneratorId,
    parts: z.array(z.object({ substationOsmId: osmId, voltageKv: kv, weight: z.number().finite().positive() }).strict()).min(2),
  }).strict().refine(properties => new Set(properties.parts.map(part => `${part.substationOsmId}@${part.voltageKv}`)).size === properties.parts.length, 'each part names another station level'),
])

const featureSchema = z.object({
  type: z.literal('Feature'),
  id: slug,
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal('Point'), coordinates: position }).strict(),
    z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }).strict(),
  ]),
  properties: propertiesSchema,
}).strict()

type CurationFeature = z.infer<typeof featureSchema>

const allowedExpiry: Record<CurationFeature['properties']['kind'], {
  readonly required: ReadonlyArray<string>
  readonly allowed: ReadonlyArray<string>
}> = {
  'add-line': { required: ['mapped-corridor-present'], allowed: ['mapped-corridor-present', 'review-by'] },
  'add-terminal': { required: ['mapped-corridor-present'], allowed: ['mapped-corridor-present', 'review-by'] },
  'assert-radial': { required: ['radial-no-longer'], allowed: ['radial-no-longer', 'review-by'] },
  'exclude-feature': { required: ['review-by'], allowed: ['review-by'] },
  boundary: { required: ['review-by'], allowed: ['review-by'] },
  'assert-in-service': { required: ['review-by'], allowed: ['review-by'] },
  'add-interconnector-ways': { required: ['review-by'], allowed: ['review-by'] },
  'offshore-load': { required: ['review-by'], allowed: ['review-by'] },
  'attach-via-regional-grid': { required: ['review-by'], allowed: ['review-by'] },
  'attach-load-via-regional-grid': { required: ['review-by'], allowed: ['review-by'] },
  'add-shunt-device': { required: ['review-by'], allowed: ['review-by'] },
  'set-line-rating': { required: ['review-by'], allowed: ['review-by'] },
  'set-transformer-rating': { required: ['review-by'], allowed: ['review-by'] },
  'add-network-equivalent': { required: ['review-by'], allowed: ['review-by'] },
  'add-transformer-units': { required: ['review-by'], allowed: ['review-by'] },
  'normally-open': { required: ['review-by'], allowed: ['review-by'] },
  'set-circuits': { required: ['review-by'], allowed: ['review-by'] },
  'split-plant': { required: ['review-by'], allowed: ['review-by'] },
}

const primaryOsmIds = (properties: CurationFeature['properties']): ReadonlyArray<string> => {
  switch (properties.kind) {
    case 'add-line': return [properties.fromSubstationOsmId, properties.toSubstationOsmId]
    case 'add-terminal': return [properties.wayOsmId, properties.substationOsmId]
    case 'assert-radial': return [properties.substationOsmId]
    case 'exclude-feature': return []
    case 'boundary': return [properties.substationOsmId]
    case 'assert-in-service': return []
    case 'add-interconnector-ways': return properties.osmWayIds
    case 'offshore-load': return []
    case 'attach-via-regional-grid': return [properties.substationOsmId]
    case 'attach-load-via-regional-grid': return [properties.substationOsmId]
    case 'add-shunt-device': return [properties.substationOsmId]
    case 'set-line-rating': return properties.wayOsmIds
    case 'set-transformer-rating': return [properties.substationOsmId]
    case 'add-network-equivalent': return [properties.fromSubstationOsmId, properties.toSubstationOsmId]
    case 'add-transformer-units': return [properties.substationOsmId]
    case 'normally-open': return properties.wayOsmIds
    case 'set-circuits': return properties.wayOsmIds
    case 'split-plant': return properties.parts.map(part => part.substationOsmId)
  }
}

export const gridCurationCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(featureSchema),
}).strict().superRefine((collection, context) => {
  const ids = new Set<string>()
  collection.features.forEach((feature, index) => {
    const issue = (path: ReadonlyArray<string | number>, message: string): void => {
      context.addIssue({ code: 'custom', path: ['features', index, ...path], message })
    }
    if (ids.has(feature.id)) issue(['id'], `duplicate curation id ${feature.id}`)
    ids.add(feature.id)
    const properties = feature.properties
    const rule = allowedExpiry[properties.kind]
    const kinds = properties.expiresWhen.map(condition => condition.kind)
    for (const required of rule.required) {
      if (!kinds.includes(required as typeof kinds[number])) issue(['properties', 'expiresWhen'], `${properties.kind} requires a ${required} condition`)
    }
    kinds.forEach((kind, conditionIndex) => {
      if (!rule.allowed.includes(kind)) issue(['properties', 'expiresWhen', conditionIndex], `${kind} does not apply to ${properties.kind}`)
    })
    for (const target of primaryOsmIds(properties)) {
      if (!properties.targetOsmIds.includes(target)) issue(['properties', 'targetOsmIds'], `targetOsmIds must include ${target}`)
    }
    if (properties.kind === 'add-line') {
      if (properties.fromSubstationOsmId === properties.toSubstationOsmId) issue(['properties'], 'add-line connects a station to itself')
      if (feature.geometry.type !== 'LineString') issue(['geometry'], 'add-line needs the curated line geometry')
    }
    if (properties.kind === 'add-terminal' && properties.substationOsmId === properties.remoteSubstationOsmId) {
      issue(['properties'], 'add-terminal remote station equals the attached station')
    }
    if (properties.kind !== 'add-line' && feature.geometry.type !== 'Point') issue(['geometry'], `${properties.kind} is located by a Point`)
  })
})

export type GridCurationCollection = z.infer<typeof gridCurationCollectionSchema>
export type GridCuration = GridCurationCollection['features'][number]
export type GridCurationExpiry = GridCuration['properties']['expiresWhen'][number]
