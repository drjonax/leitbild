import { z } from 'zod'
import { findLicence } from '../../../reference-data/licences.ts'
import { asLicenceId } from '../../../reference-data/types.ts'
import { priceAreaSchema } from './grid-ids.ts'

// Measured national production and cross-border exchange of Norway at the model's reference hours
// (models/norway-reference-dispatch.json), the evidence the Operating Points dispatch from. Values
// are hourly means of the published quarter-hours, in MW. Exchange is physical flow, positive into
// Norway, per neighbouring country (each HVDC country border is one or more links of the model; the
// Swedish and Finnish borders are the Nordic AC exchange) and per AC border of the Nordic exchange.
// Each source records the exact retrievals (URL, time, SHA-256 of the bytes) its values were read from.

const isoInstant = z.iso.datetime({ offset: true })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const mw = z.number().finite()
const nonNegativeMw = z.number().finite().nonnegative()

const sourceIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

const sourceSchema = z.strictObject({
  id: sourceIdSchema,
  title: z.string().min(1),
  publisher: z.string().min(1),
  url: z.url(),
  licence: z.string().refine(id => findLicence(asLicenceId(id)) !== null, 'licence must be registered in src/reference-data/licences.ts'),
  attribution: z.string().min(1),
  retrievals: z.array(z.strictObject({ url: z.url(), retrievedAt: isoInstant, sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
})

/** The AC borders of a country sum to its country flow within 3 MW: Svenska kraftnät's Swedish borders and Energy-Charts' (ENTSO-E) Sweden flow meter the same ties and agree within 1 MW at both reference hours; Finland's one border is Energy-Charts' Finland flow. */
const countryFlowAgreementMw = 3

const hourSchema = z.strictObject({
  /** First instant of the hour; must equal the Elhub reference hour the model or Operating Point describes. */
  startUtc: isoInstant,
  /** ENTSO-E actual generation per production type for Norway (country level). */
  generationMw: z.strictObject({
    hydroRunOfRiver: nonNegativeMw,
    hydroReservoir: nonNegativeMw,
    /** Null where the source publishes no value for the hour. */
    hydroPumpedStorage: nonNegativeMw.nullable(),
    windOnshore: nonNegativeMw,
    windOffshore: nonNegativeMw,
    fossilGas: nonNegativeMw,
    /** Waste, biomass, other renewables and solar: not modelled as units; reported for the balance. */
    other: nonNegativeMw,
  }),
  /** ENTSO-E total load of Norway, including network losses (Elhub meters end use only). */
  loadMw: nonNegativeMw,
  /** Physical cross-border flow into Norway per neighbour. */
  importMw: z.strictObject({ SE: mw, FI: mw, DK: mw, DE: mw, NL: mw, GB: mw }),
  /** Elhub's metered production of each price area per production group (PRODUCTION_PER_GROUP_MBA_HOUR), with the source it was read from. */
  areaProduction: z.strictObject({
    source: sourceIdSchema,
    mw: z.record(priceAreaSchema, z.strictObject({ hydro: nonNegativeMw, wind: nonNegativeMw, thermal: nonNegativeMw, solar: nonNegativeMw, other: nonNegativeMw })),
  }),
  /** Physical flow into Norway over each AC border of the Nordic exchange: a Norwegian price area and a Swedish bidding zone or Finland. */
  acBorderImportMw: z.array(z.strictObject({ priceArea: priceAreaSchema, externalArea: z.enum(['SE1', 'SE2', 'SE3', 'FI']), importMw: mw, source: sourceIdSchema })).min(1),
  /** Exact queries the values were read from. */
  queries: z.array(z.url()).min(1),
  note: z.string().min(1),
}).superRefine((hour, context) => {
  const seen = new Set<string>()
  hour.acBorderImportMw.forEach((border, index) => {
    const key = `${border.priceArea}–${border.externalArea}`
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['acBorderImportMw', index], message: `${key} is listed twice` })
    seen.add(key)
  })
  const sum = (country: 'SE' | 'FI'): number => hour.acBorderImportMw.filter(border => border.externalArea.startsWith(country)).reduce((total, border) => total + border.importMw, 0)
  for (const country of ['SE', 'FI'] as const) {
    if (!(Math.abs(sum(country) - hour.importMw[country]) <= countryFlowAgreementMw)) {
      context.addIssue({ code: 'custom', path: ['acBorderImportMw'], message: `the ${country} borders sum to ${sum(country).toFixed(1)} MW, the country flow is ${hour.importMw[country]} MW` })
    }
  }
})
export type GridReferenceHourDispatch = z.infer<typeof hourSchema>

export const referenceDispatchTableSchema = z.strictObject({
  schema: z.literal('leitbild.electric-grid.norway-reference-dispatch'),
  curatedAt: isoDate,
  sources: z.array(sourceSchema).min(1),
  hours: z.strictObject({ winterPeak: hourSchema, summerLow: hourSchema }),
}).superRefine((table, context) => {
  const licences = new Set(table.sources.map(source => source.licence))
  if (licences.size !== 1) context.addIssue({ code: 'custom', path: ['sources'], message: 'the table records one licence across its sources' })
  const sources = new Set(table.sources.map(source => source.id))
  const retrieved = new Set(table.sources.flatMap(source => source.retrievals.map(retrieval => retrieval.url)))
  for (const [name, hour] of Object.entries(table.hours)) {
    hour.acBorderImportMw.forEach((border, index) => {
      if (!sources.has(border.source)) context.addIssue({ code: 'custom', path: ['hours', name, 'acBorderImportMw', index, 'source'], message: `${border.source} is not a source of the table` })
    })
    if (!sources.has(hour.areaProduction.source)) context.addIssue({ code: 'custom', path: ['hours', name, 'areaProduction', 'source'], message: `${hour.areaProduction.source} is not a source of the table` })
    hour.queries.forEach((query, index) => {
      if (!retrieved.has(query)) context.addIssue({ code: 'custom', path: ['hours', name, 'queries', index], message: 'is no retrieval of a source' })
    })
  }
})
export type GridReferenceDispatchTable = z.infer<typeof referenceDispatchTableSchema>
