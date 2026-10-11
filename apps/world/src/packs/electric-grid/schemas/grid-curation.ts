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
