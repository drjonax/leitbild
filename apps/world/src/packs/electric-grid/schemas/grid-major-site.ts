import { z } from 'zod'
import { curatedEvidenceSchema, curatedProvenanceSchema } from './grid-interconnector.ts'

// Curated large point loads (models/norway-major-sites.json): smelters, process industry, gas
// plants and offshore installations powered from shore, each at the substation that serves it.
//
// Elhub meters these loads inside their municipality's `industry` group. A site absorbs part of
// that group: at a reference hour the model build gives the sites of one municipality
// industry × publishedMw / max(Σ publishedMw, industry) each, and leaves the remainder as
// distributed municipal industry load. A site therefore never exceeds its published demand and the
// municipality total stays the measured Elhub value.

const lonLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const municipalityNumberSchema = z.string().regex(/^\d{4}$/)

const substationSchema = z.strictObject({
  name: z.string().min(1),
  osmId: z.string().regex(/^(node|way|relation)\/\d+$/),
  kv: z.number().positive(),
})

export const majorSiteSchema = z.strictObject({
  id: z.string().regex(/^site:[a-z0-9-]+$/),
  name: z.string().min(1),
  operator: z.string().min(1),
  kind: z.enum(['industry-site', 'petroleum-site', 'data-center']),
  activity: z.string().min(1),
  // Where the load connects: the plant, or the onshore converter/landfall for offshore installations.
  location: lonLatSchema,
  municipalityNr: municipalityNumberSchema,
  municipalityName: z.string().min(1),
  priceArea: z.enum(['NO1', 'NO2', 'NO3', 'NO4', 'NO5']),
  // The station that feeds the site; upstreamSubstation is the transmission station behind it when
  // the serving station sits below the model's voltage range or its supply lines may be unmapped.
  servingSubstation: substationSchema,
  upstreamSubstation: substationSchema.nullable(),
  demand: z.strictObject({
    // Published electrical demand, MW: contracted or installed power, or annual energy / 8760 h.
    publishedMw: z.number().positive(),
    basis: z.string().min(1),
    year: z.number().int().min(2000).max(2100),
  }),
  offshore: z.strictObject({
    installations: z.array(z.string().min(1)).min(1),
    powerFromShoreMw: z.number().positive(),
    onshoreConnection: z.string().min(1),
  }).nullable(),
  // A power plant inside the site that supplies it (Hammerfest LNG): the model adds it as a thermal
  // unit at the site's bus, dispatched to the measured national output of its kind.
  onSiteGeneration: z.strictObject({
    name: z.string().min(1),
    osmPlantId: z.string().regex(/^(node|way|relation)\/\d+$/),
    kind: z.literal('thermal'),
    fuel: z.literal('gas'),
    units: z.number().int().positive(),
    capacityMw: z.number().positive(),
    evidence: z.array(curatedEvidenceSchema).min(1),
  }).nullable(),
  elhubAbsorption: z.strictObject({
    municipalityNr: municipalityNumberSchema,
    group: z.literal('industry'),
  }),
  evidence: z.array(curatedEvidenceSchema).min(1),
  provenance: curatedProvenanceSchema,
})

export const majorSiteTableSchema = z.strictObject({
  schema: z.literal('leitbild.electric-grid.norway-major-sites'),
  curatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  osmSnapshot: z.string().min(1),
  inclusionRule: z.string().min(1),
  sites: z.array(majorSiteSchema).min(1),
  excluded: z.array(z.strictObject({ id: z.string().regex(/^site:[a-z0-9-]+$/), name: z.string().min(1), reason: z.string().min(1) })),
}).superRefine((table, context) => {
  const ids = table.sites.map(site => site.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate) context.addIssue({ code: 'custom', message: `duplicate site id ${duplicate}` })
  for (const site of table.sites) {
    if (site.offshore !== null && site.kind !== 'petroleum-site') {
      context.addIssue({ code: 'custom', message: `${site.id}: only petroleum sites are powered offshore from shore` })
    }
  }
})

export type GridMajorSite = z.infer<typeof majorSiteSchema>
export type GridMajorSiteTable = z.infer<typeof majorSiteTableSchema>
