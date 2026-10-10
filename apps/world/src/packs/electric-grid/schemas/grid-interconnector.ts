import { z } from 'zod'

// Curated cross-border link table (models/norway-interconnectors.json): every AC tie and HVDC link
// between Norway and its neighbours, the bidding-zone border capacities, and the external
// equivalents the links terminate in. Every number carries evidence; the model build turns links
// into boundary buses, AC branches and HVDC injection pairs.

const priceAreaSchema = z.enum(['NO1', 'NO2', 'NO3', 'NO4', 'NO5'])
export const interconnectorForeignAreaSchema = z.enum(['SE1', 'SE2', 'SE3', 'FI', 'RU', 'DK1', 'NL', 'DE', 'GB'])
const lonLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const osmElementIdSchema = z.string().regex(/^(node|way|relation)\/\d+$/)
const osmWayIdSchema = z.string().regex(/^way\/\d+$/)
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const curatedEvidenceSchema = z.strictObject({
  url: z.url(),
  supports: z.string().min(1),
})

export const curatedProvenanceSchema = z.strictObject({
  sources: z.array(z.string().min(1)).min(1),
  method: z.literal('curated'),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().min(1),
})

const norwegianTerminalSchema = z.strictObject({
  substationName: z.string().min(1),
  osmId: osmElementIdSchema,
  acKv: z.number().positive(),
  location: lonLatSchema,
})

const foreignTerminalSchema = z.strictObject({
  name: z.string().min(1),
  country: z.enum(['SE', 'FI', 'RU', 'DK', 'NL', 'DE', 'GB']),
})

const ratingSchema = z.strictObject({
  mw: z.number().positive(),
  // published-rating: the operator's stated transfer or thermal rating of this link;
  // corridor-share: a share of the published border capacity, stated in the note.
  basis: z.enum(['published-rating', 'corridor-share']),
  note: z.string().min(1),
})

const linkFields = {
  id: z.string().regex(/^(hvdc|ac):[a-z0-9-]+$/),
  name: z.string().min(1),
  norwegianArea: priceAreaSchema,
  foreignArea: interconnectorForeignAreaSchema,
  norwegianTerminal: norwegianTerminalSchema,
  foreignTerminal: foreignTerminalSchema,
  commissioned: z.number().int().min(1900).max(2100).nullable(),
  rating: ratingSchema,
  inService: z.boolean(),
  statusNote: z.string().min(1).nullable(),
  // Cross-border ways in OpenStreetMap (Norwegian side and, where mapped, the crossing itself).
  osmWayIds: z.array(osmWayIdSchema),
  evidence: z.array(curatedEvidenceSchema).min(1),
  provenance: curatedProvenanceSchema,
}

export const acInterconnectorSchema = z.strictObject({
  kind: z.literal('ac'),
  ...linkFields,
  nominalKv: z.number().positive(),
  circuits: z.number().int().positive(),
})

export const hvdcInterconnectorSchema = z.strictObject({
  kind: z.literal('hvdc'),
  ...linkFields,
  technology: z.enum(['LCC', 'VSC']),
  dcKv: z.number().positive(),
  lengthKm: z.number().positive(),
  foreignConverter: z.string().min(1),
  // Converter plus cable losses at rated transfer, % of transferred power.
  lossPercentAtRated: z.number().positive().max(10),
  lossBasis: z.string().min(1),
  // Maximum change of the scheduled flow, MW per minute.
  rampMwPerMinute: z.number().positive(),
  rampBasis: z.string().min(1),
  pypsaEurPNomMw: z.number().positive().nullable(),
})

export const interconnectorSchema = z.discriminatedUnion('kind', [acInterconnectorSchema, hvdcInterconnectorSchema])

// A ramp limit shared by several HVDC links (one market border, or a combined Nordic cap), MW per minute.
export const hvdcRampGroupSchema = z.strictObject({
  id: z.string().regex(/^ramp:[a-z0-9-]+$/),
  linkIds: z.array(z.string().regex(/^hvdc:[a-z0-9-]+$/)).min(2),
  rampMwPerMinute: z.number().positive(),
  basis: z.string().min(1),
  evidence: z.array(curatedEvidenceSchema).min(1),
})

export const borderCapacitySchema = z.strictObject({
  border: z.string().regex(/^NO[1-5]-(SE1|SE2|SE3|FI|RU|DK1|NL|DE|GB)$/),
  exportMw: z.number().nonnegative(),
  importMw: z.number().nonnegative(),
  basis: z.string().min(1),
  asOf: isoDateSchema,
  evidence: z.array(curatedEvidenceSchema).min(1),
})

const synchronousCaseSchema = z.strictObject({
  // Kinetic energy of the synchronous machines in the equivalent, GW·s.
  inertiaGws: z.number().positive(),
  loadMw: z.number().positive(),
  // FCR-N stiffness, MW per Hz (full activation over ±0.1 Hz).
  fcrNMwPerHz: z.number().positive(),
  fcrDUpMw: z.number().positive(),
  fcrDDownMw: z.number().positive(),
  derivation: z.string().min(1),
})

export const externalSystemSchema = z.strictObject({
  id: z.string().regex(/^external:[a-z0-9-]+$/),
  label: z.string().min(1),
  area: z.enum(['nordic-remainder', 'DK1', 'NL', 'DE', 'GB']),
  synchronous: z.boolean(),
  members: z.array(z.string().min(1)).min(1),
  cases: z.strictObject({ winterPeak: synchronousCaseSchema, summerLow: synchronousCaseSchema }).nullable(),
  // Load self-regulation, % of load per Hz.
  loadDampingPercentPerHz: z.number().positive().nullable(),
  evidence: z.array(curatedEvidenceSchema).min(1),
  provenance: curatedProvenanceSchema,
}).refine(
  system => system.synchronous === (system.cases !== null) && system.synchronous === (system.loadDampingPercentPerHz !== null),
  { message: 'synchronous external systems need cases and load damping; HVDC-only areas have neither' },
)

export const interconnectorTableSchema = z.strictObject({
  schema: z.literal('leitbild.electric-grid.norway-interconnectors'),
  curatedAt: isoDateSchema,
  osmSnapshot: z.string().min(1),
  links: z.array(interconnectorSchema).min(1),
  hvdcRampGroups: z.array(hvdcRampGroupSchema),
  borderCapacities: z.array(borderCapacitySchema),
  externalSystems: z.array(externalSystemSchema).min(1),
  // Ties found in older statistics or OpenStreetMap whose current service could not be confirmed.
  excludedCandidates: z.array(z.strictObject({
    name: z.string().min(1),
    osmWayIds: z.array(osmWayIdSchema),
    reason: z.string().min(1),
    evidence: z.array(curatedEvidenceSchema).min(1),
  })),
}).superRefine((table, context) => {
  const ids = table.links.map(link => link.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) context.addIssue({ code: 'custom', message: `duplicate link id ${duplicate}` })
  for (const group of table.hvdcRampGroups) {
    for (const linkId of group.linkIds) {
      if (!table.links.some(link => link.id === linkId && link.kind === 'hvdc')) context.addIssue({ code: 'custom', message: `${group.id}: unknown HVDC link ${linkId}` })
    }
  }
  for (const link of table.links) {
    const synchronousForeign = ['SE1', 'SE2', 'SE3', 'FI', 'RU'].includes(link.foreignArea)
    if ((link.kind === 'ac') !== synchronousForeign) {
      context.addIssue({ code: 'custom', message: `${link.id}: AC links reach SE1–3/FI/RU and HVDC links reach DK1/NL/DE/GB` })
    }
  }
})

export type GridInterconnector = z.infer<typeof interconnectorSchema>
export type GridInterconnectorTable = z.infer<typeof interconnectorTableSchema>
export type GridExternalSystem = z.infer<typeof externalSystemSchema>
